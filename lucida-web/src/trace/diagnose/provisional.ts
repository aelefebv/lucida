/**
 * The provisional reading: what a live surface says while a run is still
 * open (#1057).
 *
 * A run that never quiesces still produces a statement. This is it: a
 * reading over a trailing window of the run's clock, carrying the phase
 * occupancy this instant, the top finding over the window, and the page's
 * own quiescence reason. Every rendering labels it provisional, because it
 * changes while you read it. It is never a verdict. A verdict needs a closed
 * interval, the attribution back-walk needs an end to walk back from, and
 * the gate trusts only the verdict of a closed run. Nothing here is called
 * one, and the document carries no `verdict` field for a gate to mistake.
 *
 * It walks no row. Everything it says comes from the live tally the row
 * table keeps as it writes and from the per-tick readings inside the window,
 * so a read costs the same at ten rows and at the per-run cap. That is what
 * lets the dock, the watch stream, and an agent poll it at the tick cadence
 * without perturbing the run they are watching (ADR 0049 as amended). What a
 * row walk would have said, the per-row durations, the critical path, and
 * the worst row, is named as what this reading did not see rather than left
 * out in silence.
 *
 * Pure, like the rest of the derivation: everything it needs is in the sample
 * it is handed, which is what lets its rules be tested over synthetic samples
 * with no browser involved. The rules are the shipped ruleset's, applied to
 * what a window of readings can show; each finding states what it was judged
 * from and what the verdict will judge instead.
 */

import type { LivePhaseOccupancy, LiveProgress } from "../liveProgress.ts";
import type { RunCause, TraceReading } from "../types.ts";
import { usToMs } from "./phaseRollup.ts";
import { summariseTiming } from "./renderTiming.ts";
import { RULESET, RULESET_VERSION } from "./ruleset.ts";
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  type FindingObservation,
  type FindingSeverity,
  type NextStep,
  type TimingSummary,
} from "./types.ts";


/**
 * How far back the reading looks when nobody says. Five seconds: long enough
 * to hold a few hundred readings at the tick rate a busy pan produces, so a
 * pinned share and a p95 mean something, and short enough that a change in
 * the pipeline's behaviour shows within a poll or two. Inside the reading
 * ring's ~17 s of continuous ticks with margin, so the window's start is
 * normally still held.
 */
export const DEFAULT_PROVISIONAL_WINDOW_MS = 5_000;

/** The one limiter a client can see from inside its own trace. */
const SCHEDULER_ADMISSION = "scheduler.admission";

/** The main-thread frame, the phase recorded only as readings. */
const RENDER_FRAME = "render.frame";

/**
 * What the recorder hands the derivation: the run's live tally, and the
 * readings from the window's start on, led by the one in force at that
 * instant. Taken without closing the run and without walking a row.
 */
export interface LiveSample {
  progress: LiveProgress;
  /** Microseconds from run start at the moment the sample was taken. */
  atUs: number;
  /**
   * The readings taken at or after the window's start, oldest first, led by
   * the last reading before it when the ring still holds one. That earlier
   * reading is the one in force when the window opened.
   */
  readings: TraceReading[];
  /** Readings the ring has dropped over the run so far. */
  readingsDropped: number;
}

export interface ProvisionalOptions {
  /** How far back to read, in milliseconds. {@link DEFAULT_PROVISIONAL_WINDOW_MS} when absent. */
  windowMs?: number;
}

/** The window in the trace's own units, resolved against the run's clock. */
export interface LiveWindow {
  startUs: number;
  endUs: number;
  requestedMs: number;
}

/**
 * The stretch of the run's clock the reading covers. It ends now and reaches
 * back the requested length, or to run start while the run is younger than
 * that. In the second case it is the run so far, and says so.
 */
export interface ProvisionalWindow {
  startMs: number;
  /** The run's clock at the reading: a live window always ends now. */
  endMs: number;
  spanMs: number;
  requestedMs: number;
  /** True when the window reaches back to run start. */
  wholeRun: boolean;
}

/** The page's own predicate, in its own words. */
export interface ProvisionalQuiescence {
  quiescent: boolean;
  reason: string;
}

/** What the reading had to read: how many readings, and what it could not see of the window. */
export interface ProvisionalReadingCoverage {
  /** Readings taken inside the window. */
  n: number;
  /** True when the ring still held the reading in force at the window's start. */
  carried: boolean;
  /** Readings the ring dropped over the run so far. */
  dropped: number;
  /**
   * True when the ring no longer holds the reading in force at the window's
   * start, so the window's first stretch is unread. Zero readings dropped
   * with none carried means the run had not ticked yet, which is not a loss.
   */
  startUnread: boolean;
  /** How much of the window's start is unread, in milliseconds. Zero unless {@link startUnread}. */
  unreadMs: number;
  /** The newest reading's age at the sample, or null when the run has none. */
  latestAgeMs: number | null;
  statement: string;
}

export interface ProvisionalOccupancy {
  /** Rows in flight this instant, by the phase each is sitting in. */
  phases: LivePhaseOccupancy[];
  /** In-flight rows that have reached no boundary yet. */
  unstamped: number;
  inFlight: number;
}

/** The rows this reading did not see. All of them: it walks none. */
export interface ProvisionalRows {
  /** Lifecycle rows the run has made so far. */
  made: number;
  complete: number;
  retired: number;
  inFlight: number;
  /** Rows the per-run cap refused, so they exist in no table. */
  unrecorded: number;
  /** Always zero. A field rather than prose, so the fact is in the document. */
  walked: 0;
  statement: string;
}

/**
 * The scheduler's admission limiter as the window's readings saw it.
 *
 * The drain here is **net**: the queue depth's change over the window, with
 * new arrivals included, because the reading has no rows to count admissions
 * from. It answers "is the backlog getting shorter", which is the question a
 * run that never settles poses, and it is not the admission rate the verdict
 * measures from the rows' queue boundaries.
 */
export interface ProvisionalLimiter {
  id: string;
  cap: number;
  capSource: "observed-max";
  unit: string;
  /** Share of the window's readings at the cap. */
  pinnedPct: number;
  /** Queue depth at the newest reading. */
  pending: number;
  /** Queue depth at the reading in force when the window opened. */
  pendingAtStart: number;
  /** Net change of the queue depth per second over the window; positive when it is shrinking. */
  netDrainPerS: number;
  /** How long the backlog needs at that net rate, or null when it is not shrinking. */
  backlogEtaS: number | null;
  windowMs: number;
  samples: number;
}

/** Render time over the window, on the two clocks the verdict keeps apart. */
export interface ProvisionalRender {
  /** Null when no reading in the window carried a frame time above the clock floor. */
  mainThread: TimingSummary | null;
  /** Null when no reading in the window carried a GPU pass time. Absent means unmeasured, never fast. */
  gpuPass: TimingSummary | null;
  /** Main-thread time charged per reading for the interval it covers, clipped to the window. A lower bound. */
  busyMs: number;
  /** {@link busyMs} over the window's span. */
  sharePct: number;
}

/**
 * One rule firing over the window. The shape the verdict's findings have,
 * minus the rank, the confidence and the attribution, which need a closed
 * run; plus the basis, which says what stood in for the rows.
 */
export interface ProvisionalFinding {
  severity: FindingSeverity;
  rule: string;
  subject: string;
  observed: FindingObservation;
  threshold: { kind: string; value: number; why: string };
  /** What the rule was judged from here, and what the verdict judges instead. */
  basis: string;
}

export interface ProvisionalReading {
  /** Always true. The label every rendering carries. */
  provisional: true;
  schemaVersion: number;
  /** The ruleset whose thresholds judged the findings. */
  rulesetVersion: number;
  runId: string;
  cause: RunCause;
  /** The run's clock at the reading, in milliseconds. */
  elapsedMs: number;
  window: ProvisionalWindow;
  readings: ProvisionalReadingCoverage;
  quiescence: ProvisionalQuiescence;
  occupancy: ProvisionalOccupancy;
  rows: ProvisionalRows;
  limiter: ProvisionalLimiter | null;
  render: ProvisionalRender | null;
  /** Ranked as the verdict ranks its findings: stalls and saturation before notes, then by share, then by time. */
  findings: ProvisionalFinding[];
  topFinding: ProvisionalFinding | null;
  /** One sentence, opening with the word provisional. */
  statement: string;
  next: NextStep[];
}

/**
 * Resolve the window against the run's clock: it ends at `atUs` and reaches
 * back `windowMs`, clamped at run start. A window that outreaches the run is
 * the run so far rather than an error, because that is what "the last five
 * seconds" means one second into a run.
 */
export function resolveLiveWindow(
  atUs: number,
  windowMs: number = DEFAULT_PROVISIONAL_WINDOW_MS,
): LiveWindow {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`a provisional window needs a positive number of milliseconds, not ${windowMs}`);
  }
  const endUs = Math.max(0, atUs);
  return { startUs: Math.max(0, endUs - Math.round(windowMs * 1_000)), endUs, requestedMs: windowMs };
}

export function deriveProvisional(
  sample: LiveSample,
  options: ProvisionalOptions = {},
): ProvisionalReading {
  const window = resolveLiveWindow(sample.atUs, options.windowMs);
  const progress = sample.progress;
  const inside = sample.readings.filter((reading) => reading.atUs >= window.startUs);
  // The recorder hands over exactly one reading before the window's start,
  // but the rule is applied here rather than assumed, so a sample built any
  // other way reads the same.
  let carried: TraceReading | null = null;
  for (const reading of sample.readings) {
    if (reading.atUs >= window.startUs) break;
    carried = reading;
  }

  const readings = describeReadings(sample, window, inside, carried);
  const limiter = summariseLimiter(window, inside, carried);
  const render = summariseRender(window, sample.readings, inside);
  const findings = rankFindings(limiter, render);
  const topFinding = findings[0] ?? null;
  const quiescence: ProvisionalQuiescence = {
    quiescent: progress.quiescent,
    reason: progress.quiescenceReason,
  };
  const rows = describeRows(progress);
  const described = describeWindow(window);

  return {
    provisional: true,
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    rulesetVersion: RULESET_VERSION,
    runId: progress.runId,
    cause: progress.cause,
    elapsedMs: usToMs(window.endUs),
    window: described,
    readings,
    quiescence,
    occupancy: {
      phases: progress.occupancy.map((slot) => ({ phase: slot.phase, rows: slot.rows })),
      unstamped: progress.unstamped,
      inFlight: progress.inFlight,
    },
    rows,
    limiter,
    render,
    findings,
    topFinding,
    statement: buildStatement(described, readings, quiescence, topFinding),
    next: nextSteps(progress.runId),
  };
}

// ---------------------------------------------------------------------------
// The window and what was read of it
// ---------------------------------------------------------------------------

function describeWindow(window: LiveWindow): ProvisionalWindow {
  return {
    startMs: usToMs(window.startUs),
    endMs: usToMs(window.endUs),
    spanMs: usToMs(window.endUs - window.startUs),
    requestedMs: window.requestedMs,
    wholeRun: window.startUs === 0,
  };
}

function describeReadings(
  sample: LiveSample,
  window: LiveWindow,
  inside: TraceReading[],
  carried: TraceReading | null,
): ProvisionalReadingCoverage {
  const newest = sample.readings[sample.readings.length - 1] ?? null;
  const latestAgeMs = newest ? usToMs(Math.max(0, window.endUs - newest.atUs)) : null;
  const startUnread = carried === null && sample.readingsDropped > 0;
  const unreadMs = startUnread
    ? usToMs((inside[0]?.atUs ?? window.endUs) - window.startUs)
    : 0;

  let statement: string;
  if (inside.length === 0 && carried === null) {
    statement = startUnread
      ? "no reading in the window, and the ring dropped the readings before it: nothing here says what the page was doing"
      : "no reading yet: the page has not ticked since the run opened, so nothing below is measured";
  } else if (inside.length === 0 && carried) {
    statement =
      `no tick landed in the window; the reading in force is ${latestAgeMs} ms old, ` +
      `with ${carried.queueDepth.toLocaleString()} pending and ${carried.inFlight.toLocaleString()} in flight — ` +
      "a page waiting on the work it has out, not a quiescent one";
  } else if (startUnread) {
    statement =
      `${inside.length} reading(s) in the window; the ring dropped the readings before ${usToMs(inside[0].atUs)} ms, ` +
      `so the window's first ${unreadMs} ms are unread`;
  } else {
    statement = `${inside.length} reading(s) in the window`;
  }

  return {
    n: inside.length,
    carried: carried !== null,
    dropped: sample.readingsDropped,
    startUnread,
    unreadMs,
    latestAgeMs,
    statement,
  };
}

function describeRows(progress: LiveProgress): ProvisionalRows {
  const made = progress.planned;
  const refused =
    progress.unrecorded > 0
      ? `, and ${progress.unrecorded.toLocaleString()} more were refused by the per-run cap`
      : "";
  return {
    made,
    complete: progress.visible,
    retired: progress.retired,
    inFlight: progress.inFlight,
    unrecorded: progress.unrecorded,
    walked: 0,
    statement:
      `walked none of the ${made.toLocaleString()} rows this run has made ` +
      `(${progress.visible.toLocaleString()} complete, ${progress.retired.toLocaleString()} retired, ` +
      `${progress.inFlight.toLocaleString()} in flight)${refused}; ` +
      "per-row durations, the critical path and the worst row wait for the verdict",
  };
}

// ---------------------------------------------------------------------------
// The limiter and the render time, from the readings alone
// ---------------------------------------------------------------------------

function summariseLimiter(
  window: LiveWindow,
  inside: TraceReading[],
  carried: TraceReading | null,
): ProvisionalLimiter | null {
  if (inside.length === 0) return null;
  // The cap is inferred exactly as the verdict infers it: the highest
  // concurrency observed, since the trace carries no configured ceiling.
  const cap = inside.reduce((max, reading) => Math.max(max, reading.inFlight), 0);
  if (cap <= 0) return null;
  const pinned = inside.filter((reading) => reading.inFlight >= cap).length;
  const pending = inside[inside.length - 1].queueDepth;
  const pendingAtStart = (carried ?? inside[0]).queueDepth;
  const seconds = Math.max(0.001, (window.endUs - window.startUs) / 1_000_000);
  // Tenths, as the verdict rounds its drain: a backlog shrinking at 0.4/s
  // rounded to zero reads as stopped, which is a different statement.
  const netDrainPerS = Math.round(((pendingAtStart - pending) / seconds) * 10) / 10;
  return {
    id: SCHEDULER_ADMISSION,
    cap,
    capSource: "observed-max",
    unit: "chunk requests in flight",
    pinnedPct: Math.round((pinned / inside.length) * 100),
    pending,
    pendingAtStart,
    netDrainPerS,
    // An empty queue needs no time at any rate, so it never reads as a
    // backlog that is not shrinking.
    backlogEtaS: pending === 0 ? 0 : netDrainPerS > 0 ? Math.round(pending / netDrainPerS) : null,
    windowMs: usToMs(window.endUs - window.startUs),
    samples: inside.length,
  };
}

/**
 * The same charging rule as the verdict's aggregate candidate: a reading is
 * charged for at most the interval it covers, clipped to the window, so a
 * sparse tick cadence under-reports rather than inventing occupancy. The
 * newest reading covers the stretch to the sample itself.
 */
function summariseRender(
  window: LiveWindow,
  readings: TraceReading[],
  inside: TraceReading[],
): ProvisionalRender | null {
  if (readings.length === 0) return null;
  const spanUs = Math.max(1, window.endUs - window.startUs);
  let busyUs = 0;
  for (let i = 0; i < readings.length; i += 1) {
    const frameTimeUs = readings[i].frameTimeUs;
    if (!(frameTimeUs > 0)) continue;
    const nextAtUs = i + 1 < readings.length ? readings[i + 1].atUs : window.endUs;
    const fromUs = Math.max(readings[i].atUs, window.startUs);
    const toUs = Math.min(nextAtUs, window.endUs);
    if (toUs > fromUs) busyUs += Math.min(frameTimeUs, toUs - fromUs);
  }
  const mainThreadUs = inside.map((reading) => reading.frameTimeUs).filter((us) => us > 0);
  const gpuPassUs = inside
    .map((reading) => reading.gpuPassUs)
    .filter((us): us is number => us != null);
  return {
    mainThread: summariseTiming(mainThreadUs),
    gpuPass: summariseTiming(gpuPassUs),
    busyMs: usToMs(busyUs),
    sharePct: Math.round((busyUs / spanUs) * 100),
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const BACKLOG_BASIS =
  "the verdict's queue.backlog threshold, judged on the queue depth's net change over this window with arrivals included; the verdict measures admissions from the rows' queue boundaries over the trailing second";
const PINNED_BASIS =
  "the window's in-flight readings against the highest in-flight observed inside it";
const RENDER_BASIS =
  "main-thread frame time charged per reading for the interval it covers, a lower bound over the window; the verdict measures it over the run";

/**
 * The shipped ruleset, applied to what the window can show. Three of its
 * rules can be judged from readings alone: the backlog ETA and the pinned
 * limiter from the in-flight and queue-depth readings, and the dominant share
 * for the one phase that is recorded only as readings. The absolute ceilings
 * and the chain share need rows, so a provisional reading never fires them.
 */
function rankFindings(
  limiter: ProvisionalLimiter | null,
  render: ProvisionalRender | null,
): ProvisionalFinding[] {
  const raw: ProvisionalFinding[] = [];

  if (limiter) {
    if (backlogExceeded(limiter)) {
      raw.push({
        severity: "saturated",
        rule: RULESET.backlog.id,
        subject: limiter.id,
        observed: {
          pending: limiter.pending,
          drainPerS: limiter.netDrainPerS,
          backlogEtaS: limiter.backlogEtaS ?? undefined,
          inFlightCap: limiter.cap,
          pinnedPct: limiter.pinnedPct,
        },
        threshold: { kind: "backlog", value: RULESET.backlog.maxEtaS, why: RULESET.backlog.why },
        basis: BACKLOG_BASIS,
      });
    } else if (limiter.pinnedPct >= RULESET.occupancy.minPinnedPct) {
      raw.push({
        severity: "note",
        rule: RULESET.occupancy.id,
        subject: limiter.id,
        observed: {
          pinnedPct: limiter.pinnedPct,
          inFlightCap: limiter.cap,
          pending: limiter.pending,
          drainPerS: limiter.netDrainPerS,
        },
        threshold: {
          kind: "occupancy",
          value: RULESET.occupancy.minPinnedPct,
          why: RULESET.occupancy.why,
        },
        basis: PINNED_BASIS,
      });
    }
  }

  if (
    render &&
    render.sharePct >= RULESET.share.minPct &&
    render.busyMs >= RULESET.share.floorMs
  ) {
    raw.push({
      severity: "stall",
      rule: RULESET.share.id,
      subject: RENDER_FRAME,
      observed: {
        ms: render.busyMs,
        sharePct: render.sharePct,
        shareOf: "window",
        rows: 0,
        tier: "per-tick readings",
      },
      threshold: { kind: "relative", value: RULESET.share.minPct, why: RULESET.share.why },
      basis: RENDER_BASIS,
    });
  }

  const weight = (finding: ProvisionalFinding): number => (finding.severity === "note" ? 0 : 1);
  return raw.sort(
    (a, b) =>
      weight(b) - weight(a) ||
      (b.observed.sharePct ?? 0) - (a.observed.sharePct ?? 0) ||
      (b.observed.ms ?? 0) - (a.observed.ms ?? 0),
  );
}

/** The verdict's backlog rule, on the net drain: a backlog no larger than one full set of in-flight slots is the next dispatch, not a queue. */
function backlogExceeded(limiter: ProvisionalLimiter): boolean {
  if (limiter.pending <= limiter.cap) return false;
  if (limiter.backlogEtaS == null) return true;
  return limiter.backlogEtaS > RULESET.backlog.maxEtaS;
}

// ---------------------------------------------------------------------------
// The statement and the next steps
// ---------------------------------------------------------------------------

function buildStatement(
  window: ProvisionalWindow,
  readings: ProvisionalReadingCoverage,
  quiescence: ProvisionalQuiescence,
  lead: ProvisionalFinding | null,
): string {
  const span = window.wholeRun
    ? `over the ${window.spanMs} ms of the run so far`
    : `over the last ${window.spanMs} ms`;
  const page = quiescence.quiescent
    ? "the page is quiescent and the run closes once that holds"
    : `the page says ${quiescence.reason}`;

  if (readings.n === 0) {
    return `provisional — ${readings.statement}; ${page}`;
  }
  if (!lead) {
    return `provisional — nothing crossed a threshold ${span}; ${page}`;
  }
  const observed = lead.observed;
  if (lead.severity === "saturated") {
    const eta =
      observed.backlogEtaS == null
        ? "the backlog is not shrinking"
        : `at the net ${observed.drainPerS}/s the backlog needs about ${observed.backlogEtaS} s`;
    return (
      `provisional — ${span}, ${lead.subject} held ${(observed.pending ?? 0).toLocaleString()} requests ` +
      `behind a cap of ${observed.inFlightCap} and ${eta}; ${page}`
    );
  }
  if (lead.severity === "note") {
    return (
      `provisional — nothing crossed a threshold ${span}; ${lead.subject} sat at its cap of ` +
      `${observed.inFlightCap} for ${observed.pinnedPct}% of it; ${page}`
    );
  }
  return (
    `provisional — ${span}, ${lead.subject} held ${observed.ms} ms ` +
    `(${observed.sharePct}% of the window); ${page}`
  );
}

function nextSteps(runId: string): NextStep[] {
  return [
    {
      why: "the verdict, once the run has closed: let it settle, or close it and read the closed run",
      command: `lucida trace show ${runId}`,
    },
    {
      why: "close the run now rather than waiting for it to settle; its end reason is then explicit",
      command: "window.lucidaTrace.closeRun()",
    },
  ];
}

// ---------------------------------------------------------------------------
// The text twin
// ---------------------------------------------------------------------------

/**
 * The reading as text, for the watch stream and the CLI. A reading of the
 * document, never a parallel design: every number here exists in the object
 * {@link deriveProvisional} returned. About a dozen lines, because a reading
 * polled every few seconds is read in a loop.
 */
export function renderProvisional(reading: ProvisionalReading): string {
  const lines: string[] = [];
  lines.push(`lucida trace ${reading.runId} — PROVISIONAL: ${reading.statement}`);
  lines.push(
    "          not a verdict: this reading changes while you read it, and a gate reads only the verdict of a closed run",
  );
  const window = reading.window;
  lines.push(
    `window    ${window.wholeRun ? "the run so far" : `the last ${window.spanMs} ms`}: ` +
      `${window.startMs}..${window.endMs} ms of the run · ${reading.readings.statement}`,
  );
  lines.push(
    `page      ${reading.quiescence.quiescent ? "quiescent" : reading.quiescence.reason}` +
      (reading.readings.latestAgeMs == null ? "" : ` · last reading ${reading.readings.latestAgeMs} ms ago`),
  );
  const occupied = reading.occupancy.phases.filter((slot) => slot.rows > 0);
  const parts = [
    ...(reading.occupancy.unstamped > 0 ? [`planned ${reading.occupancy.unstamped.toLocaleString()}`] : []),
    ...occupied.map((slot) => `${slot.phase} ${slot.rows.toLocaleString()}`),
  ];
  lines.push(
    `in flight ${reading.occupancy.inFlight.toLocaleString()} row(s) this instant` +
      (parts.length > 0 ? `: ${parts.join(" · ")}` : ""),
  );
  lines.push(`rows      ${reading.rows.statement}`);
  const limiter = reading.limiter;
  if (limiter) {
    lines.push(
      `limiter   ${limiter.id} cap ${limiter.cap} (${limiter.capSource}) · pinned ${limiter.pinnedPct}% · ` +
        `pending ${limiter.pending.toLocaleString()} (from ${limiter.pendingAtStart.toLocaleString()}) · ` +
        `net drain ${limiter.netDrainPerS}/s · ` +
        `ETA ${limiter.backlogEtaS == null ? "not shrinking" : `~${limiter.backlogEtaS} s`}`,
    );
  }
  const render = reading.render;
  if (render) {
    const main = render.mainThread
      ? `main-thread frame p50 ${render.mainThread.p50Ms} ms · p95 ${render.mainThread.p95Ms} ms (n=${render.mainThread.samples})`
      : "main-thread frame time not sampled in the window";
    const gpu = render.gpuPass
      ? `GPU pass p50 ${render.gpuPass.p50Ms} ms · p95 ${render.gpuPass.p95Ms} ms (n=${render.gpuPass.samples})`
      : "GPU pass not recorded in the window";
    lines.push(`render    ${main} · ${render.sharePct}% of the window · ${gpu}`);
  }
  if (reading.findings.length === 0) {
    lines.push("FINDINGS  none — no threshold crossed in the window (provisional).");
  } else {
    lines.push(`FINDINGS (${reading.findings.length}), provisional`);
    reading.findings.forEach((finding, index) => {
      lines.push(
        `  ${index + 1}  ${finding.severity.toUpperCase().padEnd(9)} ${finding.subject}   ` +
          `${describeProvisionalObservation(finding.observed)}   [${finding.rule}] (provisional)`,
      );
      if (index === 0) lines.push(`       basis: ${finding.basis}`);
    });
  }
  lines.push("next");
  for (const step of reading.next) lines.push(`   ${step.command.padEnd(52)} # ${step.why}`);
  return lines.join("\n");
}

/**
 * A finding's observation in one phrase. Exported so the live view spells
 * it the way the text does: two spellings of one number would read as two
 * numbers.
 */
export function describeProvisionalObservation(observed: FindingObservation): string {
  if (observed.backlogEtaS != null || observed.pending != null) {
    const parts = [
      `${(observed.pending ?? 0).toLocaleString()} pending`,
      `cap ${observed.inFlightCap ?? 0}`,
      `pinned ${observed.pinnedPct ?? 0}%`,
      `net drain ${observed.drainPerS ?? 0}/s`,
    ];
    if (observed.backlogEtaS != null) parts.push(`ETA ~${observed.backlogEtaS} s`);
    return parts.join(" · ");
  }
  const parts: string[] = [];
  if (observed.ms != null) parts.push(`${observed.ms} ms`);
  if (observed.sharePct != null) parts.push(`${observed.sharePct}% of the window`);
  if (observed.rows === 0 && observed.tier) parts.push(`no per-item rows (${observed.tier})`);
  return parts.join(" · ");
}
