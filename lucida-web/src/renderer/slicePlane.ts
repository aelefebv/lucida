/**
 * Where a full-resolution plane lands at a coarser level, in one place.
 *
 * The slice atlas keys chunks by each level's own chunk grid, so the planner,
 * which picks the chunk along Z the worker wants, and the worker, which cuts
 * the plane from it and checks a slot still holds that plane, must agree on
 * the plane a full-resolution `z` names, or a delivery is refused and re-sent
 * forever. Both go through these functions, and `slice_level_z` in
 * `lucida-core/src/chunk.rs` computes the same plane.
 */

/**
 * The plane index at a level `levelDepth` planes deep that holds the center
 * of the full-resolution plane `fullResZ`, the plane nearest-sample filtering
 * would read. Integer arithmetic, so no plane lands one short of an exact
 * boundary.
 */
export function sliceLevelZ(fullResZ: number, fullResDepth: number, levelDepth: number): number {
  const last = Math.max(levelDepth - 1, 0);
  const z = Math.max(fullResZ, 0);
  if (levelDepth === fullResDepth || fullResDepth <= 0) return Math.min(z, last);
  return Math.min(Math.floor(((2 * z + 1) * levelDepth) / (2 * fullResDepth)), last);
}

/** The chunk index along Z holding that plane, for chunks `chunkZ` planes deep. */
export function sliceChunkZ(
  fullResZ: number,
  fullResDepth: number,
  levelDepth: number,
  chunkZ: number,
): number {
  return Math.floor(sliceLevelZ(fullResZ, fullResDepth, levelDepth) / Math.max(chunkZ, 1));
}

/**
 * The half-open chunk range along Z that a 2-D view of the full-resolution
 * planes `[zStart, zEnd)` samples: from the chunk holding the first plane to
 * the one holding the last. One chunk for the single plane a slice view shows.
 */
export function sliceChunkRange(
  zStart: number,
  zEnd: number,
  fullResDepth: number,
  levelDepth: number,
  chunkZ: number,
): [number, number] {
  const first = Math.floor(zStart);
  const last = Math.ceil(zEnd) - 1;
  if (last < first) return [0, 0];
  return [
    sliceChunkZ(first, fullResDepth, levelDepth, chunkZ),
    sliceChunkZ(last, fullResDepth, levelDepth, chunkZ) + 1,
  ];
}
