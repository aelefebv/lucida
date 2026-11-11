/**
 * Display-only cold-state update: swap the per-channel display state on the
 * view's retained cold state and rebuild only its descriptor buffer. A
 * display edit changes no geometry, so pools and indirection stay
 * untouched. The rebuild uses the full ingest's
 * {@link rebuildDescriptorBuffer}, so the result is byte-identical to a full
 * cold state. No-op when no cold state has landed for the view's draw yet.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateDisplayMessage } from "../workerProtocol.ts";
import { rebuildDescriptorBuffer } from "../descriptorBuffer.ts";
import { drawOf } from "../worker/draws.ts";

export function applyColdStateDisplay(
  ctx: WorkerCtx,
  msg: ColdStateDisplayMessage,
): void {
  const draw = drawOf(ctx.state, msg.datasetId, msg.view);
  if (!draw) return;
  const cold = draw.cold;

  // The display map is dataset-level, shared by every entry, so swapping the
  // reference on each entry re-points the whole active set.
  for (const entry of cold.activeSet) {
    entry.displayStateByChannel = msg.displayStateByChannel;
  }

  draw.descriptor = rebuildDescriptorBuffer(ctx.device, draw.descriptor ?? undefined, cold, draw.sources);
}
