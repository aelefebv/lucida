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
import { sliceChunkZ } from "../slicePlane.ts";

/** Compute the target chunk Z of one level's section given the current full-res Z. */
export function computeTargetChunkZ(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo || zInfo.chunkZ <= 0) return null;
  return sliceChunkZ(currentZ, zInfo.fullResDepth, zInfo.levelDepth, zInfo.chunkZ);
}
