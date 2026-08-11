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

import { PHASES, type TraceCoverage, type TraceDocument, type TraceRun } from "../types.ts";
import { buildCriticalPath, PRE_PLAN, UNRECORDED_PREFIX } from "./criticalPath.ts";
import { backlogExceeded, isPinned, summariseLimiters } from "./limiters.ts";
import { RULESET } from "./ruleset.ts";
import { aggregateCandidates, rollupStages, usToMs } from "./stages.ts";
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
  type PathSegment,
  type RunIdentity,
  type StageRollup,
  type Verdict,
} from "./types.ts";

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
  return diagnoseRun(run, options);
}

export function diagnoseRun(run: TraceRun, options: DiagnoseOptions = {}): DiagnosticDocument {
  const stages = rollupStages(run);
  const limiters = summariseLimiters(run);
  const aggregates = aggregateCandidates(run);
  const path = buildCriticalPath(run);
  const coverage = deriveCoverage(run);
  const attribution = attribute({ run, path, stages, limiters, aggregates, coverage });
  const findings = rankFindings({
    path,
    stages,
    limiters,
    aggregates,
    attribution,
    baseline: options.baseline ?? null,
  });

  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    runId: run.header.runId,
    traceSchemaVersion: run.header.schemaVersion,
    verdict: buildVerdict(run, findings, attribution, path, coverage),
    run: runIdentity(run),
    coverage,
    attribution,
    findings,
    criticalPath: path,
    stages,
    limiters,
    aggregates,
    counts: {
      rows: run.rows.length,
      serverRows: run.serverRows.filter((row) => row.family !== "metadata-read").length,
      metadataRows: run.serverRows.filter((row) => row.family === "metadata-read").length,
      ticks: run.ticks.length,
      pointEvents: run.events.length,
    },
    raw: {
      inlined: false,
      why: "Raw spans are for a viewer, not a context window: a warm re-open is tens of thousands of rows, and nothing per-row appears at any depth here.",
      command: `lucida trace export ${run.header.runId} --format chrome`,
    },
    next: nextSteps(run, findings, attribution),
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
function deriveCoverage(run: TraceRun): DiagnosticCoverage {
  const traceCoverage: TraceCoverage = run.coverage;
  const wallUs = Math.max(1, traceCoverage.wallClockUs);
  const truncation = run.header.truncation;

  return {
    wallMs: usToMs(traceCoverage.wallClockUs),
    accountedMs: usToMs(traceCoverage.accountedUs),
    accountedPct: Math.floor((traceCoverage.accountedUs / wallUs) * 100),
    gaps: traceCoverage.gaps.map((gap) => ({
      kind: gap.kind,
      startMs: gap.startUs == null ? null : usToMs(gap.startUs),
      endMs: gap.endUs == null ? null : usToMs(gap.endUs),
      durationMs: usToMs(gap.durationUs),
      records: gap.records,
      couldHideBottleneck: gap.couldHideBottleneck,
      statement: gap.statement,
    })),
    gapCount: traceCoverage.gaps.length,
    // A truncated run is incomplete by definition: it stopped looking, so the
    // remainder is not merely unmeasured but unbounded.
    incomplete: truncation != null || traceCoverage.gaps.some((gap) => gap.couldHideBottleneck),
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
    limits: traceCoverage.limits,
    countedPhases: traceCoverage.countedPhases,
    // #899 recorded zero retries, zero failures and zero evictions while the
    // pipeline ran 20,000 requests behind. A zero here means the path was not
    // exercised, which is not the same news as the path being healthy.
    notHealthSignals: [
      { metric: "retries", value: countEvents(run, "retry") },
      { metric: "failures", value: countEvents(run, "failure") },
      { metric: "evictions", value: countEvents(run, "eviction") },
      { metric: "rejections", value: countEvents(run, "rejection") },
    ],
  };
}

function countEvents(run: TraceRun, kind: string): number {
  return run.events.filter((event) => event.kind === kind).length;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface AttributionInput {
  run: TraceRun;
  path: CriticalPath;
  stages: StageRollup[];
  limiters: LimiterSummary[];
  aggregates: AggregateCandidate[];
  coverage: DiagnosticCoverage;
}

/** What every confidence, including the strongest, still cannot see. */
const ALWAYS_DEGRADED =
  "queue time is a floor rather than a total (a request admitted off the backlog dates its queue from the plan pass that enqueued it), and this chain is one row's history rather than every row's";

function passesShare(ms: number, sharePct: number): boolean {
  return sharePct >= RULESET.share.minPct && ms >= RULESET.share.floorMs;
}

function attribute(input: AttributionInput): Attribution {
  const { path, stages, limiters, aggregates, coverage } = input;
  const saturated = limiters.find((limiter) => backlogExceeded(limiter));
  const aggregate = aggregates.find((candidate) => passesShare(candidate.busyMs, candidate.sharePct));

  if (path.kind === "undefined") {
    const reason = path.undefinedReason ?? "no critical path could be walked";
    if (saturated) {
      return {
        confidence: "resource-limited",
        cause: saturated.id,
        why: `${saturated.id} held ${saturated.pending.toLocaleString()} requests behind a cap of ${saturated.cap}, draining at ${saturated.drainPerS}/s over the trailing ${RULESET.backlog.windowMs} ms`,
        degraded: `${reason}, so the backlog is the constraint the run is under rather than a segment on anyone's path`,
        runnerUp: null,
      };
    }
    if (aggregate) {
      return {
        confidence: "aggregate-only",
        cause: aggregate.stage,
        why: `${aggregate.stage} held the main thread for ${aggregate.busyMs} ms of the run (${aggregate.sharePct}%), recorded as per-tick readings because a per-item row here would be a six-figure-per-second write`,
        degraded: `${reason}; with no per-item rows this stage can be shown to overlap the work, not to be on its path, and its busy total is a lower bound`,
        runnerUp: null,
      };
    }
    const breach = worstCeilingBreach(stages);
    if (breach) {
      return {
        confidence: "rollup-only",
        cause: breach.stage.id,
        why: `${breach.stage.id} p95 ${breach.stage.p95Ms} ms over its ${breach.ceilMs} ms ceiling across ${breach.stage.n.toLocaleString()} rows`,
        degraded: `${reason} — this is ranked by percentile, which is evidence the stage was slow and not evidence it was on the run's path`,
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

  // The chain is led by time nothing recorded. No stage can be blamed for it,
  // and saying so is the entire reason the segment is kept in the chain.
  if (leader.class === "unrecorded") {
    return {
      confidence: "partial",
      cause: null,
      why: `the largest span on the critical path is ${leader.ms} ms (${leader.sharePct}% of the run) before the first recorded boundary`,
      degraded:
        "no stage can be blamed for it — nothing instruments that stretch, and the run's bottleneck may be inside it",
      runnerUp: second ? { label: second.label, ms: second.ms } : null,
    };
  }

  // An aggregate stage large enough to rival the chain leader. It cannot be
  // placed on the path, only shown to overlap it — a weaker claim, said plainly.
  if (aggregate && aggregate.sharePct >= leader.sharePct) {
    return {
      confidence: "aggregate-only",
      cause: aggregate.stage,
      why: `${aggregate.stage} held the main thread for ${aggregate.busyMs} ms (${aggregate.sharePct}% of the run) but has no per-item rows`,
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
  return {
    confidence: strong ? "attributed" : "partial",
    cause: leader.label,
    why: `back-walk from ${path.target}: ${leader.ms} ms of a ${path.targetAtMs} ms chain`,
    degraded: strong
      ? ALWAYS_DEGRADED
      : `only ${coverage.accountedPct}% of the run's wall clock is covered by a recorded phase, so the chain may be leading past the real bottleneck; ${ALWAYS_DEGRADED}`,
    runnerUp: second ? { label: second.label, ms: second.ms } : null,
  };
}

function worstCeilingBreach(
  stages: StageRollup[],
): { stage: StageRollup; ceilMs: number; ratio: number } | null {
  let worst: { stage: StageRollup; ceilMs: number; ratio: number } | null = null;
  for (const rule of RULESET.absolute) {
    const stage = stages.find((candidate) => candidate.id === rule.stage);
    if (!stage || stage.p95Ms <= rule.ceilMs) continue;
    const ratio = stage.p95Ms / rule.ceilMs;
    if (!worst || ratio > worst.ratio) worst = { stage, ceilMs: rule.ceilMs, ratio };
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface FindingsInput {
  path: CriticalPath;
  stages: StageRollup[];
  limiters: LimiterSummary[];
  aggregates: AggregateCandidate[];
  attribution: Attribution;
  baseline: DiagnosticDocument | null;
}

function rankFindings(input: FindingsInput): Finding[] {
  const raw: Omit<Finding, "id" | "confidence" | "attribution">[] = [];

  for (const rule of RULESET.absolute) {
    const stage = input.stages.find((candidate) => candidate.id === rule.stage);
    if (!stage || stage.p95Ms <= rule.ceilMs) continue;
    raw.push({
      severity: "stall",
      rule: rule.id,
      subject: stage.id,
      observed: { stat: rule.stat, ms: stage.p95Ms, n: stage.n },
      threshold: { kind: "absolute", value: rule.ceilMs, why: rule.why },
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
    // Unrecorded time is reported as missing coverage, never as a stall, and a
    // queue segment is judged by whether its backlog drains rather than by how
    // much of the run it holds.
    if (segment.class === "unrecorded" || segment.class === "queue") continue;
    if (!passesShare(segment.ms, segment.sharePct)) continue;
    raw.push({
      severity: "stall",
      rule: RULESET.share.id,
      subject: segment.label,
      observed: {
        ms: segment.ms,
        sharePct: segment.sharePct,
        rows: segment.rows,
        ...(segment.breakdown ? { breakdown: segment.breakdown } : {}),
      },
      threshold: { kind: "relative", value: RULESET.share.minPct, why: RULESET.share.why },
    });
  }

  for (const candidate of input.aggregates) {
    if (!passesShare(candidate.busyMs, candidate.sharePct)) continue;
    raw.push({
      severity: "stall",
      rule: RULESET.share.id,
      subject: candidate.stage,
      observed: {
        ms: candidate.busyMs,
        sharePct: candidate.sharePct,
        rows: 0,
        tier: "per-tick readings",
      },
      threshold: { kind: "relative", value: RULESET.share.minPct, why: RULESET.share.why },
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
): Omit<Finding, "id" | "confidence" | "attribution">[] {
  const baseline = input.baseline;
  if (!baseline) return [];

  const out: Omit<Finding, "id" | "confidence" | "attribution">[] = [];
  for (const stage of input.stages) {
    const before = baseline.stages.find((candidate) => candidate.id === stage.id);
    if (!before || before.p95Ms <= 0) continue;
    const ratio = stage.p95Ms / before.p95Ms;
    if (ratio <= RULESET.compare.minRatio) continue;
    out.push({
      severity: "stall",
      rule: RULESET.compare.id,
      subject: stage.id,
      observed: {
        stat: "p95",
        ms: stage.p95Ms,
        baselineMs: before.p95Ms,
        ratio: Math.round(ratio * 10) / 10,
        n: stage.n,
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
      ? `slowest recorded segment was ${slowest.label} at ${slowest.ms} ms (${slowest.sharePct}% of the run)`
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

  const share = lead.observed.sharePct != null ? ` (${lead.observed.sharePct}% of the run)` : "";
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
    gpu: header.gpu ? `${header.gpu.vendor} ${header.gpu.architecture}`.trim() : "unknown",
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

function nextSteps(run: TraceRun, findings: Finding[], attribution: Attribution): DiagnosticDocument["next"] {
  const runId = run.header.runId;
  const steps: DiagnosticDocument["next"] = [
    { why: "every phase, one row each", command: `lucida trace show ${runId} --stages` },
  ];
  const lead = findings.find((finding) => finding.severity !== "note");
  if (lead) {
    steps.unshift({
      why: `the shape behind ${lead.subject}`,
      command: `lucida trace show ${runId} --stage ${lead.subject}`,
    });
  }
  if (INCONCLUSIVE.includes(attribution.confidence)) {
    steps.push({
      why: "the attribution is not conclusive; a second run makes the comparison possible",
      command: `lucida trace ${run.header.datasetIds[0] ?? "<dataset>"} --compare ${runId}`,
    });
  }
  steps.push({
    why: "raw spans, for a viewer rather than a context window",
    command: `lucida trace export ${runId} --format chrome`,
  });
  return steps;
}

/** Re-exported so a surface can name the two segments it must handle specially. */
export { PHASES, PRE_PLAN, UNRECORDED_PREFIX };
export type { PathSegment };
