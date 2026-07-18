import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_STARVATION_TIMEOUT_MS,
  FrameStarvationWatchdog,
} from "./frameStarvationWatchdog.ts";

describe("FrameStarvationWatchdog", () => {
  let now = 0;
  let visible = true;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    visible = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    now += ms;
    vi.advanceTimersByTime(ms);
  }

  function makeWatchdog(onStarved = vi.fn()) {
    return {
      onStarved,
      watchdog: new FrameStarvationWatchdog({
        onStarved,
        now: () => now,
        isVisible: () => visible,
      }),
    };
  }

  it("fires once when the oldest submitted frame misses its deadline", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.submitted(7);

    advance(FRAME_STARVATION_TIMEOUT_MS - 1);
    expect(onStarved).not.toHaveBeenCalled();
    advance(1);

    expect(onStarved).toHaveBeenCalledOnce();
    expect(onStarved).toHaveBeenCalledWith({
      oldestFrameId: 7,
      pendingFrameCount: 1,
      ageMs: FRAME_STARVATION_TIMEOUT_MS,
    });
    advance(FRAME_STARVATION_TIMEOUT_MS);
    expect(onStarved).toHaveBeenCalledOnce();
  });

  it("starts the deadline before RAF submission and preserves it at submission", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.expected(1);
    advance(6_000);
    watchdog.submitted(1);
    advance(4_000);

    expect(onStarved).toHaveBeenCalledWith({
      oldestFrameId: 1,
      pendingFrameCount: 1,
      ageMs: FRAME_STARVATION_TIMEOUT_MS,
    });
  });

  it("worker-confirmed presentation retires the obligation", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.submitted(1);
    advance(FRAME_STARVATION_TIMEOUT_MS / 2);
    watchdog.presented(1);
    advance(FRAME_STARVATION_TIMEOUT_MS * 2);

    expect(onStarved).not.toHaveBeenCalled();
  });

  it("newer submissions cannot postpone an older stuck frame", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.submitted(1);
    advance(6_000);
    watchdog.submitted(2);
    advance(4_000);

    expect(onStarved).toHaveBeenCalledWith({
      oldestFrameId: 1,
      pendingFrameCount: 2,
      ageMs: FRAME_STARVATION_TIMEOUT_MS,
    });
  });

  it("keeps a newer frame pending after an earlier acknowledgement", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.submitted(1);
    advance(1_000);
    watchdog.submitted(2);
    watchdog.presented(1);

    advance(FRAME_STARVATION_TIMEOUT_MS - 1);
    expect(onStarved).not.toHaveBeenCalled();
    advance(1);
    expect(onStarved).toHaveBeenCalledWith({
      oldestFrameId: 2,
      pendingFrameCount: 1,
      ageMs: FRAME_STARVATION_TIMEOUT_MS,
    });
  });

  it("cancels only pre-submission work", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.expected(1);
    watchdog.expected(2);
    watchdog.submitted(2);
    watchdog.cancelUnsubmitted();

    advance(FRAME_STARVATION_TIMEOUT_MS);
    expect(onStarved).toHaveBeenCalledWith({
      oldestFrameId: 2,
      pendingFrameCount: 1,
      ageMs: FRAME_STARVATION_TIMEOUT_MS,
    });
  });

  it("excludes background time and gives pending work a fresh visible budget", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.submitted(1);
    advance(5_000);

    visible = false;
    watchdog.visibilityChanged();
    advance(60_000);
    expect(onStarved).not.toHaveBeenCalled();

    visible = true;
    watchdog.visibilityChanged();
    advance(FRAME_STARVATION_TIMEOUT_MS - 1);
    expect(onStarved).not.toHaveBeenCalled();
    advance(1);
    expect(onStarved).toHaveBeenCalledOnce();
  });

  it("stop cancels the timer and forgets pending work", () => {
    const { watchdog, onStarved } = makeWatchdog();
    watchdog.submitted(1);
    watchdog.stop();
    advance(FRAME_STARVATION_TIMEOUT_MS * 2);
    expect(onStarved).not.toHaveBeenCalled();
  });
});
