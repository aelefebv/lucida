import { describe, expect, it } from "vitest";

import {
  applyContrastWindowToRgba,
  autoContrastWindow,
  normalizeContrastWindow,
} from "../src/contrast-window";

describe("contrast-window", () => {
  it("normalizes inverted or out-of-range windows", () => {
    expect(normalizeContrastWindow({ min: -20, max: 270 })).toEqual({
      min: 0,
      max: 255,
    });
    expect(normalizeContrastWindow({ min: 120, max: 120 })).toEqual({
      min: 120,
      max: 121,
    });
    expect(normalizeContrastWindow({ min: 255, max: 0 })).toEqual({
      min: 254,
      max: 255,
    });
  });

  it("applies contrast limits to RGBA while preserving alpha", () => {
    const input = new Uint8ClampedArray([
      0, 20, 40, 10,
      50, 100, 150, 20,
      200, 220, 240, 30,
    ]);
    const output = applyContrastWindowToRgba(input, { min: 50, max: 200 });

    expect(Array.from(output)).toEqual([
      0, 0, 0, 10,
      0, 85, 170, 20,
      255, 255, 255, 30,
    ]);
  });

  it("falls back to full range for degenerate auto windows", () => {
    expect(autoContrastWindow(220, 220)).toEqual({ min: 0, max: 255 });
    expect(autoContrastWindow(0, 0)).toEqual({ min: 0, max: 255 });
  });
});
