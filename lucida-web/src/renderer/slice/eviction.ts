/**
 * Slice-mode eviction state + helpers.
 *
 * Owns the per-entity camera-UV reference (`cameraUVPerEntity`) that
 * `findFarthestSlot2D` consults to prefer keeping chunks near the
 * viewport's center for each entity.
 *
 * Extracted from `sliceHandlers.ts` in Slice 7. The thin `chunkDistSq2D`
 * / `findFarthestSlot2D` wrappers delegate to the shared 2D/3D-capable
 * kernel in `renderer/eviction.ts` (Slice 6).
 */

import {
  chunkDistSq as sharedChunkDistSq,
  findFarthestSlot as sharedFindFarthestSlot,
} from "../eviction.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import type { SliceAtlasState } from "./atlas.ts";

/** Last known viewport center in [0,1] UV space per ENTITY (memberId). */
const cameraUVPerEntity = new Map<string, [number, number]>();

/** Update the per-entity camera-UV reference (called from render). */
export function setCameraUVForMember(memberId: string, uv: [number, number]): void {
  cameraUVPerEntity.set(memberId, uv);
}

/** Read the per-entity camera-UV reference (with [0.5, 0.5] fallback). */
export function cameraUVForMember(memberId: string): [number, number] {
  return cameraUVPerEntity.get(memberId) ?? [0.5, 0.5];
}

/** Drop camera-UV state for a removed dataset / member. */
export function clearCameraUVForMember(idOrMember: string): void {
  cameraUVPerEntity.delete(idOrMember);
}

/** Drop all camera-UV state (worker destroy). */
export function clearAllCameraUVs(): void {
  cameraUVPerEntity.clear();
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
 * Find the best eviction candidate: prefer stale, then farthest.
 * Per-entity distance reference (`cameraUVPerEntity`). Delegates to the
 * shared kernel with `is3D: false`.
 */
export function findFarthestSlot2D(atlas: SliceAtlasState): { key: string; dist: number } {
  return sharedFindFarthestSlot({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    entityMetas: atlas.entityMetas,
    cameraFor: (memberId) => cameraUVPerEntity.get(memberId) ?? [0.5, 0.5],
    is3D: false,
  });
}
