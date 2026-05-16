/**
 * Slice Z retargeting — pure helper that maps full-resolution Z to a
 * per-entity chunk-Z target.
 *
 * Extracted from `sliceHandlers.ts` in Slice 7. Slice mode walks every
 * frame, every chunk upload, and every remap, so this is hot enough to
 * keep as its own tiny module.
 *
 * `staleSliceKeys` lives on the `SliceAtlasState` and is managed
 * inline in `slice/atlas.ts` (`getOrCreateSlicePool` populates it on Z
 * change) and in `slice/upload.ts` (`handleSliceChunkData` consumes
 * and clears entries as fresh chunks arrive). Promoting it into a
 * separate helper module would add indirection for two read sites with
 * no shared logic to centralise.
 */

import type { SliceEntityZInfo } from "./atlas.ts";

/** Compute target chunk Z for an entity given current full-res Z. */
export function computeTargetChunkZ(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo || zInfo.chunkZ <= 0) return null;
  const levelZ = Math.min(
    Math.floor((currentZ / Math.max(zInfo.fullResDepth - 1, 1)) * Math.max(zInfo.levelDepth - 1, 1)),
    zInfo.levelDepth - 1,
  );
  return Math.floor(levelZ / zInfo.chunkZ);
}
