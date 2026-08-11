import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  UploadTelemetry,
  emptyUploadTickStats,
  type UploadTickStats,
  type UploadRollingStats,
} from "./upload.ts";
// The `debug` category set lives in `localStorage`, which is undefined in the
// default vitest node environment. The detector tests stub a minimal
// in-memory `localStorage` shim before importing so the gate opens.
import {
  UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
  UPLOAD_FILTER_RATIO_THRESHOLD,
  UPLOAD_SIZE_SAMPLES,
  UPLOAD_WINDOW_MS,
  UPLOAD_LOG_RATE_LIMIT_MS,
  UPLOAD_LOG_SUSTAIN_MS,
} from "../constants.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build an empty tick-stats record with overrides applied. */
function makeTickStats(over: Partial<UploadTickStats> = {}): UploadTickStats {
  return { ...emptyUploadTickStats(), ...over };
}

// ---------------------------------------------------------------------------
// recordEvent + cumulative counters + size sketch
// ---------------------------------------------------------------------------

describe("UploadTelemetry — recordEvent + counters", () => {
  it("accumulates total bytes and total uploads across recordEvent calls", () => {
    const tel = new UploadTelemetry();
    tel.recordEvent(100, 1000);
    tel.recordEvent(110, 2000);
    tel.recordEvent(120, 4000);
    // No publish yet — push a no-op tick to materialize rolling.
    const rolling = tel.publish(120, makeTickStats());
    expect(rolling.totalBytes).toBe(7000);
    expect(rolling.totalUploads).toBe(3);
  });

  it("publishes rolling bytesPerSec equal to bytes in the 1s window", () => {
    const tel = new UploadTelemetry();
    tel.recordEvent(10_000, 500);
    tel.recordEvent(10_200, 700, "proxy");
    tel.recordEvent(10_400, 800);
    const rolling = tel.publish(10_500, makeTickStats());
    // Window = UPLOAD_WINDOW_MS = 1000ms, so bytesInWindow == bytesPerSec.
    expect(rolling.bytesPerSec).toBe(2000);
    expect(rolling.uploadsPerSec).toBe(3);
    expect(rolling.chunkUploadsPerSec).toBe(2);
    expect(rolling.proxyUploadsPerSec).toBe(1);
  });

  it("prunes events older than UPLOAD_WINDOW_MS", () => {
    const tel = new UploadTelemetry();
    tel.recordEvent(0, 500);
    tel.recordEvent(100, 500);
    // Publish at time t such that the t=0 event falls outside the window.
    const t = UPLOAD_WINDOW_MS + 50;
    const rolling = tel.publish(t, makeTickStats());
    // Only the t=100 event remains in the window.
    expect(rolling.uploadsPerSec).toBe(1);
    expect(rolling.bytesPerSec).toBe(500);
    // Cumulative totals are unaffected by the prune.
    expect(rolling.totalUploads).toBe(2);
    expect(rolling.totalBytes).toBe(1000);
  });

  it("keeps only the last second of events across sustained load", () => {
    const tel = new UploadTelemetry();
    // 200 ticks of 128 events each, 16ms apart — well past one window's
    // worth, so the buffers wrap and prune repeatedly rather than grow.
    const perTick = 128;
    const tickMs = 16;
    const ticks = 200;
    let rolling!: UploadRollingStats;
    for (let i = 0; i < ticks; i++) {
      const now = 100_000 + i * tickMs;
      for (let e = 0; e < perTick; e++) tel.recordEvent(now, 10);
      rolling = tel.publish(now, makeTickStats());
    }
    // Events stamped at or after `now - 1000` survive: ceil(1000/16) = 63 ticks
    // (the current tick plus the 62 preceding ones inside the window).
    const ticksInWindow = Math.floor(UPLOAD_WINDOW_MS / tickMs) + 1;
    expect(rolling.uploadsPerSec).toBe(ticksInWindow * perTick);
    expect(rolling.bytesPerSec).toBe(ticksInWindow * perTick * 10);
    // Cumulative counters keep counting everything.
    expect(rolling.totalUploads).toBe(ticks * perTick);
  });

  it("publishes far faster than the shift()-pruned window it replaced", () => {
    // Regression guard for #898. The old prune was `Array.shift()` in a
    // loop; V8 left-trims cheaply until the backing store outgrows a regular
    // heap object, after which every shift is a full memmove. 128 events per
    // tick at ~120Hz puts the 1s window at ~15.5k entries — past that cliff,
    // where the shift version measures ~1.15ms per publish against a 16.7ms
    // frame budget.
    //
    // The assertion is a ratio against that old shape, measured in the same
    // run, rather than an absolute millisecond bound: the cliff is
    // structural in V8, so the ratio holds on a slow CI box where an
    // absolute bound would just flake.
    const perTick = 128;
    const tickMs = 8;
    const ticks = 300;

    const timeTicks = (base: number, onTick: (now: number) => void): number => {
      const start = performance.now();
      for (let i = 0; i < ticks; i++) onTick(base + i * tickMs);
      return performance.now() - start;
    };

    const tel = new UploadTelemetry();
    const ringTick = (now: number): void => {
      for (let e = 0; e < perTick; e++) tel.recordEvent(now, 10);
      tel.publish(now, makeTickStats());
    };
    // Warm to steady state so the measured ticks are the expensive ones
    // (a full second of events resident, pruning on every tick).
    timeTicks(100_000, ringTick);
    const ringMs = timeTicks(200_000, ringTick) / ticks;

    // The pre-fix shape: a plain array pruned with `shift()`, then scanned.
    const events: Array<{ at: number; bytes: number }> = [];
    const shiftTick = (now: number): void => {
      for (let e = 0; e < perTick; e++) events.push({ at: now, bytes: 10 });
      const cutoff = now - UPLOAD_WINDOW_MS;
      while (events.length > 0 && events[0].at < cutoff) events.shift();
      let bytes = 0;
      for (const e of events) bytes += e.bytes;
      if (bytes < 0) throw new Error("unreachable");
    };
    timeTicks(100_000, shiftTick);
    const shiftMs = timeTicks(200_000, shiftTick) / ticks;

    // Both windows hold the same events, so this is like for like.
    expect(events.length).toBeGreaterThan(15_000);
    // Measured ~16x on a dev machine; 4x is the flake-proof floor.
    expect(ringMs * 4).toBeLessThan(shiftMs);
  });

  it("derives p50 / p95 upload size from the sample buffer", () => {
    const tel = new UploadTelemetry();
    // Build a known distribution: 1,2,3,...,10.
    for (let i = 1; i <= 10; i++) tel.recordEvent(10_000 + i, i * 100);
    const rolling = tel.publish(10_100, makeTickStats());
    // Math.floor(10 * 0.5) = 5 → sorted[5] = 600.
    expect(rolling.uploadSizeP50).toBe(600);
    // Math.floor(10 * 0.95) = 9 → sorted[9] = 1000.
    expect(rolling.uploadSizeP95).toBe(1000);
  });

  it("keeps only the most recent UPLOAD_SIZE_SAMPLES sizes once it wraps", () => {
    const tel = new UploadTelemetry();
    const n = UPLOAD_SIZE_SAMPLES * 2;
    for (let i = 1; i <= n; i++) tel.recordEvent(10_000, i * 100);
    const rolling = tel.publish(10_000, makeTickStats());
    // Retained window is i = SAMPLES+1 .. 2*SAMPLES, sorted ascending.
    const retained = Array.from(
      { length: UPLOAD_SIZE_SAMPLES },
      (_, k) => (UPLOAD_SIZE_SAMPLES + 1 + k) * 100,
    );
    expect(rolling.uploadSizeP50).toBe(
      retained[Math.floor(UPLOAD_SIZE_SAMPLES * 0.5)],
    );
    expect(rolling.uploadSizeP95).toBe(
      retained[Math.floor(UPLOAD_SIZE_SAMPLES * 0.95)],
    );
  });
});

// ---------------------------------------------------------------------------
// Tick window aggregation + filter ratio
// ---------------------------------------------------------------------------

describe("UploadTelemetry — tick aggregation", () => {
  it("aggregates skip causes from per-tick stats into the rolling window", () => {
    const tel = new UploadTelemetry();
    const rolling = tel.publish(
      10_000,
      makeTickStats({
        drainedChunks: 10,
        skippedWrongLod: 4,
        skippedAlreadySent: 1,
        skippedNoMeta: 0,
        skippedPrefetch: 2,
        skippedOverview: 0,
      }),
    );
    // drainedUploadBound = drainedChunks - prefetch - overview = 10 - 2 - 0 = 8
    // skippedUploadBound = wrongLod + alreadySent + noMeta = 4 + 1 + 0 = 5
    // filterRatio = 5 / 8 = 0.625
    expect(rolling.filterRatio).toBeCloseTo(0.625);
  });

  it("counts ticks with budgetExhausted=true in the rolling window", () => {
    const tel = new UploadTelemetry();
    tel.publish(10_000, makeTickStats({ budgetExhausted: true }));
    tel.publish(10_100, makeTickStats({ budgetExhausted: false }));
    const rolling = tel.publish(10_200, makeTickStats({ budgetExhausted: true }));
    expect(rolling.budgetExhaustedTicksLastSecond).toBe(2);
  });

  it("returns NaN ratios when the relevant denominator is 0", () => {
    const tel = new UploadTelemetry();
    const rolling = tel.publish(10_000, makeTickStats());
    expect(rolling.filterRatio).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Sustained-anomaly detectors
//
// debugLog only emits when its category is enabled (`localStorage.debug`
// gates the call). We spy on `console.log`, enable the "orch" category
// for the test, and assert that the right event names land. Each test
// restores prior debug state in `afterEach` to avoid bleed.
// ---------------------------------------------------------------------------

describe("UploadTelemetry — sustained anomaly detectors", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let priorLocalStorage: unknown;

  beforeEach(async () => {
    // In-memory localStorage shim so the `debug` category write (and the
    // subsequent `readEnabled()` inside `debugLog`) can persist a value.
    const store = new Map<string, string>();
    priorLocalStorage = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { refreshDebugCategories } = await import("../../../debug/logging.ts");
    localStorage.setItem("debug", "orch");
    refreshDebugCategories();
  });
  afterEach(async () => {
    const { refreshDebugCategories } = await import("../../../debug/logging.ts");
    localStorage.removeItem("debug");
    refreshDebugCategories();
    consoleLogSpy.mockRestore();
    (globalThis as Record<string, unknown>).localStorage = priorLocalStorage;
  });

  const findLogs = (eventName: string): Array<{ payload: object }> =>
    (consoleLogSpy.mock.calls as Array<[unknown, unknown]>)
      .filter(([msg]) => typeof msg === "string" && (msg as string).includes(eventName))
      .map(([, payload]) => ({ payload: payload as object }));

  it("budget_exhausted_sustained: arms only after THRESHOLD consecutive exhausted ticks", () => {
    const tel = new UploadTelemetry();
    // Past the rate-limit at startup so it isn't the gate.
    const t0 = UPLOAD_LOG_RATE_LIMIT_MS + 1000;
    for (let i = 0; i < UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD - 1; i++) {
      tel.publish(t0 + i * 100, makeTickStats({ budgetExhausted: true }));
    }
    expect(findLogs("upload.budget_exhausted_sustained")).toHaveLength(0);
    tel.publish(t0 + 1000, makeTickStats({ budgetExhausted: true }));
    const logs = findLogs("upload.budget_exhausted_sustained");
    expect(logs).toHaveLength(1);
    expect(logs[0].payload).toMatchObject({
      consecutiveTicks: UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
    });
  });

  it("budget_exhausted_sustained: a non-exhausted tick resets the streak", () => {
    const tel = new UploadTelemetry();
    const t0 = UPLOAD_LOG_RATE_LIMIT_MS + 1000;
    for (let i = 0; i < UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD - 1; i++) {
      tel.publish(t0 + i * 100, makeTickStats({ budgetExhausted: true }));
    }
    tel.publish(t0 + 500, makeTickStats({ budgetExhausted: false }));
    // (THRESHOLD - 1) more consecutive exhausted ticks should *not* fire.
    for (let i = 0; i < UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD - 1; i++) {
      tel.publish(t0 + 600 + i * 100, makeTickStats({ budgetExhausted: true }));
    }
    expect(findLogs("upload.budget_exhausted_sustained")).toHaveLength(0);
  });

  it("drain_waste: arms when filterRatio stays > threshold for sustainMs", () => {
    const tel = new UploadTelemetry();
    // High filter ratio: 10 drained chunks, 9 skipped wrong-lod → 0.9.
    const wastyTick = makeTickStats({
      drainedChunks: 10,
      skippedWrongLod: 9,
    });
    const t0 = UPLOAD_LOG_RATE_LIMIT_MS + 1000;
    tel.publish(t0, wastyTick);
    tel.publish(t0 + UPLOAD_LOG_SUSTAIN_MS + 100, wastyTick);
    const logs = findLogs("upload.drain_waste");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect((logs[0].payload as { filterRatio: number }).filterRatio).toBeGreaterThan(
      UPLOAD_FILTER_RATIO_THRESHOLD,
    );
  });
});

// ---------------------------------------------------------------------------
// Telemetry shape regression — guards the counter migration parity
// ---------------------------------------------------------------------------

describe("UploadTelemetry — shape regression", () => {
  /**
   * Run a known sequence of recordEvent + publish calls and assert the
   * produced `UploadRollingStats` shape (every key, in order) matches
   * the expected snapshot. Safety net: if the module starts dropping or
   * renaming a tile, this test catches it before the `orch` log
   * category — its remaining consumer — starts lying.
   */
  it("preserves the full UploadRollingStats key set", () => {
    const tel = new UploadTelemetry();
    tel.recordEvent(10_000, 512);
    tel.recordEvent(10_100, 1024);
    const rolling = tel.publish(
      10_200,
      makeTickStats({
        drainedChunks: 5,
        drainedProxies: 1,
        uploadedChunks: 4,
        uploadedProxies: 1,
        bytesUploaded: 1536,
        bytesBudget: 8192,
        budgetExhausted: false,
        skippedPrefetch: 1,
        skippedWrongLod: 1,
      }),
    );
    expect(Object.keys(rolling).sort()).toEqual(
      [
        "bytesPerSec",
        "uploadsPerSec",
        "chunkUploadsPerSec",
        "proxyUploadsPerSec",
        "filterRatio",
        "uploadSizeP50",
        "uploadSizeP95",
        "totalBytes",
        "totalUploads",
        "budgetExhaustedTicksLastSecond",
      ].sort(),
    );
    // Spot-check values for a regression on the arithmetic itself.
    expect(rolling.totalBytes).toBe(1536);
    expect(rolling.totalUploads).toBe(2);
    // drainedUploadBound = 5 - 1 (prefetch) - 0 (overview) = 4
    // skippedUploadBound = 1 (wrongLod)
    // → filterRatio = 1/4 = 0.25
    expect(rolling.filterRatio).toBeCloseTo(0.25);
  });
});
