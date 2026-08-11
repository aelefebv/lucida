import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ColdStateTelemetry, type ColdStateCauseKey } from "./coldState.ts";
import {
  COLD_STATE_CHURN_SUSTAIN_MS,
  COLD_STATE_DURATION_SAMPLES,
  COLD_STATE_WINDOW_MS,
} from "../constants.ts";

// ---------------------------------------------------------------------------
// recordHit / recordRebuild basics
// ---------------------------------------------------------------------------

describe("ColdStateTelemetry — basics", () => {
  it("recordHit bumps cumulative hits + window hits but no rebuild tiles", () => {
    const tel = new ColdStateTelemetry();
    tel.recordHit(1000);
    tel.recordHit(1100);
    const snap = tel.publish();
    expect(snap.cacheHits).toBe(2);
    expect(snap.rebuilds).toBe(0);
    expect(snap.hitsLastSecond).toBe(2);
    expect(snap.rebuildsLastSecond).toBe(0);
    expect(snap.hitRate).toBeCloseTo(1.0);
    expect(snap.lastRebuildMs).toBeNull();
    expect(snap.lastRebuildAt).toBe(0);
  });

  it("recordRebuild attributes per-epoch causes and records the duration", () => {
    const tel = new ColdStateTelemetry();
    tel.recordRebuild(1000, ["content", "view"], 7.5);
    tel.recordRebuild(1100, ["selection"], 2.5);
    const snap = tel.publish();
    expect(snap.rebuilds).toBe(2);
    expect(snap.cacheHits).toBe(0);
    expect(snap.rebuildsLastSecond).toBe(2);
    expect(snap.causeLastSecond).toEqual({
      content: 1,
      layout: 0,
      view: 1,
      selection: 1,
      asset: 0,
    });
    expect(snap.lastRebuildMs).toBe(2.5);
    expect(snap.lastRebuildAt).toBe(1100);
  });

  it("prunes events older than COLD_STATE_WINDOW_MS from window counts (cumulative survives)", () => {
    const tel = new ColdStateTelemetry();
    tel.recordHit(0);
    tel.recordRebuild(100, ["content"], 1.0);
    // Push events to the right and force the prune (window cutoff =
    // now - COLD_STATE_WINDOW_MS strictly above the t=0 / t=100 events).
    tel.recordRebuild(COLD_STATE_WINDOW_MS + 200, ["view"], 1.5);
    const snap = tel.publish();
    // Cumulative survives the prune.
    expect(snap.cacheHits).toBe(1);
    expect(snap.rebuilds).toBe(2);
    // Only the most-recent rebuild is in the window.
    expect(snap.rebuildsLastSecond).toBe(1);
    expect(snap.hitsLastSecond).toBe(0);
    expect(snap.causeLastSecond).toEqual({
      content: 0,
      layout: 0,
      view: 1,
      selection: 0,
      asset: 0,
    });
  });

  it("derives p50 / p95 from the rebuild duration sample buffer (bounded by COLD_STATE_DURATION_SAMPLES)", () => {
    const tel = new ColdStateTelemetry();
    // Record more than the buffer can hold to verify the FIFO bound.
    const n = COLD_STATE_DURATION_SAMPLES + 5;
    for (let i = 0; i < n; i++) {
      // Use ascending durations so the oldest (smallest) get dropped.
      tel.recordRebuild(i, ["content"], (i + 1) * 10);
    }
    const snap = tel.publish();
    // After pruning, only the last DURATION_SAMPLES survive (durations
    // 60..640 in steps of 10 — i.e. (5+1)*10 .. (n)*10).
    // sorted = [60, 70, ..., 640]
    // p50 → floor(60 * 0.5) = 30 → 60 + 30*10 = 360.
    // p95 → floor(60 * 0.95) = 57 → 60 + 57*10 = 630.
    expect(snap.rebuildP50Ms).toBe(360);
    expect(snap.rebuildP95Ms).toBe(630);
  });

  it("hitRate is hits / (hits + rebuilds) over the rolling window", () => {
    const tel = new ColdStateTelemetry();
    tel.recordHit(1000);
    tel.recordHit(1100);
    tel.recordHit(1200);
    tel.recordRebuild(1300, ["view"], 5);
    const snap = tel.publish();
    expect(snap.hitRate).toBeCloseTo(3 / 4);
  });
});

// ---------------------------------------------------------------------------
// Churn detector (sustained-non-view rebuild rate)
//
// Threshold is COLD_STATE_CHURN_THRESHOLD_PER_SEC=30 non-view rebuilds
// within COLD_STATE_WINDOW_MS=1000ms, sustained for
// COLD_STATE_CHURN_SUSTAIN_MS=2000ms. The unit test forces all those
// conditions and asserts the dominant cause is reported correctly.
// ---------------------------------------------------------------------------

describe("ColdStateTelemetry — churn detector", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let priorLocalStorage: unknown;

  beforeEach(async () => {
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

  it("fires cold_state.churn when non-view rebuilds stay above threshold for sustainMs", () => {
    const tel = new ColdStateTelemetry();
    const causes: ColdStateCauseKey[] = ["selection"];
    // Keep the rate continuously above threshold across sustainMs.
    // We need >30 non-view rebuilds in the *current* 1s window at each
    // tick of the detector, otherwise a prune drops the condition to
    // false and resets the sustain window.
    //
    // Strategy: emit (THRESHOLD + 1) rebuilds per "burst", with bursts
    // every ~500ms spanning > COLD_STATE_CHURN_SUSTAIN_MS. The window
    // sees both the most recent burst and the prior one, keeping the
    // count above threshold.
    const t0 = 10_000;
    // The detector only arms once the window count crosses the
    // threshold (which takes (THRESHOLD+1) * 10ms = 310ms at our
    // emit rate). Add that to the sustainMs budget plus a buffer for
    // the rate-limit check (lastLogAt=0 at startup, so we need
    // now >= rateLimitMs).
    const tEnd = t0 + COLD_STATE_CHURN_SUSTAIN_MS + 500;
    // Emit one rebuild every 10ms across the whole sustain interval.
    // The rate of 100/sec sits comfortably above the
    // COLD_STATE_CHURN_THRESHOLD_PER_SEC=30 threshold.
    for (let t = t0; t <= tEnd; t += 10) {
      tel.recordRebuild(t, causes, 1);
    }
    const churnLogs = (consoleLogSpy.mock.calls as Array<[unknown, unknown]>).filter(
      ([msg]) => typeof msg === "string" && (msg as string).includes("cold_state.churn"),
    );
    expect(churnLogs.length).toBeGreaterThanOrEqual(1);
    expect(churnLogs[0][1]).toMatchObject({ dominantCause: "selection" });
  });
});
