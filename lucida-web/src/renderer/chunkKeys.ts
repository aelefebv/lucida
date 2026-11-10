import { fromPlaneFrame, toPlaneFrame, type SpatialAxis } from "./slicePlane.ts";

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
 * A chunk key's coordinates in the slice worker's frame for a view cutting
 * `axis`: `x` across the screen, `y` down it, `z` along the cut. An XY cut's
 * frame is the image's own.
 */
export function parsePlaneChunkKey(
  key: string,
  axis: SpatialAxis = "z",
): ReturnType<typeof parseChunkKey> {
  const chunk = parseChunkKey(key);
  if (chunk === null || axis === "z") return chunk;
  const [x, y, z] = toPlaneFrame([chunk.x, chunk.y, chunk.z], axis);
  return { ...chunk, x, y, z };
}

/**
 * The chunk key of the chunk at `[x, y, z]` in the slice worker's frame for
 * a view cutting `axis`, as the image names it: {@link parsePlaneChunkKey}
 * undone.
 */
export function planeChunkKey(
  level: number,
  t: number,
  c: number,
  at: readonly [number, number, number],
  axis: SpatialAxis = "z",
): string {
  const [x, y, z] = axis === "z" ? at : fromPlaneFrame(at, axis);
  return `${level}/${t}/${c}/${z}/${y}/${x}`;
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
