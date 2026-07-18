/**
 * View-move cold-state delta.
 *
 * Applies a {@link ColdStateDeltaMessage}: patch the dataset's most recent cold
 * state in place — remove the removed image ids, upsert the changed/added
 * descriptors by image id, and either apply the full-order fallback or the
 * producer's O(delta) remove/retain/append ordering hint — then re-ingest it
 * via the same {@link applyColdState} path a full cold state uses.
 *
 * The reordering is what keeps the worker and main thread agreeing on
 * descriptor-buffer entity indices: `activeSetOrder` is the exact order the main
 * thread's fresh plan produced, and `applyColdState` walks the active set in
 * that order to build the buffer, so an index computed on the main thread from
 * the same order binds to the right entity by construction.
 *
 * Because the re-ingest goes through `applyColdState`, entities that left the
 * view (dropped from the order) release their pool routing + descriptor exactly
 * as a full rebuild would — no ghost tiles — and the freshly-wanted chunks are
 * posted by the caller.
 *
 * No-op when no cold state has landed for the dataset yet: the delta can race
 * ahead of the first full cold state (which the caller's conservative gate makes
 * unlikely, but the worker stays defensive). A full cold state will follow and
 * carry the whole active set itself.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDeltaMessage,
} from "../workerProtocol.ts";
import { applyColdState } from "./apply.ts";

export function applyColdStateDelta(
  ctx: WorkerCtx,
  msg: ColdStateDeltaMessage,
): void {
  const cold = ctx.state.coldStateByDataset.get(msg.datasetId);
  if (!cold) return;

  // Build the patched active set keyed by image id: retained entries (minus
  // removed) plus upserts, then materialised in the new active-set order.
  const removed = new Set(msg.removedImageIds);
  const byImage = new Map<string, ColdStateActiveEntry>();
  for (const entry of cold.activeSet) {
    if (!removed.has(entry.imageId)) byImage.set(entry.imageId, entry);
  }
  for (const entry of msg.upserts) {
    byImage.set(entry.imageId, entry);
  }

  const nextActiveSet: ColdStateActiveEntry[] = [];
  if (msg.activeSetOrder !== undefined) {
    for (const imageId of msg.activeSetOrder) {
      const entry = byImage.get(imageId);
      // Every id in the order MUST be either retained (in the prior active set
      // and not removed) or present in `upserts`. A miss would shift every
      // subsequent descriptor index, so fail loudly.
      if (!entry) {
        throw new Error(
          `applyColdStateDelta: activeSetOrder id ${imageId} missing from ` +
            `retained+upserts (producer invariant violation)`,
        );
      }
      nextActiveSet.push(entry);
    }
  } else {
    // A view-query delta preserves the order of changed records, removes left
    // records, and appends entered records. Mirror that operation directly so
    // worker/main indices stay equal without shipping or walking a full order.
    const placed = new Set<string>();
    for (const prior of cold.activeSet) {
      if (removed.has(prior.imageId)) continue;
      const entry = byImage.get(prior.imageId);
      if (!entry) {
        throw new Error(
          `applyColdStateDelta: retained id ${prior.imageId} missing from patched set`,
        );
      }
      nextActiveSet.push(entry);
      placed.add(prior.imageId);
    }
    for (const imageId of msg.appendedImageIds ?? []) {
      const entry = byImage.get(imageId);
      if (!entry || placed.has(imageId)) {
        throw new Error(
          `applyColdStateDelta: appended id ${imageId} is missing or already retained`,
        );
      }
      nextActiveSet.push(entry);
      placed.add(imageId);
    }
    for (const entry of msg.upserts) {
      if (!placed.has(entry.imageId)) {
        throw new Error(
          `applyColdStateDelta: upsert id ${entry.imageId} was neither retained nor appended`,
        );
      }
    }
  }

  cold.activeSet = nextActiveSet;
  cold.visibleRegion = msg.visibleRegion;
  cold.currentT = msg.currentT;
  cold.currentZ = msg.currentZ;
  cold.renderRadiusView = msg.renderRadiusView;
  cold.epochs = msg.epochs;

  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = msg.epochs;
  applyColdState(ctx, cold);
}
