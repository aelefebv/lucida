/**
 * Label colour-path lock: full uint32 ids must survive to the colour stage.
 *
 * The label render (slice.wgsl / volume.wgsl) turns a voxel's integer id into a
 * colour in two ranges, so a full `u32` id is honoured with NO truncation:
 *
 *   - id `0`           → transparent (segmentation background).
 *   - id `< 65536`     → the 256×256 indexed LUT baked by core
 *                        (`build_label_lut_rgba`): an explicit `image-label.colors`
 *                        entry, else the deterministic glasbey fill.
 *   - id `>= 65536`    → the SAME glasbey colour, computed in-shader (the LUT
 *                        cannot hold it), via `glasbey_wgsl`.
 *
 * The previous code masked `labelVal & 0xFFFFu` before the lookup, so on real
 * data (yeast ids like 70000 / 92801) id 70000 collided with 4464, and any
 * multiple of 65536 masked to 0 → transparent (the region vanished) while hover
 * still reported the true id. This test pins the fixed behaviour and the
 * shader↔core colour parity.
 *
 * `glasbeyRgb` below is a TS mirror of the WGSL `glasbey_wgsl` port. WGSL has no
 * f64; a naive `f32(value) * φ⁻¹` loses all fractional precision for large ids
 * (the integer part swamps the f32 mantissa), so both the shader and this mirror
 * reduce `value` modulo 1 by splitting it into bytes weighted by
 * `frac(256^k · φ⁻¹)` — every partial product stays < 256 where f32 is precise.
 * `Math.fround` forces f32 rounding at each step so this matches the GPU exactly.
 * The hardcoded reference RGBs are core `label_lut::glasbey_rgba` (f64) outputs;
 * for these sample ids the f32 port lands on them exactly.
 */

import { describe, it, expect } from "vitest";
import sliceSrc from "./slice.wgsl?raw";
import volumeSrc from "./volume.wgsl?raw";

// φ⁻¹ = 0.6180339887498949; wₖ = frac(256^k · φ⁻¹) rounded to f32 — the exact
// literals the WGSL port uses.
const W0 = Math.fround(0.6180340051651001);
const W1 = Math.fround(0.21670112013816833);
const W2 = Math.fround(0.47548672556877136);
const W3 = Math.fround(0.7245985865592957);

const f = Math.fround;

/** f32 mirror of WGSL `glasbey_wgsl` — RGB in 0..1. Matches core to <=1/255. */
function glasbeyRgb01(value: number): [number, number, number] {
  const b0 = f(value & 0xff);
  const b1 = f((value >>> 8) & 0xff);
  const b2 = f((value >>> 16) & 0xff);
  const b3 = f((value >>> 24) & 0xff);
  const sum = f(f(f(f(f(f(b0 * W0) + f(b1 * W1)) + f(b2 * W2)) + f(b3 * W3)) + 0.5));
  const hue = f(sum - Math.floor(sum));

  const s = f(0.65);
  const v = (value & 1) === 1 ? f(0.98) : f(0.88);

  const h6 = f(f(hue - Math.floor(hue)) * 6.0);
  const sector = Math.floor(h6) | 0;
  const fr = f(h6 - Math.floor(h6));
  const p = f(v * f(1.0 - s));
  const q = f(v * f(1.0 - f(s * fr)));
  const t = f(v * f(1.0 - f(s * f(1.0 - fr))));
  let r: number, g: number, b: number;
  switch (sector) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q]; break;
  }
  // Core rounds to u8; mirror that so we compare against core's u8 output.
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** The 8-bit glasbey colour for `value`, as core `glasbey_rgba` returns (rgb). */
function glasbeyRgb(value: number): [number, number, number] {
  return glasbeyRgb01(value);
}

/**
 * The shader label id → RGBA (0..255) mapping, modelling the LUT the way core
 * bakes it (glasbey fill for slots without an explicit palette entry). This is
 * the mapping both shader label branches implement.
 */
function labelColorRgba(value: number): [number, number, number, number] {
  if (value === 0) return [0, 0, 0, 0]; // background → transparent
  // `< 65536`: LUT slot. With no explicit `image-label.colors`, core fills the
  // slot with glasbey_rgba(value); `>= 65536`: the in-shader glasbey. Same fn.
  const [r, g, b] = glasbeyRgb(value);
  return [r, g, b, 255];
}

// ---------------------------------------------------------------------------
// Behaviour: full u32 ids, no truncation.
// ---------------------------------------------------------------------------

describe("label colour path honours full uint32 ids", () => {
  it("does NOT collide 70000 with its masked-to-u16 sibling 4464", () => {
    // 70000 & 0xFFFF === 4464 — the exact collision the old mask produced.
    expect(70000 & 0xffff).toBe(4464);
    expect(labelColorRgba(70000)).not.toEqual(labelColorRgba(4464));
  });

  it("keeps every multiple of 65536 visible (not masked to transparent 0)", () => {
    for (const v of [65536, 131072, 196608, 655360]) {
      expect(v & 0xffff).toBe(0); // old mask → 0 → transparent
      const [r, g, b, a] = labelColorRgba(v);
      expect(a).toBe(255); // opaque
      expect(r + g + b).toBeGreaterThan(0); // has colour
    }
  });

  it("gives distinct colours to real yeast ids that share low 16 bits", () => {
    // 70001 & 0xFFFF === 4465, 92801 & 0xFFFF === 27265 — all must be distinct
    // from each other and from their masked siblings.
    const ids = [70000, 70001, 92801, 4464, 4465, 27265];
    const seen = new Set(ids.map((v) => labelColorRgba(v).join(",")));
    expect(seen.size).toBe(ids.length);
  });

  it("value 0 stays transparent (background is never painted)", () => {
    expect(labelColorRgba(0)).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Parity: the TS/WGSL glasbey port matches core `glasbey_rgba` (f64).
// ---------------------------------------------------------------------------

describe("glasbeyRgb matches core label_lut::glasbey_rgba", () => {
  // Hardcoded from core's f64 formula (verified by running the exact
  // `glasbey_rgba` arithmetic). For these ids the f32 port lands on core exactly.
  const CORE: Array<[number, [number, number, number]]> = [
    [1, [250, 203, 87]],
    [2, [139, 79, 224]],
    [3, [87, 250, 108]],
    [1000, [79, 195, 224]],
    [4464, [79, 224, 140]],
    [65535, [87, 250, 111]],
    [65536, [224, 79, 100]],
    [70000, [224, 79, 184]],
    [70001, [87, 250, 247]],
    [92801, [93, 87, 250]],
    [131072, [79, 224, 181]],
    [4000000003, [87, 250, 107]],
  ];

  for (const [v, rgb] of CORE) {
    it(`v=${v} → [${rgb.join(", ")}]`, () => {
      expect(glasbeyRgb(v)).toEqual(rgb);
    });
  }

  it("the LUT range (<65536) and shader range (>=65536) use one continuous formula", () => {
    // 65535 (LUT) and 65536 (shader) are adjacent ids from different code paths;
    // both come from the same glasbey walk, so they must be distinct colours (the
    // walk never short-cycles) rather than accidentally equal.
    expect(glasbeyRgb(65535)).not.toEqual(glasbeyRgb(65536));
  });
});

// ---------------------------------------------------------------------------
// Shader lock: the mask is gone and both shaders share the glasbey port.
// ---------------------------------------------------------------------------

/** Body of `fn glasbey_wgsl(...) { ... }`, brace-matched. */
function extractGlasbeyFn(src: string): string {
  const start = src.indexOf("fn glasbey_wgsl");
  if (start < 0) throw new Error("glasbey_wgsl not found");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced glasbey_wgsl braces");
}

describe("shader label branches no longer truncate the id", () => {
  it("neither shader masks the label value with & 0xFFFFu before the colour lookup", () => {
    // The whole defect: `labelVal & 0xFFFFu` / `lval & 0xFFFFu` truncated the id.
    // Strip `//` comments first so a historical note in prose can't satisfy or
    // trip this lock — it must hold on the actual shader code.
    const codeOnly = (src: string) => src.replace(/\/\/[^\n]*/g, "");
    expect(codeOnly(sliceSrc)).not.toMatch(/labelVal\s*&\s*0xFFFFu/);
    expect(codeOnly(volumeSrc)).not.toMatch(/lval\s*&\s*0xFFFFu/);
  });

  it("both shaders define glasbey_wgsl and route >= 65536 through it", () => {
    expect(sliceSrc).toContain("fn glasbey_wgsl");
    expect(volumeSrc).toContain("fn glasbey_wgsl");
    expect(sliceSrc).toContain("glasbey_wgsl(labelVal)");
    expect(volumeSrc).toContain("glasbey_wgsl(lval)");
    // The LUT path survives for < 65536 (explicit-palette ids unchanged).
    expect(sliceSrc).toContain("labelVal < 65536u");
    expect(volumeSrc).toContain("lval < 65536u");
  });

  it("both shaders share a byte-identical glasbey_wgsl port", () => {
    expect(extractGlasbeyFn(sliceSrc)).toBe(extractGlasbeyFn(volumeSrc));
  });

  it("the EntityDescriptor struct is untouched (descriptor lock stays green)", () => {
    // Both structs must still be present and identical — this file changes only
    // fragment logic, never the descriptor layout.
    const re = /struct\s+EntityDescriptor\s*\{[\s\S]*?\};/;
    const a = sliceSrc.match(re);
    const b = volumeSrc.match(re);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a![0]).toBe(b![0]);
  });
});
