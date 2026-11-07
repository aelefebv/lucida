/**
 * The dock's live draw, under the cost contract (ADR 0049): a surface that
 * draws while a run is open must not show up in the run it draws. Timed here:
 * deriving the live timeline from the open run's per-tick tiers, and laying
 * it out as a draw list. The canvas replay is bounded by the list's
 * primitive count instead, since a test runner has no rendering context.
 *
 * The derivation reads no row, so it is gated flat in rows. The dock polls
 * twice a second, so the derivation over a thirty-second window holding the
 * whole reading ring gets 2 ms and the draw list 2 ms more at a retina width,
 * both at {@link CI_SLACK}x because a CI runner measures the runner. The real
 * figures are logged on every run.
 */

import { describe, expect, it } from "vitest";

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

/** The recorder's slack, for the recorder's reason: the same code measures 45× apart across hosts. */
const CI_SLACK = 16;

/** How much more a derivation may cost at the largest row population than at the smallest. */
const FLATNESS_GROWTH_GATE = 4;

/** A small run, and one past the per-run cap, which is the largest row population a run can hold. */
const POPULATIONS = [2_000, 40_000] as const;

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

interface Timed {
  p50Us: number;
  p95Us: number;
}

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

function summarise(samples: number[]): Timed {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { p50Us: at(0.5) * 1_000, p95Us: at(0.95) * 1_000 };
}

/** The charts are asserted on so nothing here is dead code an optimiser is free to skip. */
function timeDerivation(recorder: TraceRecorder): { timed: Timed; readings: number; rowsWalked: boolean } {
  let readings = 0;
  let rowsWalked = false;
  const read = () => {
    const live = recorder.liveTimeline()!;
    rowsWalked ||= live.timeline.rowsWalked;
    const inFlight = live.timeline.charts.find((chart) => chart.id === "in-flight")!.series[0];
    readings += inFlight.recorded ? inFlight.samples : 0;
  };
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) read();
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    read();
    samples.push(performance.now() - t0);
  }
  return { timed: summarise(samples), readings: readings / 90, rowsWalked };
}

function timeDrawList(recorder: TraceRecorder): { timed: Timed; primitives: number } {
  const live = recorder.liveTimeline()!;
  let primitives = 0;
  const layout = () => {
    primitives += buildTimelineDrawList(live.timeline, LAYOUT).primitiveCount;
  };
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) layout();
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    layout();
    samples.push(performance.now() - t0);
  }
  return { timed: summarise(samples), primitives: primitives / 90 };
}

describe("the dock's live draw cost contract", () => {
  it("derives the live timeline in time flat in the run's rows, inside the budget, walking none", () => {
    // Warm the derivation on a throwaway run first, so the first population
    // measured is not also the one paying for compilation, and the flatness
    // comparison is between two warm figures.
    const warm = makeRun(POPULATIONS[0]);
    timeDerivation(warm);
    warm.reset();

    const readings = POPULATIONS.map((asked) => {
      const recorder = makeRun(asked);
      const rows = recorder.liveProgress!.planned;
      const derivation = timeDerivation(recorder);
      recorder.reset();
      // The window held the whole reading ring and nothing older.
      expect(derivation.readings).toBeGreaterThan(1_000);
      expect(derivation.readings).toBeLessThanOrEqual(1_025);
      expect(derivation.rowsWalked).toBe(false);
      return { rows, ...derivation.timed };
    });

    for (const r of readings) {
      console.log(
        `[#1064] live timeline derivation: rows=${String(r.rows).padStart(6)} | ` +
          `p50=${r.p50Us.toFixed(1)}µs p95=${r.p95Us.toFixed(1)}µs | ` +
          `${(r.p50Us / DERIVE_CEILING_US).toFixed(2)}x the ${DERIVE_CEILING_US}µs ceiling, gate ${DERIVE_CEILING_US * CI_SLACK}µs`,
      );
    }

    const [small, large] = readings;
    expect(large.rows).toBeGreaterThan(small.rows * 4);
    expect(
      large.p50Us,
      `${large.p50Us.toFixed(1)}µs at ${large.rows} rows against ${small.p50Us.toFixed(1)}µs at ${small.rows}`,
    ).toBeLessThan(Math.max(small.p50Us, 1) * FLATNESS_GROWTH_GATE);
    for (const r of readings) {
      expect(r.p50Us, `${r.p50Us.toFixed(1)}µs at ${r.rows} rows`).toBeLessThan(DERIVE_CEILING_US * CI_SLACK);
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
        `p50=${timed.p50Us.toFixed(1)}µs p95=${timed.p95Us.toFixed(1)}µs | ` +
        `${(timed.p50Us / DRAW_LIST_CEILING_US).toFixed(2)}x the ${DRAW_LIST_CEILING_US}µs ceiling, gate ${DRAW_LIST_CEILING_US * CI_SLACK}µs`,
    );

    // Each series draws at most one primitive per bucket, plus the titles,
    // backgrounds, bands and axis labels: the canvas replay is bounded by
    // this count and never by the run's rows.
    expect(primitives).toBeLessThan(seriesCount * TIMELINE_BUCKETS + live.timeline.charts.length * 3 + 64);
    expect(timed.p50Us).toBeLessThan(DRAW_LIST_CEILING_US * CI_SLACK);
  });
});
