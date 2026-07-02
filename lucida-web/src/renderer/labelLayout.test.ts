import { describe, it, expect } from "vitest";
import { labelFootprint, type Level0 } from "./labelLayout.ts";

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
