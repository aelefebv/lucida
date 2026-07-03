import { describe, it, expect } from "vitest";
import {
  labelFootprint,
  labelLevelZTarget,
  labelModelMatrices,
  type Level0,
} from "./labelLayout.ts";

/** Column-major 4×4 multiply (a · b). */
function mul(a: Float32Array, b: Float32Array): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

describe("labelFootprint", () => {
  it("sizes a coarser label to the source's full-res extent (alignment)", () => {
    // yeast mitochondria: label is 4x downsampled in Y/X vs. the source.
    const source: Level0 = { shape: [1, 1, 30, 340, 348], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    const { dataW, dataH } = labelFootprint(source, label);
    expect(dataW).toBeCloseTo(348, 6); // 87 * 4 / 1
    expect(dataH).toBeCloseTo(340, 6); // 85 * 4 / 1
  });

  it("does NOT render a coarse label at its raw pixel size", () => {
    const source: Level0 = { shape: [1, 1, 1, 512, 512], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 1, 128, 128], scale: [1, 1, 1, 4, 4] };
    const { dataW, dataH } = labelFootprint(source, label);
    expect(dataW).not.toBeCloseTo(128, 3);
    expect(dataW).toBeCloseTo(512, 6);
    expect(dataH).toBeCloseTo(512, 6);
  });

  it("is identity when label and source share the same grid and scale", () => {
    const same: Level0 = { shape: [1, 1, 10, 256, 300], scale: [1, 1, 1, 1, 1] };
    const { dataW, dataH } = labelFootprint(same, { ...same });
    expect(dataW).toBeCloseTo(300, 6);
    expect(dataH).toBeCloseTo(256, 6);
  });

  it("accounts for a physically-scaled source (microns per pixel)", () => {
    // Source at 0.5 um/px, label at 2.0 um/px -> label covers 4x source px.
    const source: Level0 = { shape: [1, 1, 1, 1000, 1000], scale: [1, 1, 1, 0.5, 0.5] };
    const label: Level0 = { shape: [1, 1, 1, 250, 250], scale: [1, 1, 1, 2.0, 2.0] };
    const { dataW, dataH } = labelFootprint(source, label);
    expect(dataW).toBeCloseTo(1000, 6); // 250 * 2.0 / 0.5
    expect(dataH).toBeCloseTo(1000, 6);
  });

  it("degrades to the label's own extent when source scale is missing/zero", () => {
    const source: Level0 = { shape: [1, 1, 1, 100, 100], scale: [1, 1, 1, 0, 0] };
    const label: Level0 = { shape: [1, 1, 1, 40, 50], scale: [1, 1, 1, 1, 1] };
    const { dataW, dataH } = labelFootprint(source, label);
    expect(dataW).toBeCloseTo(50, 6);
    expect(dataH).toBeCloseTo(40, 6);
  });
});

describe("labelLevelZTarget", () => {
  // The shared source: 30 full-res Z-planes at unit scale.
  const source: Level0 = { shape: [1, 1, 30, 340, 348], scale: [1, 1, 1, 1, 1] };

  it("maps a same-depth level plane-per-chunk to the identical Z (identity)", () => {
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    const level = { shape: [1, 1, 30, 85, 87], chunk_shape: [1, 1, 1, 128, 128] };
    expect(labelLevelZTarget(7, source, label, level)).toEqual({
      levelZ: 7,
      chunkZ: 7,
      localZ: 0,
    });
  });

  it("locates the plane inside a fat-Z chunk (chunk index + local offset)", () => {
    // Both source planes live in ONE z-chunk of depth 2: plane 1 is chunk 0,
    // offset 1 — the request must target chunk 0 and delivery must cut plane 1.
    const src2: Level0 = { shape: [1, 1, 2, 2, 2], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 2, 2, 2], scale: [1, 1, 1, 1, 1] };
    const level = { shape: [1, 1, 2, 2, 2], chunk_shape: [1, 1, 2, 2, 2] };
    expect(labelLevelZTarget(1, src2, label, level)).toEqual({
      levelZ: 1,
      chunkZ: 0,
      localZ: 1,
    });
  });

  it("maps proportionally onto a Z-downsampled level, hitting both ends exactly", () => {
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    // A coarser level with 10 planes for the label's 30.
    const level = { shape: [1, 1, 10, 43, 44], chunk_shape: [1, 1, 1, 128, 128] };
    expect(labelLevelZTarget(0, source, label, level).levelZ).toBe(0);
    expect(labelLevelZTarget(29, source, label, level).levelZ).toBe(9); // last → last
    expect(labelLevelZTarget(15, source, label, level).levelZ).toBe(4); // floor(15/29 * 9)
  });

  it("maps every plane of a depth-1 level to plane 0", () => {
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    const level = { shape: [1, 1, 1, 85, 87], chunk_shape: [1, 1, 1, 128, 128] };
    for (const z of [0, 7, 29]) {
      expect(labelLevelZTarget(z, source, label, level)).toEqual({
        levelZ: 0,
        chunkZ: 0,
        localZ: 0,
      });
    }
  });

  it("first maps the source Z through the label's own Z scale", () => {
    // Label is 3x coarser in Z (10 planes over the source's 30): source plane 7
    // sits at label plane round(7/3) = 2, which chunk-depth 4 puts in chunk 0
    // at offset 2.
    const label: Level0 = { shape: [1, 1, 10, 85, 87], scale: [1, 1, 3, 4, 4] };
    const level = { shape: [1, 1, 10, 85, 87], chunk_shape: [1, 1, 4, 128, 128] };
    expect(labelLevelZTarget(7, source, label, level)).toEqual({
      levelZ: 2,
      chunkZ: 0,
      localZ: 2,
    });
  });

  it("clamps a source Z past the label's depth to the last plane", () => {
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    const level = { shape: [1, 1, 30, 85, 87], chunk_shape: [1, 1, 1, 128, 128] };
    expect(labelLevelZTarget(100, source, label, level)).toEqual({
      levelZ: 29,
      chunkZ: 29,
      localZ: 0,
    });
  });

  it("treats a missing/zero chunk depth as one plane per chunk", () => {
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    const zeroChunk = { shape: [1, 1, 30, 85, 87], chunk_shape: [1, 1, 0, 128, 128] };
    expect(labelLevelZTarget(7, source, label, zeroChunk)).toEqual({
      levelZ: 7,
      chunkZ: 7,
      localZ: 0,
    });
  });
});

describe("labelModelMatrices", () => {
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  it("passes the source matrices through for a same-extent (downsampled) label", () => {
    // yeast mito: 4× coarser in Y/X but the SAME physical extent as its source.
    const source: Level0 = { shape: [1, 1, 30, 340, 348], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 30, 85, 87], scale: [1, 1, 1, 4, 4] };
    const model = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 5, 0, 7, 11, 13, 1]);
    const inv = new Float32Array([0.5, 0, 0, 0, 0, 1 / 3, 0, 0, 0, 0, 0.2, 0, -3.5, -11 / 3, -2.6, 1]);
    const out = labelModelMatrices(model, inv, source, label);
    // All extent ratios are 1 → unchanged values (fresh copies, not aliases).
    expect(Array.from(out.model)).toEqual(Array.from(model));
    expect(Array.from(out.inv)).toEqual(Array.from(inv));
    expect(out.model).not.toBe(model);
  });

  it("scales the source cube to a label with a SMALLER physical extent", () => {
    // Label covers half the source in X, a quarter in Y, all of Z.
    const source: Level0 = { shape: [1, 1, 10, 100, 100], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 10, 25, 50], scale: [1, 1, 1, 1, 1] };
    const out = labelModelMatrices(IDENTITY, IDENTITY, source, label);
    // rx = 50/100 = 0.5 (column 0), ry = 25/100 = 0.25 (column 1), rz = 1.
    expect(out.model[0]).toBeCloseTo(0.5, 6);
    expect(out.model[5]).toBeCloseTo(0.25, 6);
    expect(out.model[10]).toBeCloseTo(1, 6);
    // The inverse scales the matching rows by the reciprocal.
    expect(out.inv[0]).toBeCloseTo(2, 6);
    expect(out.inv[5]).toBeCloseTo(4, 6);
    expect(out.inv[10]).toBeCloseTo(1, 6);
  });

  it("returns a genuine inverse (model · inv ≈ identity) for a non-trivial source", () => {
    const source: Level0 = { shape: [1, 1, 10, 100, 100], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 4, 25, 50], scale: [1, 1, 1, 1, 1] };
    // A source placement with scale + translation (a plausible member matrix).
    const model = new Float32Array([4, 0, 0, 0, 0, 6, 0, 0, 0, 0, 8, 0, 10, 20, 30, 1]);
    const inv = new Float32Array([0.25, 0, 0, 0, 0, 1 / 6, 0, 0, 0, 0, 0.125, 0, -2.5, -20 / 6, -3.75, 1]);
    const out = labelModelMatrices(model, inv, source, label);
    const prod = mul(out.model, out.inv);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) expect(prod[i]).toBeCloseTo(identity[i], 5);
  });

  it("falls back to identity ratios when an extent is missing/zero", () => {
    const source: Level0 = { shape: [1, 1, 1, 0, 100], scale: [1, 1, 1, 1, 1] };
    const label: Level0 = { shape: [1, 1, 1, 40, 50], scale: [1, 1, 1, 1, 1] };
    const out = labelModelMatrices(IDENTITY, IDENTITY, source, label);
    // Y source extent is 0 → ry falls back to 1 (no NaN); X still scales.
    expect(out.model[5]).toBeCloseTo(1, 6);
    expect(out.model[0]).toBeCloseTo(0.5, 6); // rx = 50/100
    expect(Number.isNaN(out.inv[5])).toBe(false);
  });
});
