/**
 * The provisional reading's cost contract, asserted (#1057, ADR 0049 as
 * amended).
 *
 * The live view, the watch stream, and an agent polling the seam read a run
 * while it is open, and they are under the same contract as the recorder:
 * their cost must not show up in the thing they read. The amendment's rule
 * is that none of them walks rows while a run is open, and this file is
 * where that rule is a measurement rather than a claim.
 *
 * **Flat in the run's rows.** A reading is derived from the tally the row
 * table keeps as it writes and from the readings inside the window, so it
 * costs the same at two thousand rows and at the per-run cap. The gate holds
 * the read at the largest population a run can hold to within a small factor
 * of the read at a small one. That is the flatness shape the recorder's
 * gates use, because a read that grew with rows is a row walk in disguise.
 * Flatness is measured over a narrow window on purpose: a full window holds
 * six hundred readings and costs a few hundred microseconds, behind which a
 * walk of a millisecond at the cap would hide inside the gate's factor. Over
 * a window of a few readings the read is nearly all fixed cost, and a walk
 * shows as an order of magnitude.
 *
 * **Bounded by the window, not the ring.** The readings are read from the
 * newest slot back and stop at the window's start, so a ring that has
 * wrapped many times costs what its window costs, and a window that has
 * slid past the ring's readings costs less.
 *
 * **An absolute ceiling, at slack.** One millisecond for one read over a
 * window holding five seconds of a busy pan's readings. A person's view
 * polls the reading twice a second and the watch stream polls it on its
 * interval, never per tick, since the HUD draws from the per-tick aggregate
 * rather than from this. A millisecond therefore keeps ten polls a second
 * under one percent of the main thread. The gate sits at {@link CI_SLACK}×
 * that figure for the reason the recorder's gates do: a microbenchmark of a
 * few hundred microseconds on a CI runner measures the runner. The real
 * figure is logged on every run. Read the `[#1057]` lines for it. On the
 * host this was written on, a full window read in about a quarter of a
 * millisecond, of which roughly a third is fixed and the rest is the six
 * hundred readings the window holds.
 *
 * The amendment also asks each live surface for a documented A/B on a
 * hardware adapter at device pixel ratio 2. That needs a GPU, which CI does
 * not have, and belongs with the recorder's harness under
 * `docs/perf/recorder-cost/`; it is not in this file.
 */

import { describe, expect, it } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import { TableTraceSink } from "./sink.ts";
import { Boundary, type ChunkRowSource, type RunConditions } from "./types.ts";

/** The most one read may cost, for a reading polled a few times a second and never per tick. */
const READ_CEILING_US = 1_000;

/** The recorder's slack, for the recorder's reason: the same code measures 45× apart across hosts. */
const CI_SLACK = 16;

/**
 * How much more a read may cost at the largest row population than at the
 * smallest. Wide enough to survive a noisy runner, narrow enough that a walk
 * cannot hide in it: the walk this replaced cost about 76 ns a row, so at
 * the cap it adds over a millisecond to a narrow-window read of tens of
 * microseconds.
 */
const FLATNESS_GROWTH_GATE = 4;

/** A small run, and one past the per-run cap, which is the largest row population a run can hold. */
const POPULATIONS = [2_000, 40_000] as const;

/** A busy pan's tick rate, and the window that rate fills at the default length. */
const READINGS_PER_SECOND = 120;
const WINDOW_SECONDS = 5;

/** The window flatness is measured over: a handful of readings, so the read is nearly all fixed cost. */
const NARROW_WINDOW_MS = 50;

const OPEN_CAUSE = { epoch: "content", dirtyKind: "residency", source: "residency_fill" } as const;

const CONDITIONS: RunConditions = {
  datasetIds: ["ds"],
  composedView: { url: "/w/ws-1", mode: "slice" },
  devicePixelRatio: 2,
  viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
};

const WARMTH = { detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0 };

const OUTSTANDING = {
  pending: 0, inFlight: 0, speculativePending: 0, speculativeInFlight: 0,
  desiredDetailChunks: 0, residentDetailChunks: 0, desiredCoarseChunks: 0, residentCoarseChunks: 0,
  detailBytes: 0, detailBudgetBytes: 0, coarseBytes: 0, coarseBudgetBytes: 0,
};

interface Timed {
  p50Us: number;
  p95Us: number;
  /** Readings inside the window, averaged over the reads. */
  inWindow: number;
}

interface Reading {
  rows: number;
  narrow: Timed;
  full: Timed;
}

/**
 * A run with `rows` rows spread across the phases, and a reading ring that
 * has wrapped several times over, with the last five seconds of readings
 * inside the default window. The clock is the harness's own, so the window
 * lands where the test says rather than where the wall clock happens to be.
 */
function makeRun(rows: number): { recorder: TraceRecorder; advance: (ms: number) => void } {
  let clock = 0;
  const recorder = new TraceRecorder({
    sinkFactory: () => new TableTraceSink(),
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    // Far beyond any measurement window: a run closing mid-loop would
    // measure the null the read returns between runs.
    timeoutMs: 3_600_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => WARMTH,
    captureConditions: () => CONDITIONS,
    captureOutstanding: () => OUTSTANDING,
  });
  recorder.openRun(OPEN_CAUSE);

  const src: ChunkRowSource = {
    datasetId: "ds", entityId: "m", imageId: "i", lane: "detail",
    level: 0, t: 0, c: 0, z: 0, y: 0, x: 0,
  };
  for (let i = 0; i < rows; i++) {
    src.level = i % 5;
    src.z = i % 7;
    src.y = (i / 16) | 0;
    src.x = i % 16;
    const handle = recorder.beginChunkRow(src, 0);
    for (let b = Boundary.DecodeStart; b <= (i % 4) + Boundary.DecodeStart - 1; b++) {
      recorder.stamp(handle, b);
    }
  }

  const stepMs = 1_000 / READINGS_PER_SECOND;
  const total = READINGS_PER_SECOND * WINDOW_SECONDS * 4;
  for (let i = 0; i < total; i++) {
    recorder.noteReading(20_000 - i, 24, 2_000 + (i % 7) * 300, 400_000_000, i % 3 === 0 ? 1_500 : null);
    clock += stepMs;
  }
  return { recorder, advance: (ms: number) => { clock += ms; } };
}

function summarise(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
}

/** The totals are asserted so nothing here is dead code an optimiser is free to skip. */
function timeReads(recorder: TraceRecorder, windowMs?: number): Timed {
  const rows = recorder.provisionalReading()!.rows.made;
  let made = 0;
  let inWindow = 0;
  const read = () => {
    const reading = recorder.provisionalReading({ windowMs })!;
    made += reading.rows.made;
    inWindow += reading.readings.n;
  };
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) read();
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    read();
    samples.push(performance.now() - t0);
  }
  expect(made).toBe(rows * 220);
  const stats = summarise(samples);
  return { p50Us: stats.p50 * 1_000, p95Us: stats.p95 * 1_000, inWindow: inWindow / 220 };
}

describe("provisional reading cost contract", () => {
  it("reads an open run in time flat in its rows, inside the budget", () => {
    const readings: Reading[] = POPULATIONS.map((asked) => {
      const { recorder } = makeRun(asked);
      // What the run holds after the per-run cap, not what was asked for.
      const rows = recorder.provisionalReading()!.rows.made;
      const narrow = timeReads(recorder, NARROW_WINDOW_MS);
      const full = timeReads(recorder);
      recorder.reset();

      // The narrow window held a handful of readings and the full one held
      // five seconds of them, none from the ring's earlier laps.
      expect(narrow.inWindow).toBeLessThan(READINGS_PER_SECOND * WINDOW_SECONDS / 10);
      expect(full.inWindow).toBeCloseTo(READINGS_PER_SECOND * WINDOW_SECONDS, -1);
      expect(full.inWindow).toBeLessThan(READINGS_PER_SECOND * WINDOW_SECONDS + 2);
      return { rows, narrow, full };
    });

    for (const r of readings) {
      console.log(
        `[#1057] provisional read: rows=${String(r.rows).padStart(6)} | ` +
          `${NARROW_WINDOW_MS} ms window (${r.narrow.inWindow.toFixed(0)} readings) p50=${r.narrow.p50Us.toFixed(1)}µs | ` +
          `full window (${r.full.inWindow.toFixed(0)} readings) p50=${r.full.p50Us.toFixed(1)}µs p95=${r.full.p95Us.toFixed(1)}µs | ` +
          `${(r.full.p50Us / READ_CEILING_US).toFixed(2)}x the ${READ_CEILING_US}µs ceiling, gate ${READ_CEILING_US * CI_SLACK}µs`,
      );
    }

    const [small, large] = readings;
    expect(large.rows).toBeGreaterThan(small.rows * 4);
    expect(
      large.narrow.p50Us,
      `${large.narrow.p50Us.toFixed(1)}µs at ${large.rows} rows against ${small.narrow.p50Us.toFixed(1)}µs at ${small.rows}`,
    ).toBeLessThan(Math.max(small.narrow.p50Us, 1) * FLATNESS_GROWTH_GATE);
    for (const r of readings) {
      expect(r.full.p50Us, `${r.full.p50Us.toFixed(1)}µs at ${r.rows} rows`).toBeLessThan(
        READ_CEILING_US * CI_SLACK,
      );
    }
  });

  it("stays inside the budget with the ring wrapped, and once the window has slid past its readings", () => {
    const { recorder, advance } = makeRun(2_000);
    const wrapped = timeReads(recorder);

    // Slide the window past everything the ring holds but the newest reading.
    advance(WINDOW_SECONDS * 1_000 * 2);
    const empty = timeReads(recorder);
    const reading = recorder.provisionalReading()!;
    expect(reading.readings.n).toBe(0);
    expect(reading.readings.carried).toBe(true);

    console.log(
      `[#1057] provisional read: ring wrapped 4x, full window p50=${wrapped.p50Us.toFixed(1)}µs | ` +
        `window past the ring p50=${empty.p50Us.toFixed(1)}µs`,
    );
    expect(wrapped.p50Us).toBeLessThan(READ_CEILING_US * CI_SLACK);
    expect(empty.p50Us).toBeLessThan(READ_CEILING_US * CI_SLACK);
    recorder.reset();
  });
});
