/**
 * Volume-mode eviction state + view hot-state application.
 *
 * Owns the per-entity ray-pick reference (`rayHitPerEntity`) that
 * `findFarthestSlot` consults to prefer keeping chunks near the
 * camera's hit point.
 *
 * Extracted from `volumeHandlers.ts` in Slice 7. The thin
 * `chunkDistSq` / `findFarthestSlot` wrappers delegate to the shared
 * kernel in `renderer/eviction.ts` (Slice 6); local re-exports keep the
 * volume call sites readable.
 */

import type { ViewHotStateMessage } from "../workerProtocol.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  findFarthestSlot as sharedFindFarthestSlot,
} from "../eviction.ts";
import type { AtlasState, LodIndirectionMeta } from "./atlas.ts";

// Last known ray-volume hit point in local [0,1]³ space per ENTITY (memberId).
// Chunks closest to this point are kept; farthest are evicted first.
// Populated by `applyViewHotState` on viewEpoch advance; chunk-data and
// render handlers read it for `findFarthestSlot` distance metrics.
const rayHitPerEntity = new Map<string, [number, number, number]>();

/**
 * Apply a viewEpoch hot-state message. Updates the `rayHitPerEntity`
 * map so chunk eviction prioritization stays in sync with the camera
 * ray-pick. Latest message wins per entity.
 */
export function applyViewHotState(msg: ViewHotStateMessage): void {
  for (const [entityId, hit] of msg.rayHitsByEntity) {
    rayHitPerEntity.set(entityId, hit);
  }
}

/** Test-only: read the per-entity ray-pick map. */
export function getRayHitForMember(memberId: string): [number, number, number] | undefined {
  return rayHitPerEntity.get(memberId);
}

/** Internal: read the per-entity ray-pick map (used by chunk upload + render). */
export function rayHitForMember(memberId: string): [number, number, number] {
  return rayHitPerEntity.get(memberId) ?? [0.5, 0.5, 0.5];
}

/** Drop ray-hit state for a removed dataset / member. */
export function clearRayHitForMember(idOrMember: string): void {
  rayHitPerEntity.delete(idOrMember);
}

/** Drop all ray-hit state (worker destroy). */
export function clearAllRayHits(): void {
  rayHitPerEntity.clear();
}

/**
 * Squared distance from a chunk grid coordinate to a reference point
 * in [0,1] entity-local space. Volume-mode wrapper around the shared
 * 2D/3D-capable kernel (`eviction.chunkDistSq`); the explicit `cz`
 * argument keeps the volume call sites locally readable.
 */
export function chunkDistSq(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number, cz: number,
  cam: [number, number, number],
): number {
  return sharedChunkDistSq(lodMeta, cx, cy, cz, cam);
}

/**
 * Find the best eviction candidate: prefer stale (unmapped) chunks,
 * then farthest mapped chunk. Distance reference is per-entity
 * (`rayHitPerEntity`). Delegates to the shared kernel with `is3D: true`.
 */
export function findFarthestSlot(atlas: AtlasState): { key: string; dist: number } {
  return sharedFindFarthestSlot({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    entityMetas: atlas.entityMetas,
    cameraFor: (memberId) => rayHitPerEntity.get(memberId) ?? [0.5, 0.5, 0.5],
    is3D: true,
  });
}
