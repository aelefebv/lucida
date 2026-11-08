/**
 * Top-level pure planner. Composes active-set assignment + chunk
 * iteration + lane scheduling into a {@link RequestPlan}.
 */

import type { SceneEpochs } from "../epochs.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import {
  emitCoarseLane,
  emitDetailLane,
  emitMinimapLane,
  emitPrefetchLane,
} from "./emit.ts";
import { buildActiveSet } from "./activeSet.ts";
import { compareChunkRequests } from "./chunks.ts";
import {
  emptyPlanStats,
  type ActiveSetEntry,
  type ChunkRequest,
  type EntitySnapshot,
  type PlanningSnapshot,
  type PlanStats,
  type PlanningState,
  type RequestPlan,
  type ZoomDirection,
} from "./types.ts";
import { validatePlanningInputs } from "./validate.ts";

function resolveZoomDirection(
  state: PlanningState,
  effectiveZoom: number,
): ZoomDirection | null {
  const previous = state.previousEffectiveZoom;
  if (previous === null || effectiveZoom === previous) return state.zoomDirection;
  return effectiveZoom > previous ? "in" : "out";
}

/**
 * Emit the chunk requests for an already-resolved active set. Lets a caller regenerate requests for a T scrub or Z-plane move
 * without `buildActiveSet`. Pure in `(activeSet, snapshot, config,
 * zoomDirection)`, so the result matches a full {@link plan} for that
 * selection. A scrub is not a zoom, so the stored `zoomDirection` applies.
 * Postconditions match {@link plan}; mutates only `stats`.
 */
export function emitPlanRequests(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  config: PlanningConfig,
  zoomDirection: ZoomDirection | null,
): ChunkRequest[] {
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const allRequests: ChunkRequest[] = [];

  emitDetailLane(activeSet, snapshot, entityById, stats, allRequests, config);

  emitPrefetchLane(activeSet, snapshot, entityById, stats, allRequests, config, zoomDirection);

  emitCoarseLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Minimap goes last. Its bulk lane must rank behind every request above,
  // and lane offsets are not bands because the importance and distance
  // terms are unbounded, so it gets the plan's maximum priority as a floor.
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

  allRequests.sort(compareChunkRequests);

  return allRequests;
}

/**
 * Top-level pure planner. `state` is the opaque carry-forward the
 * caller stored from the previous tick's {@link RequestPlan.nextState}.
 *
 * Postconditions:
 *   - `requests` is sorted ascending by `priority` (lower = more urgent).
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
  // Dev-mode boundary check. Vite strips this branch and the validator
  // from production builds.
  if (import.meta.env.DEV) validatePlanningInputs(snapshot, state);

  const stats = emptyPlanStats();

  const activeSet = buildActiveSet(snapshot.entities);
  const effectiveZoom = snapshot.visibleRegion.effectiveZoom;
  const zoomDirection = resolveZoomDirection(state, effectiveZoom);

  const requests = emitPlanRequests(activeSet, snapshot, stats, config, zoomDirection);

  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  const nextState: PlanningState = {
    previousActiveSet: activeSet,
    previousEffectiveZoom: effectiveZoom,
    zoomDirection,
  };
  return { requests, activeSet, epochs, stats, nextState };
}
