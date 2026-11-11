import { describe, expect, it } from "vitest";
import { WHEEL_ZOOM_PER_PIXEL, wheelPixels, wheelZoom } from "./wheel.ts";

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;
const PAGE_PX = 900;

const wheel = (deltaY: number, deltaMode = PIXEL, ctrlKey = false) => ({ deltaY, deltaMode, ctrlKey });
const zoom = (deltaY: number, deltaMode = PIXEL, ctrlKey = false) => wheelZoom(wheel(deltaY, deltaMode, ctrlKey), PAGE_PX);
const compound = (factors: number[]) => factors.reduce((a, b) => a * b, 1);

/** Chrome's events for a trackpad scroll of 100 px up, from `Input.synthesizeScrollGesture`. */
const TRACKPAD_SCROLL = [-5, -7, -6, -12, -13, -12, -13, -12, -13, -7];

/** Chrome's events for a trackpad pinch spreading the fingers by 2, from
 * `Input.synthesizePinchGesture`: `ctrlKey` wheel events summing to −100·ln 2. */
const TRACKPAD_PINCH = [
  -1.459, -1.635, -1.413, -3.063, -2.732, -2.84, -2.624, -2.649, -1.328, -3.751, -2.495, -2.309, -2.331, -2.28, -2.232,
  -2.179, -2.113, -2.077, -2.061, -2.035, -1.944, -1.924, -1.892, -0.944, -7.196, -0.786, -1.724, -1.749, -1.56, -1.579,
  -1.6, -0.809,
];

describe("a wheel event as a zoom", () => {
  it("zooms a mouse notch in by 1.1, and out by as much", () => {
    expect(zoom(-100)).toBeCloseTo(1.1, 12);
    expect(zoom(100)).toBeCloseTo(1 / 1.1, 12);
    expect(zoom(-100) * zoom(100)).toBeCloseTo(1, 12);
  });

  it("reads a line-mode notch, Firefox's three lines, as 16 px a line", () => {
    expect(wheelPixels(wheel(3, LINE), PAGE_PX)).toBe(48);
    expect(zoom(-3, LINE)).toBeCloseTo(Math.exp(48 * WHEEL_ZOOM_PER_PIXEL), 12);
    expect(zoom(-3, LINE)).toBeCloseTo(1.1 ** 0.48, 12);
  });

  it("reads a page-mode event as a page's height", () => {
    expect(wheelPixels(wheel(1, PAGE), PAGE_PX)).toBe(PAGE_PX);
    expect(zoom(-1, PAGE)).toBeCloseTo(1.1 ** 9, 9);
  });

  it("zooms a trackpad's small deltas as far as one notch of the same total", () => {
    expect(TRACKPAD_SCROLL.reduce((a, b) => a + b)).toBe(-100);
    expect(compound(TRACKPAD_SCROLL.map((d) => zoom(d)))).toBeCloseTo(zoom(-100), 12);
    // Split finer or coarser, the same travel zooms the same.
    expect(compound(Array.from({ length: 50 }, () => zoom(-2)))).toBeCloseTo(1.1, 12);
  });

  it("zooms a pinch by the scale the fingers made", () => {
    expect(compound(TRACKPAD_PINCH.map((d) => zoom(d, PIXEL, true)))).toBeCloseTo(2, 3);
    expect(compound(TRACKPAD_PINCH.map((d) => zoom(-d, PIXEL, true)))).toBeCloseTo(0.5, 3);
  });

  it("zooms a pinch event a notch at most, so ctrl with a mouse wheel zooms as the wheel does", () => {
    expect(zoom(-100, PIXEL, true)).toBeCloseTo(1.1, 12);
    expect(zoom(100, PIXEL, true)).toBeCloseTo(1 / 1.1, 12);
    expect(zoom(-3, LINE, true)).toBeCloseTo(1.1, 12);
  });

  it("zooms nothing for an event with no vertical delta", () => {
    expect(zoom(0)).toBe(1);
    expect(zoom(0, LINE)).toBe(1);
    expect(zoom(0, PIXEL, true)).toBe(1);
  });
});
