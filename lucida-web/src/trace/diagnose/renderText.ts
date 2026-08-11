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
 * Nothing per-row appears at any depth. A warm re-open is tens of thousands of
 * rows; Perfetto is the raw-row answer and the last line says so.
 */

import type { DiagnosticDocument, Finding } from "./types.ts";

export const DEFAULT_MAX_LINES = 30;
export const DEFAULT_MAX_BYTES = 3_072;

export type RenderDepth = "summary" | "stages";

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
const GAPS = 3;
const MORE_FINDINGS = 4;
const NEXT = 5;
const DETAIL = 6;

interface Line {
  text: string;
  band: number;
}

export function renderDiagnostic(
  document: DiagnosticDocument,
  options: { depth?: RenderDepth; maxLines?: number; maxBytes?: number } = {},
): RenderedDiagnostic {
  const depth = options.depth ?? "summary";
  const provenance: Provenance[] = [];
  const p = (path: string, formatted: string | number): string => {
    provenance.push({ path, formatted: String(formatted) });
    return String(formatted);
  };

  const lines: Line[] = [];
  const push = (band: number, text: string): void => {
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
      `${document.run.gpu} · build ${document.run.build}`,
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

  // --- findings ------------------------------------------------------------
  const shown = depth === "summary" ? document.findings.slice(0, 3) : document.findings;
  if (shown.length === 0) {
    push(LEAD_FINDING, "FINDINGS  none — no threshold crossed.");
  } else {
    push(LEAD_FINDING, `FINDINGS (${p("findings.length", document.findings.length)})`);
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
    if (depth === "summary" && document.findings.length > shown.length) {
      push(
        MORE_FINDINGS,
        `  ... ranked findings above; the run carries ${p("findings.length", document.findings.length)} in total (see --stages)`,
      );
    }
  }

  // --- the anti-signal, unconditional --------------------------------------
  push(
    REQUIRED,
    `NOT A HEALTH SIGNAL  ${document.coverage.notHealthSignals
      .map((signal) => `${signal.metric}=${p(`coverage.notHealthSignals.${signal.metric}`, signal.value)}`)
      .join(" · ")} — these paths were not exercised; an absence of errors is not evidence of health.`,
  );

  if (depth !== "summary") {
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
    for (const stage of document.stages) {
      push(
        DETAIL,
        `   ${stage.id.padEnd(24)} ${stage.class.padEnd(8)} n=${String(stage.n).padStart(6)} ` +
          `p50 ${String(stage.p50Ms).padStart(8)} p95 ${String(stage.p95Ms).padStart(8)} ` +
          `max ${String(stage.maxMs).padStart(8)} total ${String(stage.totalMs).padStart(9)} ${stage.concurrencyFactor}x`,
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

  const maxLines = options.maxLines ?? (depth === "summary" ? DEFAULT_MAX_LINES : Infinity);
  const maxBytes = options.maxBytes ?? (depth === "summary" ? DEFAULT_MAX_BYTES : Infinity);
  const { kept, dropped } = fit(lines, maxLines, maxBytes);
  return { text: kept.join("\n"), provenance, droppedLines: dropped };
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
  let cutoff = DETAIL;
  for (;;) {
    const kept = lines.filter((line) => line.band <= cutoff).map((line) => line.text);
    const dropped = lines.length - kept.length;
    // Numberless on purpose: the count belongs to the rendering rather than to
    // the run, and every number in this text has to exist in the document.
    // Callers that want the figure read `droppedLines` off the result.
    const note = dropped > 0 ? ["   (lines dropped to fit the default budget — the JSON carries all of them)"] : [];
    const out = [...kept, ...note];
    if ((out.length <= maxLines && byteLength(out.join("\n")) <= maxBytes) || cutoff === REQUIRED) {
      return { kept: out, dropped };
    }
    cutoff -= 1;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function causeOf(document: DiagnosticDocument): string {
  const cause = document.run.cause;
  return cause ? `${cause.epoch ?? "none"}/${cause.dirtyKind}/${cause.source}` : "steady state";
}

function describeObservation(finding: Finding, p: (path: string, value: string | number) => string): string {
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
  if (observed.sharePct != null) parts.push(`${p(`${base}.sharePct`, observed.sharePct)}% of the run`);
  if (observed.n != null) parts.push(`n=${p(`${base}.n`, observed.n)}`);
  if (observed.rows === 0 && observed.tier) parts.push(`no per-item rows (${observed.tier})`);
  return parts.join(" · ");
}
