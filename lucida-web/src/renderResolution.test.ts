import { describe, expect, it } from "vitest";
import {
  AdaptiveResolution,
  cappedPixelRatioScale,
  LONG_FRAME_MS,
  MIN_ADAPTIVE_SCALE,
  RESTORE_AFTER_MS,
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
      res.noteInput();
      c.advance(16);
      expect(res.noteFrame(seq, 12, seq)).toBe(false);
    }
    expect(res.scale).toBe(1);
  });

  it("steps down once per frame drawn at the new resolution, to a floor", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput();
    expect(res.noteFrame(1, 50, 3)).toBe(true);
    expect(res.scale).toBeCloseTo(0.8, 6);
    // Frames 2 and 3 left before the step; their latency says nothing new.
    expect(res.noteFrame(2, 50, 4)).toBe(false);
    expect(res.noteFrame(3, 50, 4)).toBe(false);
    expect(res.noteFrame(4, 50, 6)).toBe(true);
    expect(res.scale).toBeCloseTo(0.64, 6);
    for (let seq = 7; seq < 40; seq += 2) {
      res.noteInput();
      res.noteFrame(seq, 50, seq);
    }
    expect(res.scale).toBe(MIN_ADAPTIVE_SCALE);
  });

  it("restores full resolution once input stops", () => {
    const c = clock();
    const res = new AdaptiveResolution(c.now);
    res.noteInput();
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
});
