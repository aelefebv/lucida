/**
 * The HUD's cost contract, asserted (issue #1061, ADR 0049 as amended by
 * #1048). The amendment puts the surfaces that draw while a run is open
 * under the recorder's contract; the ADR carries the reasoning, and this file
 * carries the HUD's gates:
 *
 * - **Bounded per tick, nothing per frame.** The HUD ticks on its own timer
 *   every {@link HUD_TICK_MS} and never from the render loop, so its whole
 *   cost is one sample, one model read, and one draw per tick. The ceilings
 *   are derived from the frame, not the tick: a tick that lands on a frame
 *   must not take it, so gathering plus model plus issuing the draw stays
 *   under a twentieth of a 60 Hz frame, about 800 µs, once every fifteen
 *   frames.
 * - **Never walks rows.** The sample is gathered from getters and two bounded
 *   cache reads. One gate times it against a recorder holding no rows and
 *   one holding thirty thousand and requires the two to be the same; another
 *   times the lane scan at its cap on a real scheduler.
 * - **Fixed history.** The model keeps a fixed number of ticks in fixed
 *   buffers, so a session that runs for hours draws the same picture at the
 *   same cost as one that ran for a minute.
 *
 * ## Tripwires, not benchmarks
 *
 * As in the recorder's gates, every timing assertion is an absolute bound at
 * {@link CI_SLACK} times the ceiling, and the real figure is logged on a
 * `[#1061]` line. A slow runner moves the figure; only a change of complexity
 * class trips the gate.
 *
 * ## What this cannot measure
 *
 * The draw is issued against a recording context, so what is timed is the
 * layout and the calls, not the rasterizer. The pixels' cost on a real
 * adapter is the A/B at device pixel ratio 2 that `docs/perf/hud-cost/`
 * describes, which CI cannot run.
 */

import { describe, expect, it } from "vitest";

import { drawHud, hudHeight } from "./hudDraw.ts";
import { fakeCache, HARDWARE, makeRecorder, MIB, RecordingContext } from "./hudFixtures.ts";
import { buildHudView, createHudHistory, HUD_HISTORY, HUD_TICK_MS, pushSample, type HudSample } from "./hudModel.ts";
import { emptyLaneOutstanding, HudSource } from "./hudSource.ts";
import { Scheduler } from "../pipeline/fetch/scheduler.ts";
import { LANES, type Lane } from "../pipeline/fetch/types.ts";
import type { ChunkRowSource, LaneName } from "../trace/types.ts";

/** Gathering one sample from the recorder and the cache. */
const SAMPLE_CEILING_US = 100;

/** Taking the sample into the history and reading the view back. */
const MODEL_CEILING_US = 200;

/** Issuing the draw for a full-width strip with the history full. */
const DRAW_CEILING_US = 500;

/** Same width as the recorder's gates, for the same reason: the host, not the code, moves the figure. */
const CI_SLACK = 16;

/** How much slower a sample may be over thirty thousand rows than over none. */
const ROW_INDEPENDENCE_GATE = 4;

const ROWS = 30_000;

/** Mirrors `QUIESCENCE_PENDING_SCAN_CAP` in `cpuCache.ts`, which is not exported. */
const PENDING_SCAN_CAP = 4096;

const WIDTH = 1000;

const LANE_NAMES: readonly LaneName[] = ["detail", "coarse", "minimap", "prefetch"];

/** A busy tick that varies enough to keep every series moving. */
function sampleAt(tick: number): HudSample {
  return {
    atMs: tick * HUD_TICK_MS,
    bytesSent: tick * 800,
    bytesReceived: tick * 400_000 + (tick % 7) * 50_000,
    reading: {
      seq: tick,
      frameTimeUs: 3_000 + (tick % 11) * 700,
      gpuPassUs: tick % 3 === 0 ? 1_800 + (tick % 5) * 200 : null,
    },
    quiescence: { quiescent: tick % 9 === 0, reason: tick % 9 === 0 ? "quiescent" : "chunks_in_flight" },
    lanes: {
      inFlight: { detail: 4, coarse: 1, minimap: 1, prefetch: 2, overview: 0 },
      pending: { detail: 40, coarse: 2, minimap: 5, prefetch: 60, overview: 0 },
      proxyInFlight: 0,
      proxyPending: 0,
      pendingTotal: 107,
      pendingUnclassified: false,
      pendingScanCap: PENDING_SCAN_CAP,
    },
    pools: {
      main: { bytes: (100 + tick) * MIB, budgetBytes: 512 * MIB },
      overview: { bytes: 60 * MIB, budgetBytes: 64 * MIB },
      proxy: { bytes: 0, budgetBytes: 256 * MIB },
    },
    levels: Array.from({ length: 4 }, (_, i) => ({
      datasetId: `ds-${i}`,
      name: `dataset-${i}.zarr`,
      target: { min: 2, max: 2 },
      pinned: i === 1,
      displayed: { min: 2 + (i % 2), max: 3 },
    })),
    gpu: HARDWARE,
    runOpen: tick % 9 !== 0,
  };
}

function summarise(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };
}

/** Time `step` per call in microseconds, after a warmup. */
function measure(step: () => void, iterations: number, warmup = Math.min(iterations, 50)) {
  for (let i = 0; i < warmup; i++) step();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    step();
    samples.push((performance.now() - t0) * 1000);
  }
  return summarise(samples);
}

function verdict(p50: number, ceiling: number): string {
  const ratio = p50 / ceiling;
  return ratio <= 1
    ? `${(1 / ratio).toFixed(1)}x under the ${ceiling}µs ceiling`
    : `OVER the ${ceiling}µs ceiling by ${ratio.toFixed(1)}x`;
}

function log(line: string): void {
  console.log(`[#1061] ${line}`);
}

describe("HUD cost contract", () => {
  it("takes a sample and reads the view inside the per-tick ceiling", () => {
    const history = createHudHistory();
    let tick = 0;
    const model = measure(() => {
      pushSample(history, sampleAt(tick++));
      buildHudView(history);
    }, 2_000);
    log(
      `model tick: push + build with ${HUD_HISTORY} ticks in the history | ` +
        `p50=${model.p50.toFixed(1)}µs p95=${model.p95.toFixed(1)}µs max=${model.max.toFixed(1)}µs | ` +
        `${verdict(model.p50, MODEL_CEILING_US)}, gate ${MODEL_CEILING_US * CI_SLACK}µs`,
    );
    expect(model.p50, `model tick p50 ${model.p50.toFixed(1)} µs`).toBeLessThan(MODEL_CEILING_US * CI_SLACK);
  });

  it("issues the draw inside the per-tick ceiling, with a call count that does not grow with ticks", () => {
    const history = createHudHistory();
    for (let tick = 0; tick < HUD_HISTORY * 2; tick++) pushSample(history, sampleAt(tick));
    const view = buildHudView(history);
    const box = { width: WIDTH, height: hudHeight(view, WIDTH), dpr: 2 };

    const early = new RecordingContext();
    drawHud(early, view, box);

    for (let tick = HUD_HISTORY * 2; tick < HUD_HISTORY * 40; tick++) pushSample(history, sampleAt(tick));
    const later = buildHudView(history);
    const late = new RecordingContext();
    drawHud(late, later, box);

    const ctx = new RecordingContext();
    const draw = measure(() => {
      ctx.texts.length = 0;
      drawHud(ctx, later, box);
    }, 500);
    log(
      `draw tick: ${WIDTH}px strip at ratio 2, ${late.calls} context calls (${late.texts.length} text) | ` +
        `p50=${draw.p50.toFixed(1)}µs p95=${draw.p95.toFixed(1)}µs max=${draw.max.toFixed(1)}µs | ` +
        `${verdict(draw.p50, DRAW_CEILING_US)}, gate ${DRAW_CEILING_US * CI_SLACK}µs`,
    );
    expect(draw.p50, `draw tick p50 ${draw.p50.toFixed(1)} µs`).toBeLessThan(DRAW_CEILING_US * CI_SLACK);
    // The history is full both times, so a call count that grew would mean
    // the strip remembers more than its history.
    expect(late.calls).toBe(early.calls);
  });

  it("gathers a sample without walking rows: the same cost over thirty thousand as over none", () => {
    const { recorder, now } = makeRecorder();
    recorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "test" });
    const source = new HudSource({ recorder, now, getCache: fakeCache });
    source.start();
    for (let i = 0; i < 4; i++) {
      const tick = recorder.beginTick(`ds-${i}`)!;
      tick.setTargetLevel(2, 2, false);
      tick.setDisplayedLevel({ min: 2, max: 3 });
      recorder.commitTick();
    }
    recorder.noteReading(100, 8, 4_000, 200 * MIB, 1_800);

    const empty = measure(() => source.sample(), 1_000);

    const chunk: ChunkRowSource = {
      datasetId: "ds-0",
      entityId: "entity",
      imageId: "image",
      lane: "detail",
      level: 1,
      t: 0,
      c: 0,
      z: 0,
      y: 0,
      x: 0,
    };
    for (let i = 0; i < ROWS; i++) {
      chunk.lane = LANE_NAMES[i % LANE_NAMES.length];
      chunk.x = i;
      recorder.beginChunkRow(chunk, 0);
    }
    const full = measure(() => source.sample(), 1_000);
    source.dispose();

    const ratio = full.p50 / Math.max(empty.p50, 0.01);
    log(
      `sample: 4 datasets | over 0 rows p50=${empty.p50.toFixed(1)}µs | over ${ROWS.toLocaleString("en-US")} rows ` +
        `p50=${full.p50.toFixed(1)}µs p95=${full.p95.toFixed(1)}µs | ratio ${ratio.toFixed(2)}x, gate ${ROW_INDEPENDENCE_GATE}x | ` +
        `${verdict(full.p50, SAMPLE_CEILING_US)}, gate ${SAMPLE_CEILING_US * CI_SLACK}µs`,
    );
    expect(full.p50, `sample p50 ${full.p50.toFixed(1)} µs over ${ROWS} rows`).toBeLessThan(SAMPLE_CEILING_US * CI_SLACK);
    // A sub-microsecond baseline makes the ratio noise, so only the absolute gate applies then.
    if (empty.p50 >= 1) expect(ratio, `sample cost grew ${ratio.toFixed(2)}x with rows`).toBeLessThan(ROW_INDEPENDENCE_GATE);
  });

  it("scans the pending queue by lane at the cap inside the sample ceiling", () => {
    interface Request {
      datasetId: string;
      entityId: string;
      lane: Lane;
      key: string;
    }
    const scheduler = new Scheduler<Request>(
      { maxConcurrentFetches: 12, maxBytesInFlight: 64 * MIB },
      (request) => request.key,
      () => {},
    );
    const queue: Request[] = Array.from({ length: PENDING_SCAN_CAP }, (_, i) => ({
      datasetId: "ds",
      entityId: "entity",
      lane: LANES[i % LANES.length],
      key: `k${i}`,
    }));
    scheduler.enqueue(queue, 0);

    const tally = emptyLaneOutstanding();
    let classified = false;
    const scan = measure(() => {
      for (const lane of LANES) tally.pending[lane] = 0;
      classified = scheduler.forEachPending(PENDING_SCAN_CAP, (request) => {
        tally.pending[request.lane]++;
      });
    }, 1_000);
    log(
      `lane scan: ${PENDING_SCAN_CAP.toLocaleString("en-US")} pending entries, the cap | ` +
        `p50=${scan.p50.toFixed(1)}µs p95=${scan.p95.toFixed(1)}µs max=${scan.max.toFixed(1)}µs | ` +
        `${verdict(scan.p50, SAMPLE_CEILING_US)}, gate ${SAMPLE_CEILING_US * CI_SLACK}µs`,
    );
    expect(classified).toBe(true);
    expect(Object.values(tally.pending).reduce((a, b) => a + b, 0)).toBe(PENDING_SCAN_CAP);
    expect(scan.p50, `lane scan p50 ${scan.p50.toFixed(1)} µs`).toBeLessThan(SAMPLE_CEILING_US * CI_SLACK);
  });

  it("keeps a fixed history whatever the session's length", () => {
    const history = createHudHistory();
    for (let tick = 0; tick < 10_000; tick++) pushSample(history, sampleAt(tick));
    const view = buildHudView(history);
    expect(history.receivedRate.length).toBe(HUD_HISTORY);
    for (const series of view.series) expect(series.values.length).toBe(HUD_HISTORY);
    expect(history.length).toBe(HUD_HISTORY);
  });
});
