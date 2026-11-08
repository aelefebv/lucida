/**
 * The provisional reading's cost contract. The live view, the
 * watch stream, and an agent polling the seam read a run while it is open,
 * so none of them may walk rows.
 *
 * A read at the per-run cap may cost at most {@link FLATNESS_GROWTH_GATE}×
 * a read at 2,000 rows, measured over a narrow window where fixed cost
 * dominates and a row walk shows. A read over a full five-second window,
 * with the ring wrapped or not, is designed to stay under 1 ms, and is held
 * to a budget at about twice its typical figure on any host, the way
 * `perfBudget.ts` describes. The real figures are logged on every run.
 */

import { describe, expect, it } from "vitest";

import { describeTiming, expectWithinBudget, timeStep, type StepTiming } from "../test/perfBudget.ts";

import { TraceRecorder } from "./recorder.ts";
import { TableTraceSink } from "./sink.ts";
import { Boundary, type ChunkRowSource, type RunConditions } from "./types.ts";

/** The most one read may cost, for a reading polled a few times a second and never per tick. */
const READ_CEILING_US = 1_000;

/** Budgets in nominal microseconds, about twice each typical figure. */
const FULL_READ_BUDGET_US = 400;
const WRAPPED_READ_BUDGET_US = 370;
const SLID_READ_BUDGET_US = 120;

/**
 * How much more a read may cost at the largest row population than at the
 * smallest. Wide enough to survive a noisy runner, narrow enough that a walk
 * cannot hide in it: a row walk at about 76 ns a row adds over a millisecond
 * at the cap to a narrow-window read of tens of microseconds.
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
  timing: StepTiming;
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
  const timing = timeStep(read, { samples: 200, warmup: 20 });
  expect(made).toBe(rows * 220);
  return { timing, inWindow: inWindow / 220 };
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
          `${NARROW_WINDOW_MS} ms window (${r.narrow.inWindow.toFixed(0)} readings) nominal p50=${r.narrow.timing.nominalUs.toFixed(1)}µs | ` +
          `full window (${r.full.inWindow.toFixed(0)} readings) ${describeTiming(r.full.timing, FULL_READ_BUDGET_US)} | ` +
          `${(r.full.timing.nominalUs / READ_CEILING_US).toFixed(2)}x the ${READ_CEILING_US}µs ceiling`,
      );
    }

    const [small, large] = readings;
    expect(large.rows).toBeGreaterThan(small.rows * 4);
    const narrowLarge = large.narrow.timing.nominalUs;
    const narrowSmall = small.narrow.timing.nominalUs;
    expect(
      narrowLarge,
      `${narrowLarge.toFixed(1)}µs at ${large.rows} rows against ${narrowSmall.toFixed(1)}µs at ${small.rows}`,
    ).toBeLessThan(Math.max(narrowSmall, 1) * FLATNESS_GROWTH_GATE);
    for (const r of readings) {
      expectWithinBudget(`full-window read at ${r.rows} rows`, r.full.timing, FULL_READ_BUDGET_US);
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
      `[#1057] provisional read: ring wrapped 4x, full window ${describeTiming(wrapped.timing, WRAPPED_READ_BUDGET_US)} | ` +
        `window past the ring ${describeTiming(empty.timing, SLID_READ_BUDGET_US)}`,
    );
    expectWithinBudget("read with the ring wrapped", wrapped.timing, WRAPPED_READ_BUDGET_US);
    expectWithinBudget("read with the window past the ring", empty.timing, SLID_READ_BUDGET_US);
    recorder.reset();
  });
});
