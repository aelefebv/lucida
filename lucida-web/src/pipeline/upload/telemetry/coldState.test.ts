import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ColdStateTelemetry, type ColdStateCauseKey } from "./coldState.ts";
import { COLD_STATE_CHURN_SUSTAIN_MS } from "../constants.ts";

// ---------------------------------------------------------------------------
// recordHit / recordRebuild basics
// ---------------------------------------------------------------------------


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
