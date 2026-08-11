import { describe, it, expect } from "vitest";

import { evaluateQuiescence, type QuiescenceInputs } from "./quiescence.ts";

function settled(overrides: Partial<QuiescenceInputs> = {}): QuiescenceInputs {
  return {
    interactiveDirty: false,
    residencyDirty: false,
    frameInFlight: false,
    desiredDetailChunks: 12,
    residentDetailChunks: 12,
    desiredCoarseChunks: 3,
    residentCoarseChunks: 3,
    pending: 0,
    inFlight: 0,
    speculativePending: 0,
    speculativeInFlight: 0,
    pendingUnclassified: false,
    ...overrides,
  };
}

describe("evaluateQuiescence", () => {
  it("is quiescent when nothing is dirty, nothing is drawing, and demand is met", () => {
    const state = evaluateQuiescence(settled(), 100);
    expect(state.quiescent).toBe(true);
    expect(state.reason).toBe("quiescent");
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
    const state = evaluateQuiescence(settled(overrides), 0);
    expect(state.quiescent).toBe(false);
    expect(state.reason).toBe(reason);
  });

  it("ignores speculative prefetch, and still reports it", () => {
    const state = evaluateQuiescence(settled({ speculativePending: 40, speculativeInFlight: 4 }), 0);
    expect(state.quiescent).toBe(true);
    expect(state.speculativePending).toBe(40);
    expect(state.speculativeInFlight).toBe(4);
  });

  it("refuses to call a queue it could not classify settled", () => {
    const state = evaluateQuiescence(settled({ pendingUnclassified: true }), 0);
    expect(state.quiescent).toBe(false);
    expect(state.reason).toBe("pending_unclassified");
  });
});
