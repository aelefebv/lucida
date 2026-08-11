/**
 * The per-tick aggregate sample, derived from a plan.
 *
 * Sibling of `debug.ts`, and deliberately not a caller of it: that snapshot
 * exists only while somebody has the debug panel open, and takes a
 * `CacheStateSnapshot` that allocates a Set per resident entity. Recording is
 * unconditional (ADR 0049), so this path reads counts the cache already keeps
 * and allocates nothing per tick — the sample it fills is the recorder's
 * reusable scratch.
 */

import { traceRecorder, type TraceRecorder } from "../../trace/recorder.ts";
import { TickCounter } from "../../trace/types.ts";
import type { RequestPlan } from "./types.ts";
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
 */
export function recordPlanningTick(
  datasetId: string,
  plan: RequestPlan,
  residency: LevelResidency,
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
  tick.counters[TickCounter.CatalogDegradations] = plan.stats.catalogDegradations;

  // Tallied over the whole active set, not the row-capped slice the panel
  // renders. Invisible entries have no promotion mode and are counted in
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

  recorder.commitTick();
}
