/**
 * Worker teardown: one dataset's resources on `removeLayerResources`, every
 * GPU resource when the device is lost, and everything on `destroy`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { destroyProxyAtlas } from "../proxyAtlas.ts";
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
  removeMinimapResources(id);

  const dsPools = state.proxyPoolsByDataset.get(id);
  if (dsPools) {
    for (const pool of dsPools.values()) destroyProxyAtlas(pool);
    state.proxyPoolsByDataset.delete(id);
    // A handle into a freed pool would point at whatever a reopened pool
    // under the same key later puts in that slot.
    for (const [key, desc] of state.proxyDescriptorsByEntity) {
      if (desc.tileProxyHandle && dsPools.has(desc.tileProxyHandle.poolKey)) desc.tileProxyHandle = null;
      if (desc.groupProxyHandle && dsPools.has(desc.groupProxyHandle.poolKey)) desc.groupProxyHandle = null;
      if (!desc.tileProxyHandle && !desc.groupProxyHandle) state.proxyDescriptorsByEntity.delete(key);
    }
  }
  const desc = state.descriptorBuffersByDataset.get(id);
  if (desc) {
    destroyDescriptorBuffer(desc);
    state.descriptorBuffersByDataset.delete(id);
  }
  state.currentSourcesByDataset.delete(id);
  state.coldStateByDataset.delete(id);
  state.wantedByDataset.delete(id);

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
  // groupsByDataset avoids scanning every group's child set.
  const groups = state.groupsByDataset.get(id);
  if (groups) {
    for (const groupId of groups) state.groupToTiles.delete(groupId);
    state.groupsByDataset.delete(id);
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
  state.groupToTiles.clear();
  state.groupsByDataset.clear();
  releaseDeviceResources(ctx);
  destroyAllMinimapResources();
  self.close();
}

/**
 * Free every GPU resource the worker built on its device. What says where
 * chunks go, the cold states and the routing maps, is kept, so a replacement
 * device rebuilds the same pools empty.
 */
export function releaseDeviceResources(ctx: WorkerCtx): void {
  const state = ctx.state;
  for (const dsPools of state.proxyPoolsByDataset.values()) {
    for (const pool of dsPools.values()) destroyProxyAtlas(pool);
  }
  state.proxyPoolsByDataset.clear();
  state.proxyDescriptorsByEntity.clear();
  for (const desc of state.descriptorBuffersByDataset.values()) {
    destroyDescriptorBuffer(desc);
  }
  state.descriptorBuffersByDataset.clear();
  destroyAllSliceResources(ctx);
  destroyAllVolumeResources(ctx);
  releaseMinimapDeviceResources();
  ctx.passTimer.destroy();
  destroyAllResources();
}
