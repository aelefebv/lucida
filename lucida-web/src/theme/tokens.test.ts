import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { THEMED_TOKEN_NAMES, TOKEN_NAMES } from "./tokens.ts";

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
});
