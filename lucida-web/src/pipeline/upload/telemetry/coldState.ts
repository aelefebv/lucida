/**
 * Cold-state rebuild telemetry. Owns a rolling 1s ring buffer of
 * hit/rebuild events, cumulative counters, and a non-view-churn detector.
 *
 * It also used to keep a windowed rates/percentiles snapshot for the debug
 * panel's Orch tab. That reader is gone with ADR 0049's gate and nothing
 * replaced it, so the snapshot went too rather than being recomputed on every
 * rebuild for nobody — the churn detector below is what survives, and it
 * counts what it needs itself. See the recorder-cost ledger for the
 * absorption ADR 0052 promised those rates and the trace does not yet carry.
 */

import { debugLog } from "../../../debug/logging.ts";
import {
  COLD_STATE_CHURN_LOG_RATE_LIMIT_MS,
  COLD_STATE_CHURN_SUSTAIN_MS,
  COLD_STATE_CHURN_THRESHOLD_PER_SEC,
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
  /** Empty for hits and the very first rebuild (no prior epochs to diff). */
  causes: ColdStateCauseKey[];
  durationMs?: number;
}

export class ColdStateTelemetry {
  private coldStateEvents: ColdStateEvent[] = [];
  private coldStateRebuildCount = 0;
  private coldStateHitCount = 0;

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
  }

  recordRebuild(
    now: number,
    causes: ColdStateCauseKey[],
    durationMs: number,
  ): void {
    this.coldStateRebuildCount++;
    this.coldStateEvents.push({ at: now, kind: "rebuild", causes, durationMs });
    this.pruneWindow(now);
    this.checkChurn(now);
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

}
