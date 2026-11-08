/**
 * Volume-mode eviction state and view hot-state application, over
 * `ctx.state.rayHitPerEntity`: the per-entity ray-pick point that
 * `findEvictionSlot` uses to keep chunks near the camera's hit point.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { ViewHotStateMessage } from "../workerProtocol.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type { RendererState } from "../worker/state.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  findEvictionSlot as sharedFindEvictionSlot,
  type EvictionCandidate,
} from "../eviction.ts";
import { wantedChunksFor } from "../wantedChunks.ts";
import type { AtlasState, LodIndirectionMeta } from "./atlas.ts";

/** Apply a view hot-state message to the per-entity ray hits. Latest message wins per entity. */
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

/** Squared distance from a chunk grid coordinate to a reference point in [0,1] entity-local space. */
export function chunkDistSq(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number, cz: number,
  cam: [number, number, number],
): number {
  return sharedChunkDistSq(lodMeta, cx, cy, cz, cam);
}

/** The slot a chunk arriving in `tier`'s pool may take; see the shared `findEvictionSlot`. */
export function findEvictionSlot(
  state: RendererState,
  atlas: AtlasState,
  tier: ResidencyTier,
): EvictionCandidate | null {
  return sharedFindEvictionSlot({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    entityMetas: atlas.entityMetas,
    cameraFor: (memberId) => state.rayHitPerEntity.get(memberId) ?? [0.5, 0.5, 0.5],
    targetLevelFor: (memberId) => state.targetLevelByMember.get(memberId),
    isWanted: (memberId, chunkKey) => wantedChunksFor(state, memberId, tier)?.has(chunkKey) ?? false,
    is3D: true,
  });
}
