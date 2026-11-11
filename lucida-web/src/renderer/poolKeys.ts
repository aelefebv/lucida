/** Canonical encoding for the chunk atlas pool keys. */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { PoolCut, SpatialAxis } from "./slicePlane.ts";
import type { PoolMode } from "./workerProtocol.ts";

/**
 * Which pools a delivered chunk goes to, as the page's record of what the
 * worker holds keys it: a dataset's volume pools, or one plane of the chunk
 * in its slice pools of one axis. A chunk is held for each target on its own.
 */
export function deliveryTarget(mode: PoolMode, cut?: PoolCut): string {
  return mode === "volume" || cut === undefined ? mode : `slice:${cut.axis}${cut.plane}`;
}

/** Key of what the page records for one dataset's pools of one mode. */
export function datasetModeKey(datasetId: string, mode: PoolMode): string {
  return `${datasetId}|${mode}`;
}

/** Key of what the worker and the page keep for one view's draw of one dataset. */
export function datasetViewKey(datasetId: string, view: number): string {
  return `${datasetId}|${view}`;
}

/**
 * Chunk-pool key for the worker's shared atlas pools, one per channel.
 * `chunkDims` is `[X, Y]` for slice or `[X, Y, Z]` for volume; any other
 * arity throws. A slice pool of a side view, whose slots hold planes along
 * `sliceAxis`, is a pool of its own: a slot cut along one axis must never be
 * read as one cut along another.
 */
export function chunkPoolKey(
  datasetId: string,
  channel: number,
  chunkDims: number[],
  sliceAxis: SpatialAxis = "z",
): string {
  let chunkDimsKey: string;
  if (chunkDims.length === 3) {
    chunkDimsKey = `${chunkDims[0]}x${chunkDims[1]}x${chunkDims[2]}`;
  } else if (chunkDims.length === 2) {
    chunkDimsKey = `${chunkDims[0]}x${chunkDims[1]}`;
  } else {
    throw new Error(
      `chunkPoolKey: unsupported chunkDims arity ${chunkDims.length}; expected 2 (slice) or 3 (volume)`,
    );
  }
  const axisKey = sliceAxis === "z" ? "" : `@${sliceAxis}`;
  return `${datasetId}:ch${channel}:${chunkDimsKey}${axisKey}`;
}

export function chunkTierPoolKey(
  datasetId: string,
  tier: ResidencyTier,
  channel: number,
  chunkDims: number[],
  sliceAxis: SpatialAxis = "z",
): string {
  const base = chunkPoolKey(datasetId, channel, chunkDims, sliceAxis);
  return `${base}:${tier}`;
}

/** The tier a {@link chunkTierPoolKey} names. */
export function chunkPoolTier(poolKey: string): ResidencyTier {
  return poolKey.endsWith(":coarse") ? "coarse" : "detail";
}

/**
 * Key of one indirection section within a member's routing map
 * (`ViewDraw.routes`): the tier and level it serves.
 */
export function sourceKey(tier: ResidencyTier, level: number): string {
  return `${tier}:${level}`;
}
