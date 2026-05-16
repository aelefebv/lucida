/**
 * Unit tests for {@link TelemetryCounters} and {@link BurstLogger}.
 *
 * The counters are driven by verb calls; we assert the snapshot reflects
 * what was recorded and that the per-window reset fires on each snapshot.
 * BurstLogger is exercised through `debugLog` which is mocked so we can
 * count emissions without touching the real localStorage gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});
import { debugLog } from "../../debug/logging.ts";

import { TelemetryCounters, BurstLogger } from "./telemetry.ts";

describe("TelemetryCounters", () => {
  it("snapshot reflects the verb calls", () => {
    const tc = new TelemetryCounters(0);
    tc.recordRequest();
    tc.recordRequest();
    tc.recordHit();
    tc.recordEviction("active-detail");
    tc.recordEviction("prefetch");
    tc.recordEviction("overview");
    tc.recordDecode(12);
    tc.recordDecode(20);
    tc.recordFetchFailure(true, "404 missing");
    tc.recordFetchFailure(false, "transient blip");
    tc.recordCompletedFetch(100);
    tc.recordCompletedFetch(200);

    const snap = tc.snapshot(1000);
    expect(snap.totalRequests).toBe(2);
    expect(snap.totalHits).toBe(1);
    expect(snap.hitRate).toBe(0.5);
    expect(snap.evictionsSinceSnapshot).toBe(3);
    expect(snap.decodesSinceSnapshot).toBe(2);
    expect(snap.evictionsByTier.activeDetail).toBe(1);
    expect(snap.evictionsByTier.prefetch).toBe(1);
    expect(snap.evictionsByTier.overview).toBe(1);
    expect(snap.evictionsByTier.demotedDetail).toBe(0);
    expect(snap.evictionsByTier.proxy).toBe(0);
    expect(snap.permanentFailures).toBe(1);
    expect(snap.transientFailures).toBe(1);
    expect(snap.lastError).toBe("transient blip");
    expect(snap.completedFetches).toBe(2);
    expect(snap.avgDecodedBytes).toBe(150);
    expect(snap.avgDecodeMs).toBe(16);
  });

  it("snapshot resets the per-window counters but preserves cumulative", () => {
    const tc = new TelemetryCounters(0);
    tc.recordEviction("prefetch");
    tc.recordDecode(5);
    tc.recordRequest();
    tc.recordHit();

    const first = tc.snapshot(500);
    expect(first.evictionsSinceSnapshot).toBe(1);
    expect(first.decodesSinceSnapshot).toBe(1);
    expect(first.totalRequests).toBe(1);
    expect(first.totalHits).toBe(1);

    const second = tc.snapshot(1000);
    expect(second.evictionsSinceSnapshot).toBe(0);
    expect(second.decodesSinceSnapshot).toBe(0);
    // Cumulative counters survive across snapshots.
    expect(second.totalRequests).toBe(1);
    expect(second.totalHits).toBe(1);
  });

  it("evictionsPerSec / decodesPerSec compute against the elapsed window", () => {
    const tc = new TelemetryCounters(0);
    for (let i = 0; i < 10; i++) tc.recordEviction("prefetch");
    for (let i = 0; i < 5; i++) tc.recordDecode(1);

    // 1000ms elapsed → 10 evictions/s, 5 decodes/s.
    const snap = tc.snapshot(1000);
    expect(snap.evictionsPerSec).toBe(10);
    expect(snap.decodesPerSec).toBe(5);
  });

  it("decode percentiles use the rolling sample window", () => {
    const tc = new TelemetryCounters(0);
    // Fill > 100 samples to force the window to drop the oldest.
    for (let i = 0; i < 120; i++) tc.recordDecode(i);
    // The window now holds samples [20..119]; p50 is around 70, p95 around 115.
    const snap = tc.snapshot(1000);
    expect(snap.decodeP50Ms).toBeGreaterThanOrEqual(60);
    expect(snap.decodeP95Ms).toBeGreaterThanOrEqual(100);
  });

  it("reset zeros every counter", () => {
    const tc = new TelemetryCounters(0);
    tc.recordRequest();
    tc.recordHit();
    tc.recordEviction("active-detail");
    tc.recordDecode(5);
    tc.recordFetchFailure(true, "boom");
    tc.recordCompletedFetch(200);

    tc.reset(0);
    const snap = tc.snapshot(1000);
    expect(snap.totalRequests).toBe(0);
    expect(snap.totalHits).toBe(0);
    expect(snap.hitRate).toBe(0);
    expect(snap.evictionsSinceSnapshot).toBe(0);
    expect(snap.decodesSinceSnapshot).toBe(0);
    expect(snap.permanentFailures).toBe(0);
    expect(snap.transientFailures).toBe(0);
    expect(snap.lastError).toBeNull();
    expect(snap.completedFetches).toBe(0);
    expect(snap.avgDecodedBytes).toBe(0);
  });

  it("recordCompletedFetch maintains a running average", () => {
    const tc = new TelemetryCounters(0);
    tc.recordCompletedFetch(100);
    expect(tc.averageDecodedBytes()).toBe(100);
    tc.recordCompletedFetch(300);
    expect(tc.averageDecodedBytes()).toBe(200);
  });
});

describe("BurstLogger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(debugLog).mockClear();
  });

  it("recordSkipped emits at most once per window and resets its counter", () => {
    // Advance past the initial window so the first call passes the gate.
    vi.advanceTimersByTime(2000);
    const log = new BurstLogger("cache", "cache.test_event", 1000);

    log.recordSkipped(3, (skipped) => ({ skipped }));
    expect(debugLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(debugLog).mock.calls[0][2]).toEqual({ skipped: 3 });

    // Within the same window: counter accumulates but we don't re-emit.
    log.recordSkipped(2, (skipped) => ({ skipped }));
    expect(debugLog).toHaveBeenCalledTimes(1);

    // After the window elapses: emit again with the accumulated count.
    vi.advanceTimersByTime(1100);
    log.recordSkipped(4, (skipped) => ({ skipped }));
    expect(debugLog).toHaveBeenCalledTimes(2);
    // Counter included the residual 2 from the suppressed call + the new 4.
    expect(vi.mocked(debugLog).mock.calls[1][2]).toEqual({ skipped: 6 });
  });

  it("recordBurst emits exactly once when the in-window count crosses the threshold", () => {
    vi.advanceTimersByTime(2000);
    const log = new BurstLogger("cache", "cache.failure_burst", 1000);

    // First event starts the window and does NOT emit.
    log.recordBurst(4, (count) => ({ count }));
    expect(debugLog).toHaveBeenCalledTimes(0);

    // Events 2, 3 within the same window — still no emit.
    log.recordBurst(4, (count) => ({ count }));
    log.recordBurst(4, (count) => ({ count }));
    expect(debugLog).toHaveBeenCalledTimes(0);

    // Event 4 — first emit at the threshold.
    log.recordBurst(4, (count) => ({ count }));
    expect(debugLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(debugLog).mock.calls[0][2]).toEqual({ count: 4 });

    // Events 5, 6 — still in the same window, do NOT re-emit.
    log.recordBurst(4, (count) => ({ count }));
    log.recordBurst(4, (count) => ({ count }));
    expect(debugLog).toHaveBeenCalledTimes(1);

    // Window rolls; first event in the new window resets state, no emit.
    vi.advanceTimersByTime(1100);
    log.recordBurst(4, (count) => ({ count }));
    expect(debugLog).toHaveBeenCalledTimes(1);

    // Three more inside the new window crosses the threshold again.
    log.recordBurst(4, (count) => ({ count }));
    log.recordBurst(4, (count) => ({ count }));
    log.recordBurst(4, (count) => ({ count }));
    expect(debugLog).toHaveBeenCalledTimes(2);
  });

  it("recordSkipped builds the payload lazily via the callback", () => {
    vi.advanceTimersByTime(2000);
    const log = new BurstLogger("cache", "cache.test_event", 1000);

    let callCount = 0;
    const payloadFn = (skipped: number) => {
      callCount++;
      return { skipped };
    };

    // Window not yet reset on this instance, so first call passes the gate.
    log.recordSkipped(1, payloadFn);
    expect(callCount).toBe(1);

    // Suppressed within window: payload should NOT be built.
    log.recordSkipped(1, payloadFn);
    expect(callCount).toBe(1);
  });
});
