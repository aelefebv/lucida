/**
 * The critical-path back-walk.
 *
 * Never a `max()` over phase totals. On the cold-open sample the largest total
 * belongs to whichever phase the most rows happened to sit in at once, which
 * is a statement about concurrency rather than about what the run waited for —
 * two hundred rows spending 100 ms each on the wire is 20 s of total inside a
 * 1.2 s run.
 *
 * The chain is the serial history of the one row the run finished on: what had
 * to happen before it could be planned, and then what it did. It starts at
 * **run start**, not at the first recorded row. #893's path started at the
 * first row and reported `100% accounted` for a run that was 87%
 * pre-instrument boot; the fix is an `unrecorded prefix` segment that is part
 * of the chain, can never be blamed for a stall, and always raises a coverage
 * gap.
 */

import type { TraceRow, TraceRun, TraceServerRow } from "../types.ts";
import { metadataReadRows, percentile, phaseClassOf, usToMs } from "./phaseRollup.ts";
import type { CriticalPath, PathSegment } from "./types.ts";

/** The chain's first link, and the only one nothing may be blamed for. */
export const UNRECORDED_PREFIX = "unrecorded prefix";

/**
 * The serial stretch between the dataset open finishing and the winning row
 * being planned. The pipeline was working through other chunks, so this is
 * throughput rather than a per-row wait — it is classed as a queue and judged
 * by the backlog rule, never by a share threshold.
 */
export const PRE_PLAN = "browser.pre-plan";

/** What the run finished on. A dataset open ends when its last chunk is drawn. */
const TARGET_EVENT = "last chunk presented";

export function buildCriticalPath(run: TraceRun): CriticalPath {
  const terminal = terminalRow(run);
  if (!terminal) {
    return {
      kind: "undefined",
      target: TARGET_EVENT,
      targetAtMs: null,
      undefinedReason:
        run.header.endReason === "quiescent"
          ? "no row reached a frame, so this run has no completion event to walk a critical path back from"
          : `the run ended as ${run.header.endReason} and no row reached a frame, so there is no completion event to walk back from`,
      segments: [],
      chainAccountedPct: 0,
    };
  }

  const targetUs = terminal.phases.present!.endUs;
  const segments: PathSegment[] = [];
  const share = (us: number): number => Math.round((us / Math.max(1, targetUs)) * 100);
  const add = (segment: Omit<PathSegment, "sharePct">): void => {
    if (segment.ms <= 0) return;
    segments.push({ ...segment, sharePct: share(segment.ms * 1_000) });
  };

  const firstRecordedUs = firstRecorded(run, targetUs);
  add({
    label: UNRECORDED_PREFIX,
    class: "unrecorded",
    ms: usToMs(firstRecordedUs),
    source: "derived — no row covers it",
    rows: 0,
  });

  let cursorUs = firstRecordedUs;
  const openEndUs = openEnd(run, targetUs);
  if (openEndUs > cursorUs) {
    add({
      label: "open.metadata-read",
      class: "io",
      ms: usToMs(openEndUs - cursorUs),
      source: "dataset-open bracket",
      rows: metadataReadRows(run.serverRows).length,
      breakdown: metadataBreakdown(run.serverRows),
    });
    cursorUs = openEndUs;
  }

  const rowStartUs = rowStart(terminal);
  if (rowStartUs > cursorUs) {
    add({
      label: PRE_PLAN,
      class: "queue",
      ms: usToMs(rowStartUs - cursorUs),
      source: "derived — the pipeline was working through earlier chunks",
      rows: 0,
    });
  }

  const serverRow = run.serverRows.find(
    (row) =>
      row.family !== "metadata-read" &&
      row.rid === terminal.rid &&
      row.connectionGeneration === terminal.connectionGeneration,
  );
  for (const [phase, timing] of Object.entries(terminal.phases)) {
    add({
      label: `browser.${phase}`,
      // The one inventory, not a second cascade beside it: a phase reclassified
      // in the ruleset and not here would judge one way in the rollup and
      // another on the chain, with nothing to catch the disagreement.
      class: phaseClassOf(`browser.${phase}`),
      ms: usToMs(timing.durationUs),
      source: "the row the run finished on",
      rows: 1,
      chunkKey: terminal.chunkKey,
      // A wire segment is a client-side bracket around the server's work. When
      // the server's row joined, split it rather than reporting an opaque total.
      ...(phase === "wire" && serverRow ? { breakdown: serverBreakdown(serverRow) } : {}),
    });
  }

  const chainUs = segments.reduce((total, segment) => total + segment.ms * 1_000, 0);
  return {
    kind: "chain",
    target: TARGET_EVENT,
    targetAtMs: usToMs(targetUs),
    undefinedReason: null,
    segments,
    chainAccountedPct: Math.min(100, Math.round((chainUs / Math.max(1, targetUs)) * 100)),
  };
}

/** The row the target waited on: the last one to reach a frame. */
function terminalRow(run: TraceRun): TraceRow | null {
  let best: TraceRow | null = null;
  for (const row of run.rows) {
    const present = row.phases.present;
    if (!present) continue;
    if (!best || present.endUs > best.phases.present!.endUs) best = row;
  }
  return best;
}

function rowStart(row: TraceRow): number {
  return Math.min(...Object.values(row.phases).map((timing) => timing.startUs));
}

/** The earliest thing any instrument saw. Everything before it is on no row. */
function firstRecorded(run: TraceRun, targetUs: number): number {
  let earliest = targetUs;
  for (const row of run.rows) earliest = Math.min(earliest, rowStart(row));
  for (const open of run.datasetOpens) earliest = Math.min(earliest, open.startUs);
  return Math.max(0, earliest);
}

/**
 * When the last dataset open settled. An open still in flight at run close is
 * charged to the target rather than dropped — an open that never settled is
 * the most diagnostic segment there is, and silently omitting it would hand
 * its time to whatever came next.
 */
function openEnd(run: TraceRun, targetUs: number): number {
  let end = 0;
  for (const open of run.datasetOpens) end = Math.max(end, open.endUs ?? targetUs);
  return end;
}

function metadataBreakdown(serverRows: TraceServerRow[]): Record<string, number> {
  const byPhase = new Map<string, number[]>();
  for (const row of metadataReadRows(serverRows)) {
    if (!row.metadataPhase) continue;
    const bucket = byPhase.get(row.metadataPhase);
    if (bucket) bucket.push(row.durationUs);
    else byPhase.set(row.metadataPhase, [row.durationUs]);
  }
  const out: Record<string, number> = {};
  for (const [phase, values] of byPhase) {
    values.sort((a, b) => a - b);
    out[`${phase} p50 × ${values.length}`] = usToMs(percentile(values, 0.5));
  }
  return out;
}

function serverBreakdown(row: TraceServerRow): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [phase, durationUs] of Object.entries(row.phases)) out[phase] = usToMs(durationUs);
  // The remainder inside the bracket is network plus socket queue. Named
  // rather than absorbed: the server's clock is never trusted, so what the two
  // measurements do not jointly cover belongs to neither side.
  if (row.placement) out["network + socket queue"] = usToMs(row.placement.gapUs);
  return out;
}
