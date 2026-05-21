import { describe, expect, it } from "vitest";
import type { VisibleRegion } from "./viewport.ts";
import {
  chunkCenterDistanceToVisibleCenterVox,
  chunkClosestDistanceToVisibleCenterVox,
  chunkWithinRenderRadius,
  renderRadiusLimitVox,
} from "./renderRadius.ts";

function visibleRegion(overrides?: Partial<VisibleRegion>): VisibleRegion {
  return {
    xyBoundsVox: [0, 0, 1000, 1000],
    zRangeVox: [0, 100],
    effectiveZoom: 1,
    sortCenterVox: null,
    frustumPlanes: null,
    ...overrides,
  };
}

describe("renderRadiusLimitVox", () => {
  it("uses explicit radius basis when visible region provides one", () => {
    expect(renderRadiusLimitVox(visibleRegion({ radiusBasisVox: 200 }), 0.05)).toBe(10);
  });

  it("falls back to visible-region half diagonal for older region shapes", () => {
    const limit = renderRadiusLimitVox(visibleRegion(), 0.05);
    expect(limit).toBeCloseTo(Math.sqrt(500 * 500 + 500 * 500 + 50 * 50) * 0.05);
  });
});

describe("chunkWithinRenderRadius", () => {
  const geometry = {
    fullDims: [300, 100, 100] as [number, number, number],
    levelDims: [300, 100, 100] as [number, number, number],
    chunkDims: [100, 100, 100] as [number, number, number],
  };

  it("includes a chunk when any part of its bounds enters the radius", () => {
    const region = visibleRegion({
      radiusBasisVox: 50,
      sortCenterVox: [50, 50, 50],
    });
    const args = {
      region,
      radiusView: 1,
      layoutPositionVox: [0, 0] as [number, number],
      geometry,
      chunk: { x: 1, y: 0, z: 0 },
    };

    expect(chunkCenterDistanceToVisibleCenterVox(args)).toBe(100);
    expect(chunkClosestDistanceToVisibleCenterVox(args)).toBe(50);
    expect(chunkWithinRenderRadius(args)).toBe(true);
  });

  it("excludes a chunk whose full bounds stay outside the radius", () => {
    expect(chunkWithinRenderRadius({
      region: visibleRegion({
        radiusBasisVox: 50,
        sortCenterVox: [50, 50, 50],
      }),
      radiusView: 1,
      layoutPositionVox: [0, 0],
      geometry,
      chunk: { x: 2, y: 0, z: 0 },
    })).toBe(false);
  });

  it("includes the chunk containing the focal point at zero radius", () => {
    expect(chunkWithinRenderRadius({
      region: visibleRegion({
        radiusBasisVox: 50,
        sortCenterVox: [150, 50, 50],
      }),
      radiusView: 0,
      layoutPositionVox: [0, 0],
      geometry,
      chunk: { x: 1, y: 0, z: 0 },
    })).toBe(true);
  });
});
