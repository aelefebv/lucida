/**
 * Volume-mode renderer surface area.
 *
 * Re-exports primitives from the per-concern submodules (`atlas`,
 * `eviction`, `remap`, `upload`, `render`) and provides the composed
 * cleanup functions (`removeVolumeResources`, `destroyAllVolumeResources`)
 * that mix atlas + ray-pick state.
 */

export {
  type AtlasState,
  type LodIndirectionMeta,
  destroyAllVolumeAtlasResources,
  destroyAtlas,
  ensureDepthTexture,
  getDepthTexture,
  getDummyIndirection,
  getOrCreateVolumePool,
  removeVolumeAtlas,
  resizeIndirection,
} from "./atlas.ts";

export {
  applyViewHotState,
  chunkDistSq,
  clearAllRayHits,
  clearRayHitForMember,
  findFarthestSlot,
  getRayHitForMember,
  rayHitForMember,
} from "./eviction.ts";

export { remapIndirection } from "./remap.ts";

export { handleVolumeChunkData } from "./upload.ts";

export { handleVolumeRenderMultiPass } from "./render.ts";

import {
  destroyAllVolumeAtlasResources,
  removeVolumeAtlas,
} from "./atlas.ts";
import { clearAllRayHits, clearRayHitForMember } from "./eviction.ts";
import type { WorkerCtx } from "../workerContext.ts";

/**
 * Remove resources for a removed entity or dataset.
 * Pass either a poolKey (removes the whole pool) or a memberId (removes per-entity state).
 *
 * Composed from `removeVolumeAtlas` (atlas pool teardown) and
 * `clearRayHitForMember` (per-entity ray-pick cleanup) so the atlas
 * module stays independent of the eviction module.
 */
export function removeVolumeResources(ctx: WorkerCtx, idOrMember: string): void {
  removeVolumeAtlas(ctx, idOrMember);
  clearRayHitForMember(ctx.state, idOrMember);
}

/** Tear down every volume pool, the depth texture, the dummy indirection buffer, and all ray-pick state. */
export function destroyAllVolumeResources(ctx: WorkerCtx): void {
  destroyAllVolumeAtlasResources(ctx);
  clearAllRayHits(ctx.state);
}
