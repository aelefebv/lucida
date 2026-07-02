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

function grid1D(dim: number, chunk: number): number {
  return chunk > 0 ? Math.ceil(dim / chunk) : 1;
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

/** The single label chosen to fetch + render, with its resolved source + level. */
export interface ResolvedLabel {
  label: LabelSpec;
  source: ImageSpec;
  /** Chosen multiscale level index (from {@link chooseLabelLevel}). */
  levelIdx: number;
}

/**
 * The ONE label a dataset shows by default, resolved by a single criterion
 * shared by the fetch path ({@link computeLabelChunkRequests}) and the
 * render path (`pushLabelLayers`), so they never disagree (which would fetch
 * one label but draw a different — blank — one).
 *
 * A label is eligible only if it: is a uint32 mask (the only dtype the
 * label pool handles today — uint8/uint16 are skipped with a one-time
 * warning until a widening path exists), has a resolvable source image,
 * has a positive footprint, AND has at least one multiscale level within
 * the device/budget caps. The first eligible label in manifest (OME
 * `labels`) order wins. Returns `null` when none qualifies.
 *
 * A later slice can generalize this to a SET of visible labels; for now it
 * is the single resolved default.
 */
export function resolveDefaultLabel(
  manifest: DatasetManifest,
  caps?: LabelSelectionCaps,
): ResolvedLabel | null {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return null;
  const maxDim = caps?.maxLevelDim ?? DEFAULT_MAX_LEVEL_DIM;
  const maxChunks = caps?.maxChunksPerPlane ?? DEFAULT_MAX_CHUNKS_PER_PLANE;

  for (const label of labels) {
    if (!isUint32(label.image.multiscale.data_type)) {
      if (!warnedNonUint32.has(label.image.image_id)) {
        warnedNonUint32.add(label.image.image_id);
        console.warn(
          `[labels] skipping "${label.name}" (${label.image.image_id}): ` +
          `dtype ${label.image.multiscale.data_type} not yet supported (uint32 only)`,
        );
      }
      continue;
    }
    const source = manifest.images.find((img) => img.image_id === label.source_image_id);
    if (!source) continue;
    const source0 = source.multiscale.levels[0];
    const label0 = label.image.multiscale.levels[0];
    if (!source0 || !label0) continue;
    const { dataW, dataH } = labelFootprint(
      { shape: source0.shape, scale: source0.scale },
      { shape: label0.shape, scale: label0.scale },
    );
    if (!(dataW > 0) || !(dataH > 0)) continue;
    const levelIdx = chooseLabelLevel(label.image.multiscale.levels, maxDim, maxChunks);
    if (levelIdx < 0) continue; // no level fits the device/budget caps
    return { label, source, levelIdx };
  }
  return null;
}

export interface LabelRequestArgs {
  datasetId: string;
  manifest: DatasetManifest;
  /** Current timepoint. */
  t: number;
  /** Current source full-resolution Z (the 2D slice being viewed). */
  z: number;
  maxLevelDim?: number;
  maxChunksPerPlane?: number;
}

/**
 * Emit chunk requests for the dataset's ONE default label (see
 * {@link resolveDefaultLabel}), for the current (t, z) 2D view — every
 * (y, x) chunk of the chosen level's mapped Z/T-plane. Only the resolved
 * label is fetched, so fetch and render always agree on the same label and
 * the fetch never fans out across every attached label. Returns `[]` when
 * no label qualifies.
 */
export function computeLabelChunkRequests(args: LabelRequestArgs): ChunkRequest[] {
  const resolved = resolveDefaultLabel(args.manifest, {
    maxLevelDim: args.maxLevelDim,
    maxChunksPerPlane: args.maxChunksPerPlane,
  });
  if (!resolved) return [];

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

  const requests: ChunkRequest[] = [];
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

  return requests;
}
