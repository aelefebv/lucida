/**
 * Locks the slice shader's member footprint-border rule at the source
 * level (WGSL doesn't run in vitest; same convention as
 * labelColorParity.test.ts).
 *
 * The invariant: the border only draws for members large enough on
 * screen to show content NEXT TO the frame. Without the size gate, a
 * member smaller than the frame width renders 100% border — at overview
 * zoom on a wide collection every batched member is sub-pixel, so the
 * whole field becomes constant border gray and no contrast/gamma/
 * colormap edit can reach a visible pixel.
 */

import { describe, it, expect } from "vitest";
import sliceSrc from "./slice.wgsl?raw";

/** Extract a WGSL function `fn name(...) { ... }` up to its first
 *  column-0 closing brace. `name` is matched up to its open paren so
 *  `fs` can't swallow `fsAggregate`. */
function extractFn(src: string, name: string): string {
  const m = src.match(new RegExp(`fn ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`fn ${name} not found`);
  return m[0];
}

/** Read a module-scope `const name: f32 = <value>;` from the source. */
function wgslConstF32(src: string, name: string): number {
  const m = src.match(new RegExp(`const ${name}: f32 = ([0-9.]+);`));
  if (!m) throw new Error(`const ${name} not found`);
  return parseFloat(m[1]);
}

describe("slice.wgsl member footprint border", () => {
  it("declares the border width and minimum-size constants", () => {
    expect(sliceSrc).toContain("const MEMBER_BORDER_WIDTH_PX");
    expect(sliceSrc).toContain("const MEMBER_BORDER_MIN_SCREEN_PX");
  });

  it("gates the border on member screen size in BOTH fragment entry points", () => {
    // A regression that drops the gate from either path brings back the
    // all-border rendering for small members on that path.
    for (const entry of ["fs", "fsAggregate"]) {
      const body = extractFn(sliceSrc, entry);
      expect(body).toContain("MEMBER_BORDER_MIN_SCREEN_PX");
      expect(body).toContain("MEMBER_BORDER_WIDTH_PX");
    }
  });

  it("keeps content pixels reachable for every bordered member", () => {
    // The frame eats `width` px from each side, so a member needs a
    // screen extent of at least 2×width per axis before any interior
    // (data) pixel survives. The size gate must sit at or above that,
    // or members in between still render border-only.
    const width = wgslConstF32(sliceSrc, "MEMBER_BORDER_WIDTH_PX");
    const minSize = wgslConstF32(sliceSrc, "MEMBER_BORDER_MIN_SCREEN_PX");
    expect(minSize).toBeGreaterThanOrEqual(2 * width);
  });
});
