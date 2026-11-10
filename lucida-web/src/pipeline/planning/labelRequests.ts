/**
 * Chunk requests for label overlays. The WASM planner never sees labels
 * (they are kept out of `manifest.images`/`entities`), so label chunks are
 * requested here from the label's own multiscale geometry and merged into
 * the fetch plan. A label draws from one pool covering its full 2D footprint
 * at one level, so slice mode requests every (y, x) chunk of the chosen
 * level's plane. Picking a level whose grid fits a small chunk budget keeps
 * that to a handful.
 */

import { Axis } from "../../axes.ts";
import { labelFootprint, labelLevelZ, labelTimeIndex } from "../../renderer/labelLayout.ts";
import { labelPaddedVolumeBytes } from "../../renderer/volume/atlas.ts";
import { isUint32 } from "../../renderer/dataTypeUtil.ts";
import { pageDeviceBudgets } from "../../deviceBudget.ts";
import type {
  DatasetManifest,
  ImageSpec,
  LabelSpec,
  LevelGeometry,
} from "../../manifestTypes.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import { slicePlaneIn, type PlaneInChunks } from "./emit.ts";
import type { SpatialAxis } from "../../renderer/slicePlane.ts";
import type { ChunkRequest } from "./types.ts";

/** Cap on the chosen level's per-plane chunk count in slice mode. */
const DEFAULT_MAX_CHUNKS_PER_PLANE = 64;
/**
 * Cap on a level's 2D dimensions in slice mode. The overlay renders from a
 * single-tile texture at these dims, so it must fit WebGPU's guaranteed
 * `maxTextureDimension2D` (8192). Kept well under to bound memory: a `4096²`
 * r32uint tile is 64 MB.
 */
const DEFAULT_MAX_LEVEL_DIM = 4096;

/**
 * Cap on a level's total 3D chunk count (`gz·gy·gx`) in volume mode. Volume
 * mode fetches every z-chunk, so a deep label or one with chunk-Z 1 would
 * otherwise fan out to tens of thousands of ~8 MB requests per tick.
 */
const DEFAULT_MAX_CHUNKS_PER_VOLUME = 512;
/**
 * Cap on one brick's dimension (`min(chunkAxis, extentAxis)` per axis) in
 * volume mode. Bricking frees the level extent from the 3D texture limit, but
 * each brick is one contiguous atlas region and must still fit it. 2048 is
 * WebGPU's guaranteed `maxTextureDimension3D`, so a level whose brick exceeds
 * it would make the atlas layout throw on the smallest conformant device and
 * is skipped for a coarser level.
 */
const DEFAULT_MAX_BRICK_DIM_3D = 2048;
/**
 * Byte budget for one label's bricked volume atlas (r32uint, 4 B/voxel),
 * matching the intensity volume atlas budget. Measured on the padded brick
 * footprint ({@link labelPaddedVolumeBytes}), not `w·h·d·4`, because an
 * awkward chunk shape can pad the allocation well past the true size.
 *
 * The total must be >= this so the first eligible mask always fits and 3D
 * never opens blank. {@link resolveLabelCaps} enforces the floor for
 * caller-supplied caps. Fitted to the device.
 */
const defaultMaxVolumeBytes = () => pageDeviceBudgets().labelVolumeBytes;
/**
 * Byte budget for the sum of all label volume atlases shown at once in volume
 * mode, on padded footprints. Each visible mask gets its own atlas, so the
 * per-mask cap alone does not bound device memory. Masks are shown in
 * manifest order until the budget is reached and the rest are skipped.
 */
const defaultMaxTotalVolumeBytes = () => pageDeviceBudgets().labelTotalVolumeBytes;

/**
 * Overlay opacity when no per-label setting applies, including snapshots
 * saved without per-label settings. Matches the Rust `LabelSettings` default
 * so fetch, render, and the layer panel agree.
 */
export const DEFAULT_LABEL_OPACITY = 0.5;

function grid1D(dim: number, chunk: number): number {
  return chunk > 0 ? Math.ceil(dim / chunk) : 1;
}

/** Clamp a per-label opacity into `[0, 1]`. Missing or non-finite values
 *  from the wire fall back to the default. */
function normalizeLabelOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return DEFAULT_LABEL_OPACITY;
  return Math.min(1, Math.max(0, opacity));
}

/**
 * Choose the finest label level that fits every cap of the mode, or `-1`
 * when none does. The caller then skips the label: drawing nothing beats a
 * truncated or blank overlay, so there is no forced coarsest fallback.
 *
 * Slice mode bounds the 2D footprint and per-plane chunk grid. Volume mode
 * bounds the per-brick dimension, the total chunk count, and the padded atlas
 * bytes, but not the level extent, because the bricked atlas tiles a level
 * across slots.
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
      // Brick cap first: a too-big brick makes the atlas layout throw, and the
      // byte math below packs the same brick.
      const brickX = Math.min(lvl.chunk_shape[Axis.X], w);
      const brickY = Math.min(lvl.chunk_shape[Axis.Y], h);
      const brickZ = Math.min(lvl.chunk_shape[Axis.Z], d);
      if (
        brickX > caps.maxBrickDim3D ||
        brickY > caps.maxBrickDim3D ||
        brickZ > caps.maxBrickDim3D
      ) {
        continue;
      }
      const gz = grid1D(d, lvl.chunk_shape[Axis.Z]);
      const gy = grid1D(h, lvl.chunk_shape[Axis.Y]);
      const gx = grid1D(w, lvl.chunk_shape[Axis.X]);
      if (gz * gy * gx > caps.maxChunksPerVolume) continue;
      const fitsBytes = labelPaddedVolumeBytes(lvl.shape, lvl.chunk_shape) <= caps.maxVolumeBytes;
      if (fitsBytes) return i;
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

/** Warn once per label whose volume is dropped by the 3D total-memory budget,
 *  so the console isn't spammed each tick. */
const warnedVolumeBudgetSkipped = new Set<string>();

/** Clear the warn-once sets so tests can assert warnings. Test-only. */
export function __resetLabelWarningsForTest(): void {
  warnedNonUint32.clear();
  warnedVolumeBudgetSkipped.clear();
}

export interface LabelSelectionCaps {
  /**
   * `"slice"` (default) bounds the level per Z-plane; `"volume"` bounds the
   * full 3D grid, because volume mode fetches every z-chunk. Fetch and render
   * must pass the same mode so they agree on the eligible set.
   */
  mode?: "slice" | "volume";
  /** Slice-mode 2D dimension cap (default {@link DEFAULT_MAX_LEVEL_DIM}). */
  maxLevelDim?: number;
  /** Slice-mode per-plane chunk cap (default {@link DEFAULT_MAX_CHUNKS_PER_PLANE}). */
  maxChunksPerPlane?: number;
  /** Volume-mode per-brick dimension cap (default {@link DEFAULT_MAX_BRICK_DIM_3D}). */
  maxBrickDim3D?: number;
  /** Volume-mode total chunk-count cap (default {@link DEFAULT_MAX_CHUNKS_PER_VOLUME}). */
  maxChunksPerVolume?: number;
  /** Volume-mode atlas-allocation byte budget (default from the device budgets). */
  maxVolumeBytes?: number;
  /**
   * Volume-mode byte budget across every mask shown at once (default
   * from the device budgets). {@link resolveLabelCaps} raises
   * it to at least {@link maxVolumeBytes} so the first drawable mask fits.
   */
  maxTotalVolumeBytes?: number;
}

/** Label-selection caps with defaults applied. */
interface ResolvedLabelCaps {
  mode: "slice" | "volume";
  maxLevelDim: number;
  maxChunksPerPlane: number;
  maxBrickDim3D: number;
  maxChunksPerVolume: number;
  maxVolumeBytes: number;
  maxTotalVolumeBytes: number;
}

function resolveLabelCaps(caps?: LabelSelectionCaps): ResolvedLabelCaps {
  const maxVolumeBytes = caps?.maxVolumeBytes ?? defaultMaxVolumeBytes();
  const rawTotal = caps?.maxTotalVolumeBytes ?? defaultMaxTotalVolumeBytes();
  // Floor the total at the per-texture cap, or a drawable mask could resolve
  // to nothing and 3D would open blank.
  const maxTotalVolumeBytes = Math.max(rawTotal, maxVolumeBytes);
  return {
    mode: caps?.mode ?? "slice",
    maxLevelDim: caps?.maxLevelDim ?? DEFAULT_MAX_LEVEL_DIM,
    maxChunksPerPlane: caps?.maxChunksPerPlane ?? DEFAULT_MAX_CHUNKS_PER_PLANE,
    maxBrickDim3D: caps?.maxBrickDim3D ?? DEFAULT_MAX_BRICK_DIM_3D,
    maxChunksPerVolume: caps?.maxChunksPerVolume ?? DEFAULT_MAX_CHUNKS_PER_VOLUME,
    maxVolumeBytes,
    maxTotalVolumeBytes,
  };
}

/** A single label resolved to fetch + render, with its source + chosen level. */
export interface ResolvedLabel {
  label: LabelSpec;
  source: ImageSpec;
  /** Chosen multiscale level index (from {@link chooseLabelLevel}). */
  levelIdx: number;
}

/** A resolved label with its overlay opacity. {@link resolveVisibleLabels}
 *  emits one per visible, eligible label. */
export interface ResolvedVisibleLabel extends ResolvedLabel {
  /** Label-group name (from the manifest), for UI/debug. */
  name: string;
  /** The intensity image id this label overlays. */
  sourceImageId: string;
  opacity: number;
}

/** Per-label visibility + opacity, mirroring `lucida_core::scene::LabelSettings`
 *  (the `dataset_settings.label_settings` entries surfaced from the scene). */
export interface LabelViewSetting {
  visible: boolean;
  opacity: number;
}

/**
 * A label's source and chosen level if it is drawable, else `null`. Eligible
 * means a uint32 mask (the only dtype the label pool handles; others warn
 * once), a resolvable source image, a positive footprint, and a level within
 * the mode's caps. Volume caps are stricter, so a label can be eligible in
 * slice mode and not in volume mode.
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

/**
 * Device memory one label's level takes in volume mode: the padded brick
 * footprint, not `X·Y·Z·4`, so the total budget counts what the atlas
 * actually allocates.
 */
function labelVolumeBytes(level: LevelGeometry): number {
  return labelPaddedVolumeBytes(level.shape, level.chunk_shape);
}

/**
 * The manifest-order prefix of `candidateIndices` (visible, volume-eligible
 * labels) that fits the total label-volume budget. It stops at the first mask
 * that would exceed the budget and drops every mask after it, never packing a
 * smaller later one in. Shared by {@link resolveVisibleLabels} and the layer
 * panel so both agree on the exact 3D set.
 */
export function volumeBudgetPrefix(
  manifest: DatasetManifest,
  candidateIndices: number[],
  caps?: LabelSelectionCaps,
): Set<number> {
  const resolvedCaps = resolveLabelCaps({ ...caps, mode: "volume" });
  const labels = manifest.labels ?? [];
  const kept = new Set<number>();
  let total = 0;
  for (const i of candidateIndices) {
    const label = labels[i];
    if (!label) continue;
    const elig = eligibleLabel(manifest, label, resolvedCaps);
    if (!elig) continue; // caller pre-filters to eligible; defensive
    const bytes = labelVolumeBytes(label.image.multiscale.levels[elig.levelIdx]);
    // Prefix stop: this mask and every one after it drop.
    if (total + bytes > resolvedCaps.maxTotalVolumeBytes) break;
    total += bytes;
    kept.add(i);
  }
  return kept;
}

/**
 * The labels a dataset draws: one entry per label that is visible in
 * `labelSettings` and eligible, in manifest order, with its opacity. Fetch
 * ({@link computeLabelChunkRequests}) and render (`pushLabelLayers`) share
 * it so they never fetch one label and draw another. A visible but
 * ineligible label gets no stand-in.
 *
 * Masks are opt-in: a missing entry, or no settings at all, means hidden.
 * The layer panel uses the same rule (`buildLayerInfos`). In volume mode the
 * set is then cut to the total memory budget ({@link volumeBudgetPrefix}).
 */
export function resolveVisibleLabels(
  manifest: DatasetManifest,
  labelSettings: LabelViewSetting[] | undefined,
  caps?: LabelSelectionCaps,
): ResolvedVisibleLabel[] {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return [];
  const resolvedCaps = resolveLabelCaps(caps);

  const hasSettings = labelSettings !== undefined && labelSettings.length > 0;

  // Visible + eligible labels in manifest order, each tagged with its manifest
  // index so the volume-memory budget can be applied by position.
  const candidates: { index: number; resolved: ResolvedVisibleLabel }[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const elig = eligibleLabel(manifest, label, resolvedCaps);
    if (!elig) continue;

    let visible: boolean;
    let opacity: number;
    if (hasSettings) {
      const setting = labelSettings[i];
      // Masks are opt-in: no explicit setting means hidden.
      visible = setting?.visible ?? false;
      opacity = normalizeLabelOpacity(setting?.opacity);
    } else {
      visible = false;
      opacity = DEFAULT_LABEL_OPACITY;
    }
    if (!visible) continue;
    candidates.push({
      index: i,
      resolved: {
        label,
        source: elig.source,
        levelIdx: elig.levelIdx,
        name: label.name,
        sourceImageId: label.source_image_id,
        opacity,
      },
    });
  }

  if (resolvedCaps.mode !== "volume") {
    return candidates.map((c) => c.resolved);
  }

  // 3D fail-safe: cap total volume-atlas memory so many masks cannot OOM.
  const kept = volumeBudgetPrefix(
    manifest,
    candidates.map((c) => c.index),
    resolvedCaps,
  );
  const out: ResolvedVisibleLabel[] = [];
  for (const c of candidates) {
    if (kept.has(c.index)) {
      out.push(c.resolved);
    } else {
      warnVolumeBudgetSkipped(manifest.labels?.[c.index]?.image.image_id, c.resolved.name);
    }
  }
  return out;
}

/** Emit a one-time console warning that a mask was dropped by the 3D total
 *  label-volume memory budget, keyed so it fires at most once per label. */
function warnVolumeBudgetSkipped(imageId: string | undefined, name: string): void {
  const key = imageId ?? name;
  if (warnedVolumeBudgetSkipped.has(key)) return;
  warnedVolumeBudgetSkipped.add(key);
  console.warn(
    `[labels] skipping "${name}" in 3D: total label-volume memory budget exceeded`,
  );
}

/** An eligible label's manifest index and name. */
export interface EligibleLabelInfo {
  /** Index into `manifest.labels`. Per-label commands and settings are
   *  positional, so a control must target this index even when earlier
   *  ineligible labels are omitted from the panel. */
  index: number;
  name: string;
}

/**
 * Every eligible label regardless of visibility: the set the Labels panel
 * offers controls for, so no control targets a label that cannot render.
 * Uses the same {@link eligibleLabel} test as fetch and render.
 */
export function eligibleLabelInfos(
  manifest: DatasetManifest,
  caps?: LabelSelectionCaps,
): EligibleLabelInfo[] {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return [];
  const resolvedCaps = resolveLabelCaps(caps);
  const out: EligibleLabelInfo[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (eligibleLabel(manifest, labels[i], resolvedCaps)) {
      out.push({ index: i, name: labels[i].name });
    }
  }
  return out;
}

/**
 * The first eligible label in manifest order, ignoring visibility. Masks are
 * hidden by default, so a visibility-based resolve would return nothing on a
 * fresh open. Returns `null` when none qualifies.
 */
export function resolveDefaultLabel(
  manifest: DatasetManifest,
  caps?: LabelSelectionCaps,
): ResolvedLabel | null {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return null;
  const resolvedCaps = resolveLabelCaps(caps);
  for (const label of labels) {
    const elig = eligibleLabel(manifest, label, resolvedCaps);
    if (elig) return { label, source: elig.source, levelIdx: elig.levelIdx };
  }
  return null;
}

export interface LabelRequestArgs {
  datasetId: string;
  manifest: DatasetManifest;
  t: number;
  /** Current source full-resolution Z (the 2D slice being viewed). */
  z: number;
  /**
   * Per-label visibility and opacity (`dataset_settings.label_settings`).
   * Masks are opt-in, so undefined or empty fetches nothing.
   */
  labelSettings?: LabelViewSetting[];
  maxLevelDim?: number;
  maxChunksPerPlane?: number;
  /**
   * `"slice"` (default) requests the one mapped Z-plane. `"volume"` requests
   * every z-chunk of each chosen level, because the 3D first-hit surface can
   * stop anywhere along a ray.
   */
  mode?: "slice" | "volume";
  /**
   * The planning knobs the slice view's planes follow: the band fetched
   * around the plane drawn, and the prefetch lane's priority. Defaults to
   * {@link DEFAULT_PLANNING_CONFIG}'s.
   */
  config?: Pick<PlanningConfig, "sliceBandPlanes" | "prefetchLaneOffset">;
  /**
   * Whether the selection stepped along Z since the previous plan
   * (`isCutStep`). The slice view then also prefetches whole each chunk whose
   * plane it draws, so the steps after it cost nothing.
   */
  cutStep?: boolean;
  /**
   * The axis the slice view cuts. A label overlay is drawn only on an XY
   * cut, so a side view fetches none. Absent: Z.
   */
  cutAxis?: SpatialAxis;
}

/**
 * Chunk requests for the dataset's visible labels ({@link resolveVisibleLabels}):
 * every (y, x) chunk of the mapped plane in slice mode, each asking for the
 * plane it draws and fetching a band around it as the image's detail chunks
 * do, and every (z, y, x) chunk of the chosen level, whole, in volume mode.
 */
export function computeLabelChunkRequests(args: LabelRequestArgs): ChunkRequest[] {
  if (args.mode !== "volume" && (args.cutAxis ?? "z") !== "z") return [];
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
 * The chunk a label draws from at source timepoint `t`: its chosen level, the
 * label's own chunk-T, and, given a source `z`, the plane slice mode draws
 * and the chunk-Z holding it. The mapping is per label because labels carry
 * their own geometry. Fetch and the failed-chunk marks share it, so both name
 * the same chunks.
 */
export function labelChunkAt(
  resolved: ResolvedLabel,
  t: number,
  z?: number,
): { level: number; t: number; z: number | null; plane: number | null } {
  const { label, source, levelIdx } = resolved;
  const labelLevels = label.image.multiscale.levels;
  const source0 = source.multiscale.levels[0];
  const label0 = labelLevels[0];
  const lvl = labelLevels[levelIdx];

  const src0: { shape: number[]; scale: number[] } = { shape: source0.shape, scale: source0.scale };
  const lbl0: { shape: number[]; scale: number[] } = { shape: label0.shape, scale: label0.scale };

  // Map source t to the label's own t (a T=1 label stays at t=0 for every
  // source timepoint) so scrubbing time never 404s the overlay away.
  const labelT = labelTimeIndex(t, src0, lbl0);
  const chunkT = lvl.chunk_shape[Axis.T] || 1;
  const targetChunkT = Math.floor(labelT / chunkT);
  if (z === undefined) return { level: levelIdx, t: targetChunkT, z: null, plane: null };

  const plane = labelLevelZ(z, src0, lbl0, lvl.shape[Axis.Z]);
  const chunkZ = lvl.chunk_shape[Axis.Z] || 1;
  return { level: levelIdx, t: targetChunkT, z: Math.floor(plane / chunkZ), plane };
}

/** Append one label's chunk requests to `requests`. */
function appendLabelChunkRequests(
  requests: ChunkRequest[],
  resolved: ResolvedLabel,
  args: LabelRequestArgs,
): void {
  const { label, levelIdx } = resolved;
  const lvl = label.image.multiscale.levels[levelIdx];
  const volume = (args.mode ?? "slice") === "volume";
  const at = labelChunkAt(resolved, args.t, volume ? undefined : args.z);
  const targetChunkT = at.t;

  const gy = grid1D(lvl.shape[Axis.Y], lvl.chunk_shape[Axis.Y]);
  const gx = grid1D(lvl.shape[Axis.X], lvl.chunk_shape[Axis.X]);
  const c = 0; // labels carry no channel dimension

  const pushChunk = (
    z: number,
    y: number,
    x: number,
    slice: PlaneInChunks | null = null,
    lane: "detail" | "prefetch" = "detail",
    priority = 0,
  ): void => {
    const req: ChunkRequest = {
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
      lane,
      tier: "detail",
      mode: volume ? "volume" : "slice",
      priority,
      chunkKey: `${levelIdx}/${targetChunkT}/${c}/${z}/${y}/${x}`,
    };
    if (slice) {
      req.plane = slice.plane;
      req.planes = slice.planes;
    }
    requests.push(req);
  };

  if (volume) {
    // Volume: every z-chunk of the chosen level.
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

  // Slice: the single Z-plane the current view needs, and the band around
  // it. A label's levels are all stored, never generated, so the server cuts
  // planes from any of its chunks. A level one plane deep, or one whose band
  // would cover the chunk, is fetched whole.
  const config = args.config ?? DEFAULT_PLANNING_CONFIG;
  const targetChunkZ = at.z ?? 0;
  const slice = at.plane === null
    ? null
    : slicePlaneIn(at.plane, lvl.shape[Axis.Z], lvl.chunk_shape[Axis.Z], config.sliceBandPlanes);
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      pushChunk(targetChunkZ, y, x, slice);
    }
  }
  // After a step along Z the chunks come whole as well, in the prefetch
  // lane, as the image's do.
  if (slice === null || !args.cutStep) return;
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      pushChunk(targetChunkZ, y, x, null, "prefetch", config.prefetchLaneOffset);
    }
  }
}
