/**
 * Where a full-resolution plane lands at a coarser level, in one place.
 *
 * The slice atlas keys chunks by each level's own chunk grid, so the upload
 * path and the wanted set must agree on which chunk along Z holds the plane
 * a full-resolution `z` names: a delivery lands in the chunk the wanted set
 * looked for, or the two never meet. Both go through these functions.
 */

/**
 * The plane index at a level `levelDepth` planes deep for the full-resolution
 * plane `fullResZ`. A level as deep as full resolution keeps the index; a
 * shallower level maps it by proportion of the depth, so the last plane of
 * full resolution lands on the last plane of every level.
 */
export function sliceLevelZ(fullResZ: number, fullResDepth: number, levelDepth: number): number {
  const last = Math.max(levelDepth - 1, 0);
  if (levelDepth === fullResDepth) return Math.min(Math.max(fullResZ, 0), last);
  return Math.min(
    Math.floor((fullResZ / Math.max(fullResDepth - 1, 1)) * Math.max(levelDepth - 1, 1)),
    last,
  );
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
