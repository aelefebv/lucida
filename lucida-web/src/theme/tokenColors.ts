/**
 * Token colors for code that draws outside CSS: 2D canvases, SVG attributes,
 * and the GPU renderer. Each token resolves once per appearance, so a drawer
 * can ask for its colors every frame.
 */

import { subscribeAppearance } from "./appearance.ts";
import { readColorToken, type ResolvedColor, type TokenName } from "./tokens.ts";

const cache = new Map<TokenName, ResolvedColor>();
// Subscribed when this module loads, ahead of any drawer's own subscription,
// so a drawer that re-reads its colors when the appearance changes never gets
// a value from before the change.
subscribeAppearance(() => cache.clear());

export function tokenColor(name: TokenName): ResolvedColor {
  let color = cache.get(name);
  if (!color) {
    color = readColorToken(name);
    cache.set(name, color);
  }
  return color;
}

/** Resolve a table of roles: `{ grid: "--lc-canvas-stroke" }` gives `{ grid: <resolved> }`. */
export function tokenColors<const R extends Readonly<Record<string, TokenName>>>(
  roles: R,
): { readonly [K in keyof R]: ResolvedColor } {
  const out = {} as Record<keyof R, ResolvedColor>;
  for (const role in roles) out[role] = tokenColor(roles[role]);
  return out;
}

/**
 * `color` as a CSS color with its alpha scaled by `alpha`. A drawer picks how
 * much paint a fill or a faint line takes; the token picks the color.
 */
export function paint(color: ResolvedColor, alpha = 1): string {
  return rgbColor(color.r * 255, color.g * 255, color.b * 255, color.a * alpha).css;
}

/** The color `t` of the way from `a` to `b`, mixed in sRGB. */
export function mixColor(a: ResolvedColor, b: ResolvedColor, t: number): ResolvedColor {
  const at = (x: number, y: number) => (x + (y - x) * t) * 255;
  return rgbColor(at(a.r, b.r), at(a.g, b.g), at(a.b, b.b), a.a + (b.a - a.a) * t);
}

/** A resolved color from 8-bit channels and an alpha in 0..1. */
export function rgbColor(r: number, g: number, b: number, a = 1): ResolvedColor {
  const byte = (c: number) => Math.round(Math.min(255, Math.max(0, c)));
  const alpha = Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000;
  const [R, G, B] = [byte(r), byte(g), byte(b)];
  return { r: R / 255, g: G / 255, b: B / 255, a: alpha, css: `rgba(${R}, ${G}, ${B}, ${alpha})` };
}
