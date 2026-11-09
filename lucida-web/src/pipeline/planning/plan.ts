/**
 * Top-level pure planner. Composes active-set assignment, the core's chunk
 * enumeration, and lane scheduling into a {@link RequestPlan}.
 */

import type { SceneEpochs } from "../epochs.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import {
  emitCoarseLane,
  emitDetailLane,
  emitMinimapLane,
  emitPrefetchLane,
  enumeratePlanChunks,
  isZStep,
  LaneRequests,
} from "./emit.ts";
import { buildActiveSet } from "./activeSet.ts";
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
 * zoomDirection, zStep)`, so the result matches a full {@link plan} for
 * that selection. A scrub is not a zoom, so the stored `zoomDirection`
 * applies. `zStep` says the selection stepped along Z since the last plan
 * ({@link isZStep}). Postconditions match {@link plan}; mutates only `stats`.
 */
export function emitPlanRequests(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  config: PlanningConfig,
  zoomDirection: ZoomDirection | null,
  zStep = false,
): ChunkRequest[] {
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const chunks = enumeratePlanChunks(activeSet, snapshot, entityById, config, zoomDirection);
  const lanes = new LaneRequests();

  emitDetailLane(chunks, snapshot, stats, lanes, config);

  emitPrefetchLane(chunks, snapshot, stats, lanes, config, zStep);

  emitCoarseLane(chunks, snapshot, stats, lanes, config);

  // Minimap goes last: its bulk lane ranks behind every band above it.
  emitMinimapLane(
    snapshot.minimapPending,
    snapshot.entities,
    snapshot.datasetId,
    config,
    Math.max(0, lanes.topBand) + 1,
    lanes,
  );

  return lanes.finish();
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

  const zStep = isZStep(state.previousZ, snapshot.selection, config.sliceBandPlanes);
  const requests = emitPlanRequests(activeSet, snapshot, stats, config, zoomDirection, zStep);

  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  const nextState: PlanningState = {
    previousActiveSet: activeSet,
    previousEffectiveZoom: effectiveZoom,
    zoomDirection,
    previousZ: snapshot.selection.z,
  };
  return { requests, activeSet, epochs, stats, nextState };
}
