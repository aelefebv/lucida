/**
 * Planning domain — top-level pure planner.
 *
 * Composes promotion, chunk iteration, and three-lane scheduling into a
 * single {@link RequestPlan}. The body is small by design — the actual
 * work lives in {@link assignModes} (mode decisions), the lane emitters
 * in `./emit.ts`, and the chunk-iteration helpers in `./chunks.ts`.
 *
 * See ADR 0029.
 */

import type { SceneEpochs } from "../epochs.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import {
  emitDetailLane,
  emitMinimapLane,
  emitOverviewLane,
  emitPrefetchLane,
} from "./emit.ts";
import { assignModes } from "./modes.ts";
import {
  emptyPlanStats,
  type ChunkRequest,
  type EntitySnapshot,
  type PlanningSnapshot,
  type PlanningState,
  type ProxyRequest,
  type RequestPlan,
} from "./types.ts";
import { validatePlanningInputs } from "./validate.ts";

/**
 * Top-level pure planning function. Composes promotion, chunk
 * iteration, and three-lane scheduling into a single {@link RequestPlan}.
 *
 * Three-way decomposition:
 *   - `snapshot` — the world this tick (entities, region, selection, …).
 *   - `state` — opaque carry-forward state from the previous tick (the
 *     pointer the caller stored from the previous {@link RequestPlan.nextState}).
 *   - `config` — planning tunables (live-twistable from the debug panel).
 *
 * Postconditions:
 *   - `requests` and `proxyRequests` are sorted ascending by `priority`
 *     (lower value = more urgent).
 *   - All output objects are freshly allocated; the caller may mutate
 *     them. Every request carries `datasetId` stamped from
 *     {@link PlanningSnapshot.datasetId} at emit time (the orchestrator
 *     does not post-`plan()` mutate it).
 *   - `epochs.request` is the input epoch + 1; other epoch fields are
 *     forwarded unchanged so consumers can detect plan freshness.
 *   - `stats` reflects work done in this call only — no carry-forward.
 *   - `nextState` is the opaque carry-forward state for the next tick.
 *     v1: `{ previousActiveSet: activeSet }`. The caller stores it and
 *     hands it back unchanged on the next call.
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

  // Step 1: Promote (three-tier, S6).
  const activeSet = assignModes(
    snapshot.entities,
    state.previousActiveSet,
    snapshot.assetCatalog,
    stats,
    config,
  );

  // Step 2: Build entity lookup.
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const allRequests: ChunkRequest[] = [];
  const proxyRequests: ProxyRequest[] = [];

  // Track well-proxy requests we've already emitted (one per
  // (wellId, t, c)) so multiple fields-with-proxy-fallback fields of
  // the same well don't each push a duplicate parent-well request.
  const wellProxyEmitted = new Set<string>();

  // Step 3: Minimap lane — highest priority (see ADR 0023). Emitted
  // before detail so the minimap appears within ~1s of dataset open
  // instead of after detail finishes.
  emitMinimapLane(
    snapshot.minimapPending,
    snapshot.entities,
    snapshot.datasetId,
    config,
    allRequests,
  );

  // Step 4: Detail / proxy lane (per active entry).
  emitDetailLane(
    activeSet,
    snapshot,
    entityById,
    stats,
    allRequests,
    proxyRequests,
    wellProxyEmitted,
    config,
  );

  // Step 5: Prefetch lane — for field-mode entries only.
  emitPrefetchLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Step 6: Overview lane.
  emitOverviewLane(snapshot.entities, snapshot, stats, allRequests, config);

  // Step 7: Merge and sort by priority (ascending — lower = more urgent).
  allRequests.sort((a, b) => a.priority - b.priority);
  proxyRequests.sort((a, b) => a.priority - b.priority);

  // Step 8: Epoch propagation.
  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  // Step 9: Return. `nextState` is the opaque pointer the caller will
  // hand back on the next tick — today derived from `activeSet`, but
  // future planner-internal state lands here without churning callers.
  const nextState: PlanningState = { previousActiveSet: activeSet };
  return { requests: allRequests, activeSet, epochs, proxyRequests, stats, nextState };
}
