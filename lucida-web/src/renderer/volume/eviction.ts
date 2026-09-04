/**
 * Volume-mode eviction state + view hot-state application.
 *
 * Operates over `ctx.state.rayHitPerEntity` — the per-entity ray-pick
 * reference that `findFarthestSlot` consults to prefer keeping chunks
 * near the camera's hit point. Callers thread ctx (or a
 * `RendererState`) through rather than holding a module-local Map.
 */

import type { ViewHotStateMessage } from "../workerProtocol.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type { RendererState } from "../worker/state.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  findFarthestSlot as sharedFindFarthestSlot,
} from "../eviction.ts";
import type { AtlasState, LodIndirectionMeta } from "./atlas.ts";

/**
 * Apply a viewEpoch hot-state message. Updates
 * `ctx.state.rayHitPerEntity` so chunk eviction prioritization stays in
 * sync with the camera ray-pick. Latest message wins per entity.
 */
export function applyViewHotState(ctx: WorkerCtx, msg: ViewHotStateMessage): void {
  const map = ctx.state.rayHitPerEntity;
  for (const [entityId, hit] of msg.rayHitsByEntity) {
    map.set(entityId, hit);
  }
}

/** Test/debug: read the per-entity ray-pick reference for a member. */
export function getRayHitForMember(
  state: RendererState,
  memberId: string,
): [number, number, number] | undefined {
  return state.rayHitPerEntity.get(memberId);
}

/** Internal: read the per-entity ray-pick map (used by chunk upload + render). */
export function rayHitForMember(
  state: RendererState,
  memberId: string,
): [number, number, number] {
  return state.rayHitPerEntity.get(memberId) ?? [0.5, 0.5, 0.5];
}

/** Drop ray-hit state for a removed dataset / member. */
export function clearRayHitForMember(state: RendererState, idOrMember: string): void {
  state.rayHitPerEntity.delete(idOrMember);
}

/** Drop all ray-hit state (worker destroy). */
export function clearAllRayHits(state: RendererState): void {
  state.rayHitPerEntity.clear();
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
 * Find the best eviction candidate: finer than the member's target
 * first, then stale (unmapped) chunks, then the farthest mapped chunk.
 * Distance reference (`ctx.state.rayHitPerEntity`) and target level
 * (`ctx.state.targetLevelByMember`) are per entity. Delegates to the
 * shared kernel with `is3D: true`.
 */
export function findFarthestSlot(
  state: RendererState,
  atlas: AtlasState,
): { key: string; dist: number } {
  return sharedFindFarthestSlot({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    entityMetas: atlas.entityMetas,
    cameraFor: (memberId) => state.rayHitPerEntity.get(memberId) ?? [0.5, 0.5, 0.5],
    targetLevelFor: (memberId) => state.targetLevelByMember.get(memberId),
    is3D: true,
  });
}
