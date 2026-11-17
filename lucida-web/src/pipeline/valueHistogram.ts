/**
 * A channel's values counted in equal bins, for a person to read behind the
 * contrast control. No contrast limit is taken from it: auto-contrast keeps
 * its own statistics of the same samples.
 */

import type { HistogramBin } from "./generatedAvailability.ts";

/** Bins one histogram holds at most: finer than a bar draws, so a zoomed-in span still has bins to show. */
const MAX_BINS = 4096;

export interface ValueHistogram {
  /** The first bin's low edge. */
  start: number;
  /**
   * Every bin's width. An integer type's bins are whole numbers wide and
   * centred on them, so no bin holds more of the values than another.
   */
  binWidth: number;
  /** How many values fall in each bin; a share of a wider source bin can be a fraction. */
  counts: Float64Array;
}

/** Empty bins over `min` to `max`. */
function emptyHistogram(min: number, max: number, integer: boolean): ValueHistogram {
  if (integer) {
    const values = max - min + 1;
    const binWidth = Math.max(1, Math.ceil(values / MAX_BINS));
    return { start: min - 0.5, binWidth, counts: new Float64Array(Math.max(1, Math.ceil(values / binWidth))) };
  }
  if (!(max > min)) return { start: min - 0.5, binWidth: 1, counts: new Float64Array(1) };
  return { start: min, binWidth: (max - min) / MAX_BINS, counts: new Float64Array(MAX_BINS) };
}

function binOf(h: ValueHistogram, value: number): number {
  const i = Math.floor((value - h.start) / h.binWidth);
  return i < 0 ? 0 : i >= h.counts.length ? h.counts.length - 1 : i;
}

/**
 * Every `thin`th value of each part, over `range`, which holds them all. The
 * fit reads the same thinned samples, so this costs one more pass and no read.
 */
export function histogramOfSamples(
  parts: readonly Float32Array[],
  thin: number,
  range: { min: number; max: number },
  integer: boolean,
): ValueHistogram {
  const h = emptyHistogram(range.min, range.max, integer);
  for (const part of parts) {
    for (let i = 0; i < part.length; i += thin) h.counts[binOf(h, part[i])]++;
  }
  return h;
}

/**
 * The server's bins, over `range`, which holds them all. A server bin is
 * wider than these at large values, so its count is shared out evenly
 * between its smallest and largest sample.
 */
export function histogramOfBins(
  bins: readonly HistogramBin[],
  range: { min: number; max: number },
  integer: boolean,
): ValueHistogram {
  const h = emptyHistogram(range.min, range.max, integer);
  for (const [min, max, count] of bins) {
    if (!(count > 0)) continue;
    // An integer bin holds every whole number from its smallest to its largest.
    const [lo, hi] = integer ? [min - 0.5, max + 0.5] : [min, max];
    if (!(hi > lo)) {
      h.counts[binOf(h, lo)] += count;
      continue;
    }
    const perValue = count / (hi - lo);
    const last = binOf(h, hi);
    for (let k = binOf(h, lo); k <= last; k++) {
      const overlap = Math.min(hi, h.start + (k + 1) * h.binWidth) - Math.max(lo, h.start + k * h.binWidth);
      if (overlap > 0) h.counts[k] += perValue * overlap;
    }
  }
  return h;
}

/** Whether two histograms hold the same counts in the same bins. */
export function sameHistogram(a: ValueHistogram, b: ValueHistogram): boolean {
  if (a.start !== b.start || a.binWidth !== b.binWidth || a.counts.length !== b.counts.length) return false;
  for (let i = 0; i < a.counts.length; i++) if (a.counts[i] !== b.counts[i]) return false;
  return true;
}

/**
 * Heights from 0 to 1 of `columns` equal columns from `lo` to `hi`, on a log
 * scale so a few values in a tail still show beside a peak, and scaled to
 * the tallest column in view. A column wider than a bin counts every value
 * it covers. One narrower than a bin takes that bin's count, so zooming in
 * past the bins shows them as wide as they are, not lower.
 */
export function columnHeights(h: ValueHistogram, lo: number, hi: number, columns: number): Float64Array {
  const out = new Float64Array(columns);
  if (!(hi > lo) || columns <= 0) return out;
  const columnWidth = (hi - lo) / columns;
  const first = Math.max(0, Math.floor((lo - h.start) / h.binWidth));
  const last = Math.min(h.counts.length - 1, Math.floor((hi - h.start) / h.binWidth));
  for (let k = first; k <= last; k++) {
    const count = h.counts[k];
    if (count === 0) continue;
    const binLo = Math.max(lo, h.start + k * h.binWidth);
    const binHi = Math.min(hi, h.start + (k + 1) * h.binWidth);
    if (!(binHi > binLo)) continue;
    const perValue = count / h.binWidth;
    const c0 = Math.floor((binLo - lo) / columnWidth);
    const c1 = Math.min(columns - 1, Math.floor((binHi - lo) / columnWidth));
    for (let c = Math.max(0, c0); c <= c1; c++) {
      const overlap = Math.min(binHi, lo + (c + 1) * columnWidth) - Math.max(binLo, lo + c * columnWidth);
      if (overlap > 0) out[c] += perValue * overlap;
    }
  }
  const toBinCount = Math.max(1, h.binWidth / columnWidth);
  let top = 0;
  for (let c = 0; c < columns; c++) {
    out[c] = Math.log1p(out[c] * toBinCount);
    if (out[c] > top) top = out[c];
  }
  if (top > 0) for (let c = 0; c < columns; c++) out[c] /= top;
  return out;
}
