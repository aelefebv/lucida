/** Slice Z retargeting: map full-resolution Z to one (member, level) section's chunk-Z target and plane. */

import type { SliceAtlasState, SliceEntityZInfo } from "./atlas.ts";
import { sliceChunkIndex, sliceLevelPlane } from "../slicePlane.ts";

/** Compute the target chunk Z of one level's section given the current full-res Z. */
export function computeTargetChunkZ(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo || zInfo.chunkZ <= 0) return null;
  return sliceChunkIndex(currentZ, zInfo.fullResDepth, zInfo.levelDepth, zInfo.chunkZ);
}

/** The plane of one level's section the current full-res Z maps to, or null before any chunk set its geometry. */
export function computeTargetPlane(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo) return null;
  return sliceLevelPlane(currentZ, zInfo.fullResDepth, zInfo.levelDepth);
}

/**
 * Whether the pool draws `plane` of a member's level: the plane its current
 * Z maps to, or any plane before a chunk set the level's geometry.
 */
export function drawsPlane(atlas: SliceAtlasState, memberId: string, level: number, plane: number): boolean {
  const target = computeTargetPlane(atlas.entityZInfo.get(memberId)?.get(level), atlas.z);
  return target === null || target === plane;
}
