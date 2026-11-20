/**
 * Top-level pure planner. Composes active-set assignment from the level
 * selection, the core's chunk enumeration, and lane scheduling into a
 * {@link RequestPlan}, for every view of a dataset at once.
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
import { LaneCarry, laneScope } from "./laneMemory.ts";
import { buildActiveSet } from "./activeSet.ts";
import {
  emptyPlanStats,
  initialViewPlanningState,
  type ActiveSetEntry,
  type ChunkRequest,
  type EntitySnapshot,
  type LaneMemory,
  type RequestDelta,
  type PlanningSnapshot,
  type PlanStats,
  type PlanningState,
  type RequestPlan,
  type ViewPlanningState,
  type ViewSnapshot,
} from "./types.ts";
import { validatePlanningInputs } from "./validate.ts";

/** One view's lanes, as the plan resolved them for this pass. */
interface ViewLanes {
  view: ViewSnapshot;
  activeSet: ActiveSetEntry[];
  /** The selection stepped along its cut since the view's last plan ({@link isCutStep}). */
  cutStep: boolean;
}

/** What `view` carried from its last plan, or its state before its first. */
function viewState(state: PlanningState, view: ViewSnapshot): ViewPlanningState {
  return state.views.get(view.view) ?? initialViewPlanningState();
}

/** What {@link emitLanes} makes of every view's lanes. */
interface EmittedLanes {
  requests: readonly ChunkRequest[];
  byView?: Map<number, ChunkRequest[]>;
  /** How the requests differ from the previous plan's, when they were carried from it. */
  delta?: RequestDelta;
  /** What the next plan of the one view carries from; absent with several views. */
  memory?: LaneMemory;
}

/**
 * Every view's lanes into one request list, sorted ascending by priority.
 * The minimap lane follows them once for the dataset, from the first view's
 * members, since every view lists every member.
 *
 * With `memory`, a view that plans the dataset alone carries what its lanes
 * emitted last time from `memory.previous`, and records what the next plan
 * carries (`laneMemory.ts`).
 */
function emitLanes(
  snapshot: PlanningSnapshot,
  views: readonly ViewLanes[],
  stats: PlanStats,
  config: PlanningConfig,
  memory?: { previous: LaneMemory | null },
): EmittedLanes {
  const carry = memory !== undefined && views.length === 1
    ? new LaneCarry(memory.previous, laneScope({ ...views[0].view, datasetId: snapshot.datasetId }, snapshot.epochs, config))
    : undefined;
  const lanes = new LaneRequests(carry);
  // With several views, what each asks for of its own, which its coverage
  // is counted against: its detail and coarse lanes, before two views'
  // requests for one chunk fold into one.
  const byView = views.length > 1 ? new Map<number, ChunkRequest[]>() : undefined;
  for (const { view, activeSet, cutStep } of views) {
    const input = { ...view, datasetId: snapshot.datasetId };
    const entityById = new Map<string, EntitySnapshot>();
    for (const entity of view.entities) entityById.set(entity.entityId, entity);
    const chunks = enumeratePlanChunks(activeSet, input, entityById, config);
    const from = lanes.count;
    emitDetailLane(chunks, input, lanes, config, carry);
    emitPrefetchLane(chunks, input, lanes, config, cutStep);
    emitCoarseLane(chunks, input, stats, lanes, config);
    if (view.view === snapshot.leadingView) lanes.lead(from);
    byView?.set(view.view, lanes.since(from).filter((req) => req.lane !== "prefetch"));
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
  if (carry !== undefined) return carry.finish(requests);
  if (!byView) return { requests };
  fetchContestedChunksWhole(requests);
  return { requests: distinctRequests(requests), byView };
}

/**
 * Fetch whole each chunk two views ask for different planes of, keeping the
 * plane each draws. The CPU cache holds a chunk once, whole or as some of its
 * planes, so planes of it along two axes, as two slice views crossing in it
 * ask for, would each replace the other as they land and neither view would
 * settle. Bands along one axis widen to one band holding both.
 */
function fetchContestedChunksWhole(requests: readonly ChunkRequest[]): void {
  const byChunk = new Map<string, ChunkRequest[]>();
  for (const req of requests) {
    if (!req.planes) continue;
    const key = `${req.entityId}|${req.tier}|${req.chunkKey}`;
    const held = byChunk.get(key);
    if (held) held.push(req);
    else byChunk.set(key, [req]);
  }
  for (const contested of byChunk.values()) {
    if (contested.length < 2) continue;
    const axis = contested[0].planeAxis ?? "z";
    if (contested.some((req) => (req.planeAxis ?? "z") !== axis)) {
      for (const req of contested) delete req.planes;
      continue;
    }
    const band: [number, number] = [
      Math.min(...contested.map((req) => req.planes![0])),
      Math.max(...contested.map((req) => req.planes![1])),
    ];
    for (const req of contested) req.planes = band;
  }
}

/**
 * What makes two requests ask for one thing: the chunk, its tier, the pools
 * it fills, and the planes drawn from it.
 */
export function requestIdentity(req: ChunkRequest): string {
  return [
    req.imageId, req.tier, req.mode, req.chunkKey, req.planeAxis ?? "", req.plane ?? "", req.planes?.join(",") ?? "",
    req.cut ? `${req.cut.axis}${req.cut.plane}` : "",
  ].join("|");
}

/**
 * `requests`, sorted, with each chunk two views ask for alike kept once, at
 * the more urgent of the two priorities. Views of two modes never ask alike,
 * since each mode's pools need the chunk sent to them.
 */
function distinctRequests(requests: ChunkRequest[]): ChunkRequest[] {
  const seen = new Set<string>();
  return requests.filter((req) => {
    const key = requestIdentity(req);
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
    targetLevel: b.targetLevel === undefined ? a.targetLevel : Math.min(a.targetLevel ?? b.targetLevel, b.targetLevel),
    detailLevels: [...new Set([...a.detailLevels, ...b.detailLevels])].sort((x, y) => x - y),
    keepsCoarse: (a.keepsCoarse ?? false) || (b.keepsCoarse ?? false),
    // Not null exactly when the coarse level is no finer than the detail
    // levels, so a view drawing finer keeps it.
    coarseLevel: a.coarseLevel ?? b.coarseLevel,
  };
}

/**
 * Emit the chunk requests for active sets already resolved: each view's own,
 * from `state`, with the chunks of each view's level selection in
 * `snapshot`. Lets a caller regenerate requests for a T scrub or a move
 * along the cut without `buildActiveSet`, when the selection's levels are
 * the ones the active sets hold. A view whose selection stepped along its
 * cut since `state` was planned fetches the step's chunks ({@link isCutStep}).
 * The result matches a full {@link plan} for that selection. Postconditions
 * match {@link plan}; mutates only `stats`.
 */
export function emitPlanRequests(
  snapshot: PlanningSnapshot,
  state: PlanningState,
  stats: PlanStats,
  config: PlanningConfig,
): readonly ChunkRequest[] {
  const views = snapshot.views.map((view): ViewLanes => {
    const before = viewState(state, view);
    return {
      view,
      activeSet: before.activeSet,
      cutStep: isCutStep(before.previousCut, view.selection, config.sliceBandPlanes),
    };
  });
  return emitLanes(snapshot, views, stats, config).requests;
}

/**
 * `state` after {@link emitPlanRequests} served `snapshot`: each view
 * remembers the cut it now stands at, and keeps its active set. What its
 * lanes emitted before is not what the stages after the plan now hold, so
 * the next plan emits every request again.
 */
export function scrubbedPlanningState(snapshot: PlanningSnapshot, state: PlanningState): PlanningState {
  const views = new Map(state.views);
  for (const view of snapshot.views) {
    views.set(view.view, { ...viewState(state, view), previousCut: view.selection.cut, lanes: null });
  }
  return { previousActiveSet: state.previousActiveSet, views };
}

/**
 * Top-level pure planner. `state` is the opaque carry-forward the
 * caller stored from the previous tick's {@link RequestPlan.nextState}.
 *
 * Postconditions:
 *   - `requests` is sorted ascending by `priority` (lower = more urgent).
 *   - A request a view carried from its previous plan is that plan's object,
 *     at its priority; every other is freshly allocated. The caller never
 *     mutates them. Every request carries `datasetId` from
 *     {@link PlanningSnapshot.datasetId}.
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
    const activeSet = buildActiveSet(view.entities, view.levelSelection);
    views.set(view.view, { activeSet, previousCut: view.selection.cut, lanes: null });
    return {
      view,
      activeSet,
      cutStep: isCutStep(before.previousCut, view.selection, config.sliceBandPlanes),
    };
  });
  const previous = lanes.length === 1 ? viewState(state, lanes[0].view).lanes : null;
  const { requests, byView, delta, memory } = emitLanes(snapshot, lanes, stats, config, { previous });
  if (memory !== undefined) views.set(lanes[0].view.view, { ...views.get(lanes[0].view.view)!, lanes: memory });
  const activeSet = mergeActiveSets(lanes.map((view) => view.activeSet));

  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  const nextState: PlanningState = { previousActiveSet: activeSet, views };
  return { requests, activeSet, epochs, stats, nextState, ...(byView && { byView }), ...(delta && { delta }) };
}
