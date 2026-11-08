/**
 * The dock's live draw, under the cost contract: a surface that
 * draws while a run is open must not show up in the run it draws. Timed here:
 * deriving the live timeline from the open run's per-tick tiers, and laying
 * it out as a draw list. The canvas replay is bounded by the list's
 * primitive count instead, since a test runner has no rendering context.
 *
 * The derivation reads no row, so it is gated flat in rows. The dock polls
 * twice a second, so the derivation over a thirty-second window holding the
 * whole reading ring is designed to take 2 ms and the draw list 2 ms more at
 * a retina width. Each is held to a budget at about twice its typical figure
 * on any host, the way `perfBudget.ts` describes. The real figures are
 * logged on every run.
 */

import { describe, expect, it } from "vitest";

import { describeTiming, expectWithinBudget, timeStep, type StepTiming } from "../test/perfBudget.ts";

import { buildTimelineDrawList } from "../monitor/timelineDraw.ts";
import { TIMELINE_BUCKETS } from "./diagnose/timeline.ts";
import { TraceRecorder } from "./recorder.ts";
import { TableTraceSink } from "./sink.ts";
import {
  Boundary,
  PointEvent,
  TickCounter,
  type ChunkRowSource,
  type RunConditions,
} from "./types.ts";

/** The most one derivation of the live timeline may cost, for a surface polled twice a second. */
const DERIVE_CEILING_US = 2_000;
/** The most one layout of the draw list may cost, at a retina width. */
const DRAW_LIST_CEILING_US = 2_000;

/** How much more a derivation may cost at the largest row population than at the smallest. */
const FLATNESS_GROWTH_GATE = 4;

/** A small run, and one past the per-run cap, which is the largest row population a run can hold. */
const POPULATIONS = [2_000, 40_000] as const;

/** Budgets in nominal microseconds, about twice each typical figure; the derivation's by population. */
const DERIVE_BUDGET_US = [2_300, 800] as const;
const DRAW_LIST_BUDGET_US = 84;

/** A busy pan's tick rate over the live timeline's default window: more readings than the ring holds. */
const READINGS_PER_SECOND = 120;
const WINDOW_SECONDS = 30;
const TICKS_PER_SECOND = 10;

/** The width and ratio of a dock on a retina laptop. */
const LAYOUT = { width: 1_440, devicePixelRatio: 2 };

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

const CHUNK: ChunkRowSource = {
  datasetId: "ds", entityId: "m", imageId: "i", lane: "detail",
  level: 0, t: 0, c: 0, z: 0, y: 0, x: 0,
};

/**
 * A run with `rows` rows spread across the phases, and per-tick tiers busier
 * than the window can hold: the reading ring wraps, ticks land ten times a
 * second, and an eviction lands every second. The clock is the harness's
 * own, so the window lands where the test says.
 */
function makeRun(rows: number): TraceRecorder {
  let clock = 0;
  const recorder = new TraceRecorder({
    sinkFactory: () => new TableTraceSink(),
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    timeoutMs: 3_600_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => WARMTH,
    captureConditions: () => CONDITIONS,
    captureOutstanding: () => OUTSTANDING,
  });
  recorder.openRun(OPEN_CAUSE);

  const src = { ...CHUNK };
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
  const total = READINGS_PER_SECOND * WINDOW_SECONDS;
  const tickEvery = READINGS_PER_SECOND / TICKS_PER_SECOND;
  for (let i = 0; i < total; i++) {
    recorder.noteReading(20_000 - i, 24, 2_000 + (i % 7) * 300, 400_000_000, i % 3 === 0 ? 1_500 : null);
    if (i % tickEvery === 0) {
      const scratch = recorder.beginTick("ds");
      if (scratch) {
        scratch.counters[TickCounter.LaneDetail] = 40;
        scratch.counters[TickCounter.LanePrefetch] = 8;
      }
      recorder.commitTick();
    }
    if (i % READINGS_PER_SECOND === 0) recorder.recordPointEvent(PointEvent.Eviction, "evicted", CHUNK, 0);
    clock += stepMs;
  }
  return recorder;
}

/** The charts are asserted on so nothing here is dead code an optimiser is free to skip. */
function timeDerivation(recorder: TraceRecorder): { timed: StepTiming; readings: number; rowsWalked: boolean } {
  let readings = 0;
  let rowsWalked = false;
  const read = () => {
    const live = recorder.liveTimeline()!;
    rowsWalked ||= live.timeline.rowsWalked;
    const inFlight = live.timeline.charts.find((chart) => chart.id === "in-flight")!.series[0];
    readings += inFlight.recorded ? inFlight.samples : 0;
  };
  const timed = timeStep(read, { samples: 60, warmup: 30 });
  return { timed, readings: readings / 90, rowsWalked };
}

function timeDrawList(recorder: TraceRecorder): { timed: StepTiming; primitives: number } {
  const live = recorder.liveTimeline()!;
  let primitives = 0;
  const layout = () => {
    primitives += buildTimelineDrawList(live.timeline, LAYOUT).primitiveCount;
  };
  const timed = timeStep(layout, { samples: 60, warmup: 30 });
  return { timed, primitives: primitives / 90 };
}

describe("the dock's live draw cost contract", () => {
  it("derives the live timeline in time flat in the run's rows, inside the budget, walking none", () => {
    // Warm the derivation on a throwaway run first, so the first population
    // measured is not also the one paying for compilation, and the flatness
    // comparison is between two warm figures.
    const warm = makeRun(POPULATIONS[0]);
    timeDerivation(warm);
    warm.reset();

    const readings = POPULATIONS.map((asked, index) => {
      const recorder = makeRun(asked);
      const rows = recorder.liveProgress!.planned;
      const derivation = timeDerivation(recorder);
      recorder.reset();
      // The window held the whole reading ring and nothing older.
      expect(derivation.readings).toBeGreaterThan(1_000);
      expect(derivation.readings).toBeLessThanOrEqual(1_025);
      expect(derivation.rowsWalked).toBe(false);
      return { rows, timed: derivation.timed, budgetUs: DERIVE_BUDGET_US[index] };
    });

    for (const r of readings) {
      console.log(
        `[#1064] live timeline derivation: rows=${String(r.rows).padStart(6)} | ` +
          `${describeTiming(r.timed, r.budgetUs)} | ` +
          `${(r.timed.nominalUs / DERIVE_CEILING_US).toFixed(2)}x the ${DERIVE_CEILING_US}µs ceiling`,
      );
    }

    const [small, large] = readings;
    expect(large.rows).toBeGreaterThan(small.rows * 4);
    expect(
      large.timed.nominalUs,
      `${large.timed.nominalUs.toFixed(1)}µs at ${large.rows} rows against ${small.timed.nominalUs.toFixed(1)}µs at ${small.rows}`,
    ).toBeLessThan(Math.max(small.timed.nominalUs, 1) * FLATNESS_GROWTH_GATE);
    for (const r of readings) {
      expectWithinBudget(`live timeline derivation at ${r.rows} rows`, r.timed, r.budgetUs);
    }
  });

  it("lays the draw list out inside the budget, with a primitive count bounded by charts and buckets", () => {
    const recorder = makeRun(POPULATIONS[0]);
    const live = recorder.liveTimeline()!;
    const seriesCount = live.timeline.charts.reduce((total, chart) => total + chart.series.length, 0);
    const { timed, primitives } = timeDrawList(recorder);
    recorder.reset();

    console.log(
      `[#1064] live timeline draw list: ${LAYOUT.width}px at DPR ${LAYOUT.devicePixelRatio} | ` +
        `${primitives.toFixed(0)} primitives over ${seriesCount} series | ` +
        `${describeTiming(timed, DRAW_LIST_BUDGET_US)} | ` +
        `${(timed.nominalUs / DRAW_LIST_CEILING_US).toFixed(2)}x the ${DRAW_LIST_CEILING_US}µs ceiling`,
    );

    // Each series draws at most one primitive per bucket, plus the titles,
    // backgrounds, bands and axis labels: the canvas replay is bounded by
    // this count and never by the run's rows.
    expect(primitives).toBeLessThan(seriesCount * TIMELINE_BUCKETS + live.timeline.charts.length * 3 + 64);
    expectWithinBudget("live timeline draw list", timed, DRAW_LIST_BUDGET_US);
  });
});
