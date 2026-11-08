/**
 * The `"level/t/c/z/y/x"` chunk key and the `"memberId|chunkKey"` composite
 * slot key the shared atlas pools use. Every site that builds or parses a
 * composite key goes through here.
 */

/**
 * Parse a chunk key `"level/t/c/z/y/x"` into its component integers.
 * Returns `null` unless there are six components; a non-numeric part parses to NaN.
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
 * components. Returns `null` if `key` has no `|` separator.
 */
export function parseCompositeKey(
  key: string,
): { memberId: string; chunkKey: string } | null {
  const sep = key.indexOf("|");
  if (sep < 0) return null;
  return { memberId: key.substring(0, sep), chunkKey: key.substring(sep + 1) };
}
