/**
 * Selection-scrub cold-state update: re-point the dataset's retained cold
 * state at the new T, Z, and visible region, and re-ingest it through
 * {@link applyColdState}.
 *
 * T and Z are top-level scalars, never per-entity, so the result is
 * byte-identical to a full cold state at the new selection without resending
 * the active set. A quad whose chunk moved to a new slot drops until the
 * fresh chunk arrives; it does not keep the prior plane on screen.
 * No-op when no cold state has landed for the dataset yet.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateSelectionMessage } from "../workerProtocol.ts";
import { applyColdState } from "./apply.ts";

export function applyColdStateSelection(
  ctx: WorkerCtx,
  msg: ColdStateSelectionMessage,
): void {
  const cold = ctx.state.coldStateByDataset.get(msg.datasetId);
  if (!cold) return;

  cold.currentT = msg.currentT;
  cold.currentZ = msg.currentZ;
  cold.visibleRegion = msg.visibleRegion;
  cold.wantedChunks = msg.wantedChunks;
  cold.epochs = msg.epochs;

  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = msg.epochs;
  applyColdState(ctx, cold);
}
