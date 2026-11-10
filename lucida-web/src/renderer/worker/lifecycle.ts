/**
 * Worker teardown: one dataset's resources on `removeLayerResources`, every
 * GPU resource when the device is lost, and everything on `destroy`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { destroyDescriptorBuffer } from "../descriptorBuffer.ts";
import { destroyAllSliceResources, removeSliceResources } from "../slice/index.ts";
import { destroyAllVolumeResources, removeVolumeResources } from "../volume/index.ts";
import {
  destroyAllMinimapResources,
  releaseMinimapDeviceResources,
  removeMinimapResources,
} from "../minimapHandlers.ts";
import { destroyAllResources } from "./resources.ts";
import { clearFrameCaptures } from "./captureFrame.ts";
import { clearGpuErrorReports } from "./gpuErrors.ts";

/**
 * Free everything the worker holds for a removed dataset, or for one member
 * when `id` is a member id. A dataset keeps its id when reopened, so anything
 * left here would be found again under the same keys.
 */
export function removeDatasetResources(ctx: WorkerCtx, id: string): void {
  const state = ctx.state;
  removeSliceResources(ctx, id);
  removeVolumeResources(ctx, id);
  removeMinimapResources(ctx, id);

  const desc = state.descriptorBuffersByDataset.get(id);
  if (desc) {
    destroyDescriptorBuffer(desc);
    state.descriptorBuffersByDataset.delete(id);
  }
  state.currentSourcesByDataset.delete(id);
  state.coldStateByDataset.delete(id);
  state.wantedByDataset.delete(id);
  state.failedByDataset.delete(id);

  // These maps would otherwise grow for the worker's whole lifetime.
  for (const [memberId, dsId] of state.memberToDataset) {
    if (dsId === id) {
      state.memberToDataset.delete(memberId);
      state.memberSourcePools.delete(memberId);
      state.targetLevelByMember.delete(memberId);
      state.cameraUVPerEntity.delete(memberId);
      state.rayHitPerEntity.delete(memberId);
    }
  }
  if (state.currentColdState?.datasetId === id) {
    state.currentColdState = null;
  }
}

/**
 * Worker `destroy` handler: tears down every renderer-owned resource, then
 * calls `self.close()`.
 *
 * Order matters: cold-state pointers are cleared first so in-flight async
 * handlers can't reschedule work, and the worker closes last so stragglers
 * stop.
 */
export function handleDestroy(ctx: WorkerCtx): void {
  const state = ctx.state;
  state.closing = true;
  state.currentEpochs = null;
  state.currentColdState = null;
  clearFrameCaptures(state);
  clearGpuErrorReports(ctx);
  state.memberToDataset.clear();
  state.memberSourcePools.clear();
  state.targetLevelByMember.clear();
  state.currentSourcesByDataset.clear();
  state.wantedByDataset.clear();
  state.failedByDataset.clear();
  releaseDeviceResources(ctx);
  destroyAllMinimapResources(state.minimap);
  self.close();
}

/**
 * Free every GPU resource the worker built on its device. What says where
 * chunks go, the cold states and the routing maps, is kept, so a replacement
 * device rebuilds the same pools empty.
 */
export function releaseDeviceResources(ctx: WorkerCtx): void {
  const state = ctx.state;
  for (const desc of state.descriptorBuffersByDataset.values()) {
    destroyDescriptorBuffer(desc);
  }
  state.descriptorBuffersByDataset.clear();
  destroyAllSliceResources(ctx);
  destroyAllVolumeResources(ctx);
  for (const target of state.viewTargets.values()) target.destroy();
  state.viewTargets.clear();
  releaseMinimapDeviceResources(state.minimap);
  // The page uploads every overview again to a replacement device.
  state.overviewsRefused.clear();
  ctx.passTimer.destroy();
  destroyAllResources();
}
