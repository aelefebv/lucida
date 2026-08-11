/**
 * The coverage block: what a run measured, and what it did not.
 *
 * On every run, including clean ones. "No stall found" is worth nothing on
 * its own — [#893]'s prototype reported `100% accounted` for a run that was
 * 87% pre-instrument boot — so the honest headline needs its denominator
 * attached, and the denominator is the run's whole wall clock rather than the
 * span between the first and last thing the recorder happened to see.
 *
 * A pure function over the serialised tables. It runs at export, not on the
 * write path: the union of a few thousand spans is nothing next to a
 * lifecycle row's ~75 bytes, and the recorder's own budget (ADR 0049) is
 * spent on recording rather than on interpreting.
 *
 * The judgement about whether a gap could hide the bottleneck lives here, not
 * in each reading surface. A caveat only a careful reader would derive is a
 * caveat most readers will miss, and two surfaces deriving it separately can
 * disagree.
 */

import {
  COUNTED_PHASES,
  type CountedPhase,
  type CoverageGap,
  type CoverageGapKind,
  type CoverageLimit,
  type TraceCoverage,
  type TraceRow,
  type TraceTick,
  type TruncationRecord,
} from "./types.ts";

/**
 * The shortest interval gap worth a line of its own. Ten times the platform's
 * 100 µs clock floor (#897), so anything below it is quantisation rather than
 * a hole. Shorter gaps are still counted in `unaccountedUs` — the arithmetic
 * stays exact — they just do not get named, because a hundred sub-millisecond
 * entries would bury the one that matters.
 */
export const MIN_REPORTED_GAP_US = 1_000;

/**
 * A gap could hide the bottleneck when it is long enough to be one on its own
 * terms *and* a real share of the run.
 *
 * Both halves are load-bearing, and each without the other has a known
 * failure. A share test with no absolute floor fires on a healthy sub-400 ms
 * open, where a fast run still spends most of itself somewhere ([#893]). An
 * absolute floor with no share test fires on every one-minute run, where
 * 300 ms of unaccounted time explains nothing.
 */
const BOTTLENECK_FLOOR_US = 250_000;
const BOTTLENECK_SHARE = 0.1;

/** Constant per kind: the numbers live in the gap's own fields, not in prose. */
const GAP_STATEMENTS: Record<CoverageGapKind, string> = {
  "nothing-recorded":
    "No recorded phase covers any part of this run. Whatever it spent its time on, this build did not time it — read no verdict off it at all.",
  "unrecorded-prefix":
    "Wall clock before the first recorded phase boundary. Page boot and any work that ran before the first lifecycle row existed happened here and is on no row.",
  "unaccounted-interior":
    "Wall clock inside the run that no recorded phase covers. The pipeline was between recorded work, or doing work this build does not instrument.",
  "unrecorded-suffix":
    "Wall clock after the last recorded phase boundary. The run stayed open past the last thing it measured.",
  truncated:
    "The run hit its per-run byte cap and stopped recording. Everything after this offset is unknown, and the record says how much it went on to miss.",
  "ticks-dropped":
    "The per-tick aggregate ring wrapped and overwrote its oldest samples. Elapsed time is unaffected; the early planning detail is gone.",
  "events-dropped":
    "The point-event ring wrapped and overwrote its oldest events. Elapsed time is unaffected; early evictions, retries and failures are gone.",
  "server-rows-dropped":
    "The server declared rows it dropped before sending. Those requests are still bracketed by the browser, but their server-side half is missing.",
};

/**
 * What this instrument cannot measure, on any run, ever. Emitted identically
 * every time and deliberately not conditional on the run: a reader who has
 * just been told a run is clean is exactly the reader who needs to know what
 * a clean run still cannot tell them.
 */
export const STRUCTURAL_LIMITS: readonly CoverageLimit[] = [
  {
    id: "clock-floor",
    statement:
      "The platform resolves time to 100 µs on the main thread and in workers, so any interval shorter than that is unrepresentable rather than small.",
  },
  {
    id: "counted-not-timed",
    statement:
      "Cache admission, worker dispatch and coalesce attach sit below that floor. They are counted per tick and never appear as a duration.",
  },
  {
    id: "queue-floor",
    statement:
      "Behind the admission window the scheduler keeps no per-key stamp, so a request admitted off the backlog dates its queue from the plan pass that enqueued it. Queue time is a floor, not a total.",
  },
  {
    id: "request-remainder",
    statement:
      "The server's clock is never trusted. The unattributed remainder inside a request — network plus socket queue — is reported as a gap on the placement rather than charged to either side.",
  },
  {
    id: "cache-redelivery",
    statement:
      "A chunk re-delivered from the CPU cache within the same page carries no row, so its second upload is not recorded. First deliveries are complete.",
  },
  {
    id: "prefetch-outside-predicate",
    statement:
      "Prefetch is excluded from the quiescence predicate, so a run can close with speculative work still in flight. What was outstanding at settle is in the header.",
  },
  {
    id: "observer-in-phase",
    statement:
      "The recorder's own write sits inside the phase it times. At three orders of magnitude below the clock floor it is unrepresentable, not subtracted.",
  },
];

export interface CoverageInput {
  /** The run's duration; the denominator for the whole block. */
  wallClockUs: number;
  rows: TraceRow[];
  ticks: TraceTick[];
  truncation: TruncationRecord | null;
  ticksDropped: number;
  eventsDropped: number;
  serverRowsDropped: number;
}

export function computeCoverage(input: CoverageInput): TraceCoverage {
  const wallClockUs = Math.max(0, input.wallClockUs);
  const covered = mergeSpans(input.rows, wallClockUs);
  const accountedUs = covered.reduce((total, span) => total + (span[1] - span[0]), 0);

  // A truncated run measured nothing past its offset, so scanning the tail
  // for interval gaps would only re-describe the truncation in weaker words.
  const scanEndUs = input.truncation ? Math.min(input.truncation.atUs, wallClockUs) : wallClockUs;

  const gaps: CoverageGap[] = [];
  for (const [startUs, endUs] of uncovered(covered, scanEndUs)) {
    const durationUs = endUs - startUs;
    if (durationUs < MIN_REPORTED_GAP_US) continue;
    gaps.push(intervalGap(intervalKind(startUs, endUs, scanEndUs), startUs, endUs, wallClockUs));
  }

  if (input.truncation) {
    gaps.push({
      kind: "truncated",
      startUs: scanEndUs,
      endUs: wallClockUs,
      durationUs: Math.max(0, wallClockUs - scanEndUs),
      records: unrecordedRecords(input.truncation),
      // Unconditionally: the run stopped looking, so the remainder is not
      // merely unmeasured, it is unbounded.
      couldHideBottleneck: true,
      statement: GAP_STATEMENTS.truncated,
    });
  }

  for (const [kind, records] of [
    ["ticks-dropped", input.ticksDropped],
    ["events-dropped", input.eventsDropped],
    ["server-rows-dropped", input.serverRowsDropped],
  ] as const) {
    if (records <= 0) continue;
    gaps.push({
      kind,
      startUs: null,
      endUs: null,
      durationUs: 0,
      records,
      // A dropped record costs detail, not elapsed time: the wall clock it
      // described is still bracketed by rows that did survive.
      couldHideBottleneck: false,
      statement: GAP_STATEMENTS[kind],
    });
  }

  return {
    wallClockUs,
    accountedUs,
    unaccountedUs: wallClockUs - accountedUs,
    gaps,
    countedPhases: sumCounted(input.ticks),
    limits: STRUCTURAL_LIMITS,
  };
}

/**
 * A hole that starts at the run's start and reaches its end is not a prefix —
 * calling it one reads as "boot", when what happened is that nothing was
 * measured at all. That is a different piece of news and gets a different
 * word.
 */
function intervalKind(startUs: number, endUs: number, scanEndUs: number): CoverageGapKind {
  if (startUs === 0) return endUs >= scanEndUs ? "nothing-recorded" : "unrecorded-prefix";
  return endUs >= scanEndUs ? "unrecorded-suffix" : "unaccounted-interior";
}

/** Everything the truncation swallowed, across tiers. The breakdown stays on the record. */
function unrecordedRecords(truncation: TruncationRecord): number {
  return (
    truncation.rowsUnrecorded +
    truncation.ticksUnrecorded +
    truncation.eventsUnrecorded +
    truncation.serverRowsUnrecorded
  );
}

function intervalGap(
  kind: CoverageGapKind,
  startUs: number,
  endUs: number,
  wallClockUs: number,
): CoverageGap {
  const durationUs = endUs - startUs;
  return {
    kind,
    startUs,
    endUs,
    durationUs,
    records: 0,
    couldHideBottleneck:
      durationUs >= BOTTLENECK_FLOOR_US && durationUs >= wallClockUs * BOTTLENECK_SHARE,
    statement: GAP_STATEMENTS[kind],
  };
}

/**
 * The union of every recorded phase span, clamped to the run and sorted. A
 * chunk's `wire` and a concurrent chunk's `wire` overlap constantly, so the
 * union is the only reading of "accounted" that does not exceed the run's own
 * duration.
 */
function mergeSpans(rows: TraceRow[], wallClockUs: number): [number, number][] {
  const spans: [number, number][] = [];
  for (const row of rows) {
    for (const timing of Object.values(row.phases)) {
      const startUs = Math.max(0, Math.min(timing.startUs, wallClockUs));
      const endUs = Math.max(0, Math.min(timing.endUs, wallClockUs));
      if (endUs > startUs) spans.push([startUs, endUs]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** The complement of the merged spans within `[0, endUs]`. */
function* uncovered(covered: [number, number][], endUs: number): Generator<[number, number]> {
  let cursor = 0;
  for (const [startUs, spanEndUs] of covered) {
    if (startUs >= endUs) break;
    if (startUs > cursor) yield [cursor, startUs];
    cursor = Math.max(cursor, spanEndUs);
  }
  if (cursor < endUs) yield [cursor, endUs];
}

function sumCounted(ticks: TraceTick[]): Record<CountedPhase, number> {
  const totals = {} as Record<CountedPhase, number>;
  for (const phase of COUNTED_PHASES) totals[phase] = 0;
  for (const tick of ticks) {
    for (const phase of COUNTED_PHASES) totals[phase] += tick.counted[phase] ?? 0;
  }
  return totals;
}
