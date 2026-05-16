/**
 * Cold-state telemetry collaborator.
 *
 * Replaces the cluster of ~10 cold-state-telemetry fields and the four
 * private helpers (`recordColdStateHit`, `recordColdStateRebuild`,
 * `pruneColdStateWindow`, `maybeLogColdStateChurn`, `publishColdStateDebug`)
 * that previously lived directly on `Orchestrator`. See Seam H of the
 * dechaos boundary scan and Item 10 of the composability scan.
 *
 * The class owns:
 *   - A rolling 1s ring buffer of hit/rebuild events.
 *   - Cumulative hit / rebuild counters + per-epoch cause attribution.
 *   - A bounded p50/p95 rebuild-duration sample buffer.
 *   - A sustained-non-view-churn detector driven by the shared helper
 *     in `sustained.ts`.
 *
 * The `Orchestrator` calls `recordHit(now)` on each cache-hit tick,
 * `recordRebuild(now, causes, durationMs)` on each rebuild tick, and
 * reads the latest snapshot via `publish()` to attach to
 * `debugStats.orch.coldState`.
 */

import {
  emptyColdStateDebug,
  type ColdStateCauseCounts,
  type ColdStateDebug,
} from "../../../debug/debugStats.ts";
import { debugLog } from "../../../debug/logging.ts";
import {
  COLD_STATE_CHURN_LOG_RATE_LIMIT_MS,
  COLD_STATE_CHURN_SUSTAIN_MS,
  COLD_STATE_CHURN_THRESHOLD_PER_SEC,
  COLD_STATE_DURATION_SAMPLES,
  COLD_STATE_WINDOW_MS,
} from "../constants.ts";
import { SustainedCondition } from "./sustained.ts";

/** Per-epoch cause keys we attribute rebuilds to. */
export type ColdStateCauseKey =
  | "content"
  | "layout"
  | "view"
  | "selection"
  | "asset";

interface ColdStateEvent {
  at: number;
  kind: "hit" | "rebuild";
  /** Empty for hits and for the very first rebuild (no prior epochs to diff). */
  causes: ColdStateCauseKey[];
  /** Wall-clock duration of the rebuild path; undefined for hits. */
  durationMs?: number;
}

export class ColdStateTelemetry {
  /**
   * Rolling 1s window of cold-state events. Each tick of `planAndFetch`
   * appends one entry (either a hit or a rebuild); entries older than
   * `COLD_STATE_WINDOW_MS` are pruned on every `record*` call.
   */
  private coldStateEvents: ColdStateEvent[] = [];
  private coldStateRebuildCount = 0;
  private coldStateHitCount = 0;
  private coldStateCauseTotal: ColdStateCauseCounts = {
    content: 0,
    layout: 0,
    view: 0,
    selection: 0,
    asset: 0,
  };
  /** Bounded sample buffer for p50/p95 rebuild duration. FIFO. */
  private coldStateRebuildDurations: number[] = [];
  private coldStateLastRebuildAt = 0;
  private coldStateLastRebuildMs: number | null = null;
  /**
   * Cached `ColdStateDebug` snapshot. Recomputed on every `record*`
   * call so `publish()` is a cheap return.
   */
  private coldStateDebug: ColdStateDebug = emptyColdStateDebug();

  /**
   * Sustained-non-view-churn detector. Camera motion legitimately bumps
   * `view` at high rates, so non-view causes are what trigger this.
   * The condition is "non-view rebuilds in the last 1s > threshold"; the
   * payload reports the dominant cause + per-cause counts.
   */
  private readonly churnDetector = new SustainedCondition({
    sustainMs: COLD_STATE_CHURN_SUSTAIN_MS,
    rateLimitMs: COLD_STATE_CHURN_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "cold_state.churn", payload as Record<string, unknown>),
  });

  /** Record a cache-hit tick (planAndFetch took the epoch fast-path). */
  recordHit(now: number): void {
    this.coldStateHitCount++;
    this.coldStateEvents.push({ at: now, kind: "hit", causes: [] });
    this.pruneWindow(now);
    this.refreshSnapshot();
  }

  /** Record a rebuild tick with cause attribution + wall-clock duration. */
  recordRebuild(
    now: number,
    causes: ColdStateCauseKey[],
    durationMs: number,
  ): void {
    this.coldStateRebuildCount++;
    for (const c of causes) this.coldStateCauseTotal[c]++;
    this.coldStateLastRebuildAt = now;
    this.coldStateLastRebuildMs = durationMs;
    this.coldStateRebuildDurations.push(durationMs);
    if (this.coldStateRebuildDurations.length > COLD_STATE_DURATION_SAMPLES) {
      this.coldStateRebuildDurations.shift();
    }
    this.coldStateEvents.push({ at: now, kind: "rebuild", causes, durationMs });
    this.pruneWindow(now);
    this.checkChurn(now);
    this.refreshSnapshot();
  }

  /**
   * Build (and return the latest) cold-state debug snapshot. The
   * underlying snapshot is recomputed on every `record*` call, so this
   * is a constant-time return.
   *
   * Used by `Orchestrator.planAndFetch` to attach to
   * `debugStats.orch.coldState` in both the cache-hit and rebuild
   * branches.
   */
  publish(): ColdStateDebug {
    return this.coldStateDebug;
  }

  /** Prune events older than the rolling window. */
  private pruneWindow(now: number): void {
    const cutoff = now - COLD_STATE_WINDOW_MS;
    while (
      this.coldStateEvents.length > 0 &&
      this.coldStateEvents[0].at < cutoff
    ) {
      this.coldStateEvents.shift();
    }
  }

  /**
   * Sustained-non-view-churn detector. View-epoch churn is expected
   * during camera motion; any *other* epoch sustaining above the
   * threshold fires one rate-limited `cold_state.churn` log line with
   * the dominant cause.
   */
  private checkChurn(now: number): void {
    let nonViewRebuilds = 0;
    const causeCounts: Record<string, number> = {};
    for (const e of this.coldStateEvents) {
      if (e.kind !== "rebuild") continue;
      let nonView = false;
      for (const c of e.causes) {
        if (c === "view") continue;
        nonView = true;
        causeCounts[c] = (causeCounts[c] ?? 0) + 1;
      }
      if (nonView) nonViewRebuilds++;
    }

    const above = nonViewRebuilds > COLD_STATE_CHURN_THRESHOLD_PER_SEC;
    this.churnDetector.tick(now, above, (sustainedMs) => {
      const dominant =
        Object.entries(causeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
      return {
        rebuildsLastSec: this.coldStateEvents.filter((e) => e.kind === "rebuild").length,
        nonViewRebuildsLastSec: nonViewRebuilds,
        dominantCause: dominant,
        causeCountsLastSec: causeCounts,
        sustainedMs: Math.round(sustainedMs),
      };
    });
  }

  /** Recompute the cached debug snapshot from the rolling window. */
  private refreshSnapshot(): void {
    let rebuilds = 0;
    let hits = 0;
    const causeLastSecond: ColdStateCauseCounts = {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
      asset: 0,
    };
    for (const e of this.coldStateEvents) {
      if (e.kind === "rebuild") {
        rebuilds++;
        for (const c of e.causes) causeLastSecond[c]++;
      } else {
        hits++;
      }
    }
    const total = rebuilds + hits;

    let p50: number | null = null;
    let p95: number | null = null;
    if (this.coldStateRebuildDurations.length > 0) {
      const sorted = [...this.coldStateRebuildDurations].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    this.coldStateDebug = {
      rebuilds: this.coldStateRebuildCount,
      cacheHits: this.coldStateHitCount,
      hitRate: total > 0 ? hits / total : NaN,
      rebuildsLastSecond: rebuilds,
      hitsLastSecond: hits,
      causeLastSecond,
      causeTotal: { ...this.coldStateCauseTotal },
      lastRebuildMs: this.coldStateLastRebuildMs,
      rebuildP50Ms: p50,
      rebuildP95Ms: p95,
      lastRebuildAt: this.coldStateLastRebuildAt,
    };
  }
}
