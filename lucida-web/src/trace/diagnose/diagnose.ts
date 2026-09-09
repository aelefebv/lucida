/**
 * The derivation: one pure function from a trace document to a diagnostic
 * document.
 *
 * Both surfaces read this. The agent text and the monitor's cards render from
 * the same object, so they cannot disagree about which phase stalled or how
 * much of the run was measured — #892 found #893's threshold rules transferred
 * to the visual surface unchanged, which is the evidence for one module rather
 * than two.
 *
 * Pure, with no browser and no clock of its own: everything it needs is in the
 * document it was handed, which is what lets the whole ruleset be tested over
 * fixture runs.
 */

import { accountedWithin, couldHideBottleneck } from "../coverage.ts";
import {
  CLIENT_MESSAGES,
  COUNTED_PHASES,
  TRACE_SCHEMA_VERSION,
  isInteractionCause,
  type CountedPhase,
  type CoverageGap,
  type TraceCoverage,
  type TraceDocument,
  type TracePointEvent,
  type TraceRun,
} from "../types.ts";
import { emptyChunkLookup, lookupChunk, worstRowSelector, type WorstRow } from "./chunkLookup.ts";
import { buildCriticalPath, UNRECORDED_PREFIX } from "./criticalPath.ts";
import { backlogExceeded, isPinned, summariseLimiters } from "./limiters.ts";
import { RULESET, type AbsoluteRule } from "./ruleset.ts";
import {
  aggregateCandidates,
  metadataReadRows,
  rollupWindow,
  usToMs,
  type WindowRollup,
} from "./phaseRollup.ts";
import { adapterKindOf, adapterName, deriveRenderTiming } from "./renderTiming.ts";
import { summariseSpace } from "./spatialSummary.ts";
import { deriveTimeline, type TimelineRecording } from "./timeline.ts";
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  type AggregateCandidate,
  type Attribution,
  type Confidence,
  type CriticalPath,
  type DiagnosticCoverage,
  type DiagnosticDocument,
  type Finding,
  type LimiterSummary,
  type RunIdentity,
  type PhaseRollup,
  type SentSummary,
  type Verdict,
  type WindowRequest,
} from "./types.ts";
import {
  clipSpan,
  describeWindow,
  inWindow,
  labelMs,
  resolveWindow,
  windowLabel,
  type RunWindow,
} from "./window.ts";

/**
 * The seven words, listed so a surface can enumerate them and a test can
 * assert every one is reachable. Ordered strongest first.
 */
export const CONFIDENCE_WORDS: readonly Confidence[] = [
  "attributed",
  "partial",
  "contended",
  "resource-limited",
  "aggregate-only",
  "rollup-only",
  "unattributed",
];

/**
 * How much of the run a chain has to explain before the strongest word is
 * available. Below it the chain is real but the run is mostly elsewhere.
 */
const ATTRIBUTED_MIN_COVERAGE_PCT = 75;

/** Two segments this close are not a winner and a runner-up, they are a tie. */
const TIE_RATIO = 1.25;

export interface DiagnoseOptions {
  /** A previous run's diagnostic, for the comparative rule. Nothing here stores or resolves one. */
  baseline?: DiagnosticDocument | null;
  /** The run to read out of a trace document. Defaults to the newest. */
  runId?: string;
  /**
   * The interval of the run to read, in milliseconds from run start. Scopes
   * the phase rollup, the findings and the critical path to it; the whole run
   * when absent. Brushing the interval in the monitor and the CLI's window
   * flag are both this option.
   */
  window?: WindowRequest;
  /**
   * The chunk the document's lookup is about, as `[entity/]level/t/c/z/y/x`.
   * Defaults to the worst row's chunk, so the default text has one to name.
   */
  chunk?: string;
  /**
   * The recording the run came from, so the timeline can place the other
   * retained intervals on this run's clock. Without it the axis carries this
   * run alone. {@link diagnoseDocument} supplies it from the document.
   */
  recording?: TimelineRecording;
}

/**
 * Read one run out of a trace document. The newest by default: a driver
 * exports immediately after the run it drove, and the steady-state intervals
 * are deliberately not candidates — an interval with no cause and no settle is
 * not a run and has no verdict to give.
 */
export function diagnoseDocument(
  document: TraceDocument,
  options: DiagnoseOptions = {},
): DiagnosticDocument {
  const run = options.runId
    ? document.runs.find((candidate) => candidate.header.runId === options.runId)
    : document.runs[document.runs.length - 1];
  if (!run) throw new Error(`no run ${options.runId ?? "(newest)"} in this trace document`);
  return diagnoseRun(run, {
    ...options,
    recording: options.recording ?? { runs: document.runs, steadyState: document.steadyState },
  });
}

export function diagnoseRun(run: TraceRun, options: DiagnoseOptions = {}): DiagnosticDocument {
  // A run from another schema fails here, by name, rather than partway through
  // the derivation on a field that schema never had (ADR 0047).
  if (run.header.schemaVersion !== TRACE_SCHEMA_VERSION) {
    throw new Error(
      `run ${run.header.runId} was recorded under trace schema ${run.header.schemaVersion}; ` +
        `this build reads schema ${TRACE_SCHEMA_VERSION}`,
    );
  }
  const window = resolveWindow(run, options.window);
  const rollup = rollupWindow(run, window);
  const phases = rollup.phases;
  const limiters = summariseLimiters(run, window);
  const aggregates = aggregateCandidates(run, window);
  const path = buildCriticalPath(run, window);
  const coverage = deriveCoverage(run, window, rollup);
  const interaction = isInteractionCause(run.header.cause);
  const attribution = attribute({ run, path, phases, limiters, aggregates, coverage, interaction });
  const findings = rankFindings({
    path,
    phases,
    limiters,
    aggregates,
    attribution,
    interaction,
    baseline: options.baseline ?? null,
  });
  const worst = worstRowSelector(run, phases, findings);
  const chunk =
    options.chunk !== undefined
      ? lookupChunk(run, options.chunk, "named by the caller")
      : worst
        ? lookupChunk(run, worst.selector, worst.chosen)
        : emptyChunkLookup("no chunk row in this run to choose from");

  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    runId: run.header.runId,
    traceSchemaVersion: run.header.schemaVersion,
    verdict: buildVerdict(run, findings, attribution, path, coverage),
    run: runIdentity(run),
    window: window.requested ? describeWindow(run, window) : null,
    coverage,
    attribution,
    findings,
    criticalPath: path,
    phases,
    limiters,
    aggregates,
    renderTiming: deriveRenderTiming(run),
    sent: summariseSent(run),
    counts: {
      rows: run.rows.length,
      serverRows: run.serverRows.length - metadataReadRows(run.serverRows).length,
      metadataRows: metadataReadRows(run.serverRows).length,
      ticks: run.ticks.length,
      pointEvents: run.events.length,
    },
    chunk,
    spatial: summariseSpace(run),
    timeline: deriveTimeline(run, window, options.recording),
    raw: {
      inlined: false,
      why: "Raw spans are for a viewer, not a context window: a warm re-open is tens of thousands of rows, and nothing per-row appears at any depth here beyond the one chunk the lookup is about.",
      command: "lucida trace perfetto",
    },
    next: nextSteps(run, findings, attribution, phases, window, worst),
    ruleset: RULESET,
  };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * The trace already computed which wall clock no phase covers; this restates
 * it in the diagnostic's own terms and adds the judgement a reader needs
 * attached to a verdict.
 *
 * The percentage is **floored, never rounded**. 99.6% printing as 100% in the
 * honesty block is the exact failure #893 hit.
 */
function deriveCoverage(
  run: TraceRun,
  window: RunWindow,
  rollup: WindowRollup,
): DiagnosticCoverage {
  const traceCoverage: TraceCoverage = run.coverage;
  const spanUs = window.endUs - window.startUs;
  // The whole run reads the trace's own block verbatim. A narrower window
  // measures its own accounted time, because a union cannot be apportioned,
  // and clips the gaps to itself, re-judging each against its own span.
  const accountedUs = window.whole
    ? traceCoverage.accountedUs
    : accountedWithin(run.rows, window.startUs, window.endUs);
  const gaps = window.whole
    ? traceCoverage.gaps
    : traceCoverage.gaps.flatMap((gap) => gapWithin(gap, window));
  // A truncation the window never reaches did not stop the window from
  // looking; one it does reach leaves the remainder as unbounded as ever.
  const truncation =
    run.header.truncation && run.header.truncation.atUs < window.endUs
      ? run.header.truncation
      : null;
  const events = window.whole
    ? run.events
    : run.events.filter((event) => inWindow(event.atUs, window));

  return {
    wallMs: usToMs(spanUs),
    accountedMs: usToMs(accountedUs),
    accountedPct: Math.floor((accountedUs / Math.max(1, spanUs)) * 100),
    gaps: gaps.map((gap) => ({
      kind: gap.kind,
      startMs: gap.startUs == null ? null : usToMs(gap.startUs),
      endMs: gap.endUs == null ? null : usToMs(gap.endUs),
      durationMs: usToMs(gap.durationUs),
      records: gap.records,
      couldHideBottleneck: gap.couldHideBottleneck,
      statement: gap.statement,
    })),
    gapCount: gaps.length,
    // A truncated run is incomplete by definition: it stopped looking, so the
    // remainder is not merely unmeasured but unbounded.
    incomplete: truncation != null || gaps.some((gap) => gap.couldHideBottleneck),
    truncated: truncation
      ? {
          reason: truncation.reason,
          atMs: usToMs(truncation.atUs),
          rowsRecorded: truncation.rowsRecorded,
          rowsUnrecorded: truncation.rowsUnrecorded,
          rowsTotal: truncation.rowsRecorded + truncation.rowsUnrecorded,
          recordedPct: Math.floor(
            (truncation.rowsRecorded /
              Math.max(1, truncation.rowsRecorded + truncation.rowsUnrecorded)) *
              100,
          ),
        }
      : null,
    window: window.requested
      ? {
          clippedRows: rollup.clippedRows,
          unplacedRows: rollup.unplacedRows,
          statement: window.whole ? WHOLE_WINDOW_STATEMENT : NARROWER_WINDOW_STATEMENT,
        }
      : null,
    limits: traceCoverage.limits,
    countedPhases: window.whole ? traceCoverage.countedPhases : countedWithin(run, window),
    // #899 recorded zero retries, zero failures and zero evictions while the
    // pipeline ran 20,000 requests behind. A zero here means the path was not
    // exercised, which is not the same news as the path being healthy.
    notHealthSignals: [
      { metric: "retries", value: countEvents(events, "retry") },
      { metric: "failures", value: countEvents(events, "failure") },
      { metric: "evictions", value: countEvents(events, "eviction") },
      { metric: "rejections", value: countEvents(events, "rejection") },
    ],
  };
}

function countEvents(events: TracePointEvent[], kind: string): number {
  return events.filter((event) => event.kind === kind).length;
}

/** Numberless on purpose: the counts sit beside the statement, as a gap's do. */
const WHOLE_WINDOW_STATEMENT =
  "The window is the whole run, so no row crosses an edge and no row is left out for want of a position.";
const NARROWER_WINDOW_STATEMENT =
  "A row that crosses the window's edge counts for the part inside it. A row with no position on the run's clock cannot be placed inside a narrower window and is left out; the whole run still counts it.";

/**
 * The part of a gap inside the window, re-judged against the window's span,
 * or nothing when none of it is. A stream loss has no position and costs
 * records rather than time, so it passes through: the window cannot say the
 * dropped records were not about it.
 */
function gapWithin(gap: CoverageGap, window: RunWindow): CoverageGap[] {
  if (gap.startUs == null || gap.endUs == null) return [gap];
  const span = clipSpan(gap.startUs, gap.endUs, window);
  if (!span) return [];
  return [
    {
      ...gap,
      startUs: span.startUs,
      endUs: span.endUs,
      durationUs: span.us,
      // A truncation is unbounded wherever the window meets it; every other
      // interval gap is judged by how much of the window it takes.
      couldHideBottleneck:
        gap.kind === "truncated" || couldHideBottleneck(span.us, window.endUs - window.startUs),
    },
  ];
}

function countedWithin(run: TraceRun, window: RunWindow): Record<CountedPhase, number> {
  const totals = {} as Record<CountedPhase, number>;
  for (const phase of COUNTED_PHASES) totals[phase] = 0;
  for (const tick of run.ticks) {
    if (!inWindow(tick.atUs, window)) continue;
    for (const phase of COUNTED_PHASES) totals[phase] += tick.counted[phase] ?? 0;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// The send side
// ---------------------------------------------------------------------------

function summariseSent(run: TraceRun): SentSummary {
  const wallUs = Math.max(1, run.header.durationUs);
  const perSecond = (bytes: number): number => Math.round((bytes * 1_000_000) / wallUs);
  let messages = 0;
  let bytes = 0;
  const byType = CLIENT_MESSAGES.map(({ type, label }) => {
    const tally = run.sent[type];
    messages += tally.messages;
    bytes += tally.bytes;
    return { type, label, messages: tally.messages, bytes: tally.bytes, bytesPerS: perSecond(tally.bytes) };
  });
  return { messages, bytes, bytesPerS: perSecond(bytes), byType };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface AttributionInput {
  run: TraceRun;
  path: CriticalPath;
  phases: PhaseRollup[];
  limiters: LimiterSummary[];
  aggregates: AggregateCandidate[];
  coverage: DiagnosticCoverage;
  interaction: boolean;
}

/**
 * The frame-time reading of an interaction run, judged by the ceiling rather
 * than by share. A drag ticks every frame, so its main-thread share is near
 * total by construction. Null on any other run, where the reading stays a
 * share candidate like the rest.
 */
function frameTimeOf(
  aggregates: AggregateCandidate[],
  interaction: boolean,
): { frame: AggregateCandidate; slow: boolean } | null {
  if (!interaction) return null;
  const frame = aggregates.find((candidate) => candidate.phase === RULESET.interaction.phase);
  return frame ? { frame, slow: frame.p95Ms > RULESET.interaction.ceilMs } : null;
}

/** What every confidence, including the strongest, still cannot see. */
const ALWAYS_DEGRADED =
  "queue time is a floor rather than a total (a request admitted off the backlog dates its queue from the plan pass that enqueued it), and this chain is one row's history rather than every row's";

function passesShare(ms: number, sharePct: number): boolean {
  return sharePct >= RULESET.share.minPct && ms >= RULESET.share.floorMs;
}

function attribute(input: AttributionInput): Attribution {
  const { path, phases, limiters, aggregates, coverage, interaction } = input;
  const saturated = limiters.find((limiter) => backlogExceeded(limiter));
  const frameTime = frameTimeOf(aggregates, interaction);
  const aggregate = aggregates.find(
    (candidate) => candidate !== frameTime?.frame && passesShare(candidate.busyMs, candidate.sharePct),
  );
  const slowFrames: Attribution | null = frameTime?.slow
    ? {
        confidence: "aggregate-only",
        cause: frameTime.frame.phase,
        why: `${frameTime.frame.phase} p95 ${frameTime.frame.p95Ms} ms over the ${RULESET.interaction.ceilMs} ms ceiling for an interaction run, across ${frameTime.frame.samples.toLocaleString()} ticks`,
        degraded:
          "per-tick readings show that the main thread was held, not which phase held it, and the reading is main-thread time rather than GPU time",
        runnerUp: null,
      }
    : null;

  if (path.kind === "undefined") {
    const reason = path.undefinedReason ?? "no critical path could be walked";
    if (saturated) {
      return {
        confidence: "resource-limited",
        cause: saturated.id,
        why: `${saturated.id} held ${saturated.pending.toLocaleString()} requests behind a cap of ${saturated.cap}, draining at ${saturated.drainPerS}/s over the trailing ${RULESET.backlog.windowMs} ms`,
        degraded: `${reason} — the backlog is the constraint the run is under rather than a segment on anyone's path`,
        runnerUp: null,
      };
    }
    if (slowFrames) return { ...slowFrames, degraded: `${reason}; ${slowFrames.degraded}` };
    if (aggregate) {
      return {
        confidence: "aggregate-only",
        cause: aggregate.phase,
        why: `${aggregate.phase} held the main thread for ${aggregate.busyMs} ms of the run (${aggregate.sharePct}%), recorded as per-tick readings because a per-item row here would be a six-figure-per-second write`,
        degraded: `${reason}; with no per-item rows this phase can be shown to overlap the work, not to be on its path, and its busy total is a lower bound`,
        runnerUp: null,
      };
    }
    const breach = ceilingBreaches(phases)[0];
    if (breach) {
      return {
        confidence: "rollup-only",
        cause: breach.phase.id,
        why: `${breach.phase.id} p95 ${breach.phase.p95Ms} ms over its ${breach.rule.ceilMs} ms ceiling across ${breach.phase.n.toLocaleString()} rows`,
        degraded: `${reason} — this is ranked by percentile, which is evidence the phase was slow and not evidence it was on the run's path`,
        runnerUp: null,
      };
    }
    return {
      confidence: "unattributed",
      cause: null,
      why: "nothing crossed a threshold and no chain could be walked",
      degraded: `${reason}; ${ALWAYS_DEGRADED}`,
      runnerUp: null,
    };
  }

  const ranked = [...path.segments].sort((a, b) => b.ms - a.ms);
  const leader = ranked[0];
  const second = ranked[1];

  // The chain is led by time nothing recorded. No phase can be blamed for it,
  // and saying so is the entire reason the segment is kept in the chain.
  if (leader.class === "unrecorded") {
    return {
      confidence: "partial",
      cause: null,
      why: `the largest span on the critical path is ${leader.ms} ms (${leader.sharePct}% of the chain) before the first recorded boundary`,
      degraded:
        "no phase can be blamed for it — nothing instruments that stretch, and the run's bottleneck may be inside it",
      runnerUp: second ? { label: second.label, ms: second.ms } : null,
    };
  }

  // On an interaction run the frame time is the question, so slow frames
  // outrank the chain leader whatever its size.
  if (slowFrames) return { ...slowFrames, runnerUp: { label: leader.label, ms: leader.ms } };

  // An aggregate phase large enough to rival the chain leader. It cannot be
  // placed on the path, only shown to overlap it — a weaker claim, said plainly.
  //
  // Compared in milliseconds, not in percentages: a segment's share is of the
  // chain and an aggregate's share is of the wall clock, and a run whose chain
  // ends before the run does has two different denominators wearing the same
  // "% of the run" costume.
  if (aggregate && aggregate.busyMs >= leader.ms) {
    return {
      confidence: "aggregate-only",
      cause: aggregate.phase,
      why: `${aggregate.phase} held the main thread for ${aggregate.busyMs} ms (${aggregate.sharePct}% of the run) but has no per-item rows`,
      degraded: `it cannot be placed on the critical path, only shown to overlap it; the chain leader was ${leader.label} at ${leader.ms} ms and both are reported`,
      runnerUp: { label: leader.label, ms: leader.ms },
    };
  }

  // A queue leads: name the limiter behind it, not the queue. "It waited" is
  // not a diagnosis; "it waited behind this, which was at its cap" is.
  if (leader.class === "queue") {
    const pinnedLimiter = limiters.find((limiter) => isPinned(limiter));
    if (pinnedLimiter) {
      return {
        confidence: "resource-limited",
        cause: `${leader.label} -> ${pinnedLimiter.id}`,
        why: `${pinnedLimiter.id} sat at its cap of ${pinnedLimiter.cap} for ${pinnedLimiter.pinnedPct}% of the run with ${pinnedLimiter.pending.toLocaleString()} pending behind it`,
        degraded: `the cap is inferred from the highest concurrency observed rather than read from configuration, and ${ALWAYS_DEGRADED}`,
        runnerUp: second ? { label: second.label, ms: second.ms } : null,
      };
    }
    return {
      confidence: "contended",
      cause: leader.label,
      why: "the leading segment is a queue wait and no limiter was at its cap, so the constraint is upstream of anything this run measured",
      degraded: `the limiter was not identified; ${ALWAYS_DEGRADED}`,
      runnerUp: second ? { label: second.label, ms: second.ms } : null,
    };
  }

  if (second && leader.ms < second.ms * TIE_RATIO) {
    return {
      confidence: "contended",
      cause: [leader.label, second.label],
      why: `${leader.ms} ms against ${second.ms} ms — within ${TIE_RATIO}x, so no single segment is named`,
      degraded: `reported as a set rather than a winner; ${ALWAYS_DEGRADED}`,
      runnerUp: { label: second.label, ms: second.ms },
    };
  }

  const strong = coverage.accountedPct >= ATTRIBUTED_MIN_COVERAGE_PCT && !coverage.truncated;
  // The chain's length, not the target's position: inside a window the two
  // differ by the window's start.
  const chainMs = Math.round(((path.targetAtMs ?? 0) - path.fromMs) * 10) / 10;
  return {
    confidence: strong ? "attributed" : "partial",
    cause: leader.label,
    why: `back-walk from ${path.target}: ${leader.ms} ms of a ${chainMs} ms chain`,
    degraded: strong
      ? ALWAYS_DEGRADED
      : `only ${coverage.accountedPct}% of the run's wall clock is covered by a recorded phase, so the chain may be leading past the real bottleneck; ${ALWAYS_DEGRADED}`,
    runnerUp: second ? { label: second.label, ms: second.ms } : null,
  };
}

interface CeilingBreach {
  phase: PhaseRollup;
  rule: AbsoluteRule;
  ratio: number;
}

/**
 * Every phase over its absolute ceiling, worst first. One pass shared by the
 * findings list and the non-path attribution: two copies of "is this phase over
 * its ceiling" is two places for the comparison to drift.
 */
function ceilingBreaches(phases: PhaseRollup[]): CeilingBreach[] {
  const breaches: CeilingBreach[] = [];
  for (const rule of RULESET.absolute) {
    const phase = phases.find((candidate) => candidate.id === rule.phase);
    if (!phase || phase.p95Ms <= rule.ceilMs) continue;
    breaches.push({ phase, rule, ratio: phase.p95Ms / rule.ceilMs });
  }
  return breaches.sort((a, b) => b.ratio - a.ratio);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** A finding before it is ranked: rank is what assigns an id and a confidence. */
type RawFinding = Omit<Finding, "id" | "confidence" | "attribution">;

interface FindingsInput {
  path: CriticalPath;
  phases: PhaseRollup[];
  limiters: LimiterSummary[];
  aggregates: AggregateCandidate[];
  attribution: Attribution;
  interaction: boolean;
  baseline: DiagnosticDocument | null;
}

function rankFindings(input: FindingsInput): Finding[] {
  const raw: RawFinding[] = [];

  for (const breach of ceilingBreaches(input.phases)) {
    raw.push({
      severity: "stall",
      rule: breach.rule.id,
      subject: breach.phase.id,
      observed: { stat: breach.rule.stat, ms: breach.phase.p95Ms, n: breach.phase.n },
      threshold: { kind: "absolute", value: breach.rule.ceilMs, why: breach.rule.why },
    });
  }

  for (const limiter of input.limiters) {
    if (backlogExceeded(limiter)) {
      raw.push({
        severity: "saturated",
        rule: RULESET.backlog.id,
        subject: limiter.id,
        observed: {
          pending: limiter.pending,
          drainPerS: limiter.drainPerS,
          backlogEtaS: limiter.backlogEtaS ?? undefined,
          inFlightCap: limiter.cap,
          pinnedPct: limiter.pinnedPct,
        },
        threshold: { kind: "backlog", value: RULESET.backlog.maxEtaS, why: RULESET.backlog.why },
      });
    } else if (isPinned(limiter)) {
      // Pinned but not backlogged is worth a line rather than a stall: #899
      // found two chokepoints, and a report naming only the loudest teaches the
      // reader the other one is fine.
      raw.push({
        severity: "note",
        rule: RULESET.occupancy.id,
        subject: limiter.id,
        observed: {
          pinnedPct: limiter.pinnedPct,
          inFlightCap: limiter.cap,
          pending: limiter.pending,
          drainPerS: limiter.drainPerS,
        },
        threshold: {
          kind: "occupancy",
          value: RULESET.occupancy.minPinnedPct,
          why: RULESET.occupancy.why,
        },
      });
    }
  }

  for (const segment of input.path.segments) {
    // An unrecorded prefix large enough to hide the answer is a *note*, never a
    // stall: nothing measured that stretch, so nothing can be blamed for it —
    // but a reader deciding whether to trust the chain has to be told the chain
    // is led by a hole.
    if (segment.label === UNRECORDED_PREFIX) {
      if (segment.sharePct >= RULESET.prefix.maxPct) {
        raw.push({
          severity: "note",
          rule: RULESET.prefix.id,
          subject: segment.label,
          observed: { ms: segment.ms, sharePct: segment.sharePct, shareOf: "chain", rows: 0 },
          threshold: { kind: "coverage", value: RULESET.prefix.maxPct, why: RULESET.prefix.why },
        });
      }
      continue;
    }
    // A queue segment is judged by whether its backlog drains rather than by
    // how much of the chain it holds.
    if (segment.class === "unrecorded" || segment.class === "queue") continue;
    if (!passesShare(segment.ms, segment.sharePct)) continue;
    raw.push({
      severity: "stall",
      rule: RULESET.share.id,
      subject: segment.label,
      observed: {
        ms: segment.ms,
        sharePct: segment.sharePct,
        shareOf: "chain",
        rows: segment.rows,
        ...(segment.breakdown ? { breakdown: segment.breakdown } : {}),
      },
      threshold: { kind: "relative", value: RULESET.share.minPct, why: RULESET.share.why },
    });
  }

  const frameTime = frameTimeOf(input.aggregates, input.interaction);
  for (const candidate of input.aggregates) {
    if (candidate === frameTime?.frame) continue;
    if (!passesShare(candidate.busyMs, candidate.sharePct)) continue;
    raw.push({
      severity: "stall",
      rule: RULESET.share.id,
      subject: candidate.phase,
      observed: {
        ms: candidate.busyMs,
        sharePct: candidate.sharePct,
        shareOf: "run",
        rows: 0,
        tier: "per-tick readings",
      },
      threshold: { kind: "relative", value: RULESET.share.minPct, why: RULESET.share.why },
    });
  }

  if (frameTime?.slow) {
    raw.push({
      severity: "stall",
      rule: RULESET.interaction.id,
      subject: frameTime.frame.phase,
      observed: {
        stat: RULESET.interaction.stat,
        ms: frameTime.frame.p95Ms,
        n: frameTime.frame.samples,
        rows: 0,
        tier: "per-tick readings",
      },
      threshold: {
        kind: "absolute",
        value: RULESET.interaction.ceilMs,
        why: RULESET.interaction.why,
      },
    });
  }

  raw.push(...comparativeFindings(input));

  const seen = new Set<string>();
  const weight = (finding: { severity: string }): number => (finding.severity === "note" ? 0 : 1);
  return raw
    .sort(
      (a, b) =>
        weight(b) - weight(a) ||
        (b.observed.sharePct ?? 0) - (a.observed.sharePct ?? 0) ||
        (b.observed.ms ?? 0) - (a.observed.ms ?? 0),
    )
    .filter((finding) => {
      // Two rules finding the same subject from different directions is one
      // finding, not two.
      if (seen.has(finding.subject)) return false;
      seen.add(finding.subject);
      return true;
    })
    .map((finding, index) => ({
      ...finding,
      id: index + 1,
      confidence: index === 0 ? input.attribution.confidence : ("observed" as const),
      attribution: index === 0 ? input.attribution : null,
    }));
}

/**
 * Comparison against a named baseline run, and only above 2x: #899 measured
 * that much run-to-run weather between two runs of the same fixture minutes
 * apart, so anything below that spread reports weather as regression.
 *
 * Nothing here resolves or stores a baseline — the caller hands one over or
 * there is no comparison.
 */
function comparativeFindings(
  input: FindingsInput,
): RawFinding[] {
  const baseline = input.baseline;
  if (!baseline) return [];

  const out: RawFinding[] = [];
  for (const phase of input.phases) {
    const before = baseline.phases.find((candidate) => candidate.id === phase.id);
    if (!before || before.p95Ms <= 0) continue;
    const ratio = phase.p95Ms / before.p95Ms;
    if (ratio <= RULESET.compare.minRatio) continue;
    out.push({
      severity: "stall",
      rule: RULESET.compare.id,
      subject: phase.id,
      observed: {
        stat: "p95",
        ms: phase.p95Ms,
        baselineMs: before.p95Ms,
        ratio: Math.round(ratio * 10) / 10,
        n: phase.n,
      },
      threshold: { kind: "comparative", value: RULESET.compare.minRatio, why: RULESET.compare.why },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdict and next steps
// ---------------------------------------------------------------------------

function buildVerdict(
  run: TraceRun,
  findings: Finding[],
  attribution: Attribution,
  path: CriticalPath,
  coverage: DiagnosticCoverage,
): Verdict {
  const caveat = coverage.incomplete ? " [coverage incomplete — see gaps]" : "";
  const lead = findings.find((finding) => finding.severity !== "note");

  if (!lead) {
    const slowest = [...path.segments]
      .filter((segment) => segment.class !== "unrecorded")
      .sort((a, b) => b.ms - a.ms)[0];
    const tail = slowest
      ? `slowest recorded segment was ${slowest.label} at ${slowest.ms} ms (${slowest.sharePct}% of the chain)`
      : "no recorded segment to rank";
    if (run.header.endReason !== "quiescent" && run.header.endReason !== "explicit") {
      return {
        kind: "unsettled",
        text: `no threshold crossed, but the run ended as ${run.header.endReason} rather than settling — every total below is a lower bound; ${tail}${caveat}`,
        confidence: attribution.confidence,
      };
    }
    return {
      kind: "clear",
      text: `no stall — nothing crossed a threshold; ${tail}${caveat}`,
      confidence: attribution.confidence,
    };
  }

  if (lead.severity === "saturated") {
    const eta =
      lead.observed.backlogEtaS == null
        ? "at the observed rate it does not drain at all"
        : `at the observed ${lead.observed.drainPerS}/s the backlog needs about ${lead.observed.backlogEtaS} s`;
    return {
      kind: "saturated",
      text: `saturated — ${lead.subject} held ${(lead.observed.pending ?? 0).toLocaleString()} requests behind a cap of ${lead.observed.inFlightCap}; ${eta}${caveat}`,
      confidence: attribution.confidence,
    };
  }

  // A gate's one line has to say which input was slow, not which reading
  // measured it.
  if (lead.rule === RULESET.interaction.id) {
    return {
      kind: "stall",
      text:
        `${run.header.cause?.source ?? "input"} ran at ${lead.observed.stat} ${lead.observed.ms} ms ` +
        `per main-thread frame, over the ${lead.threshold.value} ms ceiling for an interaction run${caveat}`,
      confidence: attribution.confidence,
    };
  }

  const share =
    lead.observed.sharePct != null
      ? ` (${lead.observed.sharePct}% of the ${lead.observed.shareOf ?? "run"})`
      : "";
  const amount = lead.observed.stat
    ? `${lead.observed.stat} ${lead.observed.ms} ms`
    : `${lead.observed.ms} ms`;
  return {
    kind: "stall",
    text: `${lead.subject} ${lead.observed.stat ? "ran" : "held"} ${amount}${share}${caveat}`,
    confidence: attribution.confidence,
  };
}

function runIdentity(run: TraceRun): RunIdentity {
  const header = run.header;
  const warmth = header.cacheWarmth;
  return {
    datasetIds: header.datasetIds,
    cause: header.cause,
    endReason: header.endReason,
    wallMs: usToMs(header.durationUs),
    devicePixelRatio: header.devicePixelRatio,
    viewport: `${header.viewport.deviceWidth}x${header.viewport.deviceHeight}px`,
    build: `${header.build.version} ${header.build.mode}`,
    gpu: adapterName(header.gpu),
    adapter: header.gpu,
    adapterKind: adapterKindOf(header.gpu),
    warmth:
      warmth.detailChunks + warmth.coarseChunks === 0
        ? "browser cache cold"
        : `browser cache warm (${warmth.detailChunks} detail, ${warmth.coarseChunks} coarse)`,
    outstanding: {
      pending: header.outstandingAtSettle.pending,
      inFlight: header.outstandingAtSettle.inFlight,
      speculative:
        header.outstandingAtSettle.speculativePending +
        header.outstandingAtSettle.speculativeInFlight,
    },
    startedAtEpochMs: header.startedAtEpochMs,
  };
}

const INCONCLUSIVE: readonly Confidence[] = [
  "partial",
  "contended",
  "aggregate-only",
  "rollup-only",
  "unattributed",
];

/**
 * The commands that go deeper.
 *
 * `lucida trace perfetto` exists today. The `show` verbs are the CLI surface
 * #935 builds, and these strings are the contract it has to honour — a
 * diagnostic that prints a command which does not run is worse than one that
 * prints none, so if that ticket names them differently, it changes them here.
 */
function nextSteps(
  run: TraceRun,
  findings: Finding[],
  attribution: Attribution,
  phases: PhaseRollup[],
  window: RunWindow,
  worst: WorstRow | null,
): DiagnosticDocument["next"] {
  const runId = run.header.runId;
  // A reader inside a window stays inside it: the depths carry the window, so
  // "every phase" means every phase of the interval being read.
  const scope = window.requested ? ` --window ${windowLabel(window)}` : "";
  const steps: DiagnosticDocument["next"] = [
    { why: "every phase, one row each", command: `lucida trace show ${runId} --phases${scope}` },
  ];
  const lead = findings.find((finding) => finding.severity !== "note");
  if (lead) {
    steps.unshift({
      why: `the shape behind ${lead.subject}`,
      command: `lucida trace show ${runId} --phase ${lead.subject}${scope}`,
    });
  }
  const narrower = narrowerWindow(window, lead, phases);
  if (narrower) {
    steps.push({
      why: narrower.why,
      command: `lucida trace show ${runId} --window ${narrower.label}`,
    });
  }
  // The overlay's two readings, one chunk and what is where, as commands an
  // agent can run. Both read the whole run, so a windowed reading offers
  // neither: a follow-up that leaves the window would not be a follow-up.
  // The chunk step names the worst row even when the caller named a
  // different chunk for this document's lookup.
  if (!window.requested) {
    if (worst) {
      steps.push({
        why: `${worst.chosen}: its phase history, queue rank and age`,
        command: `lucida trace show ${runId} --chunk ${worst.selector}`,
      });
    }
    steps.push({
      why: "what is where: rows by state and level, with their boxes",
      command: `lucida trace show ${runId} --spatial`,
    });
  }
  if (INCONCLUSIVE.includes(attribution.confidence)) {
    steps.push({
      why: `the attribution is not conclusive; a second run to compare against ${runId}`,
      command: `lucida trace ${run.header.datasetIds[0] ?? "<dataset>"}`,
    });
  }
  steps.push({
    why: "raw spans, for a viewer rather than a context window",
    command: "lucida trace perfetto",
  });
  return steps;
}

/**
 * The narrower window the text offers next, always strictly inside the one
 * being read, so following the offer moves the reader.
 *
 * First the stretch the lead finding's phase occupied, when the rollup can
 * place it and it is narrower than the window. Otherwise the second half: on
 * a run that never settled the recent half is where it stalled, and on a
 * clean run it is the half after the open. Whole milliseconds, because they
 * are typed back in by hand.
 */
function narrowerWindow(
  window: RunWindow,
  lead: Finding | undefined,
  phases: PhaseRollup[],
): { label: string; why: string } | null {
  const startMs = window.startUs / 1_000;
  const endMs = window.endUs / 1_000;
  const spanMs = endMs - startMs;

  const phase = lead ? phases.find((candidate) => candidate.id === lead.subject) : undefined;
  if (phase?.extent) {
    const fromMs = Math.max(startMs, Math.floor(phase.extent.firstStartMs));
    const toMs = Math.min(endMs, Math.ceil(phase.extent.lastEndMs));
    if (toMs > fromMs && toMs - fromMs < spanMs) {
      return {
        label: labelMs(fromMs, toMs),
        why: `the same reading over just the stretch ${phase.id} occupied`,
      };
    }
  }

  const midMs = Math.floor((startMs + endMs) / 2);
  if (midMs <= startMs || endMs - midMs < 1) return null;
  return {
    label: labelMs(midMs, endMs),
    why: `the same reading over the second half of the ${window.whole ? "run" : "window"}`,
  };
}
