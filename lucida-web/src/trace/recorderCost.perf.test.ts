/**
 * The recorder's cost contract, asserted (issue #928, ADR 0049).
 *
 * ADR 0049 makes the recorder's cost a **design contract rather than a runtime
 * governor**: nothing measures the recorder while it runs, because a governor
 * would make the monitor instrument itself continuously — the perverse case —
 * and would make the cost emergent when the model is deterministic by
 * construction. So the ceilings are asserted here instead:
 *
 * - **≤ 100 ns per event, amortised.** The primary number, because it
 *   composes: any burst size multiplied by it gives the tick cost.
 * - **≤ 250 µs worst-case tick.** #888's largest observed burst is 2,943 chunk
 *   requests inside one `cpuCache.submit()`. The ADR derived this ceiling as
 *   one recorded event per chunk request, and the dispatch path now emits
 *   exactly that: the row birth carries the admission stamp and opens `wire`
 *   itself. It emitted three — row birth, admission, wire start — until #949,
 *   which put the tick over a ceiling derived from one third of its events.
 *   Keeping {@link BURST_CALLS_PER_CHUNK} at 1 is what keeps the two counting
 *   the same thing; `docs/perf/recorder-cost/README.md` carries the history.
 * - **Flat in events-per-tick, not merely small at one event.** This is the
 *   gate most worth having: `UploadTelemetry.publish` in this repo went from
 *   1.4 µs to 1.13 ms between 1 and 128 events per tick because it pruned with
 *   `Array.shift()` in a loop (#888, filed as #898). That failure has already
 *   happened here. Flatness is asserted by holding *every* burst size to the
 *   same per-event ceiling — a per-event cost that grows with N blows the
 *   ceiling at N=2,943 long before it looks wrong at N=1.
 * - **Zero steady-state allocation after warmup.** An allocating recorder
 *   produces GC pauses that appear *as stalls in its own trace*.
 *
 * ## These are tripwires, not benchmarks
 *
 * Absolute timings vary widely across machines and CI runners, and a
 * ratio-based perf assertion in this repo already flakes (the #906 upload
 * telemetry ring-vs-shift guard). So every timing gate here asserts an
 * *absolute* bound at {@link CI_SLACK}× the spec ceiling and logs the real
 * figure and its headroom. Read the logged line for the actual number; the
 * assertion only fires on a change of complexity class, not on a slow runner.
 *
 * The fourth gate ADR 0049 requires — an A/B frame-throughput comparison of
 * real sink against no-op sink over a warm re-open at devicePixelRatio 2 —
 * needs a GPU, a server and a real fixture, none of which a CI runner has. It
 * lives as a harness at `docs/perf/recorder-cost/`, alongside the net
 * non-regression ledger this repo owes once the debug panel is dismantled.
 */

import process from "node:process";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import { TableTraceSink } from "./sink.ts";
import {
  Boundary,
  CountedPhaseIndex,
  PointEvent,
  TickCounter,
  type ChunkRowSource,
  type RunConditions,
  type WireLabel,
} from "./types.ts";

/** ADR 0049's amortised per-event ceiling. */
const PER_EVENT_CEILING_NS = 100;

/** ADR 0049's worst-case tick ceiling, for #888's largest observed burst. */
const WORST_TICK_CEILING_US = 250;

/**
 * How far above the measured figure a gate trips.
 *
 * Sixteen, and the width is the finding rather than a fudge: the same burst
 * measures 75 µs on an idle workstation and 3.4 ms on a GitHub runner, a
 * ~45× spread on identical code. A microbenchmark of a few-microsecond tick
 * is dominated by whatever else the host is doing. At 4× the two timing
 * gates below failed on every CI run — a gate reporting the runner, not the
 * code, which is precisely the #906 flake this file's doc says it must not
 * become.
 *
 * Sixteen clears the worst CI figure observed by ~3.5× — that 3.4 ms was
 * three write calls per chunk, and #949 made it one — and still catches the
 * shape these gates exist for by two orders of magnitude: `Array.shift()`
 * pruning took `UploadTelemetry.publish` from 1.4 µs to 1.13 ms (#888/#898),
 * ~800×. Read the logged figure for the real number — the assertion only
 * fires on a change of complexity class.
 */
const CI_SLACK = 16;

/**
 * How much more the largest burst may cost per event than the cheapest. Wide,
 * because the small bursts amortise a tick's fixed cost over very few events
 * and a tight bound would flake; narrow enough that the `Array.shift()` shape
 * — three orders of magnitude between 1 and 128 events — cannot hide in it.
 */
const FLATNESS_GROWTH_GATE = 4;

/** #888's burst sizes: one, a small tick, the panel-era failure point, the worst case. */
const BURSTS = [1, 8, 128, 2943] as const;

const OPEN_CAUSE = { epoch: "content", dirtyKind: "residency", source: "residency_fill" } as const;

const CONDITIONS: RunConditions = {
  datasetIds: ["ds"],
  composedView: { url: "/w/ws-1", mode: "slice" },
  devicePixelRatio: 2,
  viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
};

const WARMTH = {
  detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
};

const OUTSTANDING = {
  pending: 0, inFlight: 0, speculativePending: 0, speculativeInFlight: 0,
  desiredDetailChunks: 0, residentDetailChunks: 0, desiredCoarseChunks: 0, residentCoarseChunks: 0,
};

/**
 * Recorder write calls per chunk on the real emit path, counted from the call
 * sites in `cpuCache.fetchAndDecode` (row birth — which carries admission and
 * wire start with it since #949 — then label and decode), `decodePool` (upload
 * boundary + the counted worker dispatch) and the render loop's hand-off.
 * Excludes the two present stamps and the row retirement, which
 * `noteFrameDispatched` does in bulk and which {@link eventsPerTick} counts
 * separately.
 */
const CALLS_PER_CHUNK = 6;

/**
 * Per-row work inside `noteFrameDispatched`: two present stamps and a finish.
 * Counted per row rather than as the one call it arrives as, because it is a
 * loop over rows and counting it once would understate the events a tick
 * records — which would flatter every per-event figure below.
 */
const FRAME_CALLS_PER_CHUNK = 3;

/** Per-tick fixed calls: plan open/close, tick open/commit, one point event. */
const FIXED_CALLS_PER_TICK = 5;

/** The same, on the burst path, which records no point event. */
const BURST_FIXED_CALLS_PER_TICK = 4;

function eventsPerTick(chunks: number): number {
  return chunks * (CALLS_PER_CHUNK + FRAME_CALLS_PER_CHUNK) + FIXED_CALLS_PER_TICK;
}

/**
 * Recorder calls per chunk on the burst path alone: **one**, the row birth in
 * `cpuCache.fetchAndDecode`, which carries the admission stamp and opens
 * `wire` itself. Everything downstream — wire close, decode, upload, present —
 * lands on later ticks as the fetches settle, which is why the worst-case tick
 * is this and not a whole lifecycle.
 *
 * This being 1 is what #949 fixed and what this file exists to keep fixed. It
 * was 3 — row birth, admission, wire start, in one breath at dispatch — which
 * is three times the event count ADR 0049 derived
 * {@link WORST_TICK_CEILING_US} from, and the reason the worst tick sat over
 * that ceiling.
 */
const BURST_CALLS_PER_CHUNK = 1;

/**
 * One recorder wired to a real sink, plus the pre-built inputs a tick needs.
 *
 * Everything the driver hands the recorder is allocated up front and reused,
 * so what the loop measures is the recorder's write path rather than the
 * harness building arguments for it.
 */
function makeRig(chunks: number, calls?: { count: number }) {
  let sink: TableTraceSink | null = null;
  const real = new TraceRecorder({
    sinkFactory: () => (sink = new TableTraceSink()),
    // Far beyond any measurement window: a run closing mid-loop would stop
    // the write path dead and measure the early-out instead.
    timeoutMs: 3_600_000,
  });
  real.setEnvironment({
    captureWarmth: () => WARMTH,
    captureConditions: () => CONDITIONS,
    captureOutstanding: () => OUTSTANDING,
  });
  real.openRun(OPEN_CAUSE);

  // Setup happens on the recorder itself; only the drive below goes through
  // the counting wrapper, so a count describes one tick and nothing else.
  const recorder = calls ? countingRecorder(real, calls) : real;

  const sources: ChunkRowSource[] = [];
  for (let i = 0; i < chunks; i++) {
    sources.push({
      datasetId: "ds",
      entityId: `member-${i % 384}`,
      imageId: `image-${i % 384}`,
      lane: i % 3 === 0 ? "coarse" : "detail",
      level: i % 5,
      t: 0,
      c: i % 3,
      z: i % 7,
      y: (i / 16) | 0,
      x: i % 16,
    });
  }

  const handles = new Int32Array(chunks);
  const label: WireLabel = { rid: 0, connectionGeneration: 1 };

  /** One planning tick at this burst size, driven the way the pipeline drives it. */
  function tick(): void {
    recorder.markPlanStart();
    const scratch = recorder.beginTick("ds");
    if (scratch) {
      scratch.counters[TickCounter.PlannedChunks] = chunks;
      scratch.setResidency(2, chunks, 0);
    }
    const enqueuedAtMs = performance.now();
    recorder.notePlanEnqueue(enqueuedAtMs);

    for (let i = 0; i < chunks; i++) {
      const src = sources[i];
      const tier = src.lane === "coarse" ? 1 : 0;
      const handle = recorder.beginChunkRow(src, tier, enqueuedAtMs);
      handles[i] = handle;
      label.rid = i;
      recorder.labelRow(handle, label);
      recorder.stamp(handle, Boundary.DecodeStart);
      recorder.countPhase(CountedPhaseIndex.WorkerDispatch);
      recorder.stamp(handle, Boundary.UploadStart);
      recorder.noteHandedToRenderer(handle);
    }

    // Closes the previous frame's rows and opens this one's — the bulk half of
    // the per-chunk cost, and the one that would go quadratic if either
    // pending list were pruned by search instead of swapped.
    recorder.noteFrameDispatched();
    recorder.recordPointEvent(PointEvent.Eviction, "evicted", sources[0], 0);
    recorder.commitTick();
  }

  /**
   * The worst-case tick ADR 0049 sized: one `cpuCache.submit()` admitting the
   * whole burst, with nothing downstream of dispatch on this tick.
   */
  function burstTick(): void {
    recorder.markPlanStart();
    const scratch = recorder.beginTick("ds");
    if (scratch) scratch.counters[TickCounter.PlannedChunks] = chunks;
    const enqueuedAtMs = performance.now();
    recorder.notePlanEnqueue(enqueuedAtMs);
    for (let i = 0; i < chunks; i++) {
      const src = sources[i];
      recorder.beginChunkRow(src, src.lane === "coarse" ? 1 : 0, enqueuedAtMs);
    }
    recorder.commitTick();
  }

  return { recorder: real, tick, burstTick, sink: () => sink };
}

/**
 * The recorder, counting the write calls made through it. The per-event
 * figures below are a tick's cost divided by a hand-written model of how many
 * calls a tick makes; this is what stops that model going stale when an emit
 * site is added, by letting a test compare the model against the real count.
 */
function countingRecorder(target: TraceRecorder, calls: { count: number }): TraceRecorder {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.count++;
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

/** Median, p95 and max of a sample set, in the order a log line wants them. */
function summarise(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Drive `chunks` events per tick and return the per-tick timings. Iterations
 * scale down with burst size so every burst measures a comparable ~300k events
 * — enough samples to have a median at N=2,943 without spending a minute of CI
 * on the small ones.
 */
function measure(chunks: number, kind: "lifecycle" | "burst" = "lifecycle") {
  const events = kind === "lifecycle"
    ? eventsPerTick(chunks)
    : chunks * BURST_CALLS_PER_CHUNK + BURST_FIXED_CALLS_PER_TICK;
  const iterations = Math.max(20, Math.min(2000, Math.round(600_000 / events)));
  const rig = makeRig(chunks);
  const drive = kind === "lifecycle" ? rig.tick : rig.burstTick;

  // Warm past first-call JIT. The row table's doublings are *not* warmed
  // past — rows accumulate for a run's whole life, so a doubling can land in
  // any window, including in the product. They show up in the logged max and
  // leave the p50 the gates read alone, which is the honest split: a doubling
  // is a real cost the recorder pays, and it is not the per-event cost.
  for (let i = 0; i < Math.min(iterations, 20); i++) drive();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    drive();
    samples.push(performance.now() - t0);
  }
  rig.recorder.reset();

  const stats = summarise(samples);
  return {
    chunks,
    events,
    iterations,
    tickUs: { p50: stats.p50 * 1000, p95: stats.p95 * 1000, max: stats.max * 1000 },
    perEventNs: (stats.p50 * 1e6) / events,
  };
}

describe("recorder cost contract", () => {
  it("is flat in events-per-tick and inside the spec's ceilings", () => {
    const results = BURSTS.map(chunks => measure(chunks));

    for (const r of results) {
      console.log(
        `[#928] burst=${String(r.chunks).padStart(4)} events/tick=${String(r.events).padStart(5)} ` +
          `x${r.iterations} | ${r.perEventNs.toFixed(1)} ns/event ` +
          `(ceiling ${PER_EVENT_CEILING_NS}, gate ${PER_EVENT_CEILING_NS * CI_SLACK}) | ` +
          `tick p50=${r.tickUs.p50.toFixed(1)}µs p95=${r.tickUs.p95.toFixed(1)}µs ` +
          `max=${r.tickUs.max.toFixed(1)}µs`,
      );
    }

    const flat = results.map(r => r.perEventNs);
    const cheapest = Math.min(...flat);
    const growth = flat[flat.length - 1] / cheapest;
    console.log(
      `[#928] flatness: ns/event ${flat.map(n => n.toFixed(1)).join(" -> ")} ` +
        `across bursts ${BURSTS.join(", ")} | largest burst is ${growth.toFixed(2)}x the ` +
        `cheapest (gate ${FLATNESS_GROWTH_GATE}x)`,
    );

    // Two gates, because either alone can be cleared by the failure this
    // exists to catch.
    //
    // The absolute one: a per-event cost that grows with the burst clears the
    // ceiling at N=1 and blows it at N=2,943. `UploadTelemetry.publish` at 128
    // events per tick cost 8.8 µs *per event*.
    for (const r of results) {
      expect(
        r.perEventNs,
        `${r.chunks} events/tick cost ${r.perEventNs.toFixed(1)} ns/event`,
      ).toBeLessThan(PER_EVENT_CEILING_NS * CI_SLACK);
    }

    // The comparative one, which is what "flat" actually means: the largest
    // burst must not cost meaningfully more per event than the cheapest.
    // Deliberately wide — the small bursts carry the per-tick fixed cost over
    // few events, so some spread is expected and a tight ratio would flake —
    // but it still fails on any growth with N worth the name.
    expect(
      growth,
      `2,943 events/tick cost ${growth.toFixed(2)}x the cheapest burst per event`,
    ).toBeLessThan(FLATNESS_GROWTH_GATE);
  });

  it("counts the write calls the per-event figures are divided by", () => {
    // The ns/event numbers are a tick's cost over a hand-written model of how
    // many calls a tick makes. Add an emit call to the drive and forget the
    // model, and every ceiling silently loosens — so the model is checked
    // against the real count rather than trusted.
    const lifecycle = { count: 0 };
    makeRig(64, lifecycle).tick();
    const burst = { count: 0 };
    makeRig(64, burst).burstTick();

    // `noteFrameDispatched` arrives as one call and is modelled per row, so
    // the lifecycle tick makes one more call than the fixed term names.
    expect(lifecycle.count).toBe(64 * CALLS_PER_CHUNK + FIXED_CALLS_PER_TICK + 1);
    expect(burst.count).toBe(64 * BURST_CALLS_PER_CHUNK + BURST_FIXED_CALLS_PER_TICK);
  });

  it("bounds the worst tick #888 measured against the 250 µs ceiling", () => {
    // ADR 0049 derived this ceiling from one number: the largest burst #888
    // found is 2,943 chunk requests inside one `cpuCache.submit()`, and at
    // 100 ns an event that is 294 µs. So the tick being bounded is the
    // submit-and-dispatch burst — the rest of each chunk's lifecycle lands on
    // later ticks as its fetch settles, and the previous gate's whole-
    // lifecycle-in-one-tick figure is a pessimistic bound, not this one.
    const burst = measure(2943, "burst");
    const ratio = burst.tickUs.p50 / WORST_TICK_CEILING_US;
    const verdict = ratio <= 1
      ? `${(1 / ratio).toFixed(1)}x under the ceiling`
      : `OVER the ${WORST_TICK_CEILING_US}µs ceiling by ${ratio.toFixed(1)}x`;
    console.log(
      `[#928] worst tick: 2,943-chunk submit burst = ${burst.events} write calls | ` +
        `p50=${burst.tickUs.p50.toFixed(1)}µs p95=${burst.tickUs.p95.toFixed(1)}µs ` +
        `max=${burst.tickUs.max.toFixed(1)}µs x${burst.iterations} | ` +
        `${burst.perEventNs.toFixed(1)} ns/call | ${verdict}, gate ` +
        `${WORST_TICK_CEILING_US * CI_SLACK}µs`,
    );

    // Gated on the spec ceiling itself rather than on a measured stand-in.
    // It was the latter while the dispatch path emitted three write calls per
    // chunk against a ceiling derived from one, which put the tick over the
    // ceiling on a green build — a gate that cannot pass on green is not a
    // gate. #949 collapsed those three into one, so the implementation and
    // the ADR now count the same events and the ceiling is the honest bound.
    expect(
      burst.tickUs.p50,
      `worst-case tick p50 ${burst.tickUs.p50.toFixed(1)} µs`,
    ).toBeLessThan(WORST_TICK_CEILING_US * CI_SLACK);
  });

  it("holds one run inside the observability floor the teardown must not raise", () => {
    // ADR 0049's *net* obligation, as far as it can be checked before the
    // debug panel is dismantled (#918, #919): the recorder's marginal cost is
    // measured here against the floor #888 found — ≈1.05 MB of live state and
    // ≈1–3 µs per tick — so that when the panel goes, the subtraction is
    // arithmetic on two recorded numbers rather than a new measurement
    // campaign. `docs/perf/recorder-cost/README.md` carries the ledger.
    //
    // Live state is the run's buffers, not the retained history: ADR 0049
    // grants retention its own separate 8 MB resident cap, which is a
    // deliberate spend rather than a regression against this floor.
    const typical = measure(8);
    const rig = makeRig(64);
    // #888's typical run: 2,559 chunks, which ADR 0047 sizes at ~123 kB.
    for (let i = 0; i < 40; i++) rig.tick();
    const liveBytes = rig.sink()!.byteLength;
    rig.recorder.reset();

    console.log(
      `[#928] floor check: typical tick (8 chunks, ${typical.events} write calls) ` +
        `p50=${typical.tickUs.p50.toFixed(2)}µs vs #888's 1–3 µs/tick floor | ` +
        `one 2,560-chunk run holds ${(liveBytes / 1024).toFixed(0)} kB live vs the ` +
        `1.05 MB floor (retention's 8 MB cap is a separate, granted budget)`,
    );

    expect(typical.tickUs.p50).toBeLessThan(3 * CI_SLACK);
    expect(liveBytes).toBeLessThan(1.05 * 1024 * 1024);
  });

  it("allocates nothing in steady state after warmup", () => {
    // Steady state is the write path over buffers that already exist: row
    // births into spare capacity, stamps into a live row, the two drop-oldest
    // rings wrapping, the counted-phase vector, and the frame hand-off
    // swapping its two lists.
    //
    // Row appends are inside the window on purpose, and the window is sized to
    // fit inside the capacity the warmup grew. Leaving them out would make the
    // buffer-identity check below unfalsifiable — nothing else in the recorder
    // can reallocate — and growth-by-doubling is the one allocation ADR 0049
    // permits, so the thing worth asserting is that it does not happen where
    // there is room.
    const chunks = 128;
    const rig = makeRig(chunks);
    for (let i = 0; i < 400; i++) rig.tick();

    const sink = rig.sink();
    expect(sink).not.toBeNull();
    const bytesBefore = sink!.byteLength;
    // The table grows only by doubling from 1,024 rows, so its capacity — and
    // therefore the room left before the next doubling — follows from the row
    // count. Half of that room, so the window cannot reach the doubling even
    // if the growth policy is off by one.
    const capacity = 1 << Math.ceil(Math.log2(Math.max(1024, sink!.length)));
    const appends = Math.floor((capacity - sink!.length) / 2);
    expect(appends).toBeGreaterThan(1000);

    const source: ChunkRowSource = {
      datasetId: "ds", entityId: "m", imageId: "i", lane: "detail",
      level: 0, t: 0, c: 0, z: 0, y: 0, x: 0,
    };
    const handle = rig.recorder.beginChunkRow(source, 0);

    const ops = 400_000;
    const gc = resolveGc();
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < ops; i++) {
      if (i < appends) rig.recorder.beginChunkRow(source, 0);
      rig.recorder.stamp(handle, Boundary.WireStart);
      rig.recorder.countPhase(CountedPhaseIndex.CacheAdmission);
      rig.recorder.recordPointEvent(PointEvent.Rejection, "atlas-policy", null, 0);
      rig.recorder.noteFrameDispatched();
      rig.recorder.beginTick("ds");
      rig.recorder.commitTick();
    }

    gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    const grown = heapAfter - heapBefore;
    const calls = ops * 6 + appends;
    console.log(
      `[#928] steady state: ${calls} write calls (${appends} of them row births ` +
        `into spare capacity) grew the heap by ${(grown / 1024).toFixed(1)} kB ` +
        `(${(grown / calls).toFixed(3)} B/call, gc ${gc ? "forced" : "unavailable"}) | ` +
        `sink held ${(bytesBefore / 1024).toFixed(1)} kB throughout`,
    );

    // The deterministic half: nothing in the sink was reallocated, including
    // the row table, which had room and so must not have doubled.
    expect(sink!.byteLength).toBe(bytesBefore);

    // The heap half. 512 kB over ~2.4M calls is 0.2 B/call, far below the tens
    // of bytes even one small object per call would cost and far above a
    // runner's background noise. Without a forced gc the same bound would read
    // uncollected garbage as growth, so the ungated fallback is loose enough to
    // survive that and still catch per-call allocation, which would be tens of
    // megabytes.
    expect(grown).toBeLessThan(gc ? 512 * 1024 : 8 * 1024 * 1024);

    rig.recorder.reset();
  });

  /**
   * The live view's read (#937), which is the one place a *reader* spends the
   * pipeline's main thread rather than the writer.
   *
   * It costs a walk over every row the run has made, twice a second, while
   * the monitor is open — so the shape that matters is linearity. A walk that
   * went quadratic in rows would turn watching a run into perturbing it, and
   * the surface's "observation only" claim with it. Per-row cost is gated
   * across a 10x population rather than in absolute microseconds, for the
   * reason this file's doc gives: absolute timings on a CI runner measure the
   * runner.
   */
  it("reads a run in progress in time linear in its rows", () => {
    // The upper figure is past the per-run cap on purpose: it lands the walk
    // on the largest row population a run can ever hold.
    const populations = [2_000, 40_000] as const;
    const readings = populations.map((rows) => {
      const rig = makeRig(1);
      for (let i = 0; i < rows; i++) {
        const handle = rig.recorder.beginChunkRow(
          { datasetId: "ds", entityId: "m", imageId: "i", lane: "detail",
            level: i % 5, t: 0, c: 0, z: i % 7, y: (i / 16) | 0, x: i % 16 },
          0,
        );
        // Rows spread across the phases, so the backward boundary scan is not
        // measured at its best case on every row.
        if (i % 4 !== 0) stampTo(rig.recorder, handle, i % 4);
      }

      // What the run actually holds, not what was asked for: the per-run cap
      // truncates a run long before an unbounded number of rows, which is
      // also what bounds this walk in the product.
      const recorded = rig.recorder.liveProgress!.planned;

      // Read into a total the assertion below can see, so nothing here is
      // dead code an optimiser is free to skip.
      let planned = 0;
      const read = () => {
        planned += rig.recorder.liveProgress?.planned ?? 0;
      };
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) read();
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        read();
        samples.push(performance.now() - t0);
      }
      expect(planned).toBe(recorded * 220);
      const stats = summarise(samples);
      rig.recorder.reset();
      return { asked: rows, rows: recorded, p50Us: stats.p50 * 1000, perRowNs: (stats.p50 * 1e6) / recorded };
    });

    for (const r of readings) {
      console.log(
        `[#937] live read: rows=${String(r.rows).padStart(6)} | ` +
          `p50=${r.p50Us.toFixed(1)}µs | ${r.perRowNs.toFixed(1)} ns/row`,
      );
    }

    const [small, large] = readings;
    expect(
      large.perRowNs,
      `${large.perRowNs.toFixed(1)} ns/row at ${large.rows} rows against ` +
        `${small.perRowNs.toFixed(1)} at ${small.rows}`,
    ).toBeLessThan(small.perRowNs * FLATNESS_GROWTH_GATE);
  });
});

/** Stamp a row forward to `boundary`, so it reads as sitting in that phase. */
function stampTo(recorder: TraceRecorder, handle: number, boundary: number): void {
  for (let b = 0; b <= boundary; b++) recorder.stamp(handle, b);
}

/**
 * V8's `gc()`, without requiring the runner to pass `--expose-gc`. Returns
 * null if the flag cannot be set, in which case the heap figure is logged as
 * advisory and only the deterministic buffer-identity check gates.
 */
function resolveGc(): (() => void) | null {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as (() => void) | undefined;
    v8.setFlagsFromString("--no-expose-gc");
    return gc ?? null;
  } catch {
    return null;
  }
}
