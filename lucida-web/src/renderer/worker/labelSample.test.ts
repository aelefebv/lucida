/**
 * Unit tests for {@link LabelSampleStore} — the worker-side CPU cache + point
 * sample behind the label hover tooltip. Exercised off-thread (pure data), so no
 * GPU / worker harness is needed.
 *
 * Covers the slice's sampling contract:
 *  - reads the value at a fractional position from the **finest resident** level
 *    (a coarser level's fused id is never reported when a finer one is resident);
 *  - keeps `uint32` ids > 65535 intact (no truncation through a narrower type);
 *  - returns `0` outside the volume, for an unknown label, and for a point no
 *    resident chunk covers;
 *  - drops slices on eviction / stale-Z / dataset removal (bounded by residency).
 */

import { describe, it, expect } from "vitest";
import { LabelSampleStore, type LabelLevelGeom } from "./labelSample.ts";

const DS = "ds1";
const MEMBER = "img-label";

/** Level-0 geometry: one 4×4 chunk covering a 4×4×1 label. */
function level0Geom(): LabelLevelGeom {
  return {
    level: 0,
    levelDims: [1, 4, 4], // [Z, Y, X]
    gridDims: [1, 1, 1],
    chunkDims: [1, 4, 4],
  };
}

/** Level-1 geometry: one 2×2 chunk covering a 2×2×1 (half-res) label. */
function level1Geom(): LabelLevelGeom {
  return {
    level: 1,
    levelDims: [1, 2, 2],
    gridDims: [1, 1, 1],
    chunkDims: [1, 2, 2],
  };
}

/** Build a store with the label→member map wired for `DS`/label 0. */
function storeWithLabel(): LabelSampleStore {
  const store = new LabelSampleStore();
  store.setLabelMembers(DS, new Map([[0, new Set([MEMBER])]]));
  return store;
}

/** A 4×4 slice (row-major) with a distinct id per cell, incl. a > 65535 id. */
function level0Slice(): Uint32Array {
  // Row 0: [1, 2, 3, 4]; row 1: [70000, 6, 7, 8]; rows 2/3 fill the rest.
  return new Uint32Array([
    1, 2, 3, 4,
    70000, 6, 7, 8,
    9, 10, 11, 12,
    13, 14, 15, 16,
  ]);
}

describe("LabelSampleStore", () => {
  it("samples the value at a fractional position (finest resident level)", () => {
    const store = storeWithLabel();
    store.recordGeom(MEMBER, level0Geom());
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, level0Slice());

    // fx=0.1 → vx=0 (floor(0.1*4)); fy=0.1 → vy=0 → id 1 (row 0, col 0).
    expect(store.sample(DS, 0, [0.1, 0.1, 0.5])).toBe(1);
    // fx=0.6 → vx=2; fy=0.1 → vy=0 → id 3 (row 0, col 2).
    expect(store.sample(DS, 0, [0.6, 0.1, 0.5])).toBe(3);
    // fx=0.1 → vx=0; fy=0.3 → vy=1 → id 70000 (row 1, col 0).
    expect(store.sample(DS, 0, [0.1, 0.3, 0.5])).toBe(70000);
  });

  it("keeps uint32 ids > 65535 intact (no truncation)", () => {
    const store = storeWithLabel();
    store.recordGeom(MEMBER, level0Geom());
    // A single-cell-relevant slice where the picked cell holds a large id.
    const slice = new Uint32Array(16);
    const big = 4_000_000_003; // > 2^31, and > u16 max.
    slice[0] = big;
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, slice);
    const got = store.sample(DS, 0, [0.0, 0.0, 0.0]);
    expect(got).toBe(big);
    // The truncated-to-u16 value must NOT be what we read.
    expect(got & 0xffff).not.toBe(got);
  });

  it("reads the finest resident level, never a coarse fused id", () => {
    const store = storeWithLabel();
    // Both levels resident. Level 0 (finest) says 42 at the top-left; level 1
    // (coarse) says 999 there. The finest must win.
    store.recordGeom(MEMBER, level0Geom());
    store.recordGeom(MEMBER, level1Geom());
    const fine = new Uint32Array(16);
    fine[0] = 42;
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, fine);
    const coarse = new Uint32Array(4);
    coarse[0] = 999;
    store.putSlice(MEMBER, "1/0/0/0/0/0", 1, 0, 0, 2, 2, coarse);

    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(42);

    // Evict the fine level's chunk → the coarse level now answers.
    store.evict(`${MEMBER}|0/0/0/0/0/0`);
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(999);
  });

  it("returns 0 outside the volume and for an unknown label", () => {
    const store = storeWithLabel();
    store.recordGeom(MEMBER, level0Geom());
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, level0Slice());

    // Out of [0,1) in X / Y.
    expect(store.sample(DS, 0, [1.0, 0.1, 0.5])).toBe(0);
    expect(store.sample(DS, 0, [-0.1, 0.1, 0.5])).toBe(0);
    expect(store.sample(DS, 0, [0.1, 1.5, 0.5])).toBe(0);
    // Unknown label index / dataset.
    expect(store.sample(DS, 9, [0.1, 0.1, 0.5])).toBe(0);
    expect(store.sample("nope", 0, [0.1, 0.1, 0.5])).toBe(0);
  });

  it("returns 0 when no resident chunk covers the point", () => {
    const store = storeWithLabel();
    // Geometry known but nothing resident → 0 (not a throw).
    store.recordGeom(MEMBER, level0Geom());
    expect(store.sample(DS, 0, [0.1, 0.1, 0.5])).toBe(0);
  });

  it("respects a chunk's padded (invalid) region", () => {
    const store = storeWithLabel();
    // A 4-wide chunk but only 2 valid columns / 2 valid rows written; the rest
    // is padding and must not be reported.
    store.recordGeom(MEMBER, level0Geom());
    const slice = new Uint32Array(16);
    slice[0] = 5; // valid (0,0)
    slice[2] = 77; // (row 0, col 2) — in the padded region (chunkW = 2)
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, /*chunkW*/ 2, /*chunkH*/ 2, slice);
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(5);
    // fx=0.6 → col 2, beyond chunkW=2 → treated as not covered → 0.
    expect(store.sample(DS, 0, [0.6, 0.0, 0.0])).toBe(0);
  });

  it("invalidateStale drops a chunk until it is re-cached (Z change)", () => {
    const store = storeWithLabel();
    store.recordGeom(MEMBER, level0Geom());
    const compositeKey = `${MEMBER}|0/0/0/0/0/0`;
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, level0Slice());
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(1);

    store.invalidateStale([compositeKey]);
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(0);

    // Fresh slice for the new Z re-caches under the same key.
    const fresh = new Uint32Array(16);
    fresh[0] = 55;
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, fresh);
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(55);
  });

  it("removeDataset drops the dataset's slices, geometry, and label map", () => {
    const store = storeWithLabel();
    store.recordGeom(MEMBER, level0Geom());
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, level0Slice());
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(1);

    store.removeDataset(DS);
    // Label map gone → 0 even though we might re-point a member later.
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(0);
    // Re-registering the label map alone (no re-upload) still yields 0 — the
    // slice + geometry were dropped too.
    store.setLabelMembers(DS, new Map([[0, new Set([MEMBER])]]));
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(0);
  });

  it("stores an independent copy of the slice (source reuse is safe)", () => {
    const store = storeWithLabel();
    store.recordGeom(MEMBER, level0Geom());
    const src = level0Slice();
    store.putSlice(MEMBER, "0/0/0/0/0/0", 0, 0, 0, 4, 4, src);
    // Mutating the source after caching must not change what the store returns.
    src[0] = 12345;
    expect(store.sample(DS, 0, [0.0, 0.0, 0.0])).toBe(1);
  });
});
