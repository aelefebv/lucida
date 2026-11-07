/**
 * View-move cold-state delta: patch the dataset's retained cold state in place
 * (remove, upsert, reorder to `activeSetOrder`) and re-ingest it through
 * {@link applyColdState}, so departed entities release exactly as in a full
 * rebuild.
 *
 * The reorder keeps descriptor-buffer entity indices in agreement with the main
 * thread, which computes them from the same order. No-op when no cold state
 * has landed for the dataset yet; a full one will follow.
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

  const removed = new Set(msg.removedEntityIds);
  const byEntity = new Map<string, ColdStateActiveEntry>();
  for (const entry of cold.activeSet) {
    if (!removed.has(entry.entityId)) byEntity.set(entry.entityId, entry);
  }
  for (const entry of msg.upserts) {
    byEntity.set(entry.entityId, entry);
  }

  const nextActiveSet: ColdStateActiveEntry[] = [];
  for (const entityId of msg.activeSetOrder) {
    const entry = byEntity.get(entityId);
    // `buildColdStateDelta` guarantees every id is retained or upserted.
    // Skipping a miss would shift every later descriptor index and draw the
    // wrong tiles silently, so fail loudly.
    if (!entry) {
      throw new Error(
        `applyColdStateDelta: activeSetOrder id ${entityId} missing from ` +
          `retained+upserts (producer invariant violation)`,
      );
    }
    nextActiveSet.push(entry);
  }

  cold.activeSet = nextActiveSet;
  cold.visibleRegion = msg.visibleRegion;
  cold.desiredProxyKeys = msg.desiredProxyKeys;
  cold.currentT = msg.currentT;
  cold.currentZ = msg.currentZ;
  cold.renderRadiusView = msg.renderRadiusView;
  cold.epochs = msg.epochs;

  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = msg.epochs;
  applyColdState(ctx, cold);
}
