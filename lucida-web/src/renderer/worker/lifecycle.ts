/**
 * Worker `destroy` handler: tears down every renderer-owned resource, then
 * calls `self.close()`.
 *
 * Order matters: cold-state pointers are cleared first so in-flight async
 * handlers can't reschedule work, and the worker closes last so stragglers
 * stop.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { destroyProxyAtlas } from "../proxyAtlas.ts";
import { destroyDescriptorBuffer } from "../descriptorBuffer.ts";
import { destroyAllSliceResources } from "../slice/index.ts";
import { destroyAllVolumeResources } from "../volume/index.ts";
import { destroyAllMinimapResources } from "../minimapHandlers.ts";
import { destroyAllResources } from "./resources.ts";
import { clearFrameCaptures } from "./captureFrame.ts";

export function handleDestroy(ctx: WorkerCtx): void {
  const state = ctx.state;
  state.currentEpochs = null;
  state.currentColdState = null;
  clearFrameCaptures(state);
  state.memberToDataset.clear();
  state.memberSourcePools.clear();
  state.targetLevelByMember.clear();
  state.currentSourcesByDataset.clear();
  for (const dsPools of state.proxyPoolsByDataset.values()) {
    for (const pool of dsPools.values()) destroyProxyAtlas(pool);
  }
  state.proxyPoolsByDataset.clear();
  state.proxyDescriptorsByEntity.clear();
  state.groupToTiles.clear();
  state.groupsByDataset.clear();
  for (const desc of state.descriptorBuffersByDataset.values()) {
    destroyDescriptorBuffer(desc);
  }
  state.descriptorBuffersByDataset.clear();
  destroyAllSliceResources(ctx);
  destroyAllVolumeResources(ctx);
  destroyAllMinimapResources();
  ctx.passTimer.destroy();
  destroyAllResources();
  self.close();
}
