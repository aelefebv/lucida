/**
 * The limiter summary and the backlog ETA.
 *
 * Queue phases deliberately get no per-chunk ceiling. At the measured p50 of
 * 4.6 s (#899 §3) any per-chunk ceiling either fires on every row or on none,
 * and neither reading is a diagnosis. What is diagnostic is whether the
 * standing backlog will drain: pending divided by the rate admissions are
 * actually completing at, which is the wait a newly planned chunk will see.
 *
 * The drain rate is measured over the **trailing second of the run**. One
 * second matches the rolling-window convention upload telemetry already uses,
 * and it is short enough to track a limiter that changes behaviour mid-run —
 * a rate averaged over a twelve-second run would report the healthy opening as
 * though it were still happening.
 */

import type { TraceRun } from "../types.ts";
import { RULESET } from "./ruleset.ts";
import type { LimiterSummary } from "./types.ts";

/**
 * The one limiter a client can see from inside its own trace. ADR 0050 gives
 * a client its own rows and no aggregate, so the server's read cap is visible
 * only as the wait it imposes — it gets a phase, not a limiter.
 */
const SCHEDULER_ADMISSION = "scheduler.admission";

export function summariseLimiters(run: TraceRun): LimiterSummary[] {
  const readings = run.readings;
  if (readings.length === 0) return [];

  // The cap is inferred, not declared: the trace carries in-flight counts and
  // no configured ceiling, so the highest concurrency the run ever reached is
  // the only ceiling observable from inside it.
  const cap = readings.reduce((max, reading) => Math.max(max, reading.inFlight), 0);
  if (cap <= 0) return [];

  const pinned = readings.filter((reading) => reading.inFlight >= cap).length;
  const pending = readings[readings.length - 1].queueDepth || run.header.outstandingAtSettle.pending;

  const windowUs = RULESET.backlog.windowMs * 1_000;
  const windowStartUs = Math.max(0, run.header.durationUs - windowUs);
  const windowSeconds = Math.max(
    0.001,
    (run.header.durationUs - windowStartUs) / 1_000_000,
  );

  // An admission completes when its row leaves `queue` — the moment the fetch
  // was dispatched, which is what the next chunk in line is waiting for.
  let windowCompletions = 0;
  for (const row of run.rows) {
    const queue = row.phases.queue;
    if (!queue) continue;
    if (queue.endUs >= windowStartUs && queue.endUs <= run.header.durationUs) windowCompletions += 1;
  }

  const drainPerS = Math.round(windowCompletions / windowSeconds);
  return [
    {
      id: SCHEDULER_ADMISSION,
      cap,
      capSource: "observed-max",
      unit: "chunk requests in flight",
      pinnedPct: Math.round((pinned / readings.length) * 100),
      pending,
      drainPerS,
      // Null means "will not drain at the observed rate", which is worse news
      // than a large number rather than an absent one — `willNotDrain` below
      // is what the rule reads.
      backlogEtaS: drainPerS > 0 ? Math.round(pending / drainPerS) : null,
      windowMs: RULESET.backlog.windowMs,
      windowCompletions,
    },
  ];
}

/**
 * Whether a limiter's backlog is a finding.
 *
 * The `pending > cap` guard is what keeps the rule off healthy runs: a backlog
 * no larger than one full set of in-flight slots is the next dispatch, not a
 * queue. Above that, a backlog that needs longer than the ceiling — or that is
 * not draining at all — is the run's binding constraint.
 */
export function backlogExceeded(limiter: LimiterSummary): boolean {
  if (limiter.pending <= limiter.cap) return false;
  if (limiter.backlogEtaS == null) return true;
  return limiter.backlogEtaS > RULESET.backlog.maxEtaS;
}

export function isPinned(limiter: LimiterSummary): boolean {
  return limiter.pinnedPct >= RULESET.occupancy.minPinnedPct;
}
