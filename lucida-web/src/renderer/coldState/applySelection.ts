/**
 * Selection-scrub cold-state update.
 *
 * Applies a {@link ColdStateSelectionMessage}: re-point the dataset's most
 * recent cold state at the new current T / Z / visible region and re-ingest it via the
 * same {@link applyColdState} path a full cold state uses.
 *
 * `currentT` / `currentZ` are top-level scalars on the cold state, never part
 * of a per-entity descriptor, so on a pure scrub the active set — geometry,
 * LOD, matrices, and display state — is exactly what the last full
 * cold state built. Re-ingesting with the swapped selection repacks the atlas
 * indirection for the new plane/timepoint and yields a result byte-identical to
 * a full cold state at the new T / Z — without the sender rebuilding or
 * re-transmitting the O(active-set) descriptor array.
 *
 * Because the re-ingest goes through the same {@link applyColdState} path a full
 * cold state uses, the visible result matches the full path exactly: the new
 * T/Z's chunks are marked wanted and re-uploaded, and where the new selection
 * lands on a different atlas slot than the old one the render drops that quad
 * until the fresh chunk arrives (a brief blank) rather than sampling stale
 * old-T/old-Z data — this does NOT keep the prior plane on screen.
 *
 * No-op when no cold state has landed for the dataset yet: a full cold state
 * will follow and carry the selection itself.
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
  cold.epochs = msg.epochs;

  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = msg.epochs;
  applyColdState(ctx, cold);
}
