/**
 * Display-only cold-state update.
 *
 * Applies a {@link ColdStateDisplayMessage}: swap the per-channel display
 * state (contrast / gamma / opacity / colormap) on the dataset's most
 * recent cold state and rebuild just its entity descriptor buffer. Pools,
 * atlases, indirection, group→tile membership, and proxy residency are all
 * untouched — a display edit changes no geometry — so this is far cheaper
 * than {@link applyColdState} and never re-ingests the active set.
 *
 * Because the descriptor is rebuilt from the same {@link buildDescriptorBuffer}
 * path the full ingest uses (same active set, same entity metas, same proxy
 * pools), the result is byte-identical to a full cold state carrying these
 * display values — including the dense colormap-LUT reassignment a colormap
 * change needs.
 *
 * No-op when no cold state has landed for the dataset yet: a full cold
 * state will follow and carry the display state itself.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateDisplayMessage } from "../workerProtocol.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
} from "../descriptorBuffer.ts";
import type { LodIndirectionMeta } from "../volume/index.ts";

export function applyColdStateDisplay(
  ctx: WorkerCtx,
  msg: ColdStateDisplayMessage,
): void {
  const state = ctx.state;
  const cold = state.coldStateByDataset.get(msg.datasetId);
  if (!cold) return;

  // Every entry in a dataset's cold state shares one per-channel display
  // map (it is dataset-level, not per-entity), so swapping the reference
  // on each entry re-points the whole active set at the new values. The
  // active set itself — geometry, LOD, matrices, proxy flags — is left
  // exactly as the last full cold state built it.
  for (const entry of cold.activeSet) {
    entry.displayStateByChannel = msg.displayStateByChannel;
  }

  const metas: Map<string, LodIndirectionMeta[]> =
    state.currentEntityMetasByDataset.get(msg.datasetId) ?? new Map();
  const oldDesc = state.descriptorBuffersByDataset.get(msg.datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  state.descriptorBuffersByDataset.set(
    msg.datasetId,
    buildDescriptorBuffer(
      ctx.device,
      cold,
      state.proxyDescriptorsByEntity,
      state.proxyPoolsByDataset,
      metas,
    ),
  );
}
