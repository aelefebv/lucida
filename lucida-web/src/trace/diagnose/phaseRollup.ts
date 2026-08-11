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

/** Tenths of a millisecond. Below that the platform's own clock is guessing (#897). */
export function usToMs(us: number): number {
  return Math.round(us / 100) / 10;
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

export function rollupPhases(run: TraceRun): PhaseRollup[] {
  const buckets = new Map<string, PhaseSample[]>();
  const push = (id: string, sample: PhaseSample): void => {
    if (!(sample.us > 0)) return;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(sample);
    else buckets.set(id, [sample]);
  };

  for (const row of run.rows) {
    for (const [phase, timing] of Object.entries(row.phases)) {
      push(`browser.${phase}`, {
        us: timing.durationUs,
        startUs: timing.startUs,
        endUs: timing.endUs,
        label: row.chunkKey,
      });
    }
  }
  // A metadata read dates from its open's arrival, so the open's bracket is
  // what turns a dispatch offset into a position on the run's clock. Without it
  // the read is real and unplaceable, which is the honest answer for a read
  // whose open the recorder declined to bracket.
  const openStartUs = new Map<string, number>();
  for (const open of run.datasetOpens) openStartUs.set(open.requestId, open.startUs);

  for (const row of run.serverRows) {
    if (row.family === "metadata-read") {
      // A metadata read states its span in one column rather than a phase map:
      // it has no dispatch, no decode and no upload to break down.
      if (!row.metadataPhase) continue;
      const base = row.requestId == null ? undefined : openStartUs.get(row.requestId);
      const startUs = base == null ? null : base + row.dispatchOffsetUs;
      push(`metadata.${row.metadataPhase}`, {
        us: row.durationUs,
        startUs,
        endUs: startUs == null ? null : startUs + row.durationUs,
        label: `${row.requestId ?? "unknown open"} / rid ${row.rid}`,
      });
      continue;
    }
    for (const [phase, durationUs] of Object.entries(row.phases)) {
      push(`server.${phase}`, {
        us: durationUs,
        // The server's own clock is never trusted, so a server phase inherits
        // the browser bracket the row was nested into rather than claiming a
        // position of its own inside it.
        startUs: row.placement?.startUs ?? null,
        endUs: row.placement?.endUs ?? null,
        label: `rid ${row.rid} / gen ${row.connectionGeneration}`,
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
  for (const open of run.datasetOpens) {
    const endUs = open.endUs ?? run.header.durationUs;
    push(OPEN_PHASE, {
      us: endUs - open.startUs,
      startUs: open.startUs,
      endUs,
      label: open.endUs == null ? `${open.requestId} (never settled)` : open.requestId,
    });
  }

  const wallUs = Math.max(1, run.header.durationUs);
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
      concurrencyFactor: Math.round((totalUs / wallUs) * 10) / 10,
      extent: extentOf(sorted),
      worst: { label: slowest.label, ms: usToMs(slowest.us) },
    });
  }
  phases.sort((a, b) => b.totalMs - a.totalMs);
  return phases;
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
export function aggregateCandidates(run: TraceRun): AggregateCandidate[] {
  const readings = run.readings;
  if (readings.length === 0) return [];

  const wallUs = Math.max(1, run.header.durationUs);
  let busyUs = 0;
  const frameTimes: number[] = [];
  for (let i = 0; i < readings.length; i += 1) {
    const frameTimeUs = readings[i].frameTimeUs;
    if (!(frameTimeUs > 0)) continue;
    const nextAtUs = i + 1 < readings.length ? readings[i + 1].atUs : wallUs;
    const intervalUs = Math.max(0, nextAtUs - readings[i].atUs);
    busyUs += Math.min(frameTimeUs, intervalUs);
    frameTimes.push(frameTimeUs);
  }
  if (frameTimes.length === 0) return [];

  frameTimes.sort((a, b) => a - b);
  return [
    {
      phase: "render.frame",
      busyMs: usToMs(busyUs),
      sharePct: Math.round((busyUs / wallUs) * 100),
      p95Ms: usToMs(percentile(frameTimes, 0.95)),
      samples: frameTimes.length,
    },
  ];
}
