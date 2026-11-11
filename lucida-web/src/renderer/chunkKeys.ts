import { fromPlaneFrame, toPlaneFrame, type SpatialAxis } from "./slicePlane.ts";

/**
 * The `"level/t/c/z/y/x"` chunk key and the composite slot keys the shared
 * atlas pools use: `"memberId|chunkKey"` in a volume pool, and
 * `"memberId|chunkKey|plane"` in a slice pool. Every site that builds or
 * parses a composite key goes through here.
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
 * Build a slice pool's slot key `"memberId|chunkKey|plane"`. A slice slot
 * holds one plane of a chunk, the level plane along the pool's axis, so a
 * pool can hold several planes of one chunk, each in its own slot.
 */
export function makeSliceSlotKey(memberId: string, chunkKey: string, plane: number): string {
  return `${memberId}|${chunkKey}|${plane}`;
}

/**
 * Parse a composite slot key back into its `(memberId, chunkKey)`
 * components, and the plane of a slice slot key (`null` for a volume one).
 * Returns `null` if `key` has no `|` separator.
 */
export function parseCompositeKey(
  key: string,
): { memberId: string; chunkKey: string; plane: number | null } | null {
  const sep = key.indexOf("|");
  if (sep < 0) return null;
  const memberId = key.substring(0, sep);
  const planeSep = key.indexOf("|", sep + 1);
  if (planeSep < 0) return { memberId, chunkKey: key.substring(sep + 1), plane: null };
  return {
    memberId,
    chunkKey: key.substring(sep + 1, planeSep),
    plane: parseInt(key.substring(planeSep + 1), 10),
  };
}
