import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_TOKEN_NAMES, THEMED_TOKEN_NAMES, TOKEN_NAMES } from "./tokens.ts";

const css = readFileSync(resolve(process.cwd(), "src/theme/tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Innermost `selector { declarations }` blocks, as selector → name → value. */
function blocks(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const [, name, value] of body.matchAll(/(--lc-[\w-]+)\s*:\s*([^;]+);/g)) decls.set(name, value.trim());
    for (const part of selector.split(",")) {
      const key = part.trim();
      out.set(key, new Map([...(out.get(key) ?? []), ...decls]));
    }
  }
  return out;
}

const parsed = blocks();
const dark = parsed.get(':root[data-theme="dark"]')!;
const light = parsed.get(':root[data-theme="light"]')!;

describe("tokens.css", () => {
  it("defines exactly the names tokens.ts lists", () => {
    const defined = new Set([...css.matchAll(/(--lc-[\w-]+)\s*:/g)].map((m) => m[1]));
    expect([...defined].sort()).toEqual([...TOKEN_NAMES].sort());
  });

  it("gives every themed token a dark and a light value", () => {
    for (const name of THEMED_TOKEN_NAMES) {
      expect(dark.has(name), `${name} in dark`).toBe(true);
      expect(light.has(name), `${name} in light`).toBe(true);
    }
  });

  it("defines the six accent presets", () => {
    for (const name of ["indigo", "blue", "teal", "green", "amber", "rose"]) {
      expect(parsed.get(`[data-accent="${name}"]`)?.get("--lc-accent")).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

// WCAG 2 relative luminance and contrast, over opaque sRGB.
type Rgb = [number, number, number];
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
  if (!rgba) throw new Error(`cannot parse ${value}`);
  return { rgb: [+rgba[1], +rgba[2], +rgba[3]], alpha: rgba[4] === undefined ? 1 : +rgba[4] };
}
function over(top: string, base: Rgb): Rgb {
  const { rgb, alpha } = parseColor(top);
  return rgb.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;
}
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const CHART = THEMED_TOKEN_NAMES.filter((name) => name.startsWith("--lc-chart-"));

describe.each([
  ["dark", dark],
  ["light", light],
] as const)("body text contrast in %s", (_, tokens) => {
  const solid = (name: string) => parseColor(tokens.get(name)!).rgb;
  const surface1 = solid("--lc-surface-1");
  const surface2 = solid("--lc-surface-2");
  const surfaces: Record<string, Rgb> = {
    bg: solid("--lc-bg"),
    "surface-1": surface1,
    "surface-2": surface2,
    "hover on surface-1": over(tokens.get("--lc-surface-3")!, surface1),
    "hover on surface-2": over(tokens.get("--lc-surface-3")!, surface2),
    "field on surface-1": over(tokens.get("--lc-field-bg")!, surface1),
    // A floating card over the brightest and darkest data it can sit on.
    "float over white": over(tokens.get("--lc-surface-float")!, [255, 255, 255]),
    "float over black": over(tokens.get("--lc-surface-float")!, [0, 0, 0]),
  };

  it.each(["--lc-text", "--lc-text-muted"])("%s meets 4.5:1 on every surface", (text) => {
    for (const [name, rgb] of Object.entries(surfaces)) {
      expect(contrast(solid(text), rgb), `${text} on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The dock draws its charts on surface-1 and its bars on a field, and the
  // theme canvas is the background.
  it("draws chart series at 3:1 on the background, the dock, and its fields", () => {
    const behind = { bg: surfaces.bg, "surface-1": surface1, "field on surface-1": surfaces["field on surface-1"] };
    for (const series of CHART) {
      for (const [name, rgb] of Object.entries(behind)) {
        expect(contrast(solid(series), rgb), `${series} on ${name}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

// The canvas tokens on one canvas background, with the theme canvas's
// references to theme tokens resolved against that theme.
function canvasTokens(canvas: string, theme: "dark" | "light"): Map<string, string> {
  const merged = new Map([...parsed.get(":root")!, ...(theme === "light" ? light : dark)]);
  for (const [name, value] of parsed.get(`:root[data-canvas="${canvas}"]`) ?? []) merged.set(name, value);
  for (const [name, value] of merged) {
    const ref = /^var\((--lc-[\w-]+)\)$/.exec(value);
    if (ref) merged.set(name, merged.get(ref[1])!);
  }
  return merged;
}

const DRAWN_OVER_DATA = CANVAS_TOKEN_NAMES.filter(
  (name) => !["--lc-canvas-bg", "--lc-canvas-stroke", "--lc-canvas-label"].includes(name),
);
const CANVAS_CHART = CANVAS_TOKEN_NAMES.filter((name) => name.startsWith("--lc-canvas-chart-"));

describe.each([
  ["black", "dark"],
  ["dark-gray", "dark"],
  ["white", "dark"],
  ["theme", "dark"],
  ["theme", "light"],
] as const)("the %s canvas in the %s theme", (canvas, theme) => {
  const tokens = canvasTokens(canvas, theme);
  const bg = parseColor(tokens.get("--lc-canvas-bg")!).rgb;

  it("defines every canvas token", () => {
    for (const name of CANVAS_TOKEN_NAMES) expect(tokens.has(name), name).toBe(true);
  });

  it("draws axes, markers, statuses, and chart series at 3:1 or better against the background", () => {
    for (const name of DRAWN_OVER_DATA) {
      expect(contrast(parseColor(tokens.get(name)!).rgb, bg), name).toBeGreaterThanOrEqual(3);
    }
  });

  it("draws chart series in the slots its background calls for", () => {
    // The theme canvas takes the theme's own slots, so a series on it matches
    // the dock's. A dark canvas takes the dark theme's, and white the light theme's.
    const slots = canvas === "white" || (canvas === "theme" && theme === "light") ? light : dark;
    for (const name of CANVAS_CHART) {
      expect(tokens.get(name), name).toBe(slots.get(name.replace("--lc-canvas-chart-", "--lc-chart-")));
    }
  });

  it("keeps labels at 4.5:1 and strokes at 3:1", () => {
    expect(contrast(over(tokens.get("--lc-canvas-label")!, bg), bg)).toBeGreaterThanOrEqual(4.5);
    const stroke = tokens.get("--lc-canvas-stroke")!;
    // The theme canvas mixes its stroke from the theme's text, which the
    // body-text check above holds to 4.5:1.
    if (!stroke.startsWith("color-mix")) {
      expect(contrast(over(stroke, bg), bg)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("annotation colors", () => {
  // Shapes sit over the canvas background and over data, which can be as dark
  // or as bright as either end, so each color has to read on both.
  const root = parsed.get(":root")!;
  it.each([
    ["black", [0, 0, 0]],
    ["white", [255, 255, 255]],
  ] as const)("own and peer shapes meet 3:1 on %s", (_, background) => {
    for (const name of ["--lc-annotation-own", "--lc-annotation-peer"]) {
      const color = parseColor(root.get(name)!).rgb;
      expect(contrast(color, [...background]), name).toBeGreaterThanOrEqual(3);
    }
  });
});
