/**
 * The run's load reading: when its data first drew, when it settled, and what
 * the wire delivered. A perf table reads these beside the verdict, so they
 * live here rather than in each caller.
 */

import type { TraceRun } from "../types.ts";
import { usToMs } from "./phaseRollup.ts";
import { summariseReceived } from "./steadyState.ts";
import type { LoadReading } from "./types.ts";

export function deriveLoad(run: TraceRun): LoadReading {
  let firstPresentUs: number | null = null;
  for (const row of run.rows) {
    const present = row.phases.present;
    if (!present) continue;
    if (firstPresentUs === null || present.endUs < firstPresentUs) firstPresentUs = present.endUs;
  }
  const header = run.header;
  // The close waits out the hold after quiescence last went true, so the
  // view settled that long before the run ended.
  const settleUs =
    header.endReason === "quiescent"
      ? Math.max(0, header.durationUs - header.quiescenceHoldMs * 1_000)
      : null;
  return {
    firstFrameMs: firstPresentUs === null ? null : usToMs(firstPresentUs),
    settleMs: settleUs === null ? null : usToMs(settleUs),
    received: summariseReceived(run),
  };
}
