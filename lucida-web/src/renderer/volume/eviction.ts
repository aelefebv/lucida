/**
 * Volume-mode eviction state and view hot-state application, over
 * `ctx.state.rayHits`: each view's ray-pick point per entity, which eviction
 * uses to keep chunks near the hit point of a view that draws them.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { ViewHotStateMessage } from "../workerProtocol.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type { RendererState } from "../worker/state.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  type EvictionCandidate,
  type FindEvictionParams,
} from "../eviction.ts";
import { evictionViewsOf } from "../worker/draws.ts";
import type { AtlasState, LodIndirectionMeta } from "./atlas.ts";

/** Apply a view hot-state message to that view's ray hits. Latest message wins per entity. */
export function applyViewHotState(ctx: WorkerCtx, msg: ViewHotStateMessage): void {
  for (const [entityId, hit] of msg.rayHitsByEntity) ctx.state.rayHits.set(msg.view, entityId, hit);
}

/** Test/debug: read one view's ray-pick reference for a member. */
export function getRayHitForMember(
  state: RendererState,
  view: number,
  memberId: string,
): [number, number, number] | undefined {
  return state.rayHits.get(view, memberId);
}

/** One view's ray-pick reference for a member, its center before any pick. */
export function rayHitForMember(
  state: RendererState,
  view: number,
  memberId: string,
): [number, number, number] {
  return state.rayHits.get(view, memberId) ?? [0.5, 0.5, 0.5];
}

/** Drop ray-hit state for a removed dataset / member, in every view. */
export function clearRayHitForMember(state: RendererState, idOrMember: string): void {
  state.rayHits.forget(idOrMember);
}

/** Drop all ray-hit state (worker destroy). */
export function clearAllRayHits(state: RendererState): void {
  state.rayHits.clear();
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
  return atlas.order.next(volumeEvictionParams(state, atlas, tier));
}

/** What the shared eviction kernels read of a volume pool of `tier`, and of each view drawing from it. */
export function volumeEvictionParams(
  state: RendererState,
  atlas: AtlasState,
  tier: ResidencyTier,
): FindEvictionParams {
  return {
    slots: atlas.slots,
    views: evictionViewsOf(atlas, tier, (view, memberId) => rayHitForMember(state, view, memberId), state.rayHits.revision),
    is3D: true,
  };
}
