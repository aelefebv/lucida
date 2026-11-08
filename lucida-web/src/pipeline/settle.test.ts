import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SettleSignal,
  createSettleState,
  evaluateSettle,
  stallReasonOf,
  type SettleOutcome,
  type SettleState,
} from "./settle.ts";

function settled(overrides: Partial<SettleState> = {}): SettleState {
  return Object.assign(createSettleState(), {
    desiredDetailChunks: 12,
    residentDetailChunks: 12,
    desiredCoarseChunks: 3,
    residentCoarseChunks: 3,
  }, overrides);
}

describe("evaluateSettle", () => {
  it("is quiescent when nothing is dirty, nothing is drawing, and demand is met", () => {
    const state = evaluateSettle(settled(), 100);
    expect(state.quiescent).toBe(true);
    expect(state.reason).toBe("quiescent");
    expect(state.coverage).toBe(1);
    expect(state.at).toBe(100);
  });

  it.each([
    ["interactiveDirty", { interactiveDirty: true }, "interactive_dirty"],
    ["residencyDirty", { residencyDirty: true }, "residency_dirty"],
    ["frameInFlight", { frameInFlight: true }, "frame_in_flight"],
    ["chunks in flight", { inFlight: 1 }, "chunks_in_flight"],
    ["chunks pending", { pending: 1 }, "chunks_pending"],
    ["detail short of demand", { residentDetailChunks: 11 }, "detail_not_resident"],
    ["coarse short of demand", { residentCoarseChunks: 2 }, "coarse_not_resident"],
  ])("is not quiescent on %s", (_label, overrides, reason) => {
    const state = evaluateSettle(settled(overrides), 0);
    expect(state.quiescent).toBe(false);
    expect(state.reason).toBe(reason);
  });

  it("ignores speculative prefetch, and still reports it", () => {
    const state = evaluateSettle(settled({ speculativePending: 40, speculativeInFlight: 4 }), 0);
    expect(state.quiescent).toBe(true);
    expect(state.speculativePending).toBe(40);
    expect(state.speculativeInFlight).toBe(4);
  });

  it("refuses to call a queue it could not classify settled", () => {
    const state = evaluateSettle(settled({ pendingUnclassified: true }), 0);
    expect(state.quiescent).toBe(false);
    expect(state.reason).toBe("pending_unclassified");
  });

  it("settles covering less when every missing chunk is one its tier has no room for", () => {
    const state = evaluateSettle(
      settled({ desiredCoarseChunks: 36, residentCoarseChunks: 20, shortCoarseChunks: 16 }),
      0,
    );
    expect(state.quiescent).toBe(true);
    expect(state.reason).toBe("coverage_limited");
    expect(state.coverage).toBeCloseTo(32 / 48);
  });

  it("does not call a shortfall coverage-limited while some of it is waiting on the source", () => {
    const state = evaluateSettle(
      settled({
        desiredCoarseChunks: 36,
        residentCoarseChunks: 20,
        shortCoarseChunks: 12,
        serverPendingChunks: 4,
      }),
      0,
    );
    expect(state.quiescent).toBe(false);
    expect(state.reason).toBe("coarse_not_resident");
    expect(stallReasonOf(state)).toBe("server_pending");
  });

  it.each([
    [{ retryingChunks: 1 }, "source_retrying"],
    [{ failedChunks: 1 }, "chunk_failed"],
    [{ unrequestedChunks: 1 }, "not_requested"],
    [{}, "detail_not_resident"],
  ])("names what a waiting view waits on: %o", (overrides, reason) => {
    const state = evaluateSettle(settled({ residentDetailChunks: 11, ...overrides }), 0);
    expect(stallReasonOf(state)).toBe(reason);
  });
});

describe("SettleSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function signal(): { settle: SettleSignal; seen: SettleOutcome[] } {
    const settle = new SettleSignal({ holdMs: 500, stallMs: 10_000 });
    const seen: SettleOutcome[] = [];
    settle.subscribe((outcome) => seen.push(outcome));
    return { settle, seen };
  }

  function publish(settle: SettleSignal, overrides: Partial<SettleState> = {}): void {
    settle.publish(evaluateSettle(settled(overrides), Date.now()));
  }

  it("settles once the predicate has held for the hold window", () => {
    const { settle, seen } = signal();
    publish(settle);
    vi.advanceTimersByTime(499);
    expect(settle.outcome).toBe("settling");
    vi.advanceTimersByTime(1);
    expect(settle.outcome).toBe("settled");
    expect(seen).toEqual(["settled"]);
  });

  it("restarts the hold when the predicate lapses inside it", () => {
    const { settle } = signal();
    publish(settle);
    vi.advanceTimersByTime(400);
    publish(settle, { inFlight: 2 });
    vi.advanceTimersByTime(400);
    publish(settle);
    vi.advanceTimersByTime(400);
    expect(settle.outcome).toBe("settling");
    vi.advanceTimersByTime(100);
    expect(settle.outcome).toBe("settled");
  });

  it("settles a view that covers less than it wants", () => {
    const { settle } = signal();
    publish(settle, { desiredCoarseChunks: 36, residentCoarseChunks: 20, shortCoarseChunks: 16 });
    vi.advanceTimersByTime(500);
    expect(settle.outcome).toBe("settled");
    expect(settle.state?.coverage).toBeLessThan(1);
  });

  it("stops counting as settled the moment something disturbs it", () => {
    const { settle, seen } = signal();
    publish(settle);
    vi.advanceTimersByTime(500);
    settle.disturb();
    expect(settle.outcome).toBe("settling");
    expect(seen).toEqual(["settled", "settling"]);
  });

  it("stalls a view that waits with nothing on the way and nothing arriving, and says why", () => {
    const { settle, seen } = signal();
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(9_999);
    expect(settle.outcome).toBe("settling");
    vi.advanceTimersByTime(1);
    expect(settle.outcome).toBe("stalled");
    expect(settle.stallReason).toBe("server_pending");
    expect(seen).toEqual(["stalled"]);
  });

  it("keeps the stall clock running across a retry that brings nothing back", () => {
    const { settle } = signal();
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(8_000);
    publish(settle, { residentCoarseChunks: 2, inFlight: 1 });
    vi.advanceTimersByTime(100);
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(1_900);
    expect(settle.outcome).toBe("stalled");
  });

  it("starts the stall clock over when a wanted chunk arrives", () => {
    const { settle } = signal();
    publish(settle, { residentCoarseChunks: 1, serverPendingChunks: 2 });
    vi.advanceTimersByTime(8_000);
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(9_999);
    expect(settle.outcome).toBe("settling");
    vi.advanceTimersByTime(1);
    expect(settle.outcome).toBe("stalled");
  });

  it("leaves a stall once the view makes progress again", () => {
    const { settle, seen } = signal();
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(10_000);
    publish(settle);
    expect(settle.outcome).toBe("settling");
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(["stalled", "settling", "settled"]);
    expect(settle.stallReason).toBeNull();
  });

  it("does not stall a view with work in flight", () => {
    const { settle } = signal();
    publish(settle, { residentCoarseChunks: 2, inFlight: 1 });
    vi.advanceTimersByTime(60_000);
    expect(settle.outcome).toBe("settling");
  });

  it("starts the stall clock over when the view itself changes", () => {
    const { settle } = signal();
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(10_000);
    settle.restart();
    expect(settle.outcome).toBe("settling");
    publish(settle, { residentCoarseChunks: 2, serverPendingChunks: 1 });
    vi.advanceTimersByTime(9_999);
    expect(settle.outcome).toBe("settling");
    vi.advanceTimersByTime(1);
    expect(settle.outcome).toBe("stalled");
  });
});
