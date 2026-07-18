/**
 * Top-level pure planner. Composes promotion + chunk iteration +
 * three-lane scheduling into a {@link RequestPlan}. See ADR 0029.
 */

import type { SceneEpochs } from "../epochs.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import {
  emitCoarseLane,
  emitDetailLane,
  emitMinimapLane,
  emitPrefetchLane,
} from "./emit.ts";
import { assignChunkModes } from "./modes.ts";
import {
  emptyPlanStats,
  type ActiveSetEntry,
  type ChunkRequest,
  type EntitySnapshot,
  type PlanningSnapshot,
  type PlanStats,
  type PlanningState,
  type RequestPlan,
} from "./types.ts";
import { validatePlanningInputs } from "./validate.ts";

export function compareChunkRequests(a: ChunkRequest, b: ChunkRequest): number {
  const priority = a.priority - b.priority;
  if (priority !== 0) return priority;

  const image = a.imageId.localeCompare(b.imageId);
  if (image !== 0) return image;

  return (
    a.level - b.level ||
    a.t - b.t ||
    a.z - b.z ||
    a.y - b.y ||
    a.x - b.x ||
    a.c - b.c ||
    a.chunkKey.localeCompare(b.chunkKey)
  );
}

/**
 * Reconcile bulk minimap priority across the workspace-wide fetch queue.
 *
 * A per-dataset plan can only place its bulk minimap requests behind that
 * dataset's view work. The scheduler is shared, however, so the real fairness
 * invariant is workspace-wide: every bulk seed must follow every view-serving
 * request from every dataset. Planner outputs are freshly allocated and
 * explicitly caller-mutable, so this adjusts them in place and restores their
 * canonical order without another allocation.
 */
export function applyWorkspaceMinimapPriority(
  requestsByDataset: readonly ChunkRequest[][],
  minimapPending: ReadonlyMap<string, readonly unknown[]>,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): void {
  let pendingTotal = 0;
  for (const coords of minimapPending.values()) pendingTotal += coords.length;
  const fastMax = config.minimapSeedFastMaxChunks
    ?? DEFAULT_PLANNING_CONFIG.minimapSeedFastMaxChunks
    ?? 0;
  if (pendingTotal <= fastMax) return;

  let workspaceViewMax = Number.NEGATIVE_INFINITY;
  for (const requests of requestsByDataset) {
    for (const request of requests) {
      if (request.lane !== "minimap") {
        workspaceViewMax = Math.max(workspaceViewMax, request.priority);
      }
    }
  }
  const floor = Math.max(
    config.minimapSeedBulkLaneOffset
      ?? DEFAULT_PLANNING_CONFIG.minimapSeedBulkLaneOffset
      ?? 0,
    Number.isFinite(workspaceViewMax) ? workspaceViewMax + 1 : 0,
  );
  for (const requests of requestsByDataset) {
    let changed = false;
    for (const request of requests) {
      if (request.lane !== "minimap" || request.priority >= floor) continue;
      request.priority = floor;
      changed = true;
    }
    if (changed) requests.sort(compareChunkRequests);
  }
}

/**
 * Emit the chunk request stream for an already-resolved active set.
 *
 * This is steps 2–7 of {@link plan} — every lane emission plus the final
 * priority sort — factored out so a caller that already holds a valid active
 * set can regenerate its requests for a changed selection (a T-scrub or
 * Z-plane move) WITHOUT re-resolving modes or rebuilding the snapshot. Pure in
 * `(activeSet, snapshot, config)`; mutates only the supplied `stats`.
 *
 * The requests are a pure function of the active set, the entities, the visible
 * region, and the selection, so reusing an unchanged active set with a snapshot
 * whose only difference is `selection.t` / `selection.z` (and, on a Z move,
 * `visibleRegion.zRangeVox`) yields exactly the requests a full {@link plan}
 * would produce for that selection — with none of `assignChunkModes`' work.
 *
 * Postconditions match {@link plan}: `requests` is sorted ascending by
 * priority; output objects are freshly allocated and carry `datasetId` from
 * {@link PlanningSnapshot.datasetId}.
 */
export function emitPlanRequests(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): { requests: ChunkRequest[] } {
  // Step 2: Build entity lookup.
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const allRequests: ChunkRequest[] = [];
  // Step 3: Detail lane (per active entry).
  emitDetailLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Step 4: Prefetch lane — for tile-mode entries only.
  emitPrefetchLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Step 5: Source-backed coarse context lane.
  emitCoarseLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Step 6: Minimap lane (see ADR 0023). Small seed sets ride the
  // dedicated top lane (priority 0 — the sort puts them first, so the
  // minimap appears within ~1s of dataset open). Bulk seed sets must
  // instead rank strictly behind every request emitted above — lane
  // offsets are not bands (the importance/distance terms are unbounded,
  // so a constant offset cannot outrank a wide view's coarse/detail
  // priorities). The emitter is handed the plan's current maximum
  // priority as the floor its bulk lane must clear; emitting last makes
  // that maximum complete.
  let maxEmittedPriority = 0;
  for (const req of allRequests) {
    if (req.priority > maxEmittedPriority) maxEmittedPriority = req.priority;
  }
  emitMinimapLane(
    snapshot.minimapPending,
    snapshot.entities,
    snapshot.datasetId,
    config,
    maxEmittedPriority + 1,
    allRequests,
  );

  // Step 7: Merge and sort by priority (ascending — lower = more urgent).
  // Equal-priority chunk ties are spatial-first, channel-second so
  // multi-channel upload reaches all channels for focal cells instead
  // of exhausting the budget on one channel's whole grid.
  allRequests.sort(compareChunkRequests);
  return { requests: allRequests };
}

/**
 * Top-level pure planner. `state` is the opaque carry-forward the
 * caller stored from the previous tick's {@link RequestPlan.nextState}.
 *
 * Postconditions:
 *   - `requests` is sorted ascending by `priority`
 *     (lower = more urgent).
 *   - Output objects are freshly allocated; the caller may mutate them.
 *     Every request carries `datasetId` from {@link PlanningSnapshot.datasetId}.
 *   - `epochs.request` = input + 1; other epoch tiles forwarded unchanged.
 *   - `stats` reflects this call only.
 */
export function plan(
  snapshot: PlanningSnapshot,
  state: PlanningState,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): RequestPlan {
  // Dev-mode boundary check (see ADR 0031). Vite dead-code-eliminates
  // this branch in production builds; the validator's source is
  // absent from the shipped bundle.
  if (import.meta.env.DEV) validatePlanningInputs(snapshot, state);

  const stats = emptyPlanStats();

  // Step 1: Resolve each visible entity onto the ordinary chunk path.
  const activeSet = assignChunkModes(snapshot.entities);

  // Steps 2–7: emit + sort the request streams for the resolved active set.
  const { requests } = emitPlanRequests(activeSet, snapshot, stats, config);

  // Step 8: Epoch propagation.
  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  // Step 9: Return. `nextState` is the opaque pointer the caller will
  // hand back on the next tick — today derived from `activeSet`, but
  // future planner-internal state lands here without churning callers.
  const nextState: PlanningState = { previousActiveSet: activeSet };
  return { requests, activeSet, epochs, stats, nextState };
}
