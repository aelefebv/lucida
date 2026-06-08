import { describe, expect, it } from "vitest";

import { intersectSliceViewWithMember, minimapCoarseLevelIndex } from "./minimapPath.ts";
import type { MultiscaleInfo } from "./manifestTypes.ts";

function multiscale(coarseLevelIndex?: number | null): Pick<MultiscaleInfo, "levels" | "coarse_level_index"> {
  return {
    coarse_level_index: coarseLevelIndex,
    levels: [
      { level_index: 0, shape: [1, 1, 1, 1024, 1024], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 4, 4], scale: [1, 1, 1, 1, 1] },
      { level_index: 1, shape: [1, 1, 1, 512, 512], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 2, 2], scale: [1, 1, 1, 2, 2] },
      { level_index: 2, shape: [1, 1, 1, 256, 256], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 1, 1], scale: [1, 1, 1, 4, 4] },
    ],
  };
}

describe("minimapCoarseLevelIndex", () => {
  it("uses the explicit coarse level when present", () => {
    expect(minimapCoarseLevelIndex(multiscale(1))).toBe(1);
  });

  it("does not guess a coarse level when no coarse pointer exists", () => {
    expect(minimapCoarseLevelIndex(multiscale(null))).toBeNull();
    expect(minimapCoarseLevelIndex(multiscale(undefined))).toBeNull();
  });

  it("resolves by level_index before falling back to array index", () => {
    const ms = multiscale(8);
    ms.levels[1] = { ...ms.levels[1], level_index: 8 };
    expect(minimapCoarseLevelIndex(ms)).toBe(1);
  });

  it("uses an appended generated coarse level by level_index", () => {
    const ms = multiscale(8);
    ms.levels.push({
      level_index: 8,
      shape: [1, 1, 1, 128, 128],
      chunk_shape: [1, 1, 1, 128, 128],
      grid_shape: [1, 1, 1, 1, 1],
      scale: [1, 1, 1, 8, 8],
    });
    expect(minimapCoarseLevelIndex(ms)).toBe(3);
  });

  it("uses array index for legacy metadata with no matching level_index", () => {
    const ms = multiscale(1);
    ms.levels = ms.levels.map((level, idx) => ({ ...level, level_index: idx + 10 }));
    expect(minimapCoarseLevelIndex(ms)).toBe(1);
  });
});

describe("intersectSliceViewWithMember", () => {
  const modelMatrix = new Float32Array(16);

  it("keeps bounds unchanged for a member at scene origin", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 100, minY: 120, maxX: 300, maxY: 320 },
      {
        datasetId: "plate",
        memberId: "field-0-image",
        modelMatrix,
        position: [0, 0],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport?.bounds).toEqual({ minX: 100, minY: 120, maxX: 300, maxY: 320 });
    expect(viewport?.memberId).toBe("field-0-image");
  });

  it("translates scene bounds into member-local coordinates", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 1100, minY: 2100, maxX: 1300, maxY: 2300 },
      {
        datasetId: "plate",
        memberId: "field-1-image",
        modelMatrix,
        position: [1000, 2000],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport?.bounds).toEqual({ minX: 100, minY: 100, maxX: 300, maxY: 300 });
  });

  it("clamps partially overlapping bounds to the member extent", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 900, minY: 1900, maxX: 1100, maxY: 2100 },
      {
        datasetId: "plate",
        memberId: "field-1-image",
        modelMatrix,
        position: [1000, 2000],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport?.bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it("returns null when the scene bounds do not overlap the member", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      {
        datasetId: "plate",
        memberId: "field-1-image",
        modelMatrix,
        position: [1000, 2000],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport).toBeNull();
  });
});
