import { describe, expect, it } from "vitest";
import { columnHeights, histogramOfBins, histogramOfSamples, sameHistogram } from "./valueHistogram.ts";

const sum = (counts: Float64Array) => counts.reduce((total, n) => total + n, 0);

describe("histogramOfSamples", () => {
  it("gives each value of a narrow integer range a bin of its own, centred on it", () => {
    const h = histogramOfSamples([Float32Array.from([0, 1, 1, 255])], 1, { min: 0, max: 255 }, true);
    expect(h).toMatchObject({ start: -0.5, binWidth: 1 });
    expect(h.counts).toHaveLength(256);
    expect([h.counts[0], h.counts[1], h.counts[2], h.counts[255]]).toEqual([1, 2, 0, 1]);
  });

  it("gives a wide integer range bins a whole number of values wide", () => {
    const h = histogramOfSamples([Float32Array.from([0, 15, 16, 65535])], 1, { min: 0, max: 65535 }, true);
    expect(h.binWidth).toBe(16);
    expect(h.counts).toHaveLength(4096);
    expect([h.counts[0], h.counts[1], h.counts[4095]]).toEqual([2, 1, 1]);
  });

  it("puts a float range's largest value in its last bin", () => {
    const h = histogramOfSamples([Float32Array.from([-1, 0, 1])], 1, { min: -1, max: 1 }, false);
    expect(h.start).toBe(-1);
    expect(h.counts[0]).toBe(1);
    expect(h.counts[h.counts.length - 1]).toBe(1);
    expect(sum(h.counts)).toBe(3);
  });

  it("counts every thin-th sample of each part, as the fit reads them", () => {
    const part = Float32Array.from({ length: 10 }, (_, i) => i);
    const h = histogramOfSamples([part, part], 3, { min: 0, max: 9 }, true);
    expect(sum(h.counts)).toBe(8);
    expect([h.counts[0], h.counts[3], h.counts[1]]).toEqual([2, 2, 0]);
  });

  it("holds a constant channel in one bin", () => {
    const h = histogramOfSamples([Float32Array.from([4, 4])], 1, { min: 4, max: 4 }, false);
    expect(Array.from(h.counts)).toEqual([2]);
  });
});

describe("histogramOfBins", () => {
  it("shares a wide bin's count evenly between its smallest and largest sample", () => {
    const h = histogramOfBins([[0, 0, 5], [100, 115, 32]], { min: 0, max: 115 }, true);
    expect(h.counts[0]).toBe(5);
    expect(h.counts[100]).toBeCloseTo(2);
    expect(h.counts[115]).toBeCloseTo(2);
    expect(h.counts[50]).toBe(0);
    expect(sum(h.counts)).toBeCloseTo(37);
  });

  it("matches the samples' histogram when every bin holds one value", () => {
    const values = [3, 3, 7, 9, 9, 9];
    const fromSamples = histogramOfSamples([Float32Array.from(values)], 1, { min: 3, max: 9 }, true);
    const fromBins = histogramOfBins([[3, 3, 2], [7, 7, 1], [9, 9, 3]], { min: 3, max: 9 }, true);
    expect(sameHistogram(fromBins, fromSamples)).toBe(true);
  });
});

describe("columnHeights", () => {
  it("draws on a log scale, scaled to the tallest column in view", () => {
    const h = histogramOfSamples([Float32Array.from([0, ...Array(99).fill(1)])], 1, { min: 0, max: 1 }, true);
    // Two columns over -0.5..1.5, one per value.
    const heights = columnHeights(h, -0.5, 1.5, 2);
    expect(heights[0]).toBeCloseTo(Math.log(2) / Math.log(100));
    expect(heights[1]).toBe(1);
  });

  it("gives a column narrower than a bin that bin's count, so zooming in keeps its height", () => {
    const h = histogramOfSamples([Float32Array.from([0, 0, 0, 1])], 1, { min: 0, max: 1 }, true);
    const wide = columnHeights(h, -0.5, 1.5, 2);
    const zoomed = columnHeights(h, -0.5, 1.5, 20);
    expect(zoomed[0]).toBeCloseTo(wide[0]);
    expect(zoomed[15]).toBeCloseTo(wide[1]);
  });

  it("is flat outside the values the histogram holds", () => {
    const h = histogramOfSamples([Float32Array.from([10, 11])], 1, { min: 10, max: 11 }, true);
    const heights = columnHeights(h, 0, 20, 20);
    expect(heights[0]).toBe(0);
    expect(heights[19]).toBe(0);
    expect(heights[10]).toBe(1);
  });
});
