/**
 * The one renderer. Text is a reading of the diagnostic document, never a
 * parallel design: every number printed here exists in the document at a
 * stated path, recorded by {@link Provenance}. Text is the agent's default
 * because the JSON is several times larger for the same content.
 *
 * The default rendering is bounded at 30 lines and 3 kB by construction: lines
 * carry a priority, and over budget the lowest bands are dropped and the drop
 * is stated. Nothing per-row appears except the `chunk` depth's capped lookup.
 */

import type { RunCause } from "../types.ts";
import { SPATIAL_AXES } from "./spatialSummary.ts";
import { describeState } from "./rowState.ts";
import { RULESET } from "./ruleset.ts";
import type { LiveTimeline } from "./timeline.ts";
import type {
  ChunkLookup,
  DiagnosticDocument,
  Finding,
  ObservedError,
  SpatialSummary,
  TimelineSection,
} from "./types.ts";

export const DEFAULT_MAX_LINES = 30;
export const DEFAULT_MAX_BYTES = 3_072;

/**
 * `phase` is one phase's reading, named by {@link RenderOptions.phase}: the
 * depth the "the shape behind X" next step prints. It renders here rather
 * than in whoever asked, so a CLI never grows a second renderer.
 *
 * `chunk` and `spatial` are the two readings the overlay gives a person,
 * rendered as text: the document's chunk lookup, and its spatial summary.
 * Which chunk the lookup is about is a derivation option, not a rendering
 * one; this renderer prints whichever chunk the document carries.
 *
 * `timeline` is the dock's charts as text: one line per chart of the closed
 * set, naming each series' peak and newest value or the reason it is absent,
 * so nothing is visible to a person and invisible to an agent.
 */
export type RenderDepth = "summary" | "phases" | "phase" | "chunk" | "spatial" | "timeline";

const LEAD_CHUNK_ROWS = 3;
const LEAD_SPATIAL_GROUPS = 8;

export interface RenderOptions {
  depth?: RenderDepth;
  /** Which phase `depth: "phase"` is about. */
  phase?: string;
  maxLines?: number;
  maxBytes?: number;
}

/** One number, as printed and as it exists in the document. */
export interface Provenance {
  path: string;
  formatted: string;
}

export interface RenderedDiagnostic {
  text: string;
  provenance: Provenance[];
  /** Lines the budget dropped. Zero on everything that fits. */
  droppedLines: number;
}

/**
 * Priority bands. Lower survives longer. The two unconditional lines and the
 * truncation record are band 0 — a reader has to be told what the run did not
 * measure before being told what it did.
 */
const REQUIRED = 0;
const IDENTITY = 1;
const LEAD_FINDING = 2;
// The commands outrank the extra gaps and the second and third findings: the
// default rendering is required to name what to run next, and a reader who has
// the commands can reach everything below this line anyway.
const NEXT = 3;
const GAPS = 4;
const MORE_FINDINGS = 5;
const DETAIL = 6;

interface Line {
  text: string;
  band: number;
}

type PushLine = (band: number, text: string) => void;
type PrintNumber = (path: string, formatted: string | number) => string;

export function renderDiagnostic(
  document: DiagnosticDocument,
  options: RenderOptions = {},
): RenderedDiagnostic {
  const depth = options.depth ?? "summary";
  const provenance: Provenance[] = [];
  const p: PrintNumber = (path, formatted) => {
    provenance.push({ path, formatted: String(formatted) });
    return String(formatted);
  };

  const lines: Line[] = [];
  const push: PushLine = (band, text) => {
    lines.push({ band, text });
  };

  push(REQUIRED, `lucida trace ${document.runId} — VERDICT: ${document.verdict.text}`);
  push(REQUIRED, `confidence: ${document.verdict.confidence} · degraded: ${document.attribution.degraded}`);

  // Truncation and coverage lead; they do not footnote.
  const truncated = document.coverage.truncated;
  if (truncated) {
    push(
      REQUIRED,
      `TRUNCATED  recording stopped at ${p("coverage.truncated.atMs", truncated.atMs)} ms (${truncated.reason}): ` +
        `${p("coverage.truncated.rowsRecorded", truncated.rowsRecorded.toLocaleString())} of ` +
        `${p("coverage.truncated.rowsTotal", truncated.rowsTotal.toLocaleString())} rows, ` +
        `${p("coverage.truncated.recordedPct", truncated.recordedPct)}% of the run`,
    );
  }
  // The window line goes before the coverage it qualifies: every number after
  // it is of the window, not the run.
  const window = document.window;
  const clip = document.coverage.window;
  if (window && clip) {
    push(
      REQUIRED,
      `window    ${p("window.startMs", window.startMs)}..${p("window.endMs", window.endMs)} ms of the ` +
        `${p("window.ofWallMs", window.ofWallMs)} ms run` +
        (window.whole
          ? " (the whole run)"
          : ` · ${p("coverage.window.clippedRows", clip.clippedRows)} row(s) cross an edge and count for the part inside` +
            ` · ${p("coverage.window.unplacedRows", clip.unplacedRows)} with no position left out`),
    );
  }
  push(
    REQUIRED,
    `coverage  ${p("coverage.accountedMs", document.coverage.accountedMs)} of ` +
      `${p("coverage.wallMs", document.coverage.wallMs)} ms accounted (` +
      `${p("coverage.accountedPct", document.coverage.accountedPct)}%) · ` +
      `${p("coverage.gapCount", document.coverage.gapCount)} gap(s)` +
      (document.coverage.incomplete ? " · a gap could hide the bottleneck" : ""),
  );

  push(
    IDENTITY,
    `run       ${document.run.datasetIds.join(", ")} · cause=${causeOf(document)} · ${document.run.warmth} · ` +
      `${p("run.wallMs", document.run.wallMs)} ms wall · ended: ${document.run.endedAs}`,
  );
  push(
    IDENTITY,
    `client    DPR ${p("run.devicePixelRatio", document.run.devicePixelRatio)} · ${document.run.viewport} · ` +
      `${document.run.gpu} · ${document.run.adapterKind.label} · build ${document.run.build}`,
  );
  push(IDENTITY, `render    ${renderTimingOf(document, p)}`);
  // A run that took no input has no lag reading, and prints no line for one.
  const lag = lagOf(document, p);
  if (lag) push(IDENTITY, `lag       ${lag}`);
  push(IDENTITY, `gpu mem   ${gpuMemoryOf(document, p)}`);

  // The identity line names only the types that sent anything. The SENT table
  // at DETAIL lists the whole closed set, zeros included.
  const sentTypes = document.sent.byType
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.messages > 0);
  push(
    IDENTITY,
    sentTypes.length === 0
      ? "sent      nothing on the session socket"
      : `sent      ${p("sent.bytesPerS", document.sent.bytesPerS.toLocaleString())} B/s · ` +
          sentTypes
            .map(
              ({ entry, index }) =>
                `${entry.label} ${p(`sent.byType[${index}].bytesPerS`, entry.bytesPerS.toLocaleString())} B/s ` +
                `n=${p(`sent.byType[${index}].messages`, entry.messages.toLocaleString())}`,
            )
            .join(" · "),
  );

  document.coverage.gaps.forEach((gap, index) => {
    push(
      GAPS,
      `   GAP    ${gap.kind}` +
        `${gap.durationMs > 0 ? ` ${p(`coverage.gaps[${index}].durationMs`, gap.durationMs)} ms` : ""}` +
        `${gap.records > 0 ? ` ${p(`coverage.gaps[${index}].records`, gap.records.toLocaleString())} records` : ""}` +
        `${gap.couldHideBottleneck ? "  <- could hide the bottleneck" : ""}`,
    );
  });

  // The chunk and spatial readings replace the findings block rather than
  // sitting under it: the budget is thirty lines either way.
  const onlyPhase = depth === "phase" ? (options.phase ?? "") : null;
  if (depth === "chunk") renderChunk(document.chunk, document, push, p);
  else if (depth === "spatial") renderSpatial(document.spatial, document, push, p);
  else if (depth === "timeline") renderTimeline(document.timeline, LEAD_FINDING, push, p);
  else renderFindings(document, depth, onlyPhase, push, p);

  push(
    REQUIRED,
    `NOT A HEALTH SIGNAL  ${document.coverage.notHealthSignals
      .map((signal) => `${signal.metric}=${p(`coverage.notHealthSignals.${signal.metric}`, signal.value)}`)
      .join(" · ")} — ${describeNotHealthSignals(document.coverage.notHealthSignals)}`,
  );

  if (depth === "phases" || depth === "phase") {
    const phases =
      onlyPhase === null ? document.phases : document.phases.filter((phase) => phase.id === onlyPhase);
    push(DETAIL, "");
    const from =
      document.criticalPath.fromMs > 0
        ? `from ${p("criticalPath.fromMs", document.criticalPath.fromMs)} ms `
        : "";
    push(
      DETAIL,
      document.criticalPath.kind === "chain"
        ? `CRITICAL PATH  ${from}to ${document.criticalPath.target} at ${p("criticalPath.targetAtMs", document.criticalPath.targetAtMs!)} ms`
        : `CRITICAL PATH  undefined — ${document.criticalPath.undefinedReason}`,
    );
    for (const segment of document.criticalPath.segments) {
      push(
        DETAIL,
        `   ${String(segment.sharePct).padStart(3)}%  ${segment.label.padEnd(22)} ` +
          `${String(segment.ms).padStart(9)} ms  ${segment.source}`,
      );
    }
    push(DETAIL, "");
    push(
      DETAIL,
      "STAGES  (totals overlap: rows run concurrently, so a total is not a share of the wall clock)",
    );
    for (const phase of phases) {
      push(
        DETAIL,
        `   ${phase.id.padEnd(24)} ${phase.class.padEnd(8)} n=${String(phase.n).padStart(6)} ` +
          `p50 ${String(phase.p50Ms).padStart(8)} p95 ${String(phase.p95Ms).padStart(8)} ` +
          `max ${String(phase.maxMs).padStart(8)} total ${String(phase.totalMs).padStart(9)} ${phase.concurrencyFactor}x`,
      );
    }
    if (document.limiters.length > 0) {
      push(DETAIL, "");
      push(DETAIL, "LIMITERS");
      for (const limiter of document.limiters) {
        push(
          DETAIL,
          `   ${limiter.id.padEnd(24)} cap ${limiter.cap} (${limiter.capSource}) · pinned ${limiter.pinnedPct}% · ` +
            `pending ${limiter.pending.toLocaleString()} · drain ${limiter.drainPerS}/s over ${limiter.windowMs} ms · ` +
            `backlog ETA ${limiter.backlogEtaS == null ? "does not drain" : `${limiter.backlogEtaS} s`}`,
        );
      }
    }
    push(DETAIL, "");
    push(
      DETAIL,
      "SENT  (messages the page transmitted on the session socket, by client message type, over the run's wall clock)",
    );
    document.sent.byType.forEach((entry, index) => {
      push(
        DETAIL,
        `   ${entry.label.padEnd(18)} n=${p(`sent.byType[${index}].messages`, entry.messages).padStart(7)} ` +
          `${p(`sent.byType[${index}].bytes`, entry.bytes).padStart(11)} B ` +
          `${p(`sent.byType[${index}].bytesPerS`, entry.bytesPerS).padStart(9)} B/s`,
      );
    });
    renderSteadyState(document, push, p);
    if (document.lag) {
      push(DETAIL, "");
      push(DETAIL, `LAG  ${document.lag.statement}`);
    }
    push(DETAIL, "");
    push(DETAIL, `RULESET v${document.ruleset.version} — ${document.ruleset.note}`);
  }

  push(NEXT, "next");
  // `next` already ends with the raw export; the document's `raw` block states
  // why raw rows are never inlined, which is a rationale rather than a step.
  for (const step of document.next) push(NEXT, `   ${step.command.padEnd(52)} # ${step.why}`);

  // The phase depths and the timeline are where a reader goes when the budget
  // was not enough, so they are unbudgeted.
  const budgeted = depth === "summary" || depth === "chunk" || depth === "spatial";
  const maxLines = options.maxLines ?? (budgeted ? DEFAULT_MAX_LINES : Infinity);
  const maxBytes = options.maxBytes ?? (budgeted ? DEFAULT_MAX_BYTES : Infinity);
  const { kept, dropped } = fit(lines, maxLines, maxBytes);
  return { text: kept.join("\n"), provenance, droppedLines: dropped };
}

function renderFindings(
  document: DiagnosticDocument,
  depth: RenderDepth,
  onlyPhase: string | null,
  push: PushLine,
  p: PrintNumber,
): void {
  if (onlyPhase !== null) {
    const known = document.phases.some((phase) => phase.id === onlyPhase);
    push(
      LEAD_FINDING,
      known
        ? `PHASE     ${onlyPhase}`
        : `PHASE     ${onlyPhase} — not in this run; --phases lists the ones that are`,
    );
  }

  const ranked =
    onlyPhase === null
      ? document.findings
      : document.findings.filter((finding) => finding.subject === onlyPhase);
  const shown = depth === "summary" ? ranked.slice(0, 3) : ranked;
  if (shown.length === 0) {
    push(
      LEAD_FINDING,
      onlyPhase === null
        ? "FINDINGS  none — no threshold crossed."
        : `FINDINGS  none against ${onlyPhase}.`,
    );
    return;
  }
  push(LEAD_FINDING, `FINDINGS (${p("findings.length", ranked.length)})`);
  shown.forEach((finding, index) => {
    const band = index === 0 ? LEAD_FINDING : MORE_FINDINGS;
    push(
      band,
      `  ${finding.id}  ${finding.severity.toUpperCase().padEnd(9)} ${finding.subject}   ` +
        `${describeObservation(finding, p)}   [${finding.rule}]`,
    );
    if (index === 0 && finding.attribution) {
      push(band, `       why: ${finding.attribution.why}`);
    }
    if (depth !== "summary") {
      push(
        DETAIL,
        `       threshold: ${finding.threshold.value} (${finding.threshold.kind}) — ${finding.threshold.why}`,
      );
    }
  });
  if (depth === "summary" && ranked.length > shown.length) {
    push(
      MORE_FINDINGS,
      `  ... ranked findings above; the run carries ${p("findings.length", document.findings.length)} in total (see --phases)`,
    );
  }
}

function renderChunk(
  chunk: ChunkLookup,
  document: DiagnosticDocument,
  push: PushLine,
  p: PrintNumber,
): void {
  push(LEAD_FINDING, `CHUNK     ${chunk.selector ?? "(none)"} — ${chunk.chosen}`);
  push(LEAD_FINDING, `          ${chunk.statement}`);
  if (chunk.rowCount === 0 && chunk.chunkKey !== null) {
    // The queue at close is the number a missing row most often comes down to.
    push(
      LEAD_FINDING,
      `          at run close ${p("run.outstanding.pending", document.run.outstanding.pending.toLocaleString())} ` +
        `requests were still pending and ${p("run.outstanding.inFlight", document.run.outstanding.inFlight.toLocaleString())} in flight`,
    );
  }
  chunk.rows.forEach((row, index) => {
    const band =
      index < LEAD_CHUNK_ROWS ? LEAD_FINDING : index < LEAD_CHUNK_ROWS * 3 ? MORE_FINDINGS : DETAIL;
    const base = `chunk.rows[${index}]`;
    push(
      band,
      `  ${p(`${base}.id`, row.id)}  ${row.entityId} · ${row.lane}/${row.residencyTier} · ` +
        `rid ${p(`${base}.rid`, row.rid)} gen ${p(`${base}.connectionGeneration`, row.connectionGeneration)} · ` +
        describeState(row.state) +
        (row.ageMs === null ? "" : ` · age ${p(`${base}.ageMs`, row.ageMs)} ms`) +
        (row.firstSeenMs === null ? "" : ` · first seen ${p(`${base}.firstSeenMs`, row.firstSeenMs)} ms`),
    );
    if (row.phases.length > 0) {
      push(
        band,
        `     ${row.phases
          .map((phase, i) => `${phase.phase} ${p(`${base}.phases[${i}].durationMs`, phase.durationMs)}`)
          .join(" → ")} ms`,
      );
    }
    if (row.queue) {
      push(
        band,
        `     queue: ${p(`${base}.queue.aheadAtAdmission`, row.queue.aheadAtAdmission.toLocaleString())} ahead at admission · ` +
          `${p(`${base}.queue.overtaken`, row.queue.overtaken.toLocaleString())} overtook it · ` +
          `waited ${p(`${base}.queue.waitedMs`, row.queue.waitedMs)} ms · ` +
          `${row.queue.dispatched ? "dispatched" : "not dispatched by run close"}`,
      );
    }
  });
  chunk.events.forEach((event, index) => {
    push(
      index < LEAD_CHUNK_ROWS ? LEAD_FINDING : MORE_FINDINGS,
      `  EVENT  ${event.kind} (${event.reason}) at ${p(`chunk.events[${index}].atMs`, event.atMs.toLocaleString())} ms · ` +
        `${event.entityId} ${event.residencyTier}`,
    );
  });
  push(NEXT, `   cannot see: ${chunk.limits}`);
}

/**
 * The text twin of the ribbon the dock draws between two runs: what the
 * pipeline did after the view settled, and the tiers as the run left them.
 * Every steady-state finding's numbers are here whether the rule fired or
 * not, so a quiet interval reads as measured rather than as unexamined.
 */
function renderSteadyState(document: DiagnosticDocument, push: PushLine, p: PrintNumber): void {
  const steady = document.steadyState;
  push(DETAIL, "");
  push(
    DETAIL,
    "STEADY STATE  (the unlabelled interval that opened when the run closed; the tiers are the run's settle block)",
  );
  push(DETAIL, `   ${steady.statement}`);
  const interval = steady.interval;
  if (interval) {
    push(
      DETAIL,
      `   interval   ${interval.id} · ${p("steadyState.interval.windowMs", interval.windowMs)} ms · ` +
        `${p("steadyState.interval.rows", interval.rows.toLocaleString())} row(s) · ` +
        `${p("steadyState.interval.passes", interval.passes.toLocaleString())} pass(es) · ended ${interval.endReason}`,
    );
  }
  const received = steady.received;
  if (received) {
    push(
      DETAIL,
      `   received   ${p("steadyState.received.bytes", received.bytes.toLocaleString())} B ` +
        (received.wireBytes === received.bytes
          ? ""
          : `(${p("steadyState.received.wireBytes", received.wireBytes.toLocaleString())} B on the wire) `) +
        `over ` +
        `${p("steadyState.received.requests", received.requests.toLocaleString())} request(s) · ` +
        `${p("steadyState.received.bytesPerS", received.bytesPerS.toLocaleString())} B/s · ` +
        `${p("steadyState.received.busySeconds", received.busySeconds)} busy second(s) at ` +
        `${p("steadyState.received.busyBytesPerS", received.busyBytesPerS.toLocaleString())} B/s`,
    );
    received.byLane.forEach((lane, index) => {
      push(
        DETAIL,
        `      lane ${lane.lane.padEnd(9)} ${p(`steadyState.received.byLane[${index}].bytes`, lane.bytes.toLocaleString()).padStart(11)} B ` +
          `${p(`steadyState.received.byLane[${index}].requests`, lane.requests.toLocaleString()).padStart(7)} request(s) ` +
          `${p(`steadyState.received.byLane[${index}].bytesPerS`, lane.bytesPerS.toLocaleString()).padStart(9)} B/s`,
      );
    });
  }
  const refetch = steady.refetch;
  if (refetch) {
    push(
      DETAIL,
      `   refetch    ${p("steadyState.refetch.chunks", refetch.chunks.toLocaleString())} chunk(s) fetched again · ` +
        `${p("steadyState.refetch.refetches", refetch.refetches.toLocaleString())} refetch(es) · ` +
        `${p("steadyState.refetch.bytes", refetch.bytes.toLocaleString())} B · ` +
        `window ${p("steadyState.refetch.windowMs", refetch.windowMs.toLocaleString())} ms`,
    );
  }
  const replans = steady.replans;
  if (replans) {
    push(
      DETAIL,
      `   replans    ${p("steadyState.replans.availabilityWoken", replans.availabilityWoken.toLocaleString())} of ` +
        `${p("steadyState.replans.passes", replans.passes.toLocaleString())} pass(es) woken by an availability update alone`,
    );
  }
  const sent = steady.sent;
  if (sent) {
    push(
      DETAIL,
      `   sent       ${p("steadyState.sent.bytes", sent.bytes.toLocaleString())} B over ` +
        `${p("steadyState.sent.messages", sent.messages.toLocaleString())} message(s) · ` +
        `${p("steadyState.sent.bytesPerS", sent.bytesPerS.toLocaleString())} B/s`,
    );
  }
  steady.tiers.forEach((tier, index) => {
    const base = `steadyState.tiers[${index}]`;
    push(
      DETAIL,
      `   tier ${tier.tier.padEnd(6)} wants ${p(`${base}.wanted`, tier.wanted.toLocaleString())} · ` +
        `holds ${p(`${base}.resident`, tier.resident.toLocaleString())} · ` +
        `${p(`${base}.bytes`, tier.bytes.toLocaleString())} of ${p(`${base}.budgetBytes`, tier.budgetBytes.toLocaleString())} B ` +
        `(${p(`${base}.fillPct`, tier.fillPct)}%) · loss ${p(`${base}.coverageLossChunks`, tier.coverageLossChunks.toLocaleString())} ` +
        `(${p(`${base}.coverageLossPct`, tier.coverageLossPct)}%) · ` +
        (tier.budgetBound ? "budget-bound" : "not budget-bound"),
    );
  });
}

/**
 * What the summary cannot show sits in the commands' band, so the budget
 * drops groups before it drops the caveats on the groups it keeps.
 */
function renderSpatial(
  spatial: SpatialSummary,
  document: DiagnosticDocument,
  push: PushLine,
  p: PrintNumber,
): void {
  push(
    LEAD_FINDING,
    `SPATIAL   ${p("spatial.rowCount", spatial.rowCount.toLocaleString())} rows · ` +
      `${p("spatial.groupCount", spatial.groupCount)} group(s) · ${p("spatial.levelCount", spatial.levelCount)} level(s)`,
  );
  push(LEAD_FINDING, `          ${spatial.coordinates}`);
  const severalDatasets = document.run.datasetIds.length > 1;
  spatial.groups.forEach((group, index) => {
    const band =
      index < LEAD_SPATIAL_GROUPS ? LEAD_FINDING : index < LEAD_SPATIAL_GROUPS * 2 ? MORE_FINDINGS : DETAIL;
    const base = `spatial.groups[${index}]`;
    const axes = SPATIAL_AXES.map(
      (axis, i) =>
        `${axis} ${p(`${base}.box.min[${i}]`, group.box.min[i])}..${p(`${base}.box.max[${i}]`, group.box.max[i])}`,
    ).join(" ");
    push(
      band,
      `  ${String(p(`${base}.id`, group.id)).padStart(2)}  ${group.state.padEnd(9)} ` +
        `L${p(`${base}.level`, group.level)} ${group.residencyTier.padEnd(6)} ` +
        (severalDatasets ? ` ${group.datasetId} ` : "") +
        `n=${String(p(`${base}.n`, group.n.toLocaleString())).padStart(7)} ` +
        `entities ${String(p(`${base}.entityCount`, group.entityCount.toLocaleString())).padStart(5)}  ` +
        `${axes}  oldest ${p(`${base}.oldestMs`, group.oldestMs.toLocaleString())} ms`,
    );
  });
  for (const line of spatial.cannotShow) push(NEXT, `   cannot show: ${line}`);
}

/**
 * One line per chart, naming what the canvas draws for it: each recorded
 * series' peak and newest value, each absent series' reason. A test holds
 * the closed set of charts to these lines.
 */
function renderTimeline(timeline: TimelineSection, band: number, push: PushLine, p: PrintNumber): void {
  const axis = timeline.axis;
  push(
    band,
    `TIMELINE  ${p("timeline.axis.startMs", axis.startMs)}..${p("timeline.axis.endMs", axis.endMs)} ms in ` +
      `${p("timeline.axis.buckets", axis.buckets)} buckets of ${p("timeline.axis.bucketMs", axis.bucketMs)} ms · ` +
      `${timeline.rowsWalked ? "rows walked" : "rows not walked"} · ${timeline.statement}`,
  );
  timeline.intervals.forEach((interval, index) => {
    const base = `timeline.intervals[${index}]`;
    push(
      band,
      `   band  ${interval.kind.padEnd(12)} ${interval.runId.padEnd(24)} ` +
        `${p(`${base}.startMs`, interval.startMs)}..${p(`${base}.endMs`, interval.endMs)} ms · ` +
        `${interval.cause ? formatCause(interval.cause) : "steady state"} · ` +
        `${interval.endReason ?? "open"}${interval.current ? " (this run)" : ""}`,
    );
  });
  timeline.charts.forEach((chart, index) => {
    const base = `timeline.charts[${index}]`;
    const series = chart.series
      .map((entry, i) =>
        entry.recorded
          ? `${entry.label} max ${p(`${base}.series[${i}].max`, entry.max)}` +
            (entry.last === null ? "" : ` last ${p(`${base}.series[${i}].last`, entry.last)}`) +
            (entry.unsampled === 0
              ? ""
              : ` (${p(`${base}.series[${i}].unsampled`, entry.unsampled)} unsampled)`)
          : `${entry.label} absent (${entry.statement})`,
      )
      .join(" · ");
    push(
      band,
      `   ${chart.id.padEnd(20)} ${chart.kind.padEnd(8)} ${chart.recorded ? "recorded" : "absent  "}  ` +
        (chart.recorded ? `${series} [${chart.unit}]` : chart.statement),
    );
  });
}

/**
 * The live timeline as text, for the seam and the dock's text twin. Every
 * line is a selection from the object {@link deriveLiveTimeline} returned,
 * and the first word after the run id is the label every live rendering
 * carries.
 */
export function renderLiveTimeline(live: LiveTimeline): string {
  const lines: string[] = [];
  const push: PushLine = (_band, text) => {
    lines.push(text);
  };
  const p: PrintNumber = (_path, formatted) => String(formatted);
  lines.push(`lucida trace ${live.runId} — PROVISIONAL TIMELINE: ${live.statement}`);
  lines.push(
    "          not a verdict: this timeline changes while you read it, and the charts read from the rows are absent until the run closes",
  );
  const window = live.window;
  lines.push(
    `window    ${window.wholeRun ? "the run so far" : `the last ${window.spanMs} ms`}: ` +
      `${window.startMs}..${window.endMs} ms of the run`,
  );
  renderTimeline(live.timeline, REQUIRED, push, p);
  return lines.join("\n");
}

/**
 * Trim to the budget by dropping whole priority bands from the bottom up, and
 * say how many lines went. Dropping a band at a time rather than a line at a
 * time keeps the output coherent: half a findings list reads as the whole one.
 */
function fit(
  lines: Line[],
  maxLines: number,
  maxBytes: number,
): { kept: string[]; dropped: number } {
  for (let cutoff = DETAIL; ; cutoff -= 1) {
    const kept = lines.filter((line) => line.band <= cutoff).map((line) => line.text);
    const dropped = lines.length - kept.length;
    // Numberless on purpose: the count belongs to the rendering rather than to
    // the run, and every number in this text has to exist in the document.
    // Callers that want the figure read `droppedLines` off the result.
    const note = dropped > 0 ? [DROP_NOTE] : [];
    const out = [...kept, ...note];
    if (out.length <= maxLines && byteLength(out.join("\n")) <= maxBytes) {
      return { kept: out, dropped };
    }
    if (cutoff === REQUIRED) {
      // The required lines cannot be dropped — a verdict without its coverage
      // is the thing this whole module exists to prevent — so the last resort
      // is to clamp their width. Prose in a verdict or a degraded line is
      // unbounded; the budget is not.
      return { kept: clampToBytes(out, maxBytes), dropped };
    }
  }
}

const DROP_NOTE = "   (lines dropped to fit the default budget — the JSON carries all of them)";

/** Shorten from the longest line down until the whole rendering fits. */
function clampToBytes(lines: string[], maxBytes: number): string[] {
  const out = [...lines];
  while (byteLength(out.join("\n")) > maxBytes) {
    let longest = 0;
    for (let i = 1; i < out.length; i += 1) if (out[i].length > out[longest].length) longest = i;
    const line = out[longest];
    if (line.length <= 20) return out;
    out[longest] = `${line.slice(0, Math.max(20, Math.floor(line.length * 0.75)))}…`;
  }
  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function causeOf(document: DiagnosticDocument): string {
  return formatCause(document.run.cause);
}

/**
 * Why a run opened, in one line: the epoch kind, the dirty kind, and the
 * source, which for an interaction run is the input. The monitor's run
 * selector and live view spell it the same way through this function, so a
 * run reads as one run wherever it appears.
 */
export function formatCause(cause: RunCause | null): string {
  if (!cause) return "steady state";
  return `${cause.epoch ?? "none"}/${cause.dirtyKind}/${cause.source}`;
}

/**
 * What the not-a-health-signal counters say, as one sentence. A count above
 * zero says its path ran, so only the zeros are called not exercised; a run
 * thousands of requests behind can record a zero on every one, which is why a
 * zero is never read as health. The text and the monitor share this sentence.
 */
export function describeNotHealthSignals(signals: readonly { metric: string; value: number }[]): string {
  const idle = signals.filter((signal) => signal.value === 0).map((signal) => signal.metric);
  if (idle.length === 0) {
    return "every one of these paths was exercised; a count says how often, not that the run was healthy.";
  }
  const unexercised =
    idle.length === signals.length
      ? "none of these paths was exercised"
      : idle.length === 1
        ? `the path at zero (${idle[0]}) was not exercised`
        : `the paths at zero (${idle.join(", ")}) were not exercised`;
  return `${unexercised}; an absence of errors is not evidence of health.`;
}

function renderTimingOf(document: DiagnosticDocument, p: PrintNumber): string {
  const { mainThread, gpuPass } = document.renderTiming;
  const main = mainThread
    ? `main-thread frame p50 ${p("renderTiming.mainThread.p50Ms", mainThread.p50Ms)} ms · ` +
      `p95 ${p("renderTiming.mainThread.p95Ms", mainThread.p95Ms)} ms ` +
      `(n=${p("renderTiming.mainThread.samples", mainThread.samples)})`
    : "main-thread frame time not sampled";
  const gpu = gpuPass.recorded
    ? `GPU pass p50 ${p("renderTiming.gpuPass.p50Ms", gpuPass.p50Ms)} ms · ` +
      `p95 ${p("renderTiming.gpuPass.p95Ms", gpuPass.p95Ms)} ms ` +
      `(n=${p("renderTiming.gpuPass.samples", gpuPass.samples)})`
    : `GPU pass not recorded: ${gpuPass.statement}`;
  return `${main} · ${gpu}`;
}

function lagOf(document: DiagnosticDocument, p: PrintNumber): string | null {
  const lag = document.lag;
  if (!lag) return null;
  const timing = lag.inputToFrame;
  const answered = lag.inputs - lag.unanswered;
  const inputs =
    lag.unanswered > 0
      ? `n=${p("lag.inputToFrame.samples", answered)} of ${p("lag.inputs", lag.inputs)} inputs`
      : `n=${p("lag.inputs", lag.inputs)}`;
  const toFrame = timing
    ? `input-to-frame p50 ${p("lag.inputToFrame.p50Ms", timing.p50Ms)} ms · ` +
      `p95 ${p("lag.inputToFrame.p95Ms", timing.p95Ms)} ms · max ${p("lag.inputToFrame.maxMs", timing.maxMs)} ms (${inputs})`
    : `no input reached a frame before the run closed (${inputs})`;
  const tasks = lag.longTasks;
  const longTasks =
    tasks.count === 0
      ? "no long task"
      : `${p("lag.longTasks.count", tasks.count)} long task(s), longest ${p("lag.longTasks.longestMs", tasks.longestMs)} ms, ` +
        `${p("lag.longTasks.totalMs", tasks.totalMs)} ms total`;
  const frames = lag.frames;
  const dropped =
    frames.dropped === null
      ? `${p("lag.frames.presented", frames.presented)} frames, drops not counted`
      : `${p("lag.frames.presented", frames.presented)} frames, ${p("lag.frames.dropped", frames.dropped)} dropped ` +
        `against a ${p("lag.frames.displayIntervalMs", frames.displayIntervalMs!)} ms refresh`;
  return `${toFrame} · ${longTasks} · ${dropped}`;
}

function gpuMemoryOf(document: DiagnosticDocument, p: PrintNumber): string {
  const gpu = document.gpuMemory;
  // Older documents predate the field.
  if (!gpu) return "not reported by the render worker";
  const halved = gpu.lastBudgetBytes < gpu.peakBudgetBytes
    ? ` · budget halved to ${p("gpuMemory.lastBudgetBytes", gpu.lastBudgetBytes.toLocaleString())} B`
    : "";
  return (
    `peak ${p("gpuMemory.peakBytes", gpu.peakBytes.toLocaleString())} B of ` +
    `${p("gpuMemory.peakBudgetBytes", gpu.peakBudgetBytes.toLocaleString())} B budget` +
    (gpu.overBudget ? " (over budget)" : "") +
    ` · last ${p("gpuMemory.lastBytes", gpu.lastBytes.toLocaleString())} B${halved} · ` +
    `chunk slots ${p("gpuMemory.slotsHeld", gpu.slotsHeld.toLocaleString())} of ` +
    `${p("gpuMemory.slots", gpu.slots.toLocaleString())} held`
  );
}

/** Held chunks named on the finding's line; the document carries every one. */
const HELD_LISTED = 5;

/** Errors named on the finding's line; the document carries every one. */
const ERRORS_LISTED = 3;

function describeErrors(errors: ObservedError[], base: string, p: PrintNumber): string {
  const named = errors
    .slice(0, ERRORS_LISTED)
    .map((error, index) => {
      const path = `${base}.errors[${index}]`;
      const at = error.atMs === null ? "" : ` at ${p(`${path}.atMs`, error.atMs)} ms`;
      const times = error.count > 1 ? ` x${p(`${path}.count`, error.count)}` : "";
      const where = error.location ? ` (${error.location})` : "";
      return `${error.source}${at}${times}: ${error.message}${where}`;
    })
    .join("; ");
  const more = errors.length > ERRORS_LISTED ? `; +${errors.length - ERRORS_LISTED} more` : "";
  return `${named}${more}`;
}

function describeObservation(finding: Finding, p: PrintNumber): string {
  const observed = finding.observed;
  const base = `findings[${finding.id - 1}].observed`;
  if (finding.severity === "steady-state") return describeSteadyState(finding, p);
  if (observed.held) {
    const named = observed.held
      .slice(0, HELD_LISTED)
      .map((chunk) => `${chunk.entityId}/${chunk.chunkKey} (${chunk.reason})`)
      .join(", ");
    const more = observed.held.length > HELD_LISTED ? `, +${observed.held.length - HELD_LISTED} more` : "";
    return `${p(`${base}.chunks`, (observed.chunks ?? 0).toLocaleString())} chunk(s) held: ${named}${more}`;
  }
  if (finding.rule === RULESET.gpuError.id && observed.breakdown) {
    const kinds = Object.entries(observed.breakdown)
      .map(([kind, count]) => `${kind} ${p(`${base}.breakdown.${kind}`, count)}`)
      .join(", ");
    const said = observed.errors ? `; ${describeErrors(observed.errors, base, p)}` : "";
    return `${p(`${base}.n`, observed.n ?? 0)} GPU error(s): ${kinds}${said}`;
  }
  if (finding.rule === RULESET.pageError.id && observed.errors) {
    return `${p(`${base}.n`, observed.n ?? 0)} error(s): ${describeErrors(observed.errors, base, p)}`;
  }
  if (finding.rule === RULESET.blankFrame.id) {
    return (
      `one flat colour, ${observed.colour}, across all ` +
      `${p(`${base}.width`, observed.width ?? 0)}x${p(`${base}.height`, observed.height ?? 0)} pixels`
    );
  }
  if (finding.rule === RULESET.pageScroll.id && observed.scroll) {
    const at = `${base}.scroll`;
    const s = observed.scroll;
    return (
      `scrolled to ${p(`${at}.scrollX`, s.scrollX)},${p(`${at}.scrollY`, s.scrollY)}, ` +
      `document ${p(`${at}.scrollWidth`, s.scrollWidth)}x${p(`${at}.scrollHeight`, s.scrollHeight)} ` +
      `in a ${p(`${at}.viewportWidth`, s.viewportWidth)}x${p(`${at}.viewportHeight`, s.viewportHeight)} viewport, CSS pixels`
    );
  }
  if (observed.backlogEtaS != null || observed.pending != null) {
    const parts = [
      `${p(`${base}.pending`, (observed.pending ?? 0).toLocaleString())} pending`,
      `cap ${p(`${base}.inFlightCap`, observed.inFlightCap ?? 0)}`,
      `pinned ${p(`${base}.pinnedPct`, observed.pinnedPct ?? 0)}%`,
      `drain ${p(`${base}.drainPerS`, observed.drainPerS ?? 0)}/s`,
    ];
    if (observed.backlogEtaS != null) {
      parts.push(`ETA ~${p(`${base}.backlogEtaS`, observed.backlogEtaS)} s`);
    }
    return parts.join(" · ");
  }

  const parts: string[] = [];
  if (observed.ms != null) {
    parts.push(`${observed.stat ? `${observed.stat} ` : ""}${p(`${base}.ms`, observed.ms)} ms`);
  }
  if (observed.baselineMs != null) {
    parts.push(
      `vs ${p(`${base}.baselineMs`, observed.baselineMs)} ms baseline (${p(`${base}.ratio`, observed.ratio ?? 0)}x)`,
    );
  }
  if (observed.sharePct != null) {
    parts.push(`${p(`${base}.sharePct`, observed.sharePct)}% of the ${observed.shareOf ?? "run"}`);
  }
  if (observed.n != null) parts.push(`n=${p(`${base}.n`, observed.n)}`);
  if (observed.rows === 0 && observed.tier) parts.push(`no per-item rows (${observed.tier})`);
  return parts.join(" · ");
}

/**
 * A steady-state observation: what the interval after the run carried, and
 * the window it carried it over. Every finding here states its window,
 * because a count without a denominator is not a measurement — except the
 * budget-bound one, which reads the run's settle block, an instant rather
 * than an interval.
 */
function describeSteadyState(finding: Finding, p: PrintNumber): string {
  const observed = finding.observed;
  const base = `findings[${finding.id - 1}].observed`;
  const parts: string[] = [];
  if (observed.bytesPerS != null) {
    parts.push(`${p(`${base}.bytesPerS`, observed.bytesPerS.toLocaleString())} B/s`);
  }
  if (observed.seconds != null) parts.push(`over ${p(`${base}.seconds`, observed.seconds)} s`);
  if (observed.chunks != null) {
    parts.push(`${p(`${base}.chunks`, observed.chunks.toLocaleString())} chunk(s)`);
  }
  if (observed.refetches != null) {
    parts.push(`${p(`${base}.refetches`, observed.refetches.toLocaleString())} refetch(es)`);
  }
  if (observed.bytes != null) {
    parts.push(`${p(`${base}.bytes`, observed.bytes.toLocaleString())} B`);
  }
  if (observed.wokenPasses != null) {
    parts.push(
      `${p(`${base}.wokenPasses`, observed.wokenPasses.toLocaleString())} of ` +
        `${p(`${base}.passes`, (observed.passes ?? 0).toLocaleString())} pass(es)`,
    );
  }
  if (observed.fillPct != null) {
    parts.push(
      `${p(`${base}.residentBytes`, (observed.residentBytes ?? 0).toLocaleString())} of ` +
        `${p(`${base}.budgetBytes`, (observed.budgetBytes ?? 0).toLocaleString())} B ` +
        `(${p(`${base}.fillPct`, observed.fillPct)}% full)`,
    );
  }
  if (observed.lossChunks != null) {
    parts.push(
      `coverage loss ${p(`${base}.lossChunks`, observed.lossChunks.toLocaleString())} of ` +
        `${p(`${base}.wanted`, (observed.wanted ?? 0).toLocaleString())} wanted chunk(s) ` +
        `(${p(`${base}.lossPct`, observed.lossPct ?? 0)}%)`,
    );
  }
  if (observed.breakdown) {
    parts.push(
      Object.entries(observed.breakdown)
        .map(([name, bytes]) => `${name} ${p(`${base}.breakdown.${name}`, bytes.toLocaleString())} B`)
        .join(" "),
    );
  }
  if (observed.windowMs != null) {
    parts.push(`window ${p(`${base}.windowMs`, observed.windowMs.toLocaleString())} ms`);
  }
  return parts.join(" · ");
}
