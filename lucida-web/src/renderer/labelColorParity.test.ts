/**
 * TS <-> WGSL parity for the categorical label color hash.
 *
 * We can't run WGSL in vitest, so this mirrors the cross-check pattern in
 * `proxyShaderBinding.test.ts`: `wgslLabelGlasbey` below is a hand port of
 * the `labelGlasbey` function in `slice.wgsl`, and we assert it agrees
 * with the production {@link glasbeyRgb} across the full uint32 range. If
 * the shader's math and `labelColors.ts` ever drift, on-screen label
 * colors would stop matching `labelColor`, and this test fails.
 *
 * The shader source is loaded via Vite's `?raw` import (same mechanism the
 * renderers use) so we can also assert the shader still carries the exact
 * hash constants the port assumes.
 */

import { describe, it, expect } from "vitest";
import sliceSrc from "./slice.wgsl?raw";
import { glasbeyRgb, labelColor } from "./labelColors.ts";

// --- Hand port of slice.wgsl `labelGlasbey` (u32 arithmetic) -------------

/** WGSL `x * y` on u32 wraps mod 2^32; Math.imul matches, `>>> 0` unsigns. */
function mulU32(a: number, b: number): number {
  return Math.imul(a >>> 0, b >>> 0) >>> 0;
}

function wgslFmix32(value: number): number {
  let h = value >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = mulU32(h, 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = mulU32(h, 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/** WGSL u32 division truncates toward zero. */
function udiv(a: number, b: number): number {
  return Math.floor((a >>> 0) / (b >>> 0));
}

function wgslLabelGlasbey(id: number): [number, number, number] {
  const a = wgslFmix32(id);
  const b = wgslFmix32(a);

  const hue = (a >>> 0) % 1530;
  const sat = 200 + ((b >>> 0) % 56);
  const val = 205 + (udiv(b, 256) % 51);

  const seg = udiv(hue, 255);
  const off = hue % 255;

  const p = udiv(val * (255 - sat), 255);
  const q = udiv(val * (255 - udiv(sat * off, 255)), 255);
  const t = udiv(val * (255 - udiv(sat * (255 - off), 255)), 255);

  if (seg === 0) return [val, t, p];
  if (seg === 1) return [q, val, p];
  if (seg === 2) return [p, val, t];
  if (seg === 3) return [p, q, val];
  if (seg === 4) return [t, p, val];
  return [val, p, q];
}

// Hand port of slice.wgsl `labelColorFor`: scan [id, packedRgba] pairs for
// a declared color, else glasbey (alpha 255). Returns rgba bytes (0..255).
function wgslLabelColorFor(id: number, palette: number[]): [number, number, number, number] {
  const count = Math.floor(palette.length / 2);
  for (let i = 0; i < count; i++) {
    if (palette[2 * i] === id) {
      const packed = palette[2 * i + 1] >>> 0;
      return [
        packed & 0xff,
        (packed >>> 8) & 0xff,
        (packed >>> 16) & 0xff,
        (packed >>> 24) & 0xff,
      ];
    }
  }
  const [r, g, b] = wgslLabelGlasbey(id);
  return [r, g, b, 255];
}

function pack(rgba: [number, number, number, number]): number {
  return ((rgba[0] & 0xff) | ((rgba[1] & 0xff) << 8) | ((rgba[2] & 0xff) << 16) | ((rgba[3] & 0xff) << 24)) >>> 0;
}

// --- Tests ---------------------------------------------------------------

describe("label color TS <-> WGSL parity", () => {
  it("shader carries the hash constants the port assumes", () => {
    expect(sliceSrc).toContain("fn labelGlasbey");
    expect(sliceSrc).toContain("0x85ebca6b");
    expect(sliceSrc).toContain("0xc2b2ae35");
    expect(sliceSrc).toContain("1530u");
  });

  it("WGSL port matches glasbeyRgb across representative ids", () => {
    const ids = [
      1, 2, 3, 4, 5, 42, 255, 256, 257, 1000, 65535, 65536, 65537,
      92801, 100000, 1_000_000, 16_777_216, 2_000_000_000,
      3_000_000_000, 4_294_967_294, 4_294_967_295,
    ];
    for (const id of ids) {
      expect(wgslLabelGlasbey(id)).toEqual(glasbeyRgb(id));
    }
  });

  it("WGSL port matches glasbeyRgb across a dense sweep", () => {
    for (let id = 1; id <= 4096; id++) {
      expect(wgslLabelGlasbey(id)).toEqual(glasbeyRgb(id));
    }
  });

  it("WGSL port matches glasbeyRgb across a high-range stride", () => {
    for (let i = 0; i < 4096; i++) {
      const id = (0xf0000000 + i * 7919) >>> 0;
      expect(wgslLabelGlasbey(id)).toEqual(glasbeyRgb(id));
    }
  });

  it("on-screen fallback equals labelColor's rgb for undeclared ids", () => {
    for (const id of [1, 999, 70000, 92800, 4_294_967_295]) {
      expect(wgslLabelGlasbey(id)).toEqual(labelColor(id).slice(0, 3));
    }
  });

  it("shader carries the declared-palette scan", () => {
    expect(sliceSrc).toContain("fn labelColorFor");
    expect(sliceSrc).toContain("labelColors[2u * i]");
  });

  it("declared palette scan matches labelColor(explicit) for declared + undeclared ids", () => {
    // yeast-style declared colors, incl. an id past 16 bits.
    const declared: Array<{ value: number; rgba: [number, number, number, number] }> = [
      { value: 2, rgba: [230, 25, 75, 255] },
      { value: 92801, rgba: [10, 20, 30, 200] },
    ];
    const palette: number[] = [];
    const map = new Map<number, [number, number, number, number]>();
    for (const d of declared) {
      palette.push(d.value >>> 0, pack(d.rgba));
      map.set(d.value, d.rgba);
    }
    // Declared ids render exactly as authored.
    expect(wgslLabelColorFor(2, palette)).toEqual([230, 25, 75, 255]);
    expect(wgslLabelColorFor(2, palette)).toEqual(labelColor(2, map));
    expect(wgslLabelColorFor(92801, palette)).toEqual([10, 20, 30, 200]);
    expect(wgslLabelColorFor(92801, palette)).toEqual(labelColor(92801, map));
    // Undeclared ids fall back to the hash (matching labelColor).
    for (const id of [1, 3, 999, 70000, 4_294_967_295]) {
      expect(wgslLabelColorFor(id, palette)).toEqual(labelColor(id, map));
    }
  });
});
