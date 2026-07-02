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
import { labelDepthZ, labelFootprint, labelTimeIndex } from "../../renderer/labelLayout.ts";
import { isUint32 } from "../../renderer/dataTypeUtil.ts";
import type {
  DatasetManifest,
  ImageSpec,
  LabelSpec,
  LevelGeometry,
} from "../../manifestTypes.ts";
import type { ChunkRequest } from "./types.ts";

/** Cap on the chosen level's per-plane chunk count (bounds fetch + texture). */
const DEFAULT_MAX_CHUNKS_PER_PLANE = 64;
/**
 * Cap on a level's 2D dimensions. The label renders from a single-tile
 * texture at these dims, so it must fit the smallest guaranteed WebGPU 2D
 * texture limit (`maxTextureDimension2D` ≥ 8192); kept well under to bound
 * memory (a `4096²` r32uint tile is 64 MB).
 */
const DEFAULT_MAX_LEVEL_DIM = 4096;

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
 * Choose the finest label level whose full 2D footprint fits `maxDim` AND
 * whose per-plane chunk grid fits `maxChunks`. Finer levels have larger
 * dims + more chunks, so this walks finest→coarsest and takes the first
 * that satisfies both. Returns `-1` when NO level fits (e.g. a huge single-
 * scale / whole-slide label with no usable pyramid level) — the caller
 * skips such a label rather than emitting thousands of requests or creating
 * an over-limit texture. Unlike the prior version, there is no unconditional
 * coarsest-level fallback that could still exceed the caps.
 */
function chooseLabelLevel(
  levels: LevelGeometry[],
  maxDim: number,
  maxChunks: number,
): number {
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const w = lvl.shape[Axis.X];
    const h = lvl.shape[Axis.Y];
    if (!(w > 0) || !(h > 0)) continue;
    const gx = grid1D(w, lvl.chunk_shape[Axis.X]);
    const gy = grid1D(h, lvl.chunk_shape[Axis.Y]);
    if (w <= maxDim && h <= maxDim && gx * gy <= maxChunks) return i;
  }
  return -1;
}

/** Warn once per non-uint32 label so the console isn't spammed each tick. */
const warnedNonUint32 = new Set<string>();

export interface LabelSelectionCaps {
  maxLevelDim?: number;
  maxChunksPerPlane?: number;
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
 *  (the `dataset_settings.label_settings` entries surfaced from the scene). */
export interface LabelViewSetting {
  visible: boolean;
  opacity: number;
}

/**
 * Whether a label is drawable and, if so, its resolved source + chosen level.
 *
 * A label is eligible only if it: is a uint32 mask (the only dtype the label
 * pool handles today — uint8/uint16 are skipped with a one-time warning until a
 * widening path exists), has a resolvable source image, has a positive
 * footprint, AND has at least one multiscale level within the device/budget
 * caps. Returns `null` when the label does not qualify.
 */
function eligibleLabel(
  manifest: DatasetManifest,
  label: LabelSpec,
  maxDim: number,
  maxChunks: number,
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
  const levelIdx = chooseLabelLevel(label.image.multiscale.levels, maxDim, maxChunks);
  if (levelIdx < 0) return null; // no level fits the device/budget caps
  return { source, levelIdx };
}

/**
 * The labels a dataset draws, resolved by a single criterion shared by the
 * fetch path ({@link computeLabelChunkRequests}) and the render path
 * (`pushLabelLayers`), so they never disagree (which would fetch one label but
 * draw a different — blank — one). Returns one entry per label that is VISIBLE
 * (per `labelSettings`) AND eligible (see {@link eligibleLabel}), in manifest
 * (OME `labels`) order, each carrying its per-label overlay opacity.
 *
 * When `labelSettings` is undefined/empty — a snapshot that predates the
 * per-label controls — this falls back to the pre-controls default: the FIRST
 * eligible label only, at {@link DEFAULT_LABEL_OPACITY}, so behavior is
 * unchanged until the user interacts. With settings present, a label is shown
 * iff its entry is `visible` AND it is eligible; a missing entry (settings
 * shorter than the label list — a stale/short snapshot) counts as HIDDEN. This
 * is the SAME rule the layer panel uses (see `buildLayerInfos`), so the panel's
 * toggle state and the drawn set never diverge.
 *
 * Blank-open guard: if settings mark SOME label visible but none of the
 * visible-marked labels are drawable (e.g. the seed picked a uint32 label that
 * fails a render-only footprint/level check, or — defensively — a non-uint32
 * one), yet a drawable label exists, this falls back to the first eligible label
 * (like the empty-settings default) so the dataset never opens blank while it
 * has something to draw. It does NOT fire when the user has hidden EVERY label
 * (nothing marked visible), so an explicit "hide all" is honored.
 */
export function resolveVisibleLabels(
  manifest: DatasetManifest,
  labelSettings: LabelViewSetting[] | undefined,
  caps?: LabelSelectionCaps,
): ResolvedVisibleLabel[] {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return [];
  const maxDim = caps?.maxLevelDim ?? DEFAULT_MAX_LEVEL_DIM;
  const maxChunks = caps?.maxChunksPerPlane ?? DEFAULT_MAX_CHUNKS_PER_PLANE;

  const hasSettings = labelSettings !== undefined && labelSettings.length > 0;

  const out: ResolvedVisibleLabel[] = [];
  let firstEligible: ResolvedVisibleLabel | null = null;
  // Whether the settings mark ANY label visible — including an INELIGIBLE one
  // (a visible-but-undrawable label is exactly the blank-open case the fallback
  // below repairs). Distinguishes "the seed/settings wanted something shown" from
  // "the user hid everything".
  let anyMarkedVisible = false;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (hasSettings && labelSettings[i]?.visible === true) anyMarkedVisible = true;

    const elig = eligibleLabel(manifest, label, maxDim, maxChunks);
    if (!elig) continue;
    const isFirstEligible = firstEligible === null;

    let visible: boolean;
    let opacity: number;
    if (hasSettings) {
      const setting = labelSettings[i];
      visible = setting?.visible ?? false;
      opacity = normalizeLabelOpacity(setting?.opacity);
    } else {
      // No settings at all: pre-controls default — only the first eligible.
      visible = isFirstEligible;
      opacity = DEFAULT_LABEL_OPACITY;
    }
    const resolved: ResolvedVisibleLabel = {
      label,
      source: elig.source,
      levelIdx: elig.levelIdx,
      name: label.name,
      sourceImageId: label.source_image_id,
      opacity,
    };
    if (isFirstEligible) firstEligible = resolved;
    if (visible) out.push(resolved);
  }

  // Blank-open guard (see the doc): settings wanted something shown, but nothing
  // visible-marked is drawable, while a drawable label exists → show the first
  // eligible one. Never overrides an explicit "hide all".
  if (out.length === 0 && hasSettings && anyMarkedVisible && firstEligible !== null) {
    return [firstEligible];
  }
  return out;
}

/** A DRAWABLE (eligible) label: its manifest index + name. */
export interface EligibleLabelInfo {
  /** Index into `manifest.labels` — the key the per-label commands + settings
   *  are positional on, so a control targets the right label even when earlier
   *  (ineligible) labels are omitted from the panel. */
  index: number;
  name: string;
}

/**
 * Every DRAWABLE (eligible) label — its manifest index + name — regardless of
 * visibility. This is the set the Labels panel should offer controls for, so a
 * control never lies about a label that can't render (a uint8/uint16 mask, an
 * orphan with no source, or one with no level within the caps is omitted).
 * Uses the SAME {@link eligibleLabel} criterion as the fetch + render paths, so
 * the panel only exposes labels those paths can actually draw.
 */
export function eligibleLabelInfos(
  manifest: DatasetManifest,
  caps?: LabelSelectionCaps,
): EligibleLabelInfo[] {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return [];
  const maxDim = caps?.maxLevelDim ?? DEFAULT_MAX_LEVEL_DIM;
  const maxChunks = caps?.maxChunksPerPlane ?? DEFAULT_MAX_CHUNKS_PER_PLANE;
  const out: EligibleLabelInfo[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (eligibleLabel(manifest, labels[i], maxDim, maxChunks)) {
      out.push({ index: i, name: labels[i].name });
    }
  }
  return out;
}

/**
 * The ONE label a dataset shows by default (the first eligible, at the default
 * opacity). A thin wrapper over {@link resolveVisibleLabels} with no settings —
 * kept for callers/paths that only need the single default label. Returns
 * `null` when none qualifies.
 */
export function resolveDefaultLabel(
  manifest: DatasetManifest,
  caps?: LabelSelectionCaps,
): ResolvedLabel | null {
  return resolveVisibleLabels(manifest, undefined, caps)[0] ?? null;
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
}

/**
 * Emit chunk requests for the dataset's VISIBLE labels (see
 * {@link resolveVisibleLabels}), for the current (t, z) 2D view — every
 * (y, x) chunk of each chosen level's mapped Z/T-plane. Only visible+eligible
 * labels are fetched, so fetch and render always agree on the same set and the
 * fetch never fans out across hidden or ineligible labels. Returns `[]` when
 * no label qualifies.
 */
export function computeLabelChunkRequests(args: LabelRequestArgs): ChunkRequest[] {
  const resolvedList = resolveVisibleLabels(args.manifest, args.labelSettings, {
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
 * Append the (y, x) plane chunk requests for a single resolved label at the
 * current (t, z) view into `requests`. The mapping from the source view's
 * (t, z) to the label's own axes/level is per-label (labels carry their own
 * geometry), so this is applied once per visible label.
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

  // Map the source Z to the label's own full-res Z, then to this level.
  const labelFullResZ = labelDepthZ(args.z, src0, lbl0);
  const label0Depth = label0.shape[Axis.Z];
  const levelDepth = lvl.shape[Axis.Z];
  const levelZ = Math.min(
    Math.floor(
      (labelFullResZ / Math.max(label0Depth - 1, 1)) * Math.max(levelDepth - 1, 1),
    ),
    Math.max(levelDepth - 1, 0),
  );
  const chunkZ = lvl.chunk_shape[Axis.Z] || 1;
  const targetChunkZ = Math.floor(levelZ / chunkZ);

  // Map source t to the label's own t (a T=1 label stays at t=0 for every
  // source timepoint) so scrubbing time never 404s the overlay away.
  const labelT = labelTimeIndex(args.t, src0, lbl0);
  const chunkT = lvl.chunk_shape[Axis.T] || 1;
  const targetChunkT = Math.floor(labelT / chunkT);

  const gy = grid1D(lvl.shape[Axis.Y], lvl.chunk_shape[Axis.Y]);
  const gx = grid1D(lvl.shape[Axis.X], lvl.chunk_shape[Axis.X]);
  const c = 0; // labels carry no channel dimension

  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      const chunkKey = `${levelIdx}/${targetChunkT}/${c}/${targetChunkZ}/${y}/${x}`;
      requests.push({
        datasetId: args.datasetId,
        // Route + scope under the label's own image id (distinct from any
        // intensity entity), so label fetches never perturb image eviction.
        entityId: label.image.image_id,
        imageId: label.image.image_id,
        level: levelIdx,
        t: targetChunkT,
        c,
        z: targetChunkZ,
        y,
        x,
        lane: "detail",
        tier: "detail",
        priority: 0,
        chunkKey,
      });
    }
  }
}
