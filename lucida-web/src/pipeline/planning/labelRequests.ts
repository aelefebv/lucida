/**
 * Chunk requests for label overlays.
 *
 * The WASM planner is label-unaware (labels are kept out of
 * `manifest.images`/`entities`), so label chunks are requested here from
 * the label's OWN multiscale geometry and merged into the fetch plan
 * submitted to the CPU cache. Delivery routes the results to the r32uint
 * label pool (see `dispatchLabelChunkDelivery` + `handleLabelSliceChunkData`).
 *
 * A label overlay is drawn from a single-tile pool covering its full 2D
 * footprint at one level, so this requests EVERY (y, x) chunk of the chosen
 * level's current Z-plane — bounded by picking a level whose grid fits a
 * small chunk budget (labels are coarse; this stays a handful of chunks).
 */

import { Axis } from "../../axes.ts";
import { labelFootprint, labelLevelZTarget, labelTimeIndex } from "../../renderer/labelLayout.ts";
import { isUint32 } from "../../renderer/dataTypeUtil.ts";
import type {
  DatasetManifest,
  ImageSpec,
  LabelSpec,
  LevelGeometry,
} from "../../manifestTypes.ts";
import type { ChunkRequest } from "./types.ts";

/** Cap on the chosen level's per-plane chunk count in SLICE mode. */
const DEFAULT_MAX_CHUNKS_PER_PLANE = 64;
/**
 * Cap on a level's 2D dimensions in SLICE mode. The 2D overlay renders from a
 * single-tile texture at these dims, so it must fit the smallest guaranteed
 * WebGPU 2D texture limit (`maxTextureDimension2D` ≥ 8192); kept well under to
 * bound memory (a `4096²` r32uint tile is 64 MB).
 */
const DEFAULT_MAX_LEVEL_DIM = 4096;

/**
 * Cap on each dimension (X, Y AND Z) in VOLUME mode. The 3D overlay renders
 * from a monolithic r32uint texture, so every axis must fit the smallest
 * guaranteed WebGPU 3D texture limit (`maxTextureDimension3D` ≥ 2048) — much
 * lower than the 2D limit, and with a Z axis the 2D cap never considered. Used
 * as a device-agnostic default; the worker re-clamps to the real device limit
 * on pool creation. A level exceeding this is skipped (or a coarser one is
 * chosen) rather than silently truncated to the clamp while the model matrix
 * spans the full extent (which would misalign the mask).
 */
const DEFAULT_MAX_LEVEL_DIM_3D = 2048;
/**
 * Cap on a level's TOTAL 3D chunk count (`gz·gy·gx`) in VOLUME mode — the
 * volume analog of the per-plane 64. Volume mode fetches EVERY z-chunk, so an
 * anisotropic (chunk-Z 1) or deep label would otherwise fan out to tens of
 * thousands of ~8 MB requests per tick; this bounds the fan-out.
 */
const DEFAULT_MAX_CHUNKS_PER_VOLUME = 512;
/**
 * Byte budget for the monolithic label volume texture in VOLUME mode
 * (r32uint, 4 B/voxel), mirroring the intensity volume atlas budget (512 MB).
 * The per-axis clamp alone still allows a multi-GB texture (e.g. 1024²·512 =
 * 2.15 GB), which `createTexture` would reject — this bounds total memory.
 */
const DEFAULT_MAX_VOLUME_BYTES = 512 * 1024 * 1024;
/** Bytes per label voxel (r32uint). */
const LABEL_VOLUME_BYTES_PER_VOXEL = 4;

/**
 * Overlay opacity a label falls back to when no per-label setting applies — on
 * open (before the user touches a slider) and for snapshots that predate the
 * per-label controls. Matches the Rust `LabelSettings` default so fetch, render,
 * and the layer panel agree on the same starting opacity.
 */
export const DEFAULT_LABEL_OPACITY = 0.5;

function grid1D(dim: number, chunk: number): number {
  return chunk > 0 ? Math.ceil(dim / chunk) : 1;
}

/** Clamp a per-label opacity into `[0, 1]`, falling back to the default for a
 *  missing / non-finite value (a defensive guard on settings from the wire). */
function normalizeLabelOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return DEFAULT_LABEL_OPACITY;
  return Math.min(1, Math.max(0, opacity));
}

/**
 * Choose the finest label level that fits the mode's caps, walking
 * finest→coarsest and taking the first that satisfies ALL of them.
 *
 * SLICE mode bounds the 2D footprint (`maxLevelDim`) and per-plane chunk grid
 * (`maxChunksPerPlane`) — Z is irrelevant (one plane is drawn). VOLUME mode
 * bounds every axis incl. Z (`maxLevelDim3D`, the 3D texture limit), the TOTAL
 * 3D chunk count (`maxChunksPerVolume`, since every z-chunk is fetched), AND
 * the total texture bytes (`maxVolumeBytes`) — the monolithic 3D texture is
 * cubic in memory. Returns `-1` when NO level fits (e.g. a whole-slide label,
 * or a 3D label whose Z is never downsampled below the limit) — the caller
 * skips it, and the layer panel omits its controls in that mode: a clean
 * "nothing" beats a silently truncated/stretched overlay or a live-looking
 * toggle that draws nothing. No unconditional coarsest fallback.
 */
function chooseLabelLevel(levels: LevelGeometry[], caps: ResolvedLabelCaps): number {
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const w = lvl.shape[Axis.X];
    const h = lvl.shape[Axis.Y];
    if (!(w > 0) || !(h > 0)) continue;
    if (caps.mode === "volume") {
      const d = lvl.shape[Axis.Z];
      if (!(d > 0)) continue;
      const gz = grid1D(d, lvl.chunk_shape[Axis.Z]);
      const gy = grid1D(h, lvl.chunk_shape[Axis.Y]);
      const gx = grid1D(w, lvl.chunk_shape[Axis.X]);
      const fitsDims =
        w <= caps.maxLevelDim3D && h <= caps.maxLevelDim3D && d <= caps.maxLevelDim3D;
      const fitsChunks = gz * gy * gx <= caps.maxChunksPerVolume;
      const fitsBytes = w * h * d * LABEL_VOLUME_BYTES_PER_VOXEL <= caps.maxVolumeBytes;
      if (fitsDims && fitsChunks && fitsBytes) return i;
    } else {
      const gx = grid1D(w, lvl.chunk_shape[Axis.X]);
      const gy = grid1D(h, lvl.chunk_shape[Axis.Y]);
      if (w <= caps.maxLevelDim && h <= caps.maxLevelDim && gx * gy <= caps.maxChunksPerPlane) {
        return i;
      }
    }
  }
  return -1;
}

/** Warn once per non-uint32 label so the console isn't spammed each tick. */
const warnedNonUint32 = new Set<string>();

export interface LabelSelectionCaps {
  /**
   * View mode. `"slice"` (default) bounds the chosen level per Z-plane (2D
   * texture limits); `"volume"` bounds the FULL 3D grid (3D texture limit +
   * total chunk count + byte budget), because volume mode fetches every
   * z-chunk. Fetch and render must pass the SAME mode so they agree on the
   * eligible set (see {@link resolveVisibleLabels}).
   */
  mode?: "slice" | "volume";
  /** Slice-mode 2D dimension cap (default {@link DEFAULT_MAX_LEVEL_DIM}). */
  maxLevelDim?: number;
  /** Slice-mode per-plane chunk cap (default {@link DEFAULT_MAX_CHUNKS_PER_PLANE}). */
  maxChunksPerPlane?: number;
  /** Volume-mode per-axis dimension cap (default {@link DEFAULT_MAX_LEVEL_DIM_3D}). */
  maxLevelDim3D?: number;
  /** Volume-mode total chunk-count cap (default {@link DEFAULT_MAX_CHUNKS_PER_VOLUME}). */
  maxChunksPerVolume?: number;
  /** Volume-mode texture byte budget (default {@link DEFAULT_MAX_VOLUME_BYTES}). */
  maxVolumeBytes?: number;
}

/** All label-selection caps with defaults applied — the shape threaded to
 *  {@link chooseLabelLevel} / {@link eligibleLabel}. */
interface ResolvedLabelCaps {
  mode: "slice" | "volume";
  maxLevelDim: number;
  maxChunksPerPlane: number;
  maxLevelDim3D: number;
  maxChunksPerVolume: number;
  maxVolumeBytes: number;
}

function resolveLabelCaps(caps?: LabelSelectionCaps): ResolvedLabelCaps {
  return {
    mode: caps?.mode ?? "slice",
    maxLevelDim: caps?.maxLevelDim ?? DEFAULT_MAX_LEVEL_DIM,
    maxChunksPerPlane: caps?.maxChunksPerPlane ?? DEFAULT_MAX_CHUNKS_PER_PLANE,
    maxLevelDim3D: caps?.maxLevelDim3D ?? DEFAULT_MAX_LEVEL_DIM_3D,
    maxChunksPerVolume: caps?.maxChunksPerVolume ?? DEFAULT_MAX_CHUNKS_PER_VOLUME,
    maxVolumeBytes: caps?.maxVolumeBytes ?? DEFAULT_MAX_VOLUME_BYTES,
  };
}

/** A single label resolved to fetch + render, with its source + chosen level. */
export interface ResolvedLabel {
  label: LabelSpec;
  source: ImageSpec;
  /** Chosen multiscale level index (from {@link chooseLabelLevel}). */
  levelIdx: number;
}

/** A resolved label paired with its user-controlled overlay opacity, plus the
 *  identity fields ({@link ResolvedLabel} extras) the fetch + render paths use.
 *  One is emitted per VISIBLE + eligible label by {@link resolveVisibleLabels}. */
export interface ResolvedVisibleLabel extends ResolvedLabel {
  /** Label-group name (from the manifest), for UI/debug. */
  name: string;
  /** The intensity image id this label overlays. */
  sourceImageId: string;
  /** The overlay opacity to composite this label at (per-label setting, or the
   *  default when none applies). */
  opacity: number;
}

/** Per-label visibility + opacity, mirroring `lucida_core::scene::LabelSettings`
 *  (the `dataset_settings.label_settings` entries surfaced from the scene).
 *  Entries are POSITIONAL against the live manifest's label order — in-session
 *  the scene seeds one entry per label — so fetch/render resolve by index; the
 *  optional `name` (the label's manifest name, seeded scene-side) is the stable
 *  key saved views use to survive a label-list change and is not consulted
 *  here. */
export interface LabelViewSetting {
  visible: boolean;
  opacity: number;
  name?: string;
}

/**
 * Whether a label is drawable and, if so, its resolved source + chosen level.
 *
 * A label is eligible only if it: is a uint32 mask (the only dtype the label
 * pool handles today — uint8/uint16 are skipped with a one-time warning until a
 * widening path exists), has a resolvable source image, has a positive
 * footprint, AND has at least one multiscale level within the mode's
 * device/budget caps (see {@link chooseLabelLevel}). The caps are recomputed
 * per mode against that mode's OWN limits — neither cap set subsumes the
 * other: a deep label can be slice-eligible but volume-ineligible (the 3D
 * per-axis/byte caps), while a label whose per-plane chunk grid busts the
 * slice cap can still fit the volume totals. Returns `null` when the label
 * does not qualify.
 */
function eligibleLabel(
  manifest: DatasetManifest,
  label: LabelSpec,
  caps: ResolvedLabelCaps,
): { source: ImageSpec; levelIdx: number } | null {
  if (!isUint32(label.image.multiscale.data_type)) {
    if (!warnedNonUint32.has(label.image.image_id)) {
      warnedNonUint32.add(label.image.image_id);
      console.warn(
        `[labels] skipping "${label.name}" (${label.image.image_id}): ` +
        `dtype ${label.image.multiscale.data_type} not yet supported (uint32 only)`,
      );
    }
    return null;
  }
  const source = manifest.images.find((img) => img.image_id === label.source_image_id);
  if (!source) return null;
  const source0 = source.multiscale.levels[0];
  const label0 = label.image.multiscale.levels[0];
  if (!source0 || !label0) return null;
  const { dataW, dataH } = labelFootprint(
    { shape: source0.shape, scale: source0.scale },
    { shape: label0.shape, scale: label0.scale },
  );
  if (!(dataW > 0) || !(dataH > 0)) return null;
  const levelIdx = chooseLabelLevel(label.image.multiscale.levels, caps);
  if (levelIdx < 0) return null; // no level fits the mode's device/budget caps
  return { source, levelIdx };
}

/** A drawable label with its full display resolution: the manifest index the
 *  positional per-label settings/commands key on, whether it currently draws,
 *  and everything a drawn label carries ({@link ResolvedVisibleLabel}). */
export interface LabelDisplayState extends ResolvedVisibleLabel {
  /** Index into `manifest.labels` — the key the per-label commands + settings
   *  are positional on, so a control targets the right label even when earlier
   *  (ineligible) labels are omitted. */
  index: number;
  /** Whether this label is drawn under the given settings — the SAME predicate
   *  fetch and render apply, so a panel row built from this never lies. */
  visible: boolean;
}

/**
 * Resolve every DRAWABLE (eligible) label of a dataset to its display state —
 * the single place the "which labels can draw, which ARE drawn, at what
 * opacity" rules live. The fetch path ({@link computeLabelChunkRequests}), both
 * render paths (`pushLabelLayers` / `pushLabelVolumeLayers`, via
 * {@link resolveVisibleLabels}) and the layer panel (`buildLayerInfos`) all
 * derive from this one resolution, so the panel's toggle state and the drawn
 * set can never disagree for the same manifest/settings/mode.
 *
 * Eligibility is MODE-dependent (see {@link eligibleLabel} — it is recomputed
 * per mode against that mode's own caps, and neither mode's eligible set
 * contains the other's); an ineligible label gets NO entry and, deliberately,
 * no say in visibility:
 *
 * - With `labelSettings` present, an eligible label is visible iff its
 *   positional entry is `visible`; a missing entry (settings shorter than the
 *   label list — a stale/short snapshot) counts as HIDDEN.
 * - A `visible` flag on an INELIGIBLE label is inert: it neither draws (it
 *   can't) nor forces some other label on in its place. Only drawable labels
 *   get panel controls, so an overlay driven by an undrawable label's flag
 *   would be one the user has no toggle to clear; and eligibility varies by
 *   mode, so such a flag would also switch other labels on across a 2D↔3D
 *   change the user never asked for. (The scene-side seed skips labels it can
 *   tell are undrawable, but device/caps eligibility is not knowable there,
 *   and restored/older settings can carry any flags — so a visible flag CAN
 *   sit on a render-ineligible label; it must stay inert here.)
 * - With NO settings at all (a snapshot that predates the per-label controls),
 *   the default is the FIRST eligible label only, at
 *   {@link DEFAULT_LABEL_OPACITY}, so a labeled dataset doesn't open blank and
 *   behavior is unchanged until the user interacts.
 */
export function resolveLabelDisplayStates(
  manifest: DatasetManifest,
  labelSettings: LabelViewSetting[] | undefined,
  caps?: LabelSelectionCaps,
): LabelDisplayState[] {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return [];
  const resolvedCaps = resolveLabelCaps(caps);
  const hasSettings = labelSettings !== undefined && labelSettings.length > 0;

  const out: LabelDisplayState[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const elig = eligibleLabel(manifest, label, resolvedCaps);
    if (!elig) continue;

    let visible: boolean;
    let opacity: number;
    if (hasSettings) {
      const setting = labelSettings[i];
      visible = setting?.visible ?? false;
      opacity = normalizeLabelOpacity(setting?.opacity);
    } else {
      // No settings at all: pre-controls default — only the first eligible.
      visible = out.length === 0;
      opacity = DEFAULT_LABEL_OPACITY;
    }
    out.push({
      index: i,
      label,
      source: elig.source,
      levelIdx: elig.levelIdx,
      name: label.name,
      sourceImageId: label.source_image_id,
      visible,
      opacity,
    });
  }
  return out;
}

/**
 * The labels a dataset draws: every label that is visible AND eligible per
 * {@link resolveLabelDisplayStates} (which holds the full rules — per-label
 * settings, the no-settings first-eligible default, and why an undrawable
 * label's visible flag is inert), in manifest (OME `labels`) order, each
 * carrying its per-label overlay opacity. Shared by the fetch path
 * ({@link computeLabelChunkRequests}) and the render paths (`pushLabelLayers`,
 * `pushLabelVolumeLayers`), so they never disagree (which would fetch one
 * label but draw a different — blank — one). Callers must pass the same
 * `caps.mode` as the active view: eligibility is mode-dependent, and the layer
 * panel resolves its rows for the active mode too, so hiding every panel row
 * always empties this set.
 */
export function resolveVisibleLabels(
  manifest: DatasetManifest,
  labelSettings: LabelViewSetting[] | undefined,
  caps?: LabelSelectionCaps,
): ResolvedVisibleLabel[] {
  return resolveLabelDisplayStates(manifest, labelSettings, caps).filter((s) => s.visible);
}

export interface LabelRequestArgs {
  datasetId: string;
  manifest: DatasetManifest;
  /** Current timepoint. */
  t: number;
  /** Current source full-resolution Z (the 2D slice being viewed). */
  z: number;
  /**
   * Per-label visibility/opacity from the dataset's display settings
   * (`dataset_settings.label_settings`). Undefined/empty falls back to the
   * single default label (see {@link resolveVisibleLabels}), so fetch keeps
   * pace with what render draws — a hidden label is neither fetched nor drawn.
   */
  labelSettings?: LabelViewSetting[];
  maxLevelDim?: number;
  maxChunksPerPlane?: number;
  /**
   * View mode the fetch is serving. `"slice"` (default) requests only the
   * single mapped Z-plane of the current (t, z) 2D view. `"volume"` requests
   * EVERY z-chunk (the full label volume) of each chosen level, because the
   * 3D first-hit surface can stop at a non-zero voxel anywhere along a ray's
   * depth — a single plane would leave most of the surface unfetched. The
   * chosen level and (visible + eligible) set are identical across modes.
   */
  mode?: "slice" | "volume";
}

/**
 * Emit chunk requests for the dataset's VISIBLE labels (see
 * {@link resolveVisibleLabels}). In the default `slice` mode this is every
 * (y, x) chunk of each chosen level's mapped Z/T-plane for the current (t, z)
 * 2D view; in `volume` mode it is every (z, y, x) chunk of the chosen level —
 * the full label volume the 3D first-hit surface needs. Only visible+eligible
 * labels are fetched, so fetch and render always agree on the same set and the
 * fetch never fans out across hidden or ineligible labels. Returns `[]` when
 * no label qualifies.
 */
export function computeLabelChunkRequests(args: LabelRequestArgs): ChunkRequest[] {
  const resolvedList = resolveVisibleLabels(args.manifest, args.labelSettings, {
    mode: args.mode,
    maxLevelDim: args.maxLevelDim,
    maxChunksPerPlane: args.maxChunksPerPlane,
  });
  if (resolvedList.length === 0) return [];

  const requests: ChunkRequest[] = [];
  for (const resolved of resolvedList) {
    appendLabelChunkRequests(requests, resolved, args);
  }
  return requests;
}

/**
 * Append the chunk requests for a single resolved label at the current
 * (t, z) view into `requests`. The mapping from the source view's (t, z) to
 * the label's own axes/level is per-label (labels carry their own geometry),
 * so this is applied once per visible label.
 *
 * In `slice` mode this emits the (y, x) chunks of the ONE mapped Z-plane; in
 * `volume` mode it emits every (z, y, x) chunk of the chosen level — the full
 * label volume the 3D first-hit surface needs.
 */
function appendLabelChunkRequests(
  requests: ChunkRequest[],
  resolved: ResolvedLabel,
  args: LabelRequestArgs,
): void {
  const { label, source, levelIdx } = resolved;
  const labelLevels = label.image.multiscale.levels;
  const source0 = source.multiscale.levels[0];
  const label0 = labelLevels[0];
  const lvl = labelLevels[levelIdx];

  const src0: { shape: number[]; scale: number[] } = { shape: source0.shape, scale: source0.scale };
  const lbl0: { shape: number[]; scale: number[] } = { shape: label0.shape, scale: label0.scale };

  // Map source t to the label's own t (a T=1 label stays at t=0 for every
  // source timepoint) so scrubbing time never 404s the overlay away.
  const labelT = labelTimeIndex(args.t, src0, lbl0);
  const chunkT = lvl.chunk_shape[Axis.T] || 1;
  const targetChunkT = Math.floor(labelT / chunkT);

  const gy = grid1D(lvl.shape[Axis.Y], lvl.chunk_shape[Axis.Y]);
  const gx = grid1D(lvl.shape[Axis.X], lvl.chunk_shape[Axis.X]);
  const c = 0; // labels carry no channel dimension

  const pushChunk = (z: number, y: number, x: number): void => {
    requests.push({
      datasetId: args.datasetId,
      // Route + scope under the label's own image id (distinct from any
      // intensity entity), so label fetches never perturb image eviction.
      entityId: label.image.image_id,
      imageId: label.image.image_id,
      level: levelIdx,
      t: targetChunkT,
      c,
      z,
      y,
      x,
      lane: "detail",
      tier: "detail",
      priority: 0,
      chunkKey: `${levelIdx}/${targetChunkT}/${c}/${z}/${y}/${x}`,
    });
  };

  if ((args.mode ?? "slice") === "volume") {
    // Volume: every z-chunk of the chosen level (the full label volume).
    const gz = grid1D(lvl.shape[Axis.Z], lvl.chunk_shape[Axis.Z]);
    for (let z = 0; z < gz; z++) {
      for (let y = 0; y < gy; y++) {
        for (let x = 0; x < gx; x++) {
          pushChunk(z, y, x);
        }
      }
    }
    return;
  }

  // Slice: the single Z-plane the current view needs. Map the source Z to
  // the label's own full-res Z, then to this level's chunk grid — via the
  // SAME helper the delivery gate uses, so fetch and delivery always agree
  // on which z-chunk holds the view's plane.
  const { chunkZ: targetChunkZ } = labelLevelZTarget(args.z, src0, lbl0, lvl);

  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      pushChunk(targetChunkZ, y, x);
    }
  }
}
