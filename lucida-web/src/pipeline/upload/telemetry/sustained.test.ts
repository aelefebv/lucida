import { describe, it, expect } from "vitest";
import { SustainedCondition, ConsecutiveTickDetector } from "./sustained.ts";

// ---------------------------------------------------------------------------
// SustainedCondition
//
// The semantics mirror the existing detector logic in `orchestrator.ts`:
//   - First true tick arms the sustain window (no log).
//   - Subsequent trues only fire once both `sustainMs` has elapsed since
//     arming AND `rateLimitMs` has elapsed since the previous log
//     (`lastLogAt` starts at 0, so the very first log requires
//     `now >= rateLimitMs`).
//   - Any false tick resets `aboveThresholdSince` to null; sustain restarts.
// ---------------------------------------------------------------------------

describe("SustainedCondition", () => {
  const makeDetector = () => {
    const calls: object[] = [];
    const detector = new SustainedCondition({
      sustainMs: 1000,
      rateLimitMs: 2000,
      log: (payload) => calls.push(payload),
    });
    return { detector, calls };
  };

  it("does not log when the condition is true for less than sustainMs", () => {
    const { detector, calls } = makeDetector();
    // Start "now" past the rate-limit so it can't be the gate.
    detector.tick(10_000, true, () => ({ tag: "arm" }));
    detector.tick(10_500, true, () => ({ tag: "second" }));
    detector.tick(10_900, true, () => ({ tag: "third" }));
    expect(calls).toHaveLength(0);
  });

  it("logs once after the condition stays true for at least sustainMs", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ tag: "arm" }));
    detector.tick(11_200, true, () => ({ tag: "sustained" }));
    expect(calls).toEqual([{ tag: "sustained" }]);
  });

  it("rate-limits repeat logs to one per rateLimitMs while condition stays true", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ tag: "arm" }));
    // Sustained at +1200ms — fires (rate-limit elapsed since startup).
    detector.tick(11_200, true, () => ({ tag: "first" }));
    // Still sustained, still inside the 2s rate-limit window — no fire.
    detector.tick(12_500, true, () => ({ tag: "second" }));
    // Past the rate-limit (2000ms since lastLogAt=11200) → fires again.
    detector.tick(13_300, true, () => ({ tag: "third" }));
    expect(calls).toEqual([{ tag: "first" }, { tag: "third" }]);
  });

  it("resets the sustain window when the condition turns false", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ tag: "arm" }));
    detector.tick(10_800, true, () => ({ tag: "still-under" }));
    detector.tick(10_900, false, () => ({ tag: "reset" }));
    // Re-arm; the prior 900ms of sustain shouldn't count.
    detector.tick(11_100, true, () => ({ tag: "re-arm" }));
    detector.tick(11_800, true, () => ({ tag: "still-under-re-arm" }));
    expect(calls).toHaveLength(0);
    // Only once we've sustained for sustainMs *since the re-arm* should
    // it fire.
    detector.tick(12_200, true, () => ({ tag: "fires" }));
    expect(calls).toEqual([{ tag: "fires" }]);
  });
});

// ---------------------------------------------------------------------------
// ConsecutiveTickDetector
//
// Counter-based variant: each true tick increments a consecutive counter
// and fires when (counter >= threshold AND now - lastLogAt >= rateLimitMs).
// Any false tick resets the counter (but not `lastLogAt`).
// ---------------------------------------------------------------------------

describe("ConsecutiveTickDetector", () => {
  const makeDetector = () => {
    const calls: object[] = [];
    const detector = new ConsecutiveTickDetector({
      threshold: 3,
      rateLimitMs: 2000,
      log: (payload) => calls.push(payload),
    });
    return { detector, calls };
  };

  it("does not log when the condition is true for fewer than `threshold` ticks", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ ticks: 1 }));
    detector.tick(10_100, true, () => ({ ticks: 2 }));
    expect(calls).toHaveLength(0);
  });

  it("logs once the counter reaches `threshold` consecutive trues", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ ticks: 1 }));
    detector.tick(10_100, true, () => ({ ticks: 2 }));
    detector.tick(10_200, true, () => ({ ticks: 3 }));
    expect(calls).toEqual([{ ticks: 3 }]);
  });

  it("rate-limits repeat logs while the counter stays above threshold", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ ticks: 1 }));
    detector.tick(10_100, true, () => ({ ticks: 2 }));
    detector.tick(10_200, true, () => ({ ticks: 3 })); // first log
    // Still above threshold; inside rate-limit window — no fire.
    detector.tick(11_500, true, () => ({ ticks: 4 }));
    detector.tick(12_100, true, () => ({ ticks: 5 }));
    // Past the rate-limit (lastLogAt=10200; 12300-10200=2100 >= 2000).
    detector.tick(12_300, true, () => ({ ticks: 6 }));
    expect(calls).toEqual([{ ticks: 3 }, { ticks: 6 }]);
  });

  it("resets the counter when the condition turns false", () => {
    const { detector, calls } = makeDetector();
    detector.tick(10_000, true, () => ({ ticks: 1 }));
    detector.tick(10_100, true, () => ({ ticks: 2 }));
    detector.tick(10_200, false, () => ({ ticks: 0 }));
    expect(detector.getConsecutiveCount()).toBe(0);
    detector.tick(10_300, true, () => ({ ticks: 1 }));
    detector.tick(10_400, true, () => ({ ticks: 2 }));
    expect(calls).toHaveLength(0);
    detector.tick(10_500, true, () => ({ ticks: 3 }));
    expect(calls).toEqual([{ ticks: 3 }]);
  });
});
