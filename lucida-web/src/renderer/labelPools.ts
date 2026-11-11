/**
 * Which label pools the worker keeps. A label pool holds one form of one
 * label overlay: a slice pool one plane along one axis at one chunk-T, a
 * volume pool every plane at one chunk-T. Views drawing a label in one form
 * share its pool, and each form a view draws has one (`LabelForm` in its
 * cold state).
 */

import type { WorkerCtx } from "./workerContext.ts";
import { drawsOf } from "./worker/draws.ts";
import { LABEL_TIER, postChunkResidency } from "./chunkUploadFeedback.ts";
import { removeLabelSlicePool, type LabelSlicePool } from "./slice/atlas.ts";
import { removeLabelVolumePool, type LabelVolumePool } from "./volume/atlas.ts";
import type { PoolCut, SpatialAxis } from "./slicePlane.ts";

/** The key of a label's slice pool for the plane `plane` of its level along `axis` at chunk-T `t`. */
export function labelSlicePoolKey(memberId: string, t: number, plane: number, axis: SpatialAxis = "z"): string {
  return `${memberId}@${t}/${axis}${plane}`;
}

/** The key of a label's volume pool at chunk-T `t`. */
export function labelVolumePoolKey(memberId: string, t: number): string {
  return `${memberId}@${t}`;
}

/**
 * Give each label form a view of the dataset draws a pool, and free the pools
 * of forms no view draws. A form with no pool takes the pool of a form of the
 * same label that no view draws any more, so a view moving through a label
 * re-cuts it in place: its cells keep drawing what they hold until the new
 * form's chunks land, and are reported lost so the page sends those chunks.
 * A slice pool is re-cut only along its own axis, since another axis's plane
 * has another shape.
 */
export function syncLabelPools(ctx: WorkerCtx, datasetId: string): void {
  const slice = new Map<string, { memberId: string; t: number; plane: number; axis: SpatialAxis }>();
  const volume = new Map<string, { memberId: string; t: number }>();
  for (const draw of drawsOf(ctx.state, datasetId)) {
    for (const form of draw.cold.labels ?? []) {
      if (draw.mode === "volume") {
        volume.set(labelVolumePoolKey(form.memberId, form.t), form);
      } else if (form.plane !== undefined) {
        const axis = form.axis ?? "z";
        slice.set(labelSlicePoolKey(form.memberId, form.t, form.plane, axis), { ...form, plane: form.plane, axis });
      }
    }
  }

  const slicePools = ctx.state.labelSlicePools;
  const spareSlice = sparePools(slicePools, datasetId, slice, (pool) => `${pool.memberId}|${pool.axis}`);
  for (const [key, form] of slice) {
    if (slicePools.has(key)) continue;
    const pool = takeSpare(spareSlice, `${form.memberId}|${form.axis}`);
    if (!pool) continue;
    retireCells(ctx, pool, "slice", { axis: pool.axis, plane: pool.plane });
    slicePools.delete(keyOf(slicePools, pool));
    pool.t = form.t;
    pool.plane = form.plane;
    slicePools.set(key, pool);
  }
  for (const pools of spareSlice.values()) {
    for (const pool of pools) removeLabelSlicePool(ctx, keyOf(slicePools, pool), "freed");
  }

  const volumePools = ctx.state.labelVolumePools;
  const spareVolume = sparePools(volumePools, datasetId, volume, (pool) => pool.memberId);
  for (const [key, form] of volume) {
    if (volumePools.has(key)) continue;
    const pool = takeSpare(spareVolume, form.memberId);
    if (!pool) continue;
    retireCells(ctx, pool, "volume");
    volumePools.delete(keyOf(volumePools, pool));
    pool.t = form.t;
    volumePools.set(key, pool);
  }
  for (const pools of spareVolume.values()) {
    for (const pool of pools) removeLabelVolumePool(ctx, keyOf(volumePools, pool), "freed");
  }
}

type LabelPool = LabelSlicePool | LabelVolumePool;

/** The dataset's pools of a form no view draws, by the `group` a new form may take one from. */
function sparePools<P extends LabelPool>(
  pools: Map<string, P>,
  datasetId: string,
  drawn: ReadonlyMap<string, unknown>,
  group: (pool: P) => string,
): Map<string, P[]> {
  const spare = new Map<string, P[]>();
  for (const [key, pool] of pools) {
    if (pool.datasetId !== datasetId || drawn.has(key)) continue;
    const list = spare.get(group(pool));
    if (list) list.push(pool);
    else spare.set(group(pool), [pool]);
  }
  return spare;
}

function takeSpare<P extends LabelPool>(spare: Map<string, P[]>, group: string): P | undefined {
  const list = spare.get(group);
  const pool = list?.pop();
  if (list?.length === 0) spare.delete(group);
  return pool;
}

function keyOf<P>(pools: Map<string, P>, pool: P): string {
  for (const [key, held] of pools) if (held === pool) return key;
  throw new Error("label pool not in its map");
}

/** Report every chunk a pool's cells hold lost, keeping the texels they draw until replaced. */
function retireCells(ctx: WorkerCtx, pool: LabelPool, mode: "slice" | "volume", cut?: PoolCut): void {
  const keys = [...pool.keys.values()];
  pool.keys.clear();
  postChunkResidency(ctx, pool.memberId, mode, LABEL_TIER, "lost", keys, "replaced", cut);
}
