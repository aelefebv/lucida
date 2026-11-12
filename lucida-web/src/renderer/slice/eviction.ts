/**
 * Slice-mode eviction state, over `ctx.state.cameraUVs`: each view's camera
 * UV per entity, which eviction uses to keep chunks near the center of a view
 * that draws them.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { RendererState } from "../worker/state.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  type EvictionCandidate,
  type FindEvictionParams,
} from "../eviction.ts";
import { evictionViewsOf } from "../worker/draws.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import type { SliceAtlasState } from "./atlas.ts";

/** Update one view's camera-UV reference for an entity (called from render). */
export function setCameraUVForMember(
  state: RendererState,
  view: number,
  memberId: string,
  uv: [number, number],
): void {
  state.cameraUVs.set(view, memberId, uv);
}

/** Read one view's camera-UV reference for an entity (with [0.5, 0.5] fallback). */
export function cameraUVForMember(
  state: RendererState,
  view: number,
  memberId: string,
): [number, number] {
  return state.cameraUVs.get(view, memberId) ?? [0.5, 0.5];
}

/** Drop camera-UV state for a removed dataset / member, in every view. */
export function clearCameraUVForMember(state: RendererState, idOrMember: string): void {
  state.cameraUVs.forget(idOrMember);
}

/** Drop all camera-UV state (worker destroy). */
export function clearAllCameraUVs(state: RendererState): void {
  state.cameraUVs.clear();
}

/** Squared distance from a chunk grid coordinate to a reference UV. */
export function chunkDistSq2D(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number,
  cam: [number, number],
): number {
  return sharedChunkDistSq(lodMeta, cx, cy, null, cam);
}

/** The slot a chunk arriving in `tier`'s pool may take; see the shared `findEvictionSlot`. */
export function findEvictionSlot2D(
  state: RendererState,
  atlas: SliceAtlasState,
  tier: ResidencyTier,
): EvictionCandidate | null {
  return atlas.order.next(sliceEvictionParams(state, atlas, tier));
}

/** What the shared eviction kernels read of a slice pool of `tier`, and of each view drawing from it. */
export function sliceEvictionParams(
  state: RendererState,
  atlas: SliceAtlasState,
  tier: ResidencyTier,
): FindEvictionParams {
  return {
    slots: atlas.slots,
    views: evictionViewsOf(atlas, tier, (view, memberId) => cameraUVForMember(state, view, memberId), state.cameraUVs),
    is3D: false,
    sliceAxis: atlas.axis,
  };
}
