/**
 * Slice-mode renderer surface area.
 *
 * Re-exports primitives from the per-concern submodules (`atlas`,
 * `eviction`, `remap`, `upload`, `render`, `zRetarget`) and provides
 * the composed cleanup functions (`removeSliceResources`,
 * `destroyAllSliceResources`) that mix atlas + camera-UV state.
 */

export {
  type SliceAtlasState,
  type SliceEntityZInfo,
  type LabelSlicePool,
  destroyAllSliceAtlasResources,
  destroyAllLabelSlicePools,
  destroySliceAtlas,
  getDummySliceIndirection,
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
 * Remove resources for a removed entity or dataset.
 * Pass either a poolKey (removes the whole pool) or a memberId (removes per-entity state).
 *
 * Composed from `removeSliceAtlas` (atlas pool teardown),
 * `removeLabelSlicePoolsForDataset` (label pool teardown — matched by owning
 * dataset since label pools are keyed by the label image id, not the dataset
 * id), and `clearCameraUVForMember` (per-entity camera-UV cleanup) so the
 * atlas module stays independent of the eviction module.
 */
export function removeSliceResources(ctx: WorkerCtx, idOrMember: string): void {
  removeSliceAtlas(ctx, idOrMember);
  removeLabelSlicePoolsForDataset(ctx, idOrMember);
  clearCameraUVForMember(ctx.state, idOrMember);
}

/** Tear down every slice pool, the dummy indirection buffer, and all camera-UV state. */
export function destroyAllSliceResources(ctx: WorkerCtx): void {
  destroyAllSliceAtlasResources(ctx);
  destroyAllLabelSlicePools(ctx);
  clearAllCameraUVs(ctx.state);
}
