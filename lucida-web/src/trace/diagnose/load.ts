/**
 * The run's load reading: when its data first drew, when it settled, what
 * the wire delivered, and how much of the wanted set it went without. A perf
 * table reads these beside the verdict, so they live here rather than in
 * each caller.
 */

import type { TraceRun } from "../types.ts";
import { usToMs } from "./phaseRollup.ts";
import { summariseReceived } from "./steadyState.ts";
import type { LoadReading, TierAtSettle } from "./types.ts";

export function deriveLoad(run: TraceRun, tiers: readonly TierAtSettle[]): LoadReading {
  let firstPresentUs: number | null = null;
  let prefetchUs: number | null = null;
  for (const row of run.rows) {
    const present = row.phases.present;
    if (present && (firstPresentUs === null || present.endUs < firstPresentUs)) firstPresentUs = present.endUs;
    if (row.lane !== "prefetch") continue;
    // A prefetched chunk waits for its timepoint before it uploads, so it
    // is done once decoded.
    const landed = row.phases.decode ?? row.phases.wire;
    if (landed && (prefetchUs === null || landed.endUs > prefetchUs)) prefetchUs = landed.endUs;
  }
  const header = run.header;
  // A document from before the page dated its wanted set falls back to the
  // close less the hold it waited out, which counts prefetch in.
  const settleUs =
    header.endReason === "quiescent"
      ? (header.wantedSetMetAtUs ?? Math.max(0, header.durationUs - header.quiescenceHoldMs * 1_000))
      : null;
  return {
    firstFrameMs: firstPresentUs === null ? null : usToMs(firstPresentUs),
    settleMs: settleUs === null ? null : usToMs(settleUs),
    prefetchMs: prefetchUs === null ? null : usToMs(prefetchUs),
    coverageLossChunks: tiers.reduce((sum, tier) => sum + tier.coverageLossChunks, 0),
    received: summariseReceived(run),
  };
}
