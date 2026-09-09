/**
 * The cost contract of the per-chunk read (#1062, ADR 0049 as amended by
 * #1048): the overlay's phase color and churn tint read one chunk per cell
 * per tick from the interval in progress, and the amendment forbids a live
 * surface a row walk. So the read has to be flat in rows, and the index that
 * makes it so has to cost the write path nothing it can measure.
 *
 * ## Tripwires, not benchmarks
 *
 * As in the recorder's own gates, the flatness is gated as a ratio across a
 * 20x row population rather than in absolute microseconds, because absolute
 * timings on a CI runner measure the runner. The real figures are logged on
 * a `[#1062]` line. The write path's cost stays under the recorder's gates in
 * `recorderCost.perf.test.ts`, which already run with the index in place.
 */

import { describe, expect, it } from "vitest";

import { buildChunkDrawList, type ChunkCell } from "../debug/overlayDrawList.ts";
import { TraceRecorder } from "./recorder.ts";
import { tableSinkFactory } from "./sink.ts";
import { Boundary, RowOutcome } from "./types.ts";

/** How much slower a read may be over the larger population than over the smaller. */
const ROW_INDEPENDENCE_GATE = 4;

/** Cells the overlay caps itself at per tick. */
const CELLS_PER_TICK = 600;

/** One tick's worth of reads and the draw list over them, in microseconds. Generous; the figure is logged. */
const TICK_CEILING_US = 2_000;
const CI_SLACK = 16;

function makeRecorder() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    sinkFactory: tableSinkFactory,
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 3_600_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({ detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0 }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => ({
      pending: 0, inFlight: 0, speculativePending: 0, speculativeInFlight: 0,
      desiredDetailChunks: 0, residentDetailChunks: 0, desiredCoarseChunks: 0, residentCoarseChunks: 0,
      detailBytes: 0, detailBudgetBytes: 0, coarseBytes: 0, coarseBudgetBytes: 0,
    }),
  });
  return { recorder, advance: (ms: number) => { clock += ms; } };
}

/**
 * A run of `rows` rows, one chunk each, most of them fetched. The first
 * `CELLS_PER_TICK` of them are the chunks `cells()` names.
 */
function populate(rows: number) {
  const { recorder, advance } = makeRecorder();
  recorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" });
  for (let i = 0; i < rows; i++) {
    advance(1);
    const handle = recorder.beginChunkRow(
      { datasetId: "ds", entityId: `m-${i % 4}`, imageId: "i", lane: "detail",
        level: 1, t: 0, c: 0, z: i % 3, y: (i / 40) | 0, x: i % 40 },
      0,
    );
    if (i % 5 === 0) continue;
    recorder.noteBytesReceived(handle, 2_048);
    recorder.stamp(handle, Boundary.UploadStart);
    if (i % 7 === 0) recorder.finishRow(handle, RowOutcome.Complete);
  }
  return recorder;
}

function cells(): ChunkCell[] {
  const out: ChunkCell[] = [];
  for (let i = 0; i < CELLS_PER_TICK; i++) {
    out.push({
      key: `cell-${i}`,
      datasetId: "ds",
      entityId: `m-${i % 4}`,
      chunkKey: `1/0/0/${i % 3}/${(i / 40) | 0}/${i % 40}`,
      level: 1,
      t: 0,
      c: 0,
      z: i % 3,
      y: (i / 40) | 0,
      x: i % 40,
      left: (i % 40) * 20,
      top: ((i / 40) | 0) * 20,
      width: 20,
      height: 20,
      status: "cached",
      sourceTier: "detail",
    });
  }
  return out;
}

function timeTick(recorder: TraceRecorder, grid: ChunkCell[], repeats: number): number {
  const modes = { chunkTier: false, cachedTier: false, plannedRank: false, phaseColor: true, churnTint: true };
  const samples: number[] = [];
  for (let r = 0; r < repeats; r++) {
    const start = performance.now();
    buildChunkDrawList({
      cells: grid,
      modes,
      readingOf: (cell) => recorder.readChunk(cell),
      windowMs: recorder.openIntervalMs,
    });
    samples.push((performance.now() - start) * 1_000);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

describe("the per-chunk read's cost contract", () => {
  it("reads a tick's cells in time flat in the interval's rows, inside the budget", () => {
    const grid = cells();
    const small = populate(2_000);
    const large = populate(40_000);
    // Warm both, so the first-call cost of neither is what gets compared.
    timeTick(small, grid, 5);
    timeTick(large, grid, 5);
    const smallUs = timeTick(small, grid, 41);
    const largeUs = timeTick(large, grid, 41);

    console.log(
      `[#1062] overlay tick: ${CELLS_PER_TICK} cells read over 2,000 rows p50=${smallUs.toFixed(1)}µs | ` +
        `over 40,000 rows p50=${largeUs.toFixed(1)}µs | ratio ${(largeUs / smallUs).toFixed(2)}x (gate ${ROW_INDEPENDENCE_GATE}x) | ` +
        `ceiling ${TICK_CEILING_US}µs, gate ${TICK_CEILING_US * CI_SLACK}µs`,
    );

    expect(largeUs / Math.max(1, smallUs)).toBeLessThan(ROW_INDEPENDENCE_GATE);
    expect(largeUs).toBeLessThan(TICK_CEILING_US * CI_SLACK);
    small.reset();
    large.reset();
  });
});
