/** Slice Z retargeting: map full-resolution Z to one (member, level) section's chunk-Z target and plane. */

import type { SliceEntityZInfo } from "./atlas.ts";
import { sliceChunkZ, sliceLevelZ } from "../slicePlane.ts";

/** Compute the target chunk Z of one level's section given the current full-res Z. */
export function computeTargetChunkZ(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo || zInfo.chunkZ <= 0) return null;
  return sliceChunkZ(currentZ, zInfo.fullResDepth, zInfo.levelDepth, zInfo.chunkZ);
}

/** The plane of one level's section the current full-res Z maps to, or null before any chunk set its geometry. */
export function computeTargetPlane(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo) return null;
  return sliceLevelZ(currentZ, zInfo.fullResDepth, zInfo.levelDepth);
}
