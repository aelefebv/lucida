import { describe, expect, it } from "vitest";

import {
  applyContrastWindowToSamples,
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
    expect(normalizeContrastWindow({ min: -1, max: 70000 }, 65535)).toEqual({
      min: 0,
      max: 65535,
    });
  });

  it("applies contrast limits to sample buffers", () => {
    const input = new Uint16Array([0, 50, 200]);
    const output = applyContrastWindowToSamples(input, { min: 50, max: 200 }, 255);

    expect(Array.from(output)).toEqual([
      0, 0, 0, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
  });

  it("falls back to full range for degenerate auto windows", () => {
    expect(autoContrastWindow(220, 220)).toEqual({ min: 0, max: 255 });
    expect(autoContrastWindow(0, 0)).toEqual({ min: 0, max: 255 });
    expect(autoContrastWindow(1000, 1000, 65535)).toEqual({
      min: 0,
      max: 65535,
    });
  });
});
