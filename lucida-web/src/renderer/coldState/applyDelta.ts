/**
 * View-move cold-state delta: patch the view's retained cold state in place
 * (remove, upsert, reorder to `activeSetOrder`) and re-ingest it through
 * {@link applyColdState}, so departed entities release exactly as in a full
 * rebuild. A delta that changed no entry, order or selection re-ingests
 * nothing: only the wanted chunks moved, and nothing laid out reads them
 * unless a render radius or failed chunks are in play.
 *
 * The reorder keeps descriptor-buffer entity indices in agreement with the main
 * thread, which computes them from the same order. No-op when no cold state
 * has landed for the view's draw of the dataset yet; a full one will follow.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDeltaMessage,
} from "../workerProtocol.ts";
import { applyColdState } from "./apply.ts";
import { patchWantedChunks, patchWantedIndex } from "../wantedChunks.ts";
import { renderRadiusEnabled } from "../../pipeline/renderRadius.ts";
import { drawOf } from "../worker/draws.ts";
import { syncLabelPools } from "../labelPools.ts";

/** Whether either tier draws only the chunks inside a render radius, which moves with the view. */
function radiusInPlay(radius: ColdStateDeltaMessage["renderRadiusView"]): boolean {
  return radius !== undefined && (renderRadiusEnabled(radius.detail) || renderRadiusEnabled(radius.coarse));
}

export function applyColdStateDelta(
  ctx: WorkerCtx,
  msg: ColdStateDeltaMessage,
): void {
  const draw = drawOf(ctx.state, msg.datasetId, msg.view);
  if (!draw) return;
  const cold = draw.cold;

  const laidOutAsBefore =
    msg.removedEntityIds.length === 0 &&
    msg.upserts.length === 0 &&
    msg.activeSetOrder.length === cold.activeSet.length &&
    msg.activeSetOrder.every((entityId, i) => cold.activeSet[i].entityId === entityId) &&
    msg.currentT === cold.currentT &&
    msg.currentZ === cold.currentZ &&
    !radiusInPlay(cold.renderRadiusView) &&
    !radiusInPlay(msg.renderRadiusView) &&
    !ctx.state.failedByDataset.has(msg.datasetId);

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
  cold.wantedChunks = patchWantedChunks(cold.wantedChunks, msg.wantedChunks);
  cold.currentT = msg.currentT;
  cold.currentZ = msg.currentZ;
  cold.renderRadiusView = msg.renderRadiusView;
  cold.labels = msg.labels;
  cold.epochs = msg.epochs;

  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = msg.epochs;
  if (laidOutAsBefore) {
    draw.wanted = patchWantedIndex(draw.wanted, msg.wantedChunks);
    syncLabelPools(ctx, msg.datasetId);
    return;
  }
  applyColdState(ctx, cold);
}
