import { describe, expect, it } from "vitest";
import {
  cutAxis,
  fromPlaneFrame,
  planeAxes,
  sliceChunkIndex,
  sliceChunkRange,
  sliceLevelPlane,
  toPlaneFrame,
} from "./slicePlane.ts";

describe("the plane a slice view cuts", () => {
  it("draws Z down whenever it is on screen and cuts the axis it leaves off", () => {
    expect(planeAxes("xy")).toEqual(["x", "y", "z"]);
    expect(planeAxes("xz")).toEqual(["x", "z", "y"]);
    expect(planeAxes("yz")).toEqual(["y", "z", "x"]);
    expect(["xy", "xz", "yz"].map((p) => cutAxis(p as "xy"))).toEqual(["z", "y", "x"]);
  });

  it("moves values into the plane's frame and back", () => {
    expect(toPlaneFrame([1, 2, 3], "y")).toEqual([1, 3, 2]);
    expect(toPlaneFrame([1, 2, 3], "x")).toEqual([2, 3, 1]);
    expect(toPlaneFrame([1, 2, 3], "z")).toEqual([1, 2, 3]);
    for (const axis of ["x", "y", "z"] as const) {
      expect(fromPlaneFrame(toPlaneFrame([4, 5, 6], axis), axis)).toEqual([4, 5, 6]);
    }
  });
});

describe("sliceLevelPlane", () => {
  it("keeps the plane index on a level as deep as full resolution", () => {
    let mismatches = 0;
    for (let depth = 1; depth <= 300; depth++) {
      for (let z = 0; z < depth; z++) {
        if (sliceLevelPlane(z, depth, depth) !== z) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    expect(sliceLevelPlane(15, 23, 23)).toBe(15);
  });

  it("takes the level plane under the full-resolution plane's center", () => {
    expect(sliceLevelPlane(0, 32, 16)).toBe(0);
    expect(sliceLevelPlane(20, 32, 16)).toBe(10);
    expect(sliceLevelPlane(21, 32, 16)).toBe(10);
    expect(sliceLevelPlane(31, 32, 16)).toBe(15);
    // Plane 2 of 10 straddles level planes 0 and 1 of 4; its center is in 1.
    expect(sliceLevelPlane(2, 10, 4)).toBe(1);
  });

  it("puts the first and last planes of full resolution on the first and last of every level", () => {
    for (let full = 1; full <= 200; full++) {
      for (let level = 1; level <= full; level++) {
        expect(sliceLevelPlane(0, full, level)).toBe(0);
        expect(sliceLevelPlane(full - 1, full, level)).toBe(level - 1);
      }
    }
  });

  it("puts each plane in the level voxel a whole downsampling factor groups it into", () => {
    // With an exact factor, level plane i covers full-resolution planes
    // [i·f, (i + 1)·f): the slab the planner's chunk geometry assumes.
    for (const factor of [2, 3, 4]) {
      for (let z = 0; z < 120; z++) {
        expect(sliceLevelPlane(z, 120, 120 / factor)).toBe(Math.floor(z / factor));
      }
    }
  });

  it("clamps to the level's planes", () => {
    expect(sliceLevelPlane(40, 32, 16)).toBe(15);
    expect(sliceLevelPlane(40, 32, 32)).toBe(31);
    expect(sliceLevelPlane(5, 32, 1)).toBe(0);
    expect(sliceLevelPlane(0, 1, 1)).toBe(0);
    expect(sliceLevelPlane(-3, 32, 16)).toBe(0);
  });
});

describe("sliceChunkIndex", () => {
  it("names the chunk along Z that holds the mapped plane", () => {
    expect(sliceChunkIndex(20, 32, 32, 8)).toBe(2);
    expect(sliceChunkIndex(20, 32, 16, 8)).toBe(1);
    expect(sliceChunkIndex(20, 32, 16, 1)).toBe(10);
  });

  it("starts a chunk exactly where the level-0 slab of that chunk starts", () => {
    // 100 planes over a 50-plane level in chunks 8 planes deep: each chunk
    // spans 16 full-resolution planes, so planes 16, 32, … open a new chunk.
    for (let z = 0; z < 100; z++) {
      expect(sliceChunkIndex(z, 100, 50, 8)).toBe(Math.floor(z / 16));
    }
  });

  it("treats a zero chunk depth as one plane per chunk", () => {
    expect(sliceChunkIndex(7, 32, 32, 0)).toBe(7);
  });
});

describe("sliceChunkRange", () => {
  it("is the one chunk holding a single plane", () => {
    expect(sliceChunkRange(16, 17, 100, 50, 8)).toEqual([1, 2]);
    expect(sliceChunkRange(15, 16, 100, 50, 8)).toEqual([0, 1]);
    // The plane's slab overlaps level planes 0 and 1, but only its center counts.
    expect(sliceChunkRange(2, 3, 10, 4, 1)).toEqual([1, 2]);
  });

  it("spans the chunks of every plane in a wider range, and nothing for an empty one", () => {
    expect(sliceChunkRange(10, 40, 100, 50, 8)).toEqual([0, 3]);
    expect(sliceChunkRange(5, 5, 100, 50, 8)).toEqual([0, 0]);
  });
});
