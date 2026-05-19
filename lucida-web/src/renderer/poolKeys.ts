/**
 * Pool-key helpers — canonical encoding for the chunk + proxy atlas
 * pool keys. Single source of truth for pool-key formatting; drift
 * against the worker's inline format strings is caught by
 * `poolKeys.test.ts`.
 */

export { proxyPoolKey } from "./proxyAtlas.ts";

/**
 * Build the canonical chunk-pool key for the worker's shared volume +
 * slice atlas pools.
 *
 * Encoding (must match the inline strings in `gpu.worker.ts` cold-state
 * handler, ~lines 580-582 (volume) and ~665-667 (slice)):
 *
 * - Single-channel volume (`chunkDims.length === 3`):
 *   `${datasetId}:${X}x${Y}x${Z}`
 * - Multi-channel volume:
 *   `${datasetId}:ch${channel}:${X}x${Y}x${Z}`
 * - Single-channel slice (`chunkDims.length === 2`):
 *   `${datasetId}:${X}x${Y}`
 * - Multi-channel slice:
 *   `${datasetId}:ch${channel}:${X}x${Y}`
 *
 * `chunkDims` is `[X, Y]` for slice (2D) or `[X, Y, Z]` for volume
 * (3D). The helper picks the arity from `chunkDims.length` and
 * throws on anything else — there's no use case for 1-D or 4-D pools.
 */
export type ChunkTier = "detail" | "coarse";

export function chunkPoolKey(
  datasetId: string,
  channel: number,
  chunkDims: number[],
  isMultiCh: boolean,
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
  return isMultiCh
    ? `${datasetId}:ch${channel}:${chunkDimsKey}`
    : `${datasetId}:${chunkDimsKey}`;
}

export function chunkTierPoolKey(
  datasetId: string,
  tier: ChunkTier,
  channel: number,
  chunkDims: number[],
  isMultiCh: boolean,
): string {
  const base = chunkPoolKey(datasetId, channel, chunkDims, isMultiCh);
  return `${base}:${tier}`;
}

export function memberTierKey(memberId: string, tier: ChunkTier): string {
  return `${memberId}|${tier}`;
}
