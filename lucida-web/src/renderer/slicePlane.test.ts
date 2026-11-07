import { describe, expect, it } from "vitest";
import { sliceChunkZ, sliceLevelZ } from "./slicePlane.ts";

describe("sliceLevelZ", () => {
  it("keeps the plane index on a level as deep as full resolution", () => {
    // The proportional form loses to floating point on many (depth, plane)
    // pairs: (15 / 22) * 22 rounds down to 14. Same depth must be exact.
    let mismatches = 0;
    for (let depth = 1; depth <= 300; depth++) {
      for (let z = 0; z < depth; z++) {
        if (sliceLevelZ(z, depth, depth) !== z) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    expect(sliceLevelZ(15, 23, 23)).toBe(15);
  });

  it("maps the plane onto a shallower level by proportion of the depth", () => {
    expect(sliceLevelZ(0, 32, 16)).toBe(0);
    expect(sliceLevelZ(20, 32, 16)).toBe(9);
    expect(sliceLevelZ(31, 32, 16)).toBe(15);
  });

  it("clamps to the level's planes", () => {
    expect(sliceLevelZ(40, 32, 16)).toBe(15);
    expect(sliceLevelZ(40, 32, 32)).toBe(31);
    expect(sliceLevelZ(5, 32, 1)).toBe(0);
    expect(sliceLevelZ(0, 1, 1)).toBe(0);
  });
});

describe("sliceChunkZ", () => {
  it("names the chunk along Z that holds the mapped plane", () => {
    expect(sliceChunkZ(20, 32, 32, 8)).toBe(2);
    expect(sliceChunkZ(20, 32, 16, 8)).toBe(1);
    expect(sliceChunkZ(20, 32, 16, 1)).toBe(9);
  });

  it("treats a zero chunk depth as one plane per chunk", () => {
    expect(sliceChunkZ(7, 32, 32, 0)).toBe(7);
  });
});
