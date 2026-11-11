/**
 * Top-level pure planner. Composes active-set assignment, the core's chunk
 * enumeration, and lane scheduling into a {@link RequestPlan}, for every view
 * of a dataset at once.
 */

import type { SceneEpochs } from "../epochs.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import {
  emitCoarseLane,
  emitDetailLane,
  emitMinimapLane,
  emitPrefetchLane,
  enumeratePlanChunks,
  isCutStep,
  LaneRequests,
} from "./emit.ts";
import { buildActiveSet } from "./activeSet.ts";
import {
  emptyPlanStats,
  initialViewPlanningState,
  type ActiveSetEntry,
  type ChunkRequest,
  type EntitySnapshot,
  type PlanningSnapshot,
  type PlanStats,
  type PlanningState,
  type RequestPlan,
  type ViewPlanningState,
  type ViewSnapshot,
  type ZoomDirection,
} from "./types.ts";
import { validatePlanningInputs } from "./validate.ts";

function resolveZoomDirection(
  state: ViewPlanningState,
  effectiveZoom: number,
): ZoomDirection | null {
  const previous = state.previousEffectiveZoom;
  if (previous === null || effectiveZoom === previous) return state.zoomDirection;
  return effectiveZoom > previous ? "in" : "out";
}

/** One view's lanes, as the plan resolved them for this pass. */
interface ViewLanes {
  view: ViewSnapshot;
  activeSet: ActiveSetEntry[];
  zoomDirection: ZoomDirection | null;
  /** The selection stepped along its cut since the view's last plan ({@link isCutStep}). */
  cutStep: boolean;
}

/** What `view` carried from its last plan, or its state before its first. */
function viewState(state: PlanningState, view: ViewSnapshot): ViewPlanningState {
  return state.views.get(view.view) ?? initialViewPlanningState();
}

/**
 * Every view's lanes into one request list, sorted ascending by priority.
 * The minimap lane follows them once for the dataset, from the first view's
 * members, since every view lists every member.
 */
function emitLanes(
  snapshot: PlanningSnapshot,
  views: readonly ViewLanes[],
  stats: PlanStats,
  config: PlanningConfig,
): ChunkRequest[] {
  const lanes = new LaneRequests();
  for (const { view, activeSet, zoomDirection, cutStep } of views) {
    const input = { ...view, datasetId: snapshot.datasetId };
    const entityById = new Map<string, EntitySnapshot>();
    for (const entity of view.entities) entityById.set(entity.entityId, entity);
    const chunks = enumeratePlanChunks(activeSet, input, entityById, config, zoomDirection);
    emitDetailLane(chunks, input, stats, lanes, config);
    emitPrefetchLane(chunks, input, stats, lanes, config, cutStep);
    emitCoarseLane(chunks, input, stats, lanes, config);
  }

  // Minimap goes last: its bulk lane ranks behind every band above it.
  emitMinimapLane(
    snapshot.minimapPending,
    views[0]?.view.entities ?? [],
    snapshot.datasetId,
    config,
    Math.max(0, lanes.topBand) + 1,
    lanes,
    views[0]?.view.selection.renderMode,
  );

  const requests = lanes.finish();
  return views.length > 1 ? distinctRequests(requests) : requests;
}

/**
 * `requests`, sorted, with each chunk two views ask for alike kept once, at
 * the more urgent of the two priorities. Views of two modes never ask alike,
 * since each mode's pools need the chunk sent to them.
 */
function distinctRequests(requests: ChunkRequest[]): ChunkRequest[] {
  const seen = new Set<string>();
  return requests.filter((req) => {
    const key = [
      req.imageId, req.tier, req.mode, req.chunkKey, req.planeAxis ?? "", req.plane ?? "", req.planes?.join(",") ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The views' active sets as one, the set pools the views share hold: an
 * entity any view shows is a tile holding every view's detail levels, finest
 * first. One view's set is returned as it is.
 */
export function mergeActiveSets(sets: readonly ActiveSetEntry[][]): ActiveSetEntry[] {
  if (sets.length === 1) return sets[0];
  const merged = new Map<string, ActiveSetEntry>();
  for (const set of sets) {
    for (const entry of set) {
      const held = merged.get(entry.entityId);
      merged.set(entry.entityId, held === undefined ? entry : mergeEntries(held, entry));
    }
  }
  return [...merged.values()];
}

function mergeEntries(a: ActiveSetEntry, b: ActiveSetEntry): ActiveSetEntry {
  if (b.kind === "invisible") return a;
  if (a.kind === "invisible") return b;
  return {
    ...a,
    detailLevels: [...new Set([...a.detailLevels, ...b.detailLevels])].sort((x, y) => x - y),
    // Not null exactly when the coarse level is no finer than the target,
    // so a view targeting a finer level keeps it.
    coarseLevel: a.coarseLevel ?? b.coarseLevel,
  };
}

/**
 * Emit the chunk requests for active sets already resolved: each view's own,
 * from `state`. Lets a caller regenerate requests for a T scrub or a move
 * along the cut without `buildActiveSet`. A scrub is not a zoom, so each
 * view's stored `zoomDirection` applies, and a view whose selection stepped
 * along its cut since `state` was planned fetches the step's chunks
 * ({@link isCutStep}). The result matches a full {@link plan} for that
 * selection. Postconditions match {@link plan}; mutates only `stats`.
 */
export function emitPlanRequests(
  snapshot: PlanningSnapshot,
  state: PlanningState,
  stats: PlanStats,
  config: PlanningConfig,
): ChunkRequest[] {
  const views = snapshot.views.map((view): ViewLanes => {
    const before = viewState(state, view);
    return {
      view,
      activeSet: before.activeSet,
      zoomDirection: before.zoomDirection,
      cutStep: isCutStep(before.previousCut, view.selection, config.sliceBandPlanes),
    };
  });
  return emitLanes(snapshot, views, stats, config);
}

/**
 * `state` after {@link emitPlanRequests} served `snapshot`: each view
 * remembers the cut it now stands at, and keeps its active set and zoom.
 */
export function scrubbedPlanningState(snapshot: PlanningSnapshot, state: PlanningState): PlanningState {
  const views = new Map(state.views);
  for (const view of snapshot.views) {
    views.set(view.view, { ...viewState(state, view), previousCut: view.selection.cut });
  }
  return { previousActiveSet: state.previousActiveSet, views };
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
  const views = new Map<number, ViewPlanningState>();
  const lanes = snapshot.views.map((view): ViewLanes => {
    const before = viewState(state, view);
    const activeSet = buildActiveSet(view.entities);
    const effectiveZoom = view.visibleRegion.effectiveZoom;
    const zoomDirection = resolveZoomDirection(before, effectiveZoom);
    views.set(view.view, {
      activeSet,
      previousEffectiveZoom: effectiveZoom,
      zoomDirection,
      previousCut: view.selection.cut,
    });
    return {
      view,
      activeSet,
      zoomDirection,
      cutStep: isCutStep(before.previousCut, view.selection, config.sliceBandPlanes),
    };
  });
  const requests = emitLanes(snapshot, lanes, stats, config);
  const activeSet = mergeActiveSets(lanes.map((view) => view.activeSet));

  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  const nextState: PlanningState = { previousActiveSet: activeSet, views };
  return { requests, activeSet, epochs, stats, nextState };
}
