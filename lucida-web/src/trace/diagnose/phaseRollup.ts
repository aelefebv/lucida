/**
 * Phase rollup: what each phase looked like across the whole run.
 *
 * A rollup is evidence, never an answer. Thousands of rows are in flight at
 * once, so the per-phase totals overlap and their sum routinely exceeds the
 * run's own wall clock — which is why {@link PhaseRollup.concurrencyFactor}
 * is reported next to the total, and why the largest total is not the thing
 * the attribution walks back to.
 */

import type { TraceRun, TraceServerRow } from "../types.ts";
import { PHASE_CLASSES } from "./ruleset.ts";
import type { AggregateCandidate, PhaseClass, PhaseRollup, PhaseSide } from "./types.ts";
import { clipSpan, inWindow, resolveWindow, type ClippedSpan, type RunWindow } from "./window.ts";

/** Tenths of a millisecond. Below that the platform's own clock is guessing (#897). */
export function usToMs(us: number): number {
  return Math.round(us / 100) / 10;
}

/** {@link usToMs} for a value that may be absent. */
export function nullableUsToMs(us: number | null): number | null {
  return us === null ? null : usToMs(us);
}

/**
 * The nearest-rank percentile of a sorted array. No interpolation: every value
 * here is a real observation and a percentile that reports a duration nothing
 * took is a number with no row behind it.
 */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

export function phaseSideOf(id: string): PhaseSide {
  return id.startsWith("server.") ? "server" : id.startsWith("metadata.") ? "metadata" : "browser";
}

export function phaseClassOf(id: string): PhaseClass {
  return PHASE_CLASSES[id] ?? "compute";
}

/**
 * The metadata-read rows out of a server table.
 *
 * One predicate in one place: a metadata read is the family that keys on an
 * open's request id rather than on a correlation label, and it is the family
 * whose duration lives in its own column instead of a phase map. Three copies
 * of `family === "metadata-read"` is three places to forget one.
 */
export function metadataReadRows(serverRows: TraceServerRow[]): TraceServerRow[] {
  return serverRows.filter((row) => row.family === "metadata-read");
}

/** One metadata read as a window sees it. */
export interface MetadataReadInWindow {
  row: TraceServerRow;
  /** False when the read's open was never bracketed, so it has no position at all. */
  placed: boolean;
  /** The part of the read inside the window, or null when it is unplaced or entirely outside. */
  span: ClippedSpan | null;
}

/**
 * The metadata reads with a duration, placed against the window.
 *
 * A read dates from its open's arrival, so the open's bracket is what turns a
 * dispatch offset into a position on the run's clock. Without it the read is
 * real and unplaceable, which is the honest answer for a read whose open the
 * recorder declined to bracket. One rule for the rollup and the chain, so the
 * open segment's breakdown and the `metadata.*` rows agree.
 */
export function metadataReadsWithin(run: TraceRun, window: RunWindow): MetadataReadInWindow[] {
  const openStartUs = new Map<string, number>();
  for (const open of run.datasetOpens) openStartUs.set(open.requestId, open.startUs);

  const reads: MetadataReadInWindow[] = [];
  for (const row of metadataReadRows(run.serverRows)) {
    if (!row.metadataPhase || !(row.durationUs > 0)) continue;
    const base = row.requestId == null ? undefined : openStartUs.get(row.requestId);
    if (base == null) {
      reads.push({ row, placed: false, span: null });
      continue;
    }
    const startUs = base + row.dispatchOffsetUs;
    reads.push({ row, placed: true, span: clipSpan(startUs, startUs + row.durationUs, window) });
  }
  return reads;
}

/**
 * The dataset-open bracket, rolled up beside the reads that nest inside it.
 * Named on the metadata side because that is the work it contains and the band
 * it belongs to.
 */
export const OPEN_PHASE = "metadata.dataset-open";

/**
 * One observation of a phase: how long it took, which row it belonged to, and
 * where on the run's clock it sat when anything could say.
 *
 * The position is optional because a placement is not always available — a
 * server row the merge could not nest has a duration and no position at all
 * (ADR 0050) — and a phase whose rows are all unplaced has to say so rather
 * than be drawn at zero.
 */
interface PhaseSample {
  us: number;
  startUs: number | null;
  endUs: number | null;
  /** The row's identity, so a drill-down names a row instead of a moment. */
  label: string;
}

/** The rollup over a window, with what the window did to the rows beside it. */
export interface WindowRollup {
  phases: PhaseRollup[];
  /** Rows with a position that crossed a window edge and were counted for the part inside. */
  clippedRows: number;
  /** Rows with no position, left out because a narrower window cannot place them. Zero on the whole run. */
  unplacedRows: number;
}

export function rollupPhases(run: TraceRun, window: RunWindow = resolveWindow(run)): PhaseRollup[] {
  return rollupWindow(run, window).phases;
}

/**
 * The rollup over one window of the run.
 *
 * Every positioned sample is clipped to the window and counts for the part
 * inside. On the whole run that clip is `[0, wall]`, which is what lets a
 * full-window reading equal an unwindowed one by construction. A sample with
 * no position belongs to the run and to no narrower window: it is kept on the
 * whole run, where nothing narrower is being claimed, and left out and counted
 * otherwise, because placing it inside a window would be the same lie as
 * drawing it at the origin.
 */
export function rollupWindow(run: TraceRun, window: RunWindow): WindowRollup {
  const buckets = new Map<string, PhaseSample[]>();
  const clippedRows = new Set<string>();
  let unplacedRows = 0;
  const push = (id: string, sample: PhaseSample): void => {
    if (!(sample.us > 0)) return;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(sample);
    else buckets.set(id, [sample]);
  };
  // `rowKey` names the row rather than the sample, so a row clipped on three
  // of its phases is one clipped row.
  const pushPlaced = (id: string, rowKey: string | null, startUs: number, endUs: number, label: string): void => {
    const span = clipSpan(startUs, endUs, window);
    if (!span) return;
    if (span.clipped && rowKey) clippedRows.add(rowKey);
    push(id, { us: span.us, startUs: span.startUs, endUs: span.endUs, label });
  };

  for (const [index, row] of run.rows.entries()) {
    for (const [phase, timing] of Object.entries(row.phases)) {
      pushPlaced(`browser.${phase}`, `row:${index}`, timing.startUs, timing.endUs, row.chunkKey);
    }
  }

  // A metadata read states its span in one column rather than a phase map: it
  // has no dispatch, no decode and no upload to break down.
  for (const [index, read] of metadataReadsWithin(run, window).entries()) {
    const { row, span } = read;
    const id = `metadata.${row.metadataPhase}`;
    const label = `${row.requestId ?? "unknown open"} / rid ${row.rid}`;
    if (!read.placed) {
      if (window.whole) push(id, { us: row.durationUs, startUs: null, endUs: null, label });
      else unplacedRows += 1;
      continue;
    }
    if (!span) continue;
    if (span.clipped) clippedRows.add(`metadata:${index}`);
    push(id, { us: span.us, startUs: span.startUs, endUs: span.endUs, label });
  }

  for (const [index, row] of run.serverRows.entries()) {
    if (row.family === "metadata-read") continue;
    const rowKey = `server:${index}`;
    const phases = Object.entries(row.phases).filter(([, durationUs]) => durationUs > 0);
    if (phases.length === 0) continue;
    const label = `rid ${row.rid} / gen ${row.connectionGeneration}`;
    // The server's own clock is never trusted, so a server phase inherits the
    // browser bracket the row was nested into rather than claiming a position
    // of its own inside it.
    const placement = row.placement;
    if (!placement) {
      if (window.whole) {
        for (const [phase, durationUs] of phases) {
          push(`server.${phase}`, { us: durationUs, startUs: null, endUs: null, label });
        }
      } else {
        unplacedRows += 1;
      }
      continue;
    }
    const bracket = clipSpan(placement.startUs, placement.endUs, window);
    if (!bracket) continue;
    if (bracket.clipped) clippedRows.add(rowKey);
    for (const [phase, durationUs] of phases) {
      // Where inside the bracket the server's work sat is unknowable, so a cut
      // bracket caps the server's figure at its own part inside rather than
      // apportioning it. An uncut bracket keeps the server's own figure.
      push(`server.${phase}`, {
        us: bracket.clipped ? Math.min(durationUs, bracket.us) : durationUs,
        startUs: bracket.startUs,
        endUs: bracket.endUs,
        label,
      });
    }
  }

  // The dataset open itself, as its own family.
  //
  // Not a recorded phase — the row enum is closed (ADR 0047) — but a bracket
  // the run already carries, rolled up so a surface can place it. Without it a
  // warm re-open draws nothing over its own open: every read inside quantises
  // to zero against the 100 µs clock floor (#897) and drops out, leaving
  // silence over the stretch the critical path blames. The reads nest inside
  // this, so the two overlap by construction — which every total here does.
  // A bracket is not a row, so a window cutting it is not a clipped row.
  for (const open of run.datasetOpens) {
    const endUs = open.endUs ?? run.header.durationUs;
    pushPlaced(
      OPEN_PHASE,
      null,
      open.startUs,
      endUs,
      open.endUs == null ? `${open.requestId} (never settled)` : open.requestId,
    );
  }

  const spanUs = Math.max(1, window.endUs - window.startUs);
  const phases: PhaseRollup[] = [];
  for (const [id, samples] of buckets) {
    const sorted = [...samples].sort((a, b) => a.us - b.us);
    const totalUs = sorted.reduce((sum, sample) => sum + sample.us, 0);
    const slowest = sorted[sorted.length - 1];
    phases.push({
      id,
      label: id,
      side: phaseSideOf(id),
      class: phaseClassOf(id),
      n: sorted.length,
      p50Ms: usToMs(percentileOf(sorted, 0.5)),
      p95Ms: usToMs(percentileOf(sorted, 0.95)),
      maxMs: usToMs(slowest.us),
      totalMs: usToMs(totalUs),
      concurrencyFactor: Math.round((totalUs / spanUs) * 10) / 10,
      extent: extentOf(sorted),
      worst: { label: slowest.label, ms: usToMs(slowest.us) },
    });
  }
  phases.sort((a, b) => b.totalMs - a.totalMs);
  return { phases, clippedRows: clippedRows.size, unplacedRows };
}

function percentileOf(sorted: PhaseSample[], fraction: number): number {
  return percentile(
    sorted.map((sample) => sample.us),
    fraction,
  );
}

/**
 * The stretch of the run this phase occupied, and how many of its rows could
 * be put anywhere at all.
 *
 * Null rather than a zero-width bar when nothing was placeable: a timeline
 * track drawn at the origin for a phase with no position is the same class of
 * lie as drawing silence over a bottleneck.
 */
function extentOf(samples: PhaseSample[]): PhaseRollup["extent"] {
  let firstUs = Infinity;
  let lastUs = -Infinity;
  let positionedN = 0;
  for (const sample of samples) {
    if (sample.startUs == null || sample.endUs == null) continue;
    positionedN += 1;
    firstUs = Math.min(firstUs, sample.startUs);
    lastUs = Math.max(lastUs, sample.endUs);
  }
  if (positionedN === 0) return null;
  return { firstStartMs: usToMs(firstUs), lastEndMs: usToMs(lastUs), positionedN };
}

/**
 * Phases recorded only as per-tick readings, which therefore can never appear
 * on a critical path built from rows. They still hold the main thread, so they
 * are offered as candidates with a confidence ceiling that says so.
 *
 * `busyMs` is a **lower bound**. Each reading is charged for at most the
 * interval it covers, so a sparse tick cadence under-reports rather than
 * inventing occupancy — the safe direction, since this number can only be used
 * to claim a stall.
 */
export function aggregateCandidates(
  run: TraceRun,
  window: RunWindow = resolveWindow(run),
): AggregateCandidate[] {
  const readings = run.readings;
  if (readings.length === 0) return [];

  const runWallUs = Math.max(1, run.header.durationUs);
  const spanUs = Math.max(1, window.endUs - window.startUs);
  let busyUs = 0;
  const frameTimes: number[] = [];
  for (let i = 0; i < readings.length; i += 1) {
    const frameTimeUs = readings[i].frameTimeUs;
    if (!(frameTimeUs > 0)) continue;
    const nextAtUs = i + 1 < readings.length ? readings[i + 1].atUs : runWallUs;
    // A reading is charged for the part of its interval inside the window, so
    // a reading just before the window still covers the window's first
    // stretch. Only a reading taken inside the window is one of its samples.
    const interval = clipSpan(readings[i].atUs, nextAtUs, window);
    if (interval) busyUs += Math.min(frameTimeUs, interval.us);
    if (inWindow(readings[i].atUs, window)) frameTimes.push(frameTimeUs);
  }
  if (frameTimes.length === 0) return [];

  frameTimes.sort((a, b) => a - b);
  return [
    {
      phase: "render.frame",
      busyMs: usToMs(busyUs),
      sharePct: Math.round((busyUs / spanUs) * 100),
      p95Ms: usToMs(percentile(frameTimes, 0.95)),
      samples: frameTimes.length,
    },
  ];
}
