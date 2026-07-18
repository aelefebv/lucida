/**
 * Cold-state rebuild telemetry. Owns a rolling 1s ring buffer of
 * hit/rebuild events, cumulative + windowed counters, per-epoch cause
 * attribution, a p50/p95 duration sketch, and a non-view-churn detector.
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
  | "selection";

interface ColdStateEvent {
  at: number;
  kind: "hit" | "rebuild";
  /** Empty for hits and the very first rebuild (no prior epochs to diff). */
  causes: ColdStateCauseKey[];
  durationMs?: number;
}

export class ColdStateTelemetry {
  private coldStateEvents: ColdStateEvent[] = [];
  private coldStateRebuildCount = 0;
  private coldStateHitCount = 0;
  private coldStateCauseTotal: ColdStateCauseCounts = {
    content: 0,
    layout: 0,
    view: 0,
    selection: 0,
  };
  /** FIFO sample buffer for p50/p95 rebuild duration. */
  private coldStateRebuildDurations: number[] = [];
  private coldStateLastRebuildAt = 0;
  private coldStateLastRebuildMs: number | null = null;
  /** Recomputed on every `record*` call so `publish()` is a cheap return. */
  private coldStateDebug: ColdStateDebug = emptyColdStateDebug();

  /**
   * Non-view churn detector. Camera motion legitimately bumps `view` at
   * high rates, so only non-view causes can trigger it.
   */
  private readonly churnDetector = new SustainedCondition({
    sustainMs: COLD_STATE_CHURN_SUSTAIN_MS,
    rateLimitMs: COLD_STATE_CHURN_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "cold_state.churn", payload as Record<string, unknown>),
  });

  /** Called when planAndFetch took the epoch fast-path. */
  recordHit(now: number): void {
    this.coldStateHitCount++;
    this.coldStateEvents.push({ at: now, kind: "hit", causes: [] });
    this.pruneWindow(now);
    this.refreshSnapshot();
  }

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

  /** O(1) — the underlying snapshot is recomputed on every `record*`. */
  publish(): ColdStateDebug {
    return this.coldStateDebug;
  }

  private pruneWindow(now: number): void {
    const cutoff = now - COLD_STATE_WINDOW_MS;
    while (
      this.coldStateEvents.length > 0 &&
      this.coldStateEvents[0].at < cutoff
    ) {
      this.coldStateEvents.shift();
    }
  }

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

  private refreshSnapshot(): void {
    let rebuilds = 0;
    let hits = 0;
    const causeLastSecond: ColdStateCauseCounts = {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
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
