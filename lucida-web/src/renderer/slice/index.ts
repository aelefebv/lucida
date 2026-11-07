/**
 * Slice-mode renderer surface: re-exports the submodules and owns the
 * composed cleanups that mix atlas and camera-UV state, so the atlas module
 * stays independent of the eviction module.
 */

export {
  type SliceAtlasState,
  type SliceEntityZInfo,
  type LabelSlicePool,
  destroyAllSliceAtlasResources,
  destroyAllLabelSlicePools,
  destroySliceAtlas,
  getOrCreateSlicePool,
  getOrCreateLabelSlicePool,
  removeLabelSlicePool,
  removeLabelSlicePoolsForDataset,
  resetLabelSliceAllocWarnings,
  removeSliceAtlas,
  resizeSliceIndirection,
} from "./atlas.ts";

export {
  cameraUVForMember,
  chunkDistSq2D,
  clearAllCameraUVs,
  clearCameraUVForMember,
  findFarthestSlot2D,
  setCameraUVForMember,
} from "./eviction.ts";

export { remapSliceIndirection } from "./remap.ts";

export { handleSliceChunkData, handleLabelSliceChunkData } from "./upload.ts";

export { handleSliceRenderMultiPass } from "./render.ts";

export { computeTargetChunkZ } from "./zRetarget.ts";

import {
  destroyAllSliceAtlasResources,
  destroyAllLabelSlicePools,
  removeLabelSlicePoolsForDataset,
  removeSliceAtlas,
} from "./atlas.ts";
import { clearAllCameraUVs, clearCameraUVForMember } from "./eviction.ts";
import type { WorkerCtx } from "../workerContext.ts";

/**
 * Remove resources for a removed entity or dataset. Pass a poolKey to remove
 * the whole pool or a memberId to remove per-entity state.
 */
export function removeSliceResources(ctx: WorkerCtx, idOrMember: string): void {
  removeSliceAtlas(ctx, idOrMember);
  removeLabelSlicePoolsForDataset(ctx, idOrMember);
  clearCameraUVForMember(ctx.state, idOrMember);
}

/** Tear down every slice pool and all camera-UV state. */
export function destroyAllSliceResources(ctx: WorkerCtx): void {
  destroyAllSliceAtlasResources(ctx);
  destroyAllLabelSlicePools(ctx);
  clearAllCameraUVs(ctx.state);
}
