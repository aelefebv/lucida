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

export function rollupPhases(run: TraceRun): PhaseRollup[] {
  const buckets = new Map<string, number[]>();
  const push = (id: string, us: number): void => {
    if (!(us > 0)) return;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(us);
    else buckets.set(id, [us]);
  };

  for (const row of run.rows) {
    for (const [phase, timing] of Object.entries(row.phases)) {
      push(`browser.${phase}`, timing.durationUs);
    }
  }
  for (const row of run.serverRows) {
    if (row.family === "metadata-read") {
      // A metadata read states its span in one column rather than a phase map:
      // it has no dispatch, no decode and no upload to break down.
      if (row.metadataPhase) push(`metadata.${row.metadataPhase}`, row.durationUs);
      continue;
    }
    for (const [phase, durationUs] of Object.entries(row.phases)) {
      push(`server.${phase}`, durationUs);
    }
  }

  const wallUs = Math.max(1, run.header.durationUs);
  const phases: PhaseRollup[] = [];
  for (const [id, values] of buckets) {
    const sorted = [...values].sort((a, b) => a - b);
    const totalUs = sorted.reduce((sum, value) => sum + value, 0);
    phases.push({
      id,
      label: id,
      side: phaseSideOf(id),
      class: phaseClassOf(id),
      n: sorted.length,
      p50Ms: usToMs(percentile(sorted, 0.5)),
      p95Ms: usToMs(percentile(sorted, 0.95)),
      maxMs: usToMs(sorted[sorted.length - 1]),
      totalMs: usToMs(totalUs),
      concurrencyFactor: Math.round((totalUs / wallUs) * 10) / 10,
    });
  }
  phases.sort((a, b) => b.totalMs - a.totalMs);
  return phases;
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
