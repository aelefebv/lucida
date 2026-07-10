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
  emitOverviewLane,
  emitPrefetchLane,
} from "./emit.ts";
import { assignCoarseDetailModes, assignModes } from "./modes.ts";
import {
  emptyPlanStats,
  type ActiveSetEntry,
  type ChunkRequest,
  type EntitySnapshot,
  type PlanningSnapshot,
  type PlanStats,
  type PlanningState,
  type ProxyRequest,
  type RequestPlan,
} from "./types.ts";
import { validatePlanningInputs } from "./validate.ts";

function compareChunkRequests(a: ChunkRequest, b: ChunkRequest): number {
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

function compareProxyRequests(a: ProxyRequest, b: ProxyRequest): number {
  const priority = a.priority - b.priority;
  if (priority !== 0) return priority;
  return (
    a.datasetId.localeCompare(b.datasetId) ||
    a.entityId.localeCompare(b.entityId) ||
    a.kind.localeCompare(b.kind) ||
    a.t - b.t ||
    a.c - b.c
  );
}

/**
 * Emit the chunk + proxy request streams for an ALREADY-RESOLVED active set.
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
 * would produce for that selection — with none of `assignModes`' work.
 *
 * Postconditions match {@link plan}: `requests` and `proxyRequests` are sorted
 * ascending by priority; output objects are freshly allocated and carry
 * `datasetId` from {@link PlanningSnapshot.datasetId}.
 */
export function emitPlanRequests(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): { requests: ChunkRequest[]; proxyRequests: ProxyRequest[] } {
  // Step 2: Build entity lookup.
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const allRequests: ChunkRequest[] = [];
  const proxyRequests: ProxyRequest[] = [];

  // Track group-proxy requests we've already emitted (one per
  // (groupId, t, c)) so multiple tiles-with-proxy-fallback tiles of
  // the same group don't each push a duplicate parent-group request.
  const groupProxyEmitted = new Set<string>();

  // Step 3: Detail / proxy lane (per active entry).
  emitDetailLane(
    activeSet,
    snapshot,
    entityById,
    stats,
    allRequests,
    proxyRequests,
    groupProxyEmitted,
    config,
  );

  // Step 4: Prefetch lane — for tile-mode entries only.
  emitPrefetchLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Step 5: Context fallback lane. The bridge emits explicit coarse
  // tier chunks; the legacy path keeps the old overview migration lane.
  if (config.coarseDetailEnabled) {
    emitCoarseLane(activeSet, snapshot, entityById, stats, allRequests, config);
  } else {
    emitOverviewLane(snapshot.entities, snapshot, stats, allRequests, config);
  }

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
  proxyRequests.sort(compareProxyRequests);

  return { requests: allRequests, proxyRequests };
}

/**
 * Top-level pure planner. `state` is the opaque carry-forward the
 * caller stored from the previous tick's {@link RequestPlan.nextState}.
 *
 * Postconditions:
 *   - `requests` and `proxyRequests` are sorted ascending by `priority`
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

  // Step 1: Resolve residency entries. The coarse/detail bridge bypasses
  // proxy promotion while the legacy path preserves the three-tier model.
  const activeSet = config.coarseDetailEnabled
    ? assignCoarseDetailModes(snapshot.entities)
    : assignModes(
        snapshot.entities,
        state.previousActiveSet,
        snapshot.assetCatalog,
        stats,
        config,
      );

  // Steps 2–7: emit + sort the request streams for the resolved active set.
  const { requests, proxyRequests } = emitPlanRequests(activeSet, snapshot, stats, config);

  // Step 8: Epoch propagation.
  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  // Step 9: Return. `nextState` is the opaque pointer the caller will
  // hand back on the next tick — today derived from `activeSet`, but
  // future planner-internal state lands here without churning callers.
  const nextState: PlanningState = { previousActiveSet: activeSet };
  return { requests, activeSet, epochs, proxyRequests, stats, nextState };
}
