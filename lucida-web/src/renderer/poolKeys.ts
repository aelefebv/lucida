/** Canonical encoding for the chunk and proxy atlas pool keys. */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";

export { proxyPoolKey } from "./proxyAtlas.ts";

/**
 * Chunk-pool key for the worker's shared atlas pools, one per channel.
 * `chunkDims` is `[X, Y]` for slice or `[X, Y, Z]` for volume; any other
 * arity throws.
 */
export function chunkPoolKey(
  datasetId: string,
  channel: number,
  chunkDims: number[],
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
  return `${datasetId}:ch${channel}:${chunkDimsKey}`;
}

export function chunkTierPoolKey(
  datasetId: string,
  tier: ResidencyTier,
  channel: number,
  chunkDims: number[],
): string {
  const base = chunkPoolKey(datasetId, channel, chunkDims);
  return `${base}:${tier}`;
}

/** The tier a {@link chunkTierPoolKey} names. */
export function chunkPoolTier(poolKey: string): ResidencyTier {
  return poolKey.endsWith(":coarse") ? "coarse" : "detail";
}

/**
 * Key of one indirection section within a member's routing map
 * (`RendererState.memberSourcePools`): the tier and level it serves.
 */
export function sourceKey(tier: ResidencyTier, level: number): string {
  return `${tier}:${level}`;
}
