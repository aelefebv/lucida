import { describe, expect, it } from "vitest";
import {
  AdaptiveResolution,
  cappedPixelRatioScale,
  GESTURE_START_STEP_UP,
  LONG_FRAME_MS,
  MIN_ADAPTIVE_SCALE,
  RESTORE_AFTER_MS,
  TARGET_FRAME_MS,
} from "./renderResolution.ts";

describe("cappedPixelRatioScale", () => {
  it("leaves ratios up to 2 at full resolution", () => {
    expect(cappedPixelRatioScale(1)).toBe(1);
    expect(cappedPixelRatioScale(1.5)).toBe(1);
    expect(cappedPixelRatioScale(2)).toBe(1);
  });

  it("holds a 3x phone to twice its CSS size", () => {
    expect(390 * 3 * cappedPixelRatioScale(3)).toBeCloseTo(780, 6);
    expect(844 * 3 * cappedPixelRatioScale(3)).toBeCloseTo(1688, 6);
  });
});

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("AdaptiveResolution", () => {
  it("ignores long frames outside a gesture", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    expect(res.noteFrame(1, LONG_FRAME_MS * 3, 1)).toBe(false);
    expect(res.scale).toBe(1);
    expect(res.msUntilRestore()).toBeNull();
  });

  it("keeps full resolution while a gesture's frames are quick", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    for (let seq = 1; seq <= 30; seq++) {
      res.noteInput(seq - 1);
      c.advance(16);
      expect(res.noteFrame(seq, 12, seq)).toBe(false);
    }
    expect(res.scale).toBe(1);
  });

  it("steps down as far as brings such a frame to the target, once per frame drawn at the new resolution", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput(0);
    // Twice the target: half the pixels, so the scale falls by a square root of 2.
    expect(res.noteFrame(1, TARGET_FRAME_MS * 2, 3)).toBe(true);
    expect(res.scale).toBeCloseTo(Math.SQRT1_2, 6);
    // Frames 2 and 3 left before the step; their latency says nothing new.
    expect(res.noteFrame(2, 50, 4)).toBe(false);
    expect(res.noteFrame(3, 50, 4)).toBe(false);
    expect(res.noteFrame(4, TARGET_FRAME_MS * 2, 6)).toBe(true);
    expect(res.scale).toBeCloseTo(0.5, 6);
  });

  it("never steps below the floor, however long the frame", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput(0);
    expect(res.noteFrame(1, 400, 1)).toBe(true);
    expect(res.scale).toBe(MIN_ADAPTIVE_SCALE);
    expect(res.noteFrame(2, 400, 2)).toBe(false);
  });

  it("leaves a frame no longer than a display frame and the trip alone", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput(0);
    expect(res.noteFrame(1, LONG_FRAME_MS, 1)).toBe(false);
    expect(res.scale).toBe(1);
  });

  it("leaves out the frames dispatched before a gesture began", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    // Frame 3, the last a load drew, is read at the gesture's first tick.
    res.noteInput(3);
    expect(res.noteFrame(3, 50, 4)).toBe(false);
    expect(res.scale).toBe(1);
    expect(res.noteFrame(4, TARGET_FRAME_MS * 2, 4)).toBe(true);
    expect(res.scale).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("judges frames dispatched between a gesture's inputs as its own", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput(0);
    c.advance(16);
    res.noteInput(2);
    expect(res.noteFrame(2, 50, 3)).toBe(true);
  });

  it("restores full resolution once input stops", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput(0);
    res.noteFrame(1, 80, 1);
    expect(res.scale).toBeLessThan(1);
    c.advance(100);
    expect(res.msUntilRestore()).toBe(RESTORE_AFTER_MS - 100);
    expect(res.restoreIfIdle()).toBe(false);
    c.advance(RESTORE_AFTER_MS);
    expect(res.restoreIfIdle()).toBe(true);
    expect(res.scale).toBe(1);
    expect(res.msUntilRestore()).toBeNull();
  });

  it("starts a gesture a step above where the one before it ended, and works back to full", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput(0);
    res.noteFrame(1, 400, 1);
    expect(res.scale).toBe(MIN_ADAPTIVE_SCALE);
    c.advance(RESTORE_AFTER_MS);
    expect(res.restoreIfIdle()).toBe(true);
    expect(res.scale).toBe(1);

    // The next gesture's first frame is drawn below full, so a GPU that
    // idled since is not handed the heaviest frame there is.
    let expected = MIN_ADAPTIVE_SCALE;
    for (let gesture = 0; expected < 1; gesture++) {
      expected = Math.min(1, expected * GESTURE_START_STEP_UP);
      res.noteInput(10 * gesture + 2);
      expect(res.scale).toBeCloseTo(expected, 6);
      // Its frames keep up, so it ends where it started.
      res.noteFrame(10 * gesture + 3, TARGET_FRAME_MS, 10 * gesture + 3);
      c.advance(RESTORE_AFTER_MS);
      res.restoreIfIdle();
      expect(res.scale).toBe(1);
    }
    res.noteInput(1000);
    expect(res.scale).toBe(1);
    expect(res.msUntilRestore()).toBeNull();
  });
});
