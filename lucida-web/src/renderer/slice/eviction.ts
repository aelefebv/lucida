/**
 * Slice-mode eviction state + helpers.
 *
 * Operates over `ctx.state.cameraUVPerEntity` — the per-entity
 * camera-UV reference that `findFarthestSlot2D` consults to prefer
 * keeping chunks near the viewport's center for each entity. Callers
 * thread `RendererState` through rather than holding a module-local Map.
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

/**
 * Squared distance from a chunk grid coordinate to a reference UV.
 * Slice-mode wrapper around the shared 2D/3D-capable kernel
 * (`eviction.chunkDistSq` with `cz: null`); the explicit 2D signature
 * keeps the slice call sites locally readable.
 */
export function chunkDistSq2D(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number,
  cam: [number, number],
): number {
  return sharedChunkDistSq(lodMeta, cx, cy, null, cam);
}

/**
 * Find the best eviction candidate: finer than the member's target
 * first, then stale, then farthest. Per-entity distance reference
 * (`ctx.state.cameraUVPerEntity`) and target level
 * (`ctx.state.targetLevelByMember`). Delegates to the shared kernel with
 * `is3D: false`.
 */
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
