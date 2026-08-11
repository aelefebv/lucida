/**
 * The monitor's reading of a diagnostic document.
 *
 * A *reading*, in the same sense as the agent text (`renderText.ts`): this
 * module selects from the document and never computes a number of its own. If
 * the page needs a figure the derivation does not carry, the fix is a field on
 * the derivation, not an expression in a component — a number a surface
 * computes for itself exists in no document and cannot be looked up.
 *
 * It is pure and browser-free, so the page's whole content is testable over
 * the derivation's fixture runs with nothing rendered.
 */

import type {
  Confidence,
  CriticalPath,
  DiagnosticDocument,
  Finding,
  LimiterSummary,
  PhaseRollup,
  PhaseSide,
} from "../trace/diagnose/types.ts";
import type { RunCause } from "../trace/types.ts";

/** One figure, already formatted, with the word that names it. */
export interface MonitorNumber {
  label: string;
  value: string;
}

/**
 * What a drill-down carries: a phase to scope to, the question that sent the
 * reader there, and the worst row that phase saw.
 *
 * Deliberately not a time range. Brushing a time window is Perfetto's job; the
 * question a callout raises is "what is behind this phase", and an interval is
 * an answer to a different one.
 */
export interface MonitorDrill {
  phaseId: string;
  /** The callout's headline, carried through verbatim so one step changes nothing but the depth. */
  question: string;
  worst: { label: string; ms: number } | null;
  /** The phase's shape, formatted once here rather than again in the panel. */
  numbers: MonitorNumber[];
  /** Where the phase sat on the run's clock, or why it sat nowhere. */
  placement: string;
}

export interface MonitorCallout {
  id: string;
  tone: "verdict" | "stall" | "saturated" | "note";
  /** The phase, limiter or segment the callout is about. */
  subject: string;
  headline: string;
  confidence: Confidence | "observed";
  /** What this callout cannot see, or why the rule fired. Never empty. */
  detail: string;
  rule: string | null;
  numbers: MonitorNumber[];
  /** Null when the subject is nothing the phase table can scope to. */
  drill: MonitorDrill | null;
}

export type MonitorBannerKind = "truncation" | "coverage" | "gap" | "not-health" | "limits";

export interface MonitorBanner {
  kind: MonitorBannerKind;
  headline: string;
  detail: string;
  /** True when this banner qualifies the verdict rather than merely informing. */
  severe: boolean;
}

/**
 * One phase drawn over the run's wall clock.
 *
 * `placed` is not decoration. A phase can be measured and unplaceable — a
 * server row the merge could not nest carries durations and no position at all
 * (ADR 0050) — and drawing one of those at the origin is the same class of lie
 * as drawing silence over a cold open's metadata reads.
 */
export interface MonitorTrack {
  phaseId: string;
  label: string;
  side: PhaseSide;
  className: PhaseRollup["class"];
  placed: boolean;
  leftPct: number;
  widthPct: number;
  /** Rows, and how many of them could be positioned. Always states the shortfall. */
  note: string;
  p95Ms: number;
  totalMs: number;
}

export interface MonitorTrackGroup {
  side: PhaseSide;
  title: string;
  /** Why this group exists as its own row band, for a reader who has never seen one before. */
  why: string;
  tracks: MonitorTrack[];
}

export interface MonitorView {
  runId: string;
  wallMs: number;
  identity: MonitorNumber[];
  /** Truncation and coverage, ahead of every number they qualify. */
  banners: MonitorBanner[];
  /** The verdict, then the ranked findings. Index 0 is always the verdict. */
  callouts: MonitorCallout[];
  trackGroups: MonitorTrackGroup[];
  phases: PhaseRollup[];
  limiters: LimiterSummary[];
  criticalPath: CriticalPath;
  counts: MonitorNumber[];
  ruleset: { version: number; note: string };
}

/**
 * A duration as a human reads one. Under a second stays in milliseconds
 * because that is the unit the thresholds are stated in; above it, tenths of a
 * second, because nobody reads 17,400.
 */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

/** A single dataset open is one row, not "1 rows". */
function formatRows(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "row" : "rows"}`;
}

/**
 * The track bands, in the order a run happens.
 *
 * Metadata first and unconditional when the run has any: on a cold open the
 * first seconds are dataset-open metadata reads, and no chunk track can draw
 * them because the first chunk does not exist yet (#893 measured those reads
 * at 91% of a cold headline run).
 */
const TRACK_BANDS: { side: PhaseSide; title: string; why: string }[] = [
  {
    side: "metadata",
    title: "Dataset open — metadata reads",
    why: "Before the first chunk exists. A timeline without this band renders silence over a cold open's bottleneck.",
  },
  {
    side: "browser",
    title: "Browser",
    why: "The per-chunk lifecycle this page's own process measured.",
  },
  {
    side: "server",
    title: "Server",
    why: "Pushed from the server and nested inside the browser's wire bracket; a row the merge could not nest has durations and no position.",
  },
];

export function buildMonitorView(diagnostic: DiagnosticDocument): MonitorView {
  return {
    runId: diagnostic.runId,
    wallMs: diagnostic.run.wallMs,
    identity: identityOf(diagnostic),
    banners: bannersOf(diagnostic),
    callouts: calloutsOf(diagnostic),
    trackGroups: trackGroupsOf(diagnostic),
    phases: diagnostic.phases,
    limiters: diagnostic.limiters,
    criticalPath: diagnostic.criticalPath,
    counts: [
      { label: "chunk rows", value: formatCount(diagnostic.counts.rows) },
      { label: "server rows", value: formatCount(diagnostic.counts.serverRows) },
      { label: "metadata reads", value: formatCount(diagnostic.counts.metadataRows) },
      { label: "ticks", value: formatCount(diagnostic.counts.ticks) },
      { label: "point events", value: formatCount(diagnostic.counts.pointEvents) },
    ],
    ruleset: { version: diagnostic.ruleset.version, note: diagnostic.ruleset.note },
  };
}

/**
 * Why a run opened, in one line. Shared with the live view, which shows the
 * same run before it closes — two spellings of one cause would read as two
 * different runs.
 */
export function formatCause(cause: RunCause | null): string {
  if (!cause) return "steady state";
  return `${cause.epoch ?? "none"} / ${cause.dirtyKind} / ${cause.source}`;
}

function identityOf(diagnostic: DiagnosticDocument): MonitorNumber[] {
  const run = diagnostic.run;
  const cause = formatCause(run.cause);
  return [
    { label: "dataset", value: run.datasetIds.join(", ") || "none" },
    { label: "cause", value: cause },
    { label: "wall clock", value: formatMs(run.wallMs) },
    { label: "ended", value: run.endReason },
    { label: "warmth", value: run.warmth },
    {
      label: "outstanding at close",
      value: `${formatCount(run.outstanding.pending)} pending · ${formatCount(run.outstanding.inFlight)} in flight · ${formatCount(run.outstanding.speculative)} speculative`,
    },
    { label: "device pixel ratio", value: String(run.devicePixelRatio) },
    { label: "viewport", value: run.viewport },
    { label: "gpu", value: run.gpu },
    { label: "build", value: run.build },
  ];
}

/**
 * Truncation and coverage lead. They are not footnotes: a reader has to be told
 * what the run did not measure before being told what it did, and #893 shipped
 * `100% accounted` for a run that was 87% pre-instrument boot.
 */
function bannersOf(diagnostic: DiagnosticDocument): MonitorBanner[] {
  const coverage = diagnostic.coverage;
  const banners: MonitorBanner[] = [];

  if (coverage.truncated) {
    const truncated = coverage.truncated;
    banners.push({
      kind: "truncation",
      headline: `Truncated at ${formatMs(truncated.atMs)} — ${formatCount(truncated.rowsRecorded)} of ${formatCount(truncated.rowsTotal)} rows recorded (${truncated.recordedPct}%)`,
      detail: `Recording stopped: ${truncated.reason}. Everything below is a partial trace, and the remainder is unbounded rather than merely unmeasured.`,
      severe: true,
    });
  }

  banners.push({
    kind: "coverage",
    headline: `${formatMs(coverage.accountedMs)} of ${formatMs(coverage.wallMs)} accounted (${coverage.accountedPct}%) · ${coverage.gapCount} gap(s)`,
    detail: coverage.incomplete
      ? "A gap here could hide the bottleneck, so the verdict is qualified rather than final."
      : "Every stretch of this run is covered by a recorded phase.",
    severe: coverage.incomplete,
  });

  for (const gap of coverage.gaps) {
    const span = gap.durationMs > 0 ? ` · ${formatMs(gap.durationMs)}` : "";
    const records = gap.records > 0 ? ` · ${formatCount(gap.records)} records` : "";
    banners.push({
      kind: "gap",
      headline: `Gap: ${gap.kind}${span}${records}`,
      detail: gap.statement,
      severe: gap.couldHideBottleneck,
    });
  }

  banners.push({
    kind: "not-health",
    headline: `Not a health signal — ${coverage.notHealthSignals
      .map((signal) => `${signal.metric} ${formatCount(signal.value)}`)
      .join(" · ")}`,
    detail:
      "These paths were not exercised. A pipeline running twenty thousand requests behind has recorded exactly these zeroes; an absence of errors is not evidence of health.",
    severe: false,
  });

  if (coverage.limits.length > 0) {
    banners.push({
      kind: "limits",
      headline: `Limits of the instrument (${coverage.limits.length})`,
      detail: coverage.limits.map((limit) => `${limit.id}: ${limit.statement}`).join(" — "),
      severe: false,
    });
  }

  return banners;
}

function calloutsOf(diagnostic: DiagnosticDocument): MonitorCallout[] {
  const lead = diagnostic.findings.find((finding) => finding.severity !== "note");
  const verdict: MonitorCallout = {
    id: "verdict",
    tone: "verdict",
    subject: diagnostic.runId,
    headline: diagnostic.verdict.text,
    confidence: diagnostic.verdict.confidence,
    detail: `Cannot see: ${diagnostic.attribution.degraded}`,
    rule: null,
    numbers: [
      { label: "wall clock", value: formatMs(diagnostic.run.wallMs) },
      { label: "accounted", value: `${diagnostic.coverage.accountedPct}%` },
      { label: "findings", value: formatCount(diagnostic.findings.length) },
    ],
    // The verdict names a phase, so the step from it has to land on that
    // phase. Its question is the verdict's own sentence, not the lead
    // finding's — a reader who clicks from here is asking what the verdict
    // was about.
    drill: drillInto(
      lead ? drillPhase(lead.subject, diagnostic.phases) : null,
      diagnostic.verdict.text,
    ),
  };

  return [verdict, ...diagnostic.findings.map((finding) => calloutOf(finding, diagnostic))];
}

function drillInto(phase: PhaseRollup | null, question: string): MonitorDrill | null {
  if (!phase) return null;
  return {
    phaseId: phase.id,
    question,
    worst: phase.worst,
    numbers: phaseNumbers(phase),
    placement: phase.extent
      ? `${formatMs(phase.extent.firstStartMs)} to ${formatMs(phase.extent.lastEndMs)}`
      : "nowhere on this run's clock",
  };
}

/** A phase's shape, in the order a reader checks it. */
function phaseNumbers(phase: PhaseRollup): MonitorNumber[] {
  return [
    { label: "rows", value: formatCount(phase.n) },
    { label: "p50", value: formatMs(phase.p50Ms) },
    { label: "p95", value: formatMs(phase.p95Ms) },
    { label: "max", value: formatMs(phase.maxMs) },
    // Totals overlap: rows run concurrently, so this is not a share of the
    // wall clock and the factor next to it says how badly.
    { label: "total", value: `${formatMs(phase.totalMs)} (${phase.concurrencyFactor}x at once)` },
  ];
}

function calloutOf(finding: Finding, diagnostic: DiagnosticDocument): MonitorCallout {
  const phase = drillPhase(finding.subject, diagnostic.phases);
  const headline = headlineOf(finding);
  return {
    id: `finding-${finding.id}`,
    tone: finding.severity === "saturated" ? "saturated" : finding.severity === "note" ? "note" : "stall",
    subject: finding.subject,
    headline,
    confidence: finding.confidence,
    detail: finding.attribution
      ? `${finding.attribution.why}. Cannot see: ${finding.attribution.degraded}`
      : `${finding.threshold.kind} threshold ${finding.threshold.value}: ${finding.threshold.why}`,
    rule: finding.rule,
    numbers: numbersOf(finding, phase),
    drill: drillInto(phase, headline),
  };
}

/**
 * The one bit, in a sentence.
 *
 * The same bit the raw track conveys — a solid rectangle spanning the run — plus
 * the numbers that make it actionable. The numbers themselves ride
 * {@link MonitorCallout.numbers} rather than being spelled into the prose, so
 * a reader can scan them and a test can assert one without matching a string.
 */
function headlineOf(finding: Finding): string {
  const observed = finding.observed;
  if (observed.pending != null) {
    return `${finding.subject} held ${formatCount(observed.pending)} behind a cap of ${observed.inFlightCap ?? 0}`;
  }
  const share =
    observed.sharePct != null ? `, ${observed.sharePct}% of the ${observed.shareOf ?? "run"}` : "";
  const amount = observed.ms != null ? `${observed.stat ? `${observed.stat} ` : ""}${formatMs(observed.ms)}` : "";
  return `${finding.subject} — ${amount}${share}`;
}

function numbersOf(finding: Finding, phase: PhaseRollup | null): MonitorNumber[] {
  const numbers: MonitorNumber[] = [];
  const observed = finding.observed;

  if (phase) {
    numbers.push(...phaseNumbers(phase));
  } else if (observed.ms != null) {
    numbers.push({ label: observed.stat ?? "duration", value: formatMs(observed.ms) });
  }

  if (observed.sharePct != null) {
    numbers.push({ label: `share of ${observed.shareOf ?? "run"}`, value: `${observed.sharePct}%` });
  }
  if (observed.pending != null) {
    numbers.push({ label: "pending", value: formatCount(observed.pending) });
  }
  if (observed.inFlightCap != null) {
    numbers.push({ label: "cap", value: `${observed.inFlightCap} (observed max)` });
  }
  if (observed.pinnedPct != null) {
    numbers.push({ label: "pinned at cap", value: `${observed.pinnedPct}%` });
  }
  if (observed.drainPerS != null) {
    numbers.push({ label: "drain", value: `${observed.drainPerS}/s` });
  }
  if (observed.backlogEtaS != null) {
    numbers.push({ label: "backlog eta", value: `${observed.backlogEtaS} s` });
  }
  if (observed.ratio != null && observed.baselineMs != null) {
    numbers.push({ label: "vs baseline", value: `${formatMs(observed.baselineMs)} (${observed.ratio}x)` });
  }
  if (observed.rows === 0 && observed.tier) {
    numbers.push({ label: "per-item rows", value: `none (${observed.tier})` });
  }
  return numbers;
}

/**
 * Which table row a callout opens.
 *
 * Two cases and no guessing. A finding whose subject is a phase opens that
 * phase. The dataset-open segment is the metadata read family under another
 * name — the critical path builds it out of exactly those rows — so it opens
 * the largest metadata phase. Everything else opens nothing: a limiter is not a
 * phase, an aggregate candidate has no per-item rows by definition, and a
 * button that opens neither is worse than no button.
 */
function drillPhase(subject: string, phases: PhaseRollup[]): PhaseRollup | null {
  const exact = phases.find((phase) => phase.id === subject);
  if (exact) return exact;
  if (subject === "open.metadata-read") {
    return phases.filter((phase) => phase.side === "metadata")[0] ?? null;
  }
  return null;
}

function trackGroupsOf(diagnostic: DiagnosticDocument): MonitorTrackGroup[] {
  const wallMs = Math.max(1, diagnostic.run.wallMs);
  const groups: MonitorTrackGroup[] = [];

  for (const band of TRACK_BANDS) {
    const tracks = diagnostic.phases
      .filter((phase) => phase.side === band.side)
      .map((phase) => trackOf(phase, wallMs))
      // Placed tracks in the order they happened, then the unplaceable ones —
      // which have no order, and are last so they read as an appendix rather
      // than as a phase that started at zero.
      .sort((a, b) => Number(b.placed) - Number(a.placed) || a.leftPct - b.leftPct);
    if (tracks.length > 0) groups.push({ ...band, tracks });
  }
  return groups;
}

function trackOf(phase: PhaseRollup, wallMs: number): MonitorTrack {
  const extent = phase.extent;
  const placed = extent != null;
  const shortfall = extent ? phase.n - extent.positionedN : phase.n;
  return {
    phaseId: phase.id,
    label: phase.label,
    side: phase.side,
    className: phase.class,
    placed,
    leftPct: extent ? clampPct((extent.firstStartMs / wallMs) * 100) : 0,
    widthPct: extent
      ? Math.max(0.4, clampPct(((extent.lastEndMs - extent.firstStartMs) / wallMs) * 100))
      : 0,
    note: extent
      ? shortfall > 0
        ? `${formatRows(phase.n)} · ${formatCount(shortfall)} with no position`
        : formatRows(phase.n)
      : `${formatRows(phase.n)} · no position on this run's clock`,
    p95Ms: phase.p95Ms,
    totalMs: phase.totalMs,
  };
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}
