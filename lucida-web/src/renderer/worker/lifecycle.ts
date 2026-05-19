/**
 * Worker `destroy` handler — tears down every renderer-owned resource
 * the worker has accumulated, then calls `self.close()` so the worker
 * thread exits cleanly.
 *
 * Teardown order matters: clear cold-state pointers first (so any
 * in-flight async handlers can't reschedule work), then drop proxy
 * pools + descriptor buffers (they hold GPU resources), then per-mode
 * atlas + minimap resources, then the worker-process resource caches
 * (LUT, offscreen pool, dummies). Finally, close the worker so any
 * stragglers don't continue processing.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { destroyProxyAtlas } from "../proxyAtlas.ts";
import { destroyDescriptorBuffer } from "../descriptorBuffer.ts";
import { destroyAllSliceResources } from "../slice/index.ts";
import { destroyAllVolumeResources } from "../volume/index.ts";
import { destroyAllMinimapResources } from "../minimapHandlers.ts";
import { destroyAllResources } from "./resources.ts";

export function handleDestroy(ctx: WorkerCtx): void {
  const state = ctx.state;
  state.currentEpochs = null;
  state.currentColdState = null;
  state.memberToDataset.clear();
  state.memberToPool.clear();
  state.memberTierToPool.clear();
  state.currentEntityMetasByDataset.clear();
  // Tear down proxy atlas pools and descriptors.
  for (const dsPools of state.proxyPoolsByDataset.values()) {
    for (const pool of dsPools.values()) destroyProxyAtlas(pool);
  }
  state.proxyPoolsByDataset.clear();
  state.proxyDescriptorsByEntity.clear();
  state.wellToFields.clear();
  state.wellsByDataset.clear();
  // Tear down all entity descriptor buffers.
  for (const desc of state.descriptorBuffersByDataset.values()) {
    destroyDescriptorBuffer(desc);
  }
  state.descriptorBuffersByDataset.clear();
  destroyAllSliceResources(ctx);
  destroyAllVolumeResources(ctx);
  destroyAllMinimapResources();
  // Drop worker-process resource caches (LUT, offscreen pool, dummies).
  destroyAllResources();
  self.close();
}
