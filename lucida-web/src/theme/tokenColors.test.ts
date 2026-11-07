// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ count: 0, value: 0 }));
vi.mock("./tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tokens.ts")>();
  return {
    ...actual,
    // happy-dom resolves no custom property, so each read answers a fresh gray.
    readColorToken: () => {
      reads.count += 1;
      const v = reads.value;
      return { r: v, g: v, b: v, a: 1, css: `rgba(${v * 255}, ${v * 255}, ${v * 255}, 1)` };
    },
  };
});

import { canvasBackgroundPreference, installAppearance, subscribeAppearance } from "./appearance.ts";
import { __resetPreferencesForTesting, setPreference } from "./preferences.ts";
import { mixColor, paint, rgbColor, tokenColor, tokenColors } from "./tokenColors.ts";

describe("tokenColor", () => {
  let uninstall: () => void;
  beforeEach(() => {
    localStorage.clear();
    __resetPreferencesForTesting();
    uninstall = installAppearance();
    reads.count = 0;
  });
  afterEach(() => uninstall());

  it("reads a token once until the appearance changes", () => {
    reads.value = 0;
    const first = tokenColor("--lc-canvas-bg");
    expect(tokenColor("--lc-canvas-bg")).toBe(first);
    expect(reads.count).toBe(1);

    reads.value = 1;
    setPreference(canvasBackgroundPreference, "white");
    expect(tokenColor("--lc-canvas-bg").r).toBe(1);
    expect(reads.count).toBe(2);
  });

  it("gives an appearance subscriber the new value", () => {
    reads.value = 0;
    tokenColor("--lc-canvas-stroke");
    let seen: number | null = null;
    const unsubscribe = subscribeAppearance(() => {
      seen = tokenColor("--lc-canvas-stroke").r;
    });
    reads.value = 1;
    setPreference(canvasBackgroundPreference, "dark-gray");
    unsubscribe();
    expect(seen).toBe(1);
  });

  it("resolves a table of roles", () => {
    reads.value = 0.2;
    const colors = tokenColors({ line: "--lc-canvas-stroke", text: "--lc-canvas-label" });
    expect(Object.keys(colors)).toEqual(["line", "text"]);
    expect(colors.line.r).toBe(0.2);
  });
});

describe("paint and mix", () => {
  it("scales the token's own alpha", () => {
    expect(paint(rgbColor(255, 255, 255, 0.8), 0.5)).toBe("rgba(255, 255, 255, 0.4)");
    expect(paint(rgbColor(10, 20, 30))).toBe("rgba(10, 20, 30, 1)");
  });

  it("mixes in sRGB", () => {
    expect(mixColor(rgbColor(0, 0, 0), rgbColor(255, 100, 50), 0.5).css).toBe("rgba(128, 50, 25, 1)");
  });
});
