/** Slice Z retargeting: map full-resolution Z to one (member, level) section's chunk-Z target and plane. */

import type { SliceAtlasState, SliceEntityZInfo } from "./atlas.ts";
import { sliceChunkIndex, sliceLevelPlane } from "../slicePlane.ts";
import { sectionOf, type ViewIndirection } from "../viewIndirection.ts";

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
 * Whether `view` draws plane `plane` of a member's level at timepoint `t`: it
 * lays out a section for the level, stands at `t`, and its Z maps to the
 * plane, or to any plane before a chunk set the level's geometry.
 */
export function viewDrawsPlane(
  atlas: SliceAtlasState,
  view: ViewIndirection,
  memberId: string,
  level: number,
  t: number,
  plane: number,
): boolean {
  if (view.draw.cold.currentT !== t || !sectionOf(view, memberId, level)) return false;
  const target = computeTargetPlane(atlas.entityZInfo.get(memberId)?.get(level), view.draw.cold.currentZ);
  return target === null || target === plane;
}

/** Whether any view drawing from the pool draws plane `plane` of a member's level at timepoint `t`. */
export function drawsPlane(atlas: SliceAtlasState, memberId: string, level: number, t: number, plane: number): boolean {
  for (const view of atlas.views.values()) {
    if (viewDrawsPlane(atlas, view, memberId, level, t, plane)) return true;
  }
  return false;
}
