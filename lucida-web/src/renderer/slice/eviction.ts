/**
 * Slice-mode eviction state, over `ctx.state.cameraUVPerEntity`: the
 * per-entity camera UV that `findFarthestSlot2D` uses to keep chunks near
 * the viewport center.
 */

import type { RendererState } from "../worker/state.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  findFarthestSlot as sharedFindFarthestSlot,
} from "../eviction.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import type { SliceAtlasState } from "./atlas.ts";

/** Update the per-entity camera-UV reference (called from render). */
export function setCameraUVForMember(
  state: RendererState,
  memberId: string,
  uv: [number, number],
): void {
  state.cameraUVPerEntity.set(memberId, uv);
}

/** Read the per-entity camera-UV reference (with [0.5, 0.5] fallback). */
export function cameraUVForMember(
  state: RendererState,
  memberId: string,
): [number, number] {
  return state.cameraUVPerEntity.get(memberId) ?? [0.5, 0.5];
}

/** Drop camera-UV state for a removed dataset / member. */
export function clearCameraUVForMember(state: RendererState, idOrMember: string): void {
  state.cameraUVPerEntity.delete(idOrMember);
}

/** Drop all camera-UV state (worker destroy). */
export function clearAllCameraUVs(state: RendererState): void {
  state.cameraUVPerEntity.clear();
}

/** Squared distance from a chunk grid coordinate to a reference UV. */
export function chunkDistSq2D(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number,
  cam: [number, number],
): number {
  return sharedChunkDistSq(lodMeta, cx, cy, null, cam);
}

/** Find the best eviction candidate: finer than the member's target first, then stale, then farthest. */
export function findFarthestSlot2D(
  state: RendererState,
  atlas: SliceAtlasState,
): { key: string; dist: number } {
  return sharedFindFarthestSlot({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    entityMetas: atlas.entityMetas,
    cameraFor: (memberId) => state.cameraUVPerEntity.get(memberId) ?? [0.5, 0.5],
    targetLevelFor: (memberId) => state.targetLevelByMember.get(memberId),
    is3D: false,
  });
}
