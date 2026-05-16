/**
 * Chunk-key helpers — pure string parsing / construction for the
 * `"level/t/c/z/y/x"` chunk key and the `"memberId|chunkKey"` composite
 * slot key used by the shared atlas pools.
 *
 * Lifted from `volumeHandlers.ts` (dechaos render Pass 5 Contract Issue
 * 4: pool/key encoding scattered across modules). Centralising the
 * format here means every site that builds or parses a composite key
 * goes through the same helper, and any future shape change has one
 * place to update.
 *
 * No GPU coupling, no module state — safe to import from worker code,
 * wanted-set computation, and tests.
 */

/**
 * Parse a chunk key `"level/t/c/z/y/x"` into its component integers.
 * Returns `null` for malformed input (wrong number of components or
 * unparseable integers — though the latter is not currently rejected by
 * `parseInt`).
 */
export function parseChunkKey(
  key: string,
): { level: number; t: number; c: number; z: number; y: number; x: number } | null {
  const parts = key.split("/");
  if (parts.length !== 6) return null;
  return {
    level: parseInt(parts[0], 10),
    t: parseInt(parts[1], 10),
    c: parseInt(parts[2], 10),
    z: parseInt(parts[3], 10),
    y: parseInt(parts[4], 10),
    x: parseInt(parts[5], 10),
  };
}

/**
 * Build the composite slot key `"memberId|chunkKey"` used by the
 * shared volume + slice atlas pools to disambiguate identical chunk
 * coordinates that belong to different members of the same pool.
 */
export function makeCompositeKey(memberId: string, chunkKey: string): string {
  return `${memberId}|${chunkKey}`;
}

/**
 * Parse a composite slot key back into its `(memberId, chunkKey)`
 * components. Returns `null` if `key` doesn't contain the `|`
 * separator (e.g. a legacy non-composite slice key).
 */
export function parseCompositeKey(
  key: string,
): { memberId: string; chunkKey: string } | null {
  const sep = key.indexOf("|");
  if (sep < 0) return null;
  return { memberId: key.substring(0, sep), chunkKey: key.substring(sep + 1) };
}

/**
 * Derive the shared chunk pool key from a memberId and its datasetId.
 *
 * - Single-channel: `memberId = "imageId"` → `poolKey = "datasetId"`.
 * - Multi-channel:  `memberId = "imageId:chN"` → `poolKey = "datasetId:chN"`.
 *
 * The convention preserves the per-channel split that the canonical
 * `chunkPoolKey` helper applies during pool registration; this helper
 * is the inverse mapping used at sites that already hold a memberId.
 */
export function derivePoolKey(memberId: string, datasetId: string): string {
  const colonIdx = memberId.indexOf(":");
  if (colonIdx >= 0) {
    return `${datasetId}${memberId.substring(colonIdx)}`;
  }
  return datasetId;
}
