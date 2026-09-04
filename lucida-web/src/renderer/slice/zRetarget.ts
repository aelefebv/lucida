/**
 * Slice Z retargeting — pure helper that maps full-resolution Z to the
 * chunk-Z target of one (member, level) section.
 *
 * `staleSliceKeys` lives on the `SliceAtlasState` and is managed
 * inline in `slice/atlas.ts` (`getOrCreateSlicePool` populates it on Z
 * change) and in `slice/upload.ts` (`handleSliceChunkData` consumes
 * and clears entries as fresh chunks arrive). Promoting it into a
 * separate helper module would add indirection for two read sites with
 * no shared logic to centralise.
 */

import type { SliceEntityZInfo } from "./atlas.ts";

/** Compute the target chunk Z of one level's section given the current full-res Z. */
export function computeTargetChunkZ(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo || zInfo.chunkZ <= 0) return null;
  const levelZ = Math.min(
    Math.floor((currentZ / Math.max(zInfo.fullResDepth - 1, 1)) * Math.max(zInfo.levelDepth - 1, 1)),
    zInfo.levelDepth - 1,
  );
  return Math.floor(levelZ / zInfo.chunkZ);
}
