/**
 * The one renderer. Text is a *reading* of the diagnostic document, never a
 * parallel design.
 *
 * Text is the agent's default because the JSON is several times larger for the
 * same content, and a diagnostic that does not fit in a context window is a
 * diagnostic nobody reads. Parity is one-directional and enforced: every
 * number printed here exists in the document at a stated path, recorded as it
 * is printed by {@link Provenance}. The converse does not hold — the document
 * is a superset and this renderer selects from it.
 *
 * The default rendering is bounded: **30 lines and 3 kB**. The bound is
 * enforced by construction rather than hoped for. Lines carry a priority, and
 * when the budget is exceeded the lowest-priority ones are dropped and the
 * drop is stated — a report that silently loses its last finding is worse than
 * one that says it did.
 *
 * Nothing per-row appears at any depth, with one exception: the `chunk` depth
 * is about one chunk's rows by definition, and the lookup it prints is capped
 * at a handful. A warm re-open is tens of thousands of rows; Perfetto is the
 * raw-row answer and the last line says so.
 */

import { SPATIAL_AXES } from "./spatialSummary.ts";
import { describeState } from "./rowState.ts";
import type { ChunkLookup, DiagnosticDocument, Finding, SpatialSummary } from "./types.ts";

export const DEFAULT_MAX_LINES = 30;
export const DEFAULT_MAX_BYTES = 3_072;

/**
 * `phase` is one phase's reading, named by {@link RenderOptions.phase} — the
 * depth #893's "the shape behind X" follow-up prints. It renders here rather
 * than in whoever asked, so a CLI never grows a second renderer.
 *
 * `chunk` and `spatial` are the two readings the overlay gives a person,
 * rendered as text: the document's chunk lookup, and its spatial summary.
 * Which chunk the lookup is about is a derivation option, not a rendering
 * one; this renderer prints whichever chunk the document carries.
 */
export type RenderDepth = "summary" | "phases" | "phase" | "chunk" | "spatial";

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

  // --- verdict -------------------------------------------------------------
  push(REQUIRED, `lucida trace ${document.runId} — VERDICT: ${document.verdict.text}`);
  push(REQUIRED, `confidence: ${document.verdict.confidence} · degraded: ${document.attribution.degraded}`);

  // --- truncation and coverage lead, they do not footnote --------------------
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
  push(
    REQUIRED,
    `coverage  ${p("coverage.accountedMs", document.coverage.accountedMs)} of ` +
      `${p("coverage.wallMs", document.coverage.wallMs)} ms accounted (` +
      `${p("coverage.accountedPct", document.coverage.accountedPct)}%) · ` +
      `${p("coverage.gapCount", document.coverage.gapCount)} gap(s)` +
      (document.coverage.incomplete ? " · a gap could hide the bottleneck" : ""),
  );

  // --- run identity --------------------------------------------------------
  push(
    IDENTITY,
    `run       ${document.run.datasetIds.join(", ")} · cause=${causeOf(document)} · ${document.run.warmth} · ` +
      `${p("run.wallMs", document.run.wallMs)} ms wall · ended: ${document.run.endReason}`,
  );
  push(
    IDENTITY,
    `client    DPR ${p("run.devicePixelRatio", document.run.devicePixelRatio)} · ${document.run.viewport} · ` +
      `${document.run.gpu} · ${document.run.adapterKind.label} · build ${document.run.build}`,
  );
  push(IDENTITY, `render    ${renderTimingOf(document, p)}`);

  document.coverage.gaps.forEach((gap, index) => {
    push(
      GAPS,
      `   GAP    ${gap.kind}` +
        `${gap.durationMs > 0 ? ` ${p(`coverage.gaps[${index}].durationMs`, gap.durationMs)} ms` : ""}` +
        `${gap.records > 0 ? ` ${p(`coverage.gaps[${index}].records`, gap.records.toLocaleString())} records` : ""}` +
        `${gap.couldHideBottleneck ? "  <- could hide the bottleneck" : ""}`,
    );
  });

  // --- the reading this depth is about ---------------------------------------
  // The chunk and spatial readings replace the findings block rather than
  // sitting under it: the budget is thirty lines either way.
  const onlyPhase = depth === "phase" ? (options.phase ?? "") : null;
  if (depth === "chunk") renderChunk(document.chunk, document, push, p);
  else if (depth === "spatial") renderSpatial(document.spatial, document, push, p);
  else renderFindings(document, depth, onlyPhase, push, p);

  // --- the anti-signal, unconditional --------------------------------------
  push(
    REQUIRED,
    `NOT A HEALTH SIGNAL  ${document.coverage.notHealthSignals
      .map((signal) => `${signal.metric}=${p(`coverage.notHealthSignals.${signal.metric}`, signal.value)}`)
      .join(" · ")} — these paths were not exercised; an absence of errors is not evidence of health.`,
  );

  if (depth === "phases" || depth === "phase") {
    const phases =
      onlyPhase === null ? document.phases : document.phases.filter((phase) => phase.id === onlyPhase);
    push(DETAIL, "");
    push(
      DETAIL,
      document.criticalPath.kind === "chain"
        ? `CRITICAL PATH  to ${document.criticalPath.target} at ${document.criticalPath.targetAtMs} ms`
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
    push(DETAIL, `RULESET v${document.ruleset.version} — ${document.ruleset.note}`);
  }

  push(NEXT, "next");
  // `next` already ends with the raw export; the document's `raw` block states
  // why raw rows are never inlined, which is a rationale rather than a step.
  for (const step of document.next) push(NEXT, `   ${step.command.padEnd(52)} # ${step.why}`);

  // The phase depths are where a reader goes when the budget was not enough,
  // so they are unbudgeted.
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
  const cause = document.run.cause;
  return cause ? `${cause.epoch ?? "none"}/${cause.dirtyKind}/${cause.source}` : "steady state";
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

function describeObservation(finding: Finding, p: PrintNumber): string {
  const observed = finding.observed;
  const base = `findings[${finding.id - 1}].observed`;
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
