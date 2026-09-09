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
import {
  metadataReadRows,
  metadataReadsWithin,
  percentile,
  phaseClassOf,
  usToMs,
} from "./phaseRollup.ts";
import type { CriticalPath, PathSegment } from "./types.ts";
import { clipSpan, inWindow, resolveWindow, windowLabel, type RunWindow } from "./window.ts";

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

/**
 * Walk the chain for one window of the run. On the whole run the chain starts
 * at run start; on a narrower window it starts at the window and ends on the
 * last chunk presented inside it, and every segment counts for the part of
 * itself inside. The row the window's target waited on may have been on the
 * wire when the window opened, and that wire is where the window's chain
 * begins.
 */
export function buildCriticalPath(run: TraceRun, window: RunWindow = resolveWindow(run)): CriticalPath {
  const fromUs = window.startUs;
  const terminal = terminalRow(run, window);
  if (!terminal) {
    const where = window.whole ? "" : ` inside the window ${windowLabel(window)} ms`;
    return {
      kind: "undefined",
      target: TARGET_EVENT,
      targetAtMs: null,
      fromMs: usToMs(fromUs),
      undefinedReason:
        run.header.endReason === "quiescent"
          ? `no row reached a frame${where}, so this run has no completion event to walk a critical path back from`
          : `the run ended as ${run.header.endReason} and no row reached a frame${where}, so there is no completion event to walk back from`,
      segments: [],
      chainAccountedPct: 0,
    };
  }

  const targetUs = terminal.phases.present!.endUs;
  const spanUs = Math.max(1, targetUs - fromUs);
  const segments: PathSegment[] = [];
  const share = (us: number): number => Math.round((us / spanUs) * 100);
  const add = (segment: Omit<PathSegment, "sharePct">): void => {
    if (segment.ms <= 0) return;
    segments.push({ ...segment, sharePct: share(segment.ms * 1_000) });
  };

  const firstRecordedUs = firstRecorded(run, window, targetUs);
  add({
    label: UNRECORDED_PREFIX,
    class: "unrecorded",
    ms: usToMs(firstRecordedUs - fromUs),
    source: "derived — no row covers it",
    rows: 0,
  });

  let cursorUs = firstRecordedUs;
  const openEndUs = openEnd(run, window, targetUs);
  if (openEndUs > cursorUs) {
    const reads = metadataReadsInside(run, window);
    add({
      label: "open.metadata-read",
      class: "io",
      ms: usToMs(openEndUs - cursorUs),
      source: "dataset-open bracket",
      rows: reads.length,
      breakdown: metadataBreakdown(reads),
    });
    cursorUs = openEndUs;
  }

  const rowStartUs = Math.max(fromUs, rowStart(terminal));
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
    const span = clipSpan(timing.startUs, timing.endUs, window);
    if (!span) continue;
    add({
      label: `browser.${phase}`,
      // The one inventory, not a second cascade beside it: a phase reclassified
      // in the ruleset and not here would judge one way in the rollup and
      // another on the chain, with nothing to catch the disagreement.
      class: phaseClassOf(`browser.${phase}`),
      ms: usToMs(span.us),
      source: "the row the run finished on",
      rows: 1,
      chunkKey: terminal.chunkKey,
      // A wire segment is a client-side bracket around the server's work. When
      // the server's row joined, split it rather than reporting an opaque total.
      // Not when the window cut the bracket: the server's phases cannot be
      // placed inside a part of it.
      ...(phase === "wire" && serverRow && !span.clipped
        ? { breakdown: serverBreakdown(serverRow) }
        : {}),
    });
  }

  const chainUs = segments.reduce((total, segment) => total + segment.ms * 1_000, 0);
  return {
    kind: "chain",
    target: TARGET_EVENT,
    targetAtMs: usToMs(targetUs),
    fromMs: usToMs(fromUs),
    undefinedReason: null,
    segments,
    chainAccountedPct: Math.min(100, Math.round((chainUs / spanUs) * 100)),
  };
}

/** The row the target waited on: the last one to reach a frame inside the window. */
function terminalRow(run: TraceRun, window: RunWindow): TraceRow | null {
  let best: TraceRow | null = null;
  for (const row of run.rows) {
    const present = row.phases.present;
    if (!present || !inWindow(present.endUs, window)) continue;
    if (!best || present.endUs > best.phases.present!.endUs) best = row;
  }
  return best;
}

function rowStart(row: TraceRow): number {
  return Math.min(...Object.values(row.phases).map((timing) => timing.startUs));
}

function rowEnd(row: TraceRow): number {
  return Math.max(...Object.values(row.phases).map((timing) => timing.endUs));
}

/**
 * The earliest thing any instrument saw inside the window. Everything between
 * the window's start and it is on no row. A row already running when the
 * window opened makes that stretch zero: the window opened on recorded work.
 */
function firstRecorded(run: TraceRun, window: RunWindow, targetUs: number): number {
  let earliest = targetUs;
  for (const row of run.rows) {
    if (rowEnd(row) <= window.startUs) continue;
    earliest = Math.min(earliest, Math.max(window.startUs, rowStart(row)));
  }
  for (const open of run.datasetOpens) {
    if ((open.endUs ?? targetUs) <= window.startUs) continue;
    earliest = Math.min(earliest, Math.max(window.startUs, open.startUs));
  }
  return Math.max(window.startUs, earliest);
}

/**
 * When the last dataset open that reaches into the window settled, no later
 * than the target. An open still in flight at run close is charged to the
 * target rather than dropped: an open that never settled is the most
 * diagnostic segment there is, and silently omitting it would hand its time
 * to whatever came next.
 */
function openEnd(run: TraceRun, window: RunWindow, targetUs: number): number {
  let end = window.startUs;
  for (const open of run.datasetOpens) {
    const endUs = open.endUs ?? targetUs;
    if (endUs <= window.startUs || open.startUs > targetUs) continue;
    end = Math.max(end, Math.min(endUs, targetUs));
  }
  return end;
}

/**
 * The metadata reads the window can see, each counted for the part of itself
 * inside, under the rollup's placement rule. A read with no position belongs
 * to the whole run only.
 */
function metadataReadsInside(run: TraceRun, window: RunWindow): TraceServerRow[] {
  const inside: TraceServerRow[] = [];
  for (const { row, placed, span } of metadataReadsWithin(run, window)) {
    if (!placed) {
      if (window.whole) inside.push(row);
      continue;
    }
    if (!span) continue;
    inside.push(span.clipped ? { ...row, durationUs: span.us } : row);
  }
  return inside;
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
