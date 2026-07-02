import { describe, it, expect } from "vitest";
import {
  labelColor,
  glasbeyRgb,
  packLabelPalette,
  MAX_GPU_LABEL_COLORS,
  type RGBA,
} from "./labelColors.ts";

describe("labelColor", () => {
  it("maps background id 0 to fully transparent", () => {
    expect(labelColor(0)).toEqual([0, 0, 0, 0]);
  });

  it("honors declared RGB but normalizes alpha to opaque (uniform overlay opacity)", () => {
    const explicit = new Map<number, RGBA>([[7, [10, 20, 30, 200]]]);
    expect(labelColor(7, explicit)).toEqual([10, 20, 30, 255]);
  });

  it("normalizes a declared SEMI-TRANSPARENT color (alpha<255) to opaque", () => {
    // Regression: the ISR plate declares cells 1..10 with alpha=128, which
    // rendered them at ~50% while glasbey-fallback cells stayed opaque — a
    // patchwork the opacity slider couldn't correct. Alpha is now uniform;
    // the per-label opacity is the sole transparency control.
    const explicit = new Map<number, RGBA>([[3, [255, 225, 25, 128]]]);
    expect(labelColor(3, explicit)).toEqual([255, 225, 25, 255]);
  });

  it("honors explicit colors for ids well past the 16-bit range", () => {
    // The yeast fixture declares a color for value 92801 (> 65535).
    const explicit = new Map<number, RGBA>([[92801, [1, 2, 3, 255]]]);
    expect(labelColor(92801, explicit)).toEqual([1, 2, 3, 255]);
  });

  it("falls back to the deterministic hash for undeclared ids (opaque)", () => {
    const explicit = new Map<number, RGBA>([[7, [10, 20, 30, 200]]]);
    const c = labelColor(9, explicit);
    expect(c.slice(0, 3)).toEqual(glasbeyRgb(9));
    expect(c[3]).toBe(255);
  });

  it("is deterministic", () => {
    expect(labelColor(123456)).toEqual(labelColor(123456));
  });

  it("does not truncate ids to 16 bits — ids differing only above bit 16 differ", () => {
    // Prior bug: `id & 0xFFFF` collapsed these onto one color.
    const a = labelColor(5);
    const b = labelColor(5 + 0x10000);
    const c = labelColor(5 + 0x20000);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
  });

  it("stays in-gamut (every channel 0..255) across a wide id sweep", () => {
    const ids = [1, 2, 3, 255, 256, 65535, 65536, 92801, 1_000_000, 2_000_000_000, 4_294_967_295];
    for (const id of ids) {
      const c = labelColor(id);
      for (const ch of c) {
        expect(Number.isInteger(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it("produces distinct colors across a dense id range (well-distributed)", () => {
    const seen = new Set<string>();
    let collisions = 0;
    for (let id = 1; id <= 2000; id++) {
      const key = glasbeyRgb(id).join(",");
      if (seen.has(key)) collisions++;
      seen.add(key);
    }
    // A handful of collisions is acceptable for a hash; a truncation bug
    // or a degenerate palette would collapse most ids together.
    expect(collisions).toBeLessThan(50);
  });

  it("keeps full-u32 ids distinct near the top of the range", () => {
    const top = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = (4_294_967_295 - i) >>> 0;
      top.add(glasbeyRgb(id).join(","));
    }
    expect(top.size).toBeGreaterThan(400);
  });
});

describe("packLabelPalette", () => {
  it("packs [id, rgba] pairs in the shader's u32 layout (alpha forced opaque)", () => {
    const packed = packLabelPalette([{ value: 92801, rgba: [10, 20, 30, 200] }]);
    expect(packed.length).toBe(2);
    expect(packed[0]).toBe(92801);
    // r | g<<8 | b<<16 | a<<24 — declared RGB preserved, alpha normalized to 255
    expect(packed[1]).toBe(((10) | (20 << 8) | (30 << 16) | (255 << 24)) >>> 0);
  });

  it("forces a declared partial alpha to opaque so overlay opacity stays uniform", () => {
    const packed = packLabelPalette([{ value: 5, rgba: [245, 130, 48, 128] }]);
    expect(packed[1] >>> 24).toBe(255); // alpha byte opaque, not the declared 128
  });

  it("caps the palette so the per-fragment shader scan stays bounded", () => {
    const many = Array.from({ length: MAX_GPU_LABEL_COLORS + 5000 }, (_v, i) => ({
      value: i + 1,
      rgba: [1, 2, 3, 255] as [number, number, number, number],
    }));
    const packed = packLabelPalette(many);
    expect(packed.length).toBe(MAX_GPU_LABEL_COLORS * 2); // capped, not 70k+ pairs
  });
});
