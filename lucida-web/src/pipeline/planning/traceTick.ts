/**
 * The per-tick aggregate sample, derived from a plan.
 *
 * This deliberately does not reuse the panel-era `debug.ts` snapshot, which
 * ran only while somebody had the debug panel open and took a
 * `CacheStateSnapshot` that allocated a Set per resident entity. Both are gone
 * (ADR 0052). Recording is unconditional (ADR 0049), so this path reads counts
 * the cache already keeps and allocates nothing per tick — the sample it fills
 * is the recorder's reusable scratch.
 */

import type { LevelRange } from "../../renderer/workerProtocol.ts";
import { traceRecorder, type TraceRecorder } from "../../trace/recorder.ts";
import { TickCounter } from "../../trace/types.ts";
import type { EntitySnapshot, RequestPlan } from "./types.ts";
import type { Lane, LevelResidency } from "../fetch/types.ts";

/**
 * Which counter each lane feeds. A map rather than a switch, so adding a lane
 * is a compile error here instead of silently landing in whichever branch the
 * default happened to be.
 */
const LANE_COUNTERS: Record<Lane, number> = {
  minimap: TickCounter.LaneMinimap,
  detail: TickCounter.LaneDetail,
  coarse: TickCounter.LaneCoarse,
  prefetch: TickCounter.LanePrefetch,
  overview: TickCounter.LaneOverview,
};

/**
 * Record one dataset's planning aggregate for this tick. A no-op when no run
 * is open, like every other tier.
 *
 * `entities` are the snapshot the plan was built from; the target level is
 * read off them rather than off the plan's active set because the pin flag
 * lives only there. `displayed` is the render worker's last word on which
 * levels are on screen for this dataset, which the planner cannot know and
 * which therefore lags the target by one report.
 */
export function recordPlanningTick(
  datasetId: string,
  plan: RequestPlan,
  residency: LevelResidency,
  entities: readonly EntitySnapshot[],
  displayed: LevelRange | null,
  recorder: TraceRecorder = traceRecorder,
): void {
  const tick = recorder.beginTick(datasetId);
  if (!tick) return;

  for (const request of plan.requests) {
    tick.counters[LANE_COUNTERS[request.lane]]++;
    tick.addPlanned(request.level);
  }

  tick.counters[TickCounter.PlannedChunks] = plan.requests.length;
  tick.counters[TickCounter.ProxyRequests] = plan.proxyRequests.length;
  tick.counters[TickCounter.CullingConsidered] = plan.stats.culling.considered;
  tick.counters[TickCounter.CullingAfterXyBounds] = plan.stats.culling.afterXyBounds;
  tick.counters[TickCounter.CullingAfterZRange] = plan.stats.culling.afterZRange;
  tick.counters[TickCounter.CullingAfterFrustum] = plan.stats.culling.afterFrustum;

  // Tallied over the whole active set, not the row-capped slice the panel
  // renders. Invisible entries carry no mode and are counted in
  // none of the three, so they sum to at most the total.
  tick.counters[TickCounter.ActiveSetTotal] = plan.activeSet.length;
  for (const entry of plan.activeSet) {
    if (entry.kind === "group-as-proxy") {
      tick.counters[TickCounter.ActiveSetGroupAsProxy]++;
    } else if (entry.kind === "invisible") {
      continue;
    } else if (entry.mode === "tiles-with-proxy-fallback") {
      tick.counters[TickCounter.ActiveSetTilesProxyFallback]++;
    } else if (entry.mode === "tiles-with-detail") {
      tick.counters[TickCounter.ActiveSetTilesDetail]++;
    }
  }

  const levels = Math.max(residency.cached.length, residency.inFlight.length);
  for (let level = 0; level < levels; level++) {
    const cached = residency.cached[level] ?? 0;
    const inFlight = residency.inFlight[level] ?? 0;
    if (cached === 0 && inFlight === 0) continue;
    tick.setResidency(level, cached, inFlight);
  }

  // Mirrors summarizeDatasetLevels, the layer panel's readout, so the trace
  // and the panel carry the same numbers: visible image-bearing entities, or
  // every such entity when none is in view. A group renders through its
  // tiles. The pin is per dataset, so any one entity's flag is the dataset's.
  // A hand loop rather than the summary because this runs on every planning
  // pass and must not allocate.
  let visibleMin = Infinity;
  let visibleMax = -Infinity;
  let anyMin = Infinity;
  let anyMax = -Infinity;
  let pinned = false;
  for (const entity of entities) {
    if (entity.kind === "Group") continue;
    const level = entity.targetLevel;
    pinned = entity.levelPinned;
    if (level < anyMin) anyMin = level;
    if (level > anyMax) anyMax = level;
    if (!entity.visible) continue;
    if (level < visibleMin) visibleMin = level;
    if (level > visibleMax) visibleMax = level;
  }
  if (visibleMin !== Infinity) tick.setTargetLevel(visibleMin, visibleMax, pinned);
  else if (anyMin !== Infinity) tick.setTargetLevel(anyMin, anyMax, pinned);
  tick.setDisplayedLevel(displayed);

  recorder.commitTick();
}
