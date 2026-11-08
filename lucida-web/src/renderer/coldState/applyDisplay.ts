/**
 * Display-only cold-state update: swap the per-channel display state on the
 * dataset's retained cold state and rebuild only its descriptor buffer. A
 * display edit changes no geometry, so pools and indirection stay
 * untouched. The rebuild uses the full ingest's
 * {@link buildDescriptorBuffer}, so the result is byte-identical to a full
 * cold state. No-op when no cold state has landed for the dataset yet.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateDisplayMessage } from "../workerProtocol.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
} from "../descriptorBuffer.ts";
import type { EntitySource } from "../entitySources.ts";

export function applyColdStateDisplay(
  ctx: WorkerCtx,
  msg: ColdStateDisplayMessage,
): void {
  const state = ctx.state;
  const cold = state.coldStateByDataset.get(msg.datasetId);
  if (!cold) return;

  // The display map is dataset-level, shared by every entry, so swapping the
  // reference on each entry re-points the whole active set.
  for (const entry of cold.activeSet) {
    entry.displayStateByChannel = msg.displayStateByChannel;
  }

  const sources: Map<string, EntitySource[]> =
    state.currentSourcesByDataset.get(msg.datasetId) ?? new Map();
  const oldDesc = state.descriptorBuffersByDataset.get(msg.datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  state.descriptorBuffersByDataset.set(
    msg.datasetId,
    buildDescriptorBuffer(
      ctx.device,
      cold,
      sources,
    ),
  );
}
