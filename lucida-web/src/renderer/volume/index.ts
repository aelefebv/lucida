/**
 * Volume-mode renderer surface: re-exports the submodules and owns the
 * composed cleanups that mix atlas and ray-pick state, so the atlas module
 * stays independent of the eviction module.
 */

export {
  type AtlasState,
  type LabelVolumePool,
  type LodIndirectionMeta,
  destroyAllLabelVolumePools,
  destroyAllVolumeAtlasResources,
  destroyAtlas,
  getOrCreateLabelVolumePool,
  getOrCreateVolumePool,
  growVolumeAtlas,
  removeLabelVolumePool,
  removeLabelVolumePoolsForDataset,
  removeVolumeAtlasesForDataset,
  resizeIndirection,
} from "./atlas.ts";

export {
  applyViewHotState,
  chunkDistSq,
  clearAllRayHits,
  clearRayHitForMember,
  findEvictionSlot,
  getRayHitForMember,
  rayHitForMember,
} from "./eviction.ts";

export { remapIndirection } from "./remap.ts";

export { handleVolumeChunkData, handleLabelVolumeChunkData } from "./upload.ts";

export { handleVolumeRenderMultiPass } from "./render.ts";

import {
  destroyAllLabelVolumePools,
  destroyAllVolumeAtlasResources,
  removeLabelVolumePoolsForDataset,
  removeVolumeAtlasesForDataset,
} from "./atlas.ts";
import { clearAllRayHits, clearRayHitForMember } from "./eviction.ts";
import type { WorkerCtx } from "../workerContext.ts";

/**
 * Remove resources for a removed dataset or member: a dataset id frees every
 * pool the dataset owns, and a member id frees that member's label pool and
 * ray-pick state.
 */
export function removeVolumeResources(ctx: WorkerCtx, idOrMember: string): void {
  removeVolumeAtlasesForDataset(ctx, idOrMember);
  removeLabelVolumePoolsForDataset(ctx, idOrMember);
  clearRayHitForMember(ctx.state, idOrMember);
}

/** Tear down every volume pool, the label volume pools, the depth texture, and all ray-pick state. */
export function destroyAllVolumeResources(ctx: WorkerCtx): void {
  destroyAllVolumeAtlasResources(ctx);
  destroyAllLabelVolumePools(ctx);
  clearAllRayHits(ctx.state);
}
