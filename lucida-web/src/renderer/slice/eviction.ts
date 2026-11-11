/**
 * Slice-mode eviction state, over `ctx.state.cameraUVPerEntity`: the
 * per-entity camera UV that `findEvictionSlot2D` uses to keep chunks near
 * the viewport center.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { RendererState } from "../worker/state.ts";
import {
  chunkDistSq as sharedChunkDistSq,
  findEvictionSlot,
  type EvictionCandidate,
  type FindEvictionParams,
} from "../eviction.ts";
import { wantedChunksFor } from "../wantedChunks.ts";
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

/** The slot a chunk arriving in `tier`'s pool may take; see `findEvictionSlot`. */
export function findEvictionSlot2D(
  state: RendererState,
  atlas: SliceAtlasState,
  tier: ResidencyTier,
): EvictionCandidate | null {
  return findEvictionSlot(sliceEvictionParams(state, atlas, tier));
}

/** What the shared eviction kernels read of a slice pool of `tier`. */
export function sliceEvictionParams(
  state: RendererState,
  atlas: SliceAtlasState,
  tier: ResidencyTier,
): FindEvictionParams {
  return {
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    entityMetas: atlas.entityMetas,
    cameraFor: (memberId) => state.cameraUVPerEntity.get(memberId) ?? [0.5, 0.5],
    targetLevelFor: (memberId) => state.targetLevelByMember.slice.get(memberId),
    isWanted: (memberId, chunkKey) => wantedChunksFor(state, "slice", memberId, tier)?.has(chunkKey) ?? false,
    is3D: false,
    sliceAxis: atlas.axis,
  };
}
