/**
 * Worker `destroy` handler — tears down every renderer-owned resource
 * the worker has accumulated, then calls `self.close()` so the worker
 * thread exits cleanly.
 *
 * Teardown order matters: clear cold-state pointers first (so any
 * in-flight async handlers can't reschedule work), then drop descriptor
 * buffers (they hold GPU resources), then per-mode
 * atlas + minimap resources, then the worker-process resource caches
 * (LUT, offscreen pool, dummies). Finally, close the worker so any
 * stragglers don't continue processing.
 */

import type { WorkerCtx } from "../workerContext.ts";
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
  // Tear down all entity descriptor buffers.
  for (const desc of state.descriptorBuffersByDataset.values()) {
    destroyDescriptorBuffer(desc);
  }
  state.descriptorBuffersByDataset.clear();
  destroyAllSliceResources(ctx);
  destroyAllVolumeResources(ctx);
  destroyAllMinimapResources();
  ctx.destroyRenderers();
  // Drop worker-process resource caches (LUT, offscreen pool, dummies).
  destroyAllResources();
  // Domain owners above normally release every tracked handle. This final
  // allocator sweep makes teardown exact even if a future owner forgets to
  // register a composed cleanup path.
  ctx.gpuResources.destroyAll();
  self.close();
}
