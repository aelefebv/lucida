/**
 * Display-only cold-state update: swap the per-channel display state on the
 * dataset's retained cold state and rebuild only its descriptor buffer. A
 * display edit changes no geometry, so pools and indirection stay
 * untouched. The rebuild uses the full ingest's
 * {@link rebuildDescriptorBuffer}, so the result is byte-identical to a full
 * cold state. No-op when no cold state has landed for the dataset yet.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateDisplayMessage } from "../workerProtocol.ts";
import { rebuildDescriptorBuffer } from "../descriptorBuffer.ts";
import type { EntitySource } from "../entitySources.ts";
import { datasetModeKey } from "../poolKeys.ts";

export function applyColdStateDisplay(
  ctx: WorkerCtx,
  msg: ColdStateDisplayMessage,
): void {
  const state = ctx.state;
  const key = datasetModeKey(msg.datasetId, msg.viewMode);
  const cold = state.coldStateByDatasetMode.get(key);
  if (!cold) return;

  // The display map is dataset-level, shared by every entry, so swapping the
  // reference on each entry re-points the whole active set.
  for (const entry of cold.activeSet) {
    entry.displayStateByChannel = msg.displayStateByChannel;
  }

  const sources: Map<string, EntitySource[]> =
    state.currentSourcesByDatasetMode.get(key) ?? new Map();
  state.descriptorBuffersByDatasetMode.set(
    key,
    rebuildDescriptorBuffer(ctx.device, state.descriptorBuffersByDatasetMode.get(key), cold, sources),
  );
}
