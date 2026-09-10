/**
 * Two runs compared (#1059): header differences with a comparability
 * warning, phase deltas, and finding deltas, as one document and one text.
 *
 * The subtraction lives behind the trace seam, as the diagnostic does, so
 * every reader of it prints the same deltas: `lucida trace diff` today, and
 * any viewer surface that sets two runs side by side. Each side is derived
 * by {@link diagnoseDocument} first, and the comparison selects from the two
 * diagnostics and computes nothing of its own beyond a subtraction: a number
 * here is a number in one of the two documents, or the difference of two
 * such numbers.
 *
 * The header comparison is what makes a diff honest. Two runs at different
 * device pixel ratios, on different adapters, or of different datasets are
 * incomparable, and a diff that prints their deltas without saying so is
 * worse than no diff (ADR 0047). Those fields break comparability when they
 * differ. The planning configuration and the CPU cache knobs are the
 * experiment: they are listed, never warned about.
 */

import { CACHE_KNOB_FIELDS, type CacheKnobs } from "../../pipeline/fetch/cacheKnobs.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "../../pipeline/planning/config.ts";
import type { RunHeader, TraceDocument } from "../types.ts";
import { diagnoseDocument } from "./diagnose.ts";
import { formatCause } from "./renderText.ts";
import type {
  DiagnosticDocument,
  Finding,
  FindingObservation,
  FindingSeverity,
  NextStep,
  PhaseClass,
  PhaseRollup,
  PhaseSide,
  Verdict,
} from "./types.ts";

/** A header value as the comparison carries it: readable, and JSON. */
export type HeaderValue = string | number | boolean | null;

/**
 * One side of a comparison. A trace document and which of its runs, plus
 * what the caller knows about the conditions that the document does not
 * record: the planning configuration the run ran under, the CPU cache knobs
 * it was given, and any other condition worth listing.
 */
export interface CompareSide {
  trace: TraceDocument;
  /** The run to compare. The newest when absent. */
  runId?: string;
  /** How the side is named in text: a file path, or the knobs it ran under. The run id when absent. */
  label?: string;
  /**
   * The planning fields known for this run. A bundle's header carries the
   * whole configuration; the driver's run file carries the knobs it set,
   * and every other field ran at the page's default. Omit when nothing is
   * known: the side then reads as unknown beside a side that knows, and no
   * planning field is listed when neither side knows.
   */
  planning?: Partial<PlanningConfig> | null;
  /** The CPU cache knobs the run was given. A knob neither side set is not listed. */
  cache?: CacheKnobs | null;
  /** Conditions the caller knows and the trace does not, listed as given and never judged. */
  conditions?: Record<string, HeaderValue> | null;
}

/** What each side is, for the text's two identity lines and the JSON. */
export interface ComparedRun {
  runId: string;
  label: string;
  datasetIds: string[];
  cause: string;
  endReason: string;
  wallMs: number;
  verdict: Verdict;
}

/**
 * Where a header field comes from: the run header the trace records, the
 * planning configuration, the CPU cache knobs, or a condition the caller
 * listed.
 */
export type HeaderGroup = "run" | "planning" | "cache" | "condition";

/** One header field on both sides. */
export interface HeaderDifference {
  /** `devicePixelRatio`, `planning.prefetchDepth`, `cache.maxConcurrentFetches`, or a caller's condition. */
  field: string;
  group: HeaderGroup;
  left: HeaderValue;
  right: HeaderValue;
  same: boolean;
  /**
   * Whether a difference here makes the two runs incomparable rather than
   * being the experiment. True for the conditions the trace header records
   * so two runs are comparable or visibly not; false for the planning
   * configuration, the cache knobs, and a caller's conditions.
   */
  breaksComparability: boolean;
}

/** One phase's numbers, the columns of the phase table. */
export interface PhaseNumbers {
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
}

/** One phase on both sides. `delta` is right minus left, and null when a side lacks the phase. */
export interface PhaseDelta {
  id: string;
  label: string;
  side: PhaseSide;
  class: PhaseClass;
  left: PhaseNumbers | null;
  right: PhaseNumbers | null;
  delta: PhaseNumbers | null;
}

/** A finding as one side saw it. */
export interface FindingReading {
  id: number;
  severity: FindingSeverity;
  observed: FindingObservation;
}

/** The numeric fields of an observation, each right minus left. */
export type ObservationDelta = Partial<Record<NumericObservationKey, number>>;

type NumericObservationKey = {
  [K in keyof FindingObservation]-?: FindingObservation[K] extends number | undefined ? K : never;
}[keyof FindingObservation];

/** One rule on one subject, on both sides. */
export interface FindingDelta {
  rule: string;
  subject: string;
  status: "both" | "left-only" | "right-only";
  left: FindingReading | null;
  right: FindingReading | null;
  /** Right minus left over the observation fields both sides carry. Null unless both do. */
  delta: ObservationDelta | null;
}

export interface RunComparison {
  left: ComparedRun;
  right: ComparedRun;
  /** False when a header field that breaks comparability differs. The deltas are still computed. */
  comparable: boolean;
  /** One sentence per header field that breaks comparability, empty when comparable. */
  warnings: string[];
  header: HeaderDifference[];
  wall: { leftMs: number; rightMs: number; deltaMs: number; deltaPct: number | null };
  /** Whether the verdict kind differs between the sides. */
  verdictChanged: boolean;
  phases: PhaseDelta[];
  findings: FindingDelta[];
  next: NextStep[];
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * Compare `right` against `left`: every delta is right minus left, so a
 * baseline on the left and a candidate on the right read as "what the
 * candidate changed".
 */
export function compareTraces(left: CompareSide, right: CompareSide): RunComparison {
  const l = resolve(left);
  const r = resolve(right);

  const header = compareHeaders(l, r);
  const warnings = header
    .filter((field) => field.breaksComparability && !field.same)
    .map((field) => `${WARNING_LABELS[field.field] ?? field.field} ${show(field.left)} vs ${show(field.right)}`);

  const leftWall = l.doc.run.wallMs;
  const rightWall = r.doc.run.wallMs;
  return {
    left: comparedRun(l),
    right: comparedRun(r),
    comparable: warnings.length === 0,
    warnings,
    header,
    wall: {
      leftMs: leftWall,
      rightMs: rightWall,
      deltaMs: round(rightWall - leftWall),
      deltaPct: leftWall > 0 ? Math.round(((rightWall - leftWall) / leftWall) * 100) : null,
    },
    verdictChanged: l.doc.verdict.kind !== r.doc.verdict.kind,
    phases: comparePhases(l.doc.phases, r.doc.phases),
    findings: compareFindings(l.doc.findings, r.doc.findings),
    next: [
      { why: "the left run's phases, one row each", command: `lucida trace show ${l.doc.runId} --phases` },
      { why: "the right run's phases, one row each", command: `lucida trace show ${r.doc.runId} --phases` },
    ],
  };
}

/** One side with its run found and its diagnostic derived. */
interface ResolvedSide {
  side: CompareSide;
  run: RunHeader;
  doc: DiagnosticDocument;
}

function resolve(side: CompareSide): ResolvedSide {
  const run = runOf(side);
  return { side, run, doc: diagnoseDocument(side.trace, { runId: run.runId }) };
}

function runOf(side: CompareSide): RunHeader {
  const runs = side.trace.runs;
  const run = side.runId
    ? runs.find((candidate) => candidate.header.runId === side.runId)
    : runs[runs.length - 1];
  if (!run) throw new Error(`no run ${side.runId ?? "(newest)"} in this trace document`);
  return run.header;
}

function comparedRun({ side, doc }: ResolvedSide): ComparedRun {
  return {
    runId: doc.runId,
    label: side.label ?? doc.runId,
    datasetIds: doc.run.datasetIds,
    cause: formatCause(doc.run.cause),
    endReason: doc.run.endReason,
    wallMs: doc.run.wallMs,
    verdict: doc.verdict,
  };
}

/** The words the warning uses for each field that breaks comparability. */
const WARNING_LABELS: Record<string, string> = {
  dataset: "dataset",
  cause: "cause",
  mode: "mode",
  devicePixelRatio: "device pixel ratio",
  viewport: "viewport",
  adapter: "adapter",
  build: "build",
  cacheWarmth: "browser cache",
  quiescenceHoldMs: "quiescence hold",
};

function compareHeaders(left: ResolvedSide, right: ResolvedSide): HeaderDifference[] {
  const fields: HeaderDifference[] = [];
  const breaking = (field: string, l: HeaderValue, r: HeaderValue) =>
    fields.push({ field, group: "run", left: l, right: r, same: l === r, breaksComparability: true });
  const listed = (group: HeaderGroup, field: string, l: HeaderValue, r: HeaderValue) =>
    fields.push({ field, group, left: l, right: r, same: l === r, breaksComparability: false });

  // The fields the trace header records so two runs are comparable or
  // visibly not (ADR 0047). Read off the diagnostic's identity block where
  // it phrases them; mode and the quiescence hold come off the header.
  breaking("dataset", left.doc.run.datasetIds.join(", "), right.doc.run.datasetIds.join(", "));
  breaking("cause", formatCause(left.doc.run.cause), formatCause(right.doc.run.cause));
  breaking("mode", left.run.composedView.mode, right.run.composedView.mode);
  breaking("devicePixelRatio", left.doc.run.devicePixelRatio, right.doc.run.devicePixelRatio);
  breaking("viewport", left.doc.run.viewport, right.doc.run.viewport);
  breaking("adapter", adapterOf(left.doc), adapterOf(right.doc));
  breaking("build", left.doc.run.build, right.doc.run.build);
  breaking("cacheWarmth", left.doc.run.warmth, right.doc.run.warmth);
  breaking("quiescenceHoldMs", left.run.quiescenceHoldMs, right.run.quiescenceHoldMs);
  // The end reason is an outcome, not a condition: listed, never warned about.
  listed("run", "endReason", left.doc.run.endReason, right.doc.run.endReason);

  // The experiment. A side that knows any planning field knows them all,
  // because the rest ran at the page's defaults. A side that knows none
  // reads as unknown rather than as the defaults, and when neither side
  // knows, the planning rows are left out.
  if (left.side.planning || right.side.planning) {
    const leftPlanning = left.side.planning ? { ...DEFAULT_PLANNING_CONFIG, ...left.side.planning } : null;
    const rightPlanning = right.side.planning ? { ...DEFAULT_PLANNING_CONFIG, ...right.side.planning } : null;
    for (const field of Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof PlanningConfig)[]) {
      listed("planning", `planning.${field}`, leftPlanning?.[field] ?? null, rightPlanning?.[field] ?? null);
    }
  }
  // A cache knob's default depends on the machine, so an unset knob reads
  // as null, which the text prints as "default", rather than as a number.
  for (const field of CACHE_KNOB_FIELDS) {
    const l = left.side.cache?.[field];
    const r = right.side.cache?.[field];
    if (l === undefined && r === undefined) continue;
    listed("cache", `cache.${field}`, l ?? null, r ?? null);
  }
  const conditionKeys = new Set([
    ...Object.keys(left.side.conditions ?? {}),
    ...Object.keys(right.side.conditions ?? {}),
  ]);
  for (const key of conditionKeys) {
    listed("condition", key, left.side.conditions?.[key] ?? null, right.side.conditions?.[key] ?? null);
  }
  return fields;
}

function adapterOf(document: DiagnosticDocument): string {
  return `${document.run.gpu} · ${document.run.adapterKind.label}`;
}

function numbersOf(phase: PhaseRollup): PhaseNumbers {
  return { n: phase.n, p50Ms: phase.p50Ms, p95Ms: phase.p95Ms, maxMs: phase.maxMs, totalMs: phase.totalMs };
}

/**
 * Both sides' entries paired under one key, in first-seen order; an entry
 * the other side lacks pairs with null. The first entry under a key wins on
 * each side.
 */
function pairByKey<T>(
  left: T[],
  right: T[],
  key: (entry: T) => string,
): { left: T | null; right: T | null }[] {
  const byKey = new Map<string, { left: T | null; right: T | null }>();
  for (const entry of left) {
    const k = key(entry);
    if (!byKey.has(k)) byKey.set(k, { left: entry, right: null });
  }
  for (const entry of right) {
    const k = key(entry);
    const pair = byKey.get(k);
    if (!pair) byKey.set(k, { left: null, right: entry });
    else if (!pair.right) pair.right = entry;
  }
  return [...byKey.values()];
}

function comparePhases(left: PhaseRollup[], right: PhaseRollup[]): PhaseDelta[] {
  const deltas: PhaseDelta[] = [];
  for (const { left: l, right: r } of pairByKey(left, right, (phase) => phase.id)) {
    const known = (l ?? r)!;
    const leftNumbers = l ? numbersOf(l) : null;
    const rightNumbers = r ? numbersOf(r) : null;
    deltas.push({
      id: known.id,
      label: known.label,
      side: known.side,
      class: known.class,
      left: leftNumbers,
      right: rightNumbers,
      delta:
        leftNumbers && rightNumbers
          ? {
              n: rightNumbers.n - leftNumbers.n,
              p50Ms: round(rightNumbers.p50Ms - leftNumbers.p50Ms),
              p95Ms: round(rightNumbers.p95Ms - leftNumbers.p95Ms),
              maxMs: round(rightNumbers.maxMs - leftNumbers.maxMs),
              totalMs: round(rightNumbers.totalMs - leftNumbers.totalMs),
            }
          : null,
    });
  }
  return deltas;
}

function readingOf(finding: Finding): FindingReading {
  return { id: finding.id, severity: finding.severity, observed: finding.observed };
}

function findingKey(finding: Finding): string {
  return `${finding.rule} ${finding.subject}`;
}

/**
 * A finding is matched across the two runs by its rule and its subject,
 * never by its rank: the same stall ranked second instead of first is the
 * same stall. A rule fires once per subject, so a second entry under a key
 * would be the same finding ranked again, and the first wins.
 */
function compareFindings(left: Finding[], right: Finding[]): FindingDelta[] {
  const deltas: FindingDelta[] = [];
  for (const { left: l, right: r } of pairByKey(left, right, findingKey)) {
    const known = (l ?? r)!;
    deltas.push({
      rule: known.rule,
      subject: known.subject,
      status: l && r ? "both" : l ? "left-only" : "right-only",
      left: l ? readingOf(l) : null,
      right: r ? readingOf(r) : null,
      delta: l && r ? observationDelta(l.observed, r.observed) : null,
    });
  }
  return deltas;
}

function observationDelta(left: FindingObservation, right: FindingObservation): ObservationDelta {
  const delta: ObservationDelta = {};
  for (const key of Object.keys(right) as (keyof FindingObservation)[]) {
    const l = left[key];
    const r = right[key];
    if (typeof l === "number" && typeof r === "number") {
      delta[key as NumericObservationKey] = round(r - l);
    }
  }
  return delta;
}

/** Three decimals: the rollups carry one, and a subtraction of two such numbers should not print float noise. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/**
 * The comparison as text. One renderer, so every number in the text exists
 * in {@link compareTraces}'s output. The warning leads when the runs are not
 * comparable, before any delta a reader might otherwise take at face value.
 */
export function renderComparison(comparison: RunComparison): string {
  const lines: string[] = [];
  const { left, right } = comparison;
  lines.push(`lucida trace diff ${left.runId} ${right.runId} — every delta is right minus left`);
  lines.push(`left      ${identity(left)}`);
  lines.push(`right     ${identity(right)}`);
  if (!comparison.comparable) {
    lines.push(
      `NOT COMPARABLE  ${comparison.warnings.join(" · ")} — the deltas below compare different conditions`,
    );
  }

  const differing = comparison.header.filter((field) => !field.same && !field.breaksComparability);
  lines.push(
    differing.length === 0
      ? `header    ${comparison.comparable ? "no difference" : "no other difference"}`
      : `header    ${differing
          .map((field) => `${field.field} ${showSide(field, field.left)} → ${showSide(field, field.right)}`)
          .join(" · ")}`,
  );
  const wall = comparison.wall;
  lines.push(
    `wall      ${wall.leftMs} → ${wall.rightMs} ms (${signed(wall.deltaMs)}` +
      `${wall.deltaPct === null ? "" : `, ${signed(wall.deltaPct)}%`})` +
      (comparison.verdictChanged ? ` · verdict ${left.verdict.kind} → ${right.verdict.kind}` : ""),
  );

  lines.push("PHASES    (right minus left; n · p50 · p95 · max · total, ms)");
  for (const phase of comparison.phases) {
    const name = `   ${phase.id.padEnd(24)}`;
    if (phase.delta && phase.left && phase.right) {
      lines.push(
        `${name} n ${phase.left.n}→${phase.right.n} (${signed(phase.delta.n)}) · ` +
          `p50 ${phase.left.p50Ms}→${phase.right.p50Ms} (${signed(phase.delta.p50Ms)}) · ` +
          `p95 ${phase.left.p95Ms}→${phase.right.p95Ms} (${signed(phase.delta.p95Ms)}) · ` +
          `max ${phase.left.maxMs}→${phase.right.maxMs} (${signed(phase.delta.maxMs)}) · ` +
          `total ${phase.left.totalMs}→${phase.right.totalMs} (${signed(phase.delta.totalMs)})`,
      );
    } else {
      const only = (phase.left ?? phase.right)!;
      lines.push(
        `${name} ${phase.left ? "left" : "right"} only · n=${only.n} · p50 ${only.p50Ms} · p95 ${only.p95Ms} · ` +
          `max ${only.maxMs} · total ${only.totalMs}`,
      );
    }
  }

  const shared = comparison.findings.filter((finding) => finding.status === "both").length;
  const leftOnly = comparison.findings.filter((finding) => finding.status === "left-only").length;
  const rightOnly = comparison.findings.filter((finding) => finding.status === "right-only").length;
  lines.push(
    comparison.findings.length === 0
      ? "FINDINGS  none on either side"
      : `FINDINGS  ${shared} shared · ${leftOnly} left only · ${rightOnly} right only`,
  );
  for (const finding of comparison.findings) {
    const where = finding.status === "both" ? "both" : finding.status === "left-only" ? "left" : "right";
    const severity = (finding.right ?? finding.left)!.severity.toUpperCase();
    lines.push(
      `   ${where.padEnd(9)} ${severity.padEnd(12)} ${finding.subject}   ${headline(finding)}   [${finding.rule}]`,
    );
  }

  lines.push("next");
  for (const step of comparison.next) lines.push(`   ${step.command.padEnd(52)} # ${step.why}`);
  return lines.join("\n");
}

function identity(run: ComparedRun): string {
  const label = run.label === run.runId ? run.runId : `${run.runId} (${run.label})`;
  return (
    `${label} · ${run.datasetIds.join(", ")} · cause=${run.cause} · ${run.wallMs} ms wall · ` +
    `ended: ${run.endReason} · VERDICT: ${run.verdict.text}`
  );
}

/** The observation fields a finding's one-line delta reads, most telling first. */
const HEADLINE_KEYS: NumericObservationKey[] = [
  "ms",
  "sharePct",
  "backlogEtaS",
  "bytesPerS",
  "bytes",
  "refetches",
  "chunks",
  "fillPct",
  "lossPct",
  "wokenPasses",
  "pending",
  "n",
];

function headline(finding: FindingDelta): string {
  if (finding.left && finding.right && finding.delta) {
    for (const key of HEADLINE_KEYS) {
      const l = finding.left.observed[key];
      const r = finding.right.observed[key];
      const d = finding.delta[key];
      if (typeof l === "number" && typeof r === "number" && typeof d === "number") {
        return `${key} ${l} → ${r} (${signed(d)})`;
      }
    }
    return "no shared measure";
  }
  const only = (finding.left ?? finding.right)!;
  for (const key of HEADLINE_KEYS) {
    const value = only.observed[key];
    if (typeof value === "number") return `${key} ${value}`;
  }
  return "";
}

function show(value: HeaderValue): string {
  return value === null ? "unknown" : String(value);
}

/** A cache knob a side did not set ran at the cache's default; any other null is a side that could not say. */
function showSide(field: HeaderDifference, value: HeaderValue): string {
  if (value === null && field.group === "cache") return "default";
  return show(value);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
