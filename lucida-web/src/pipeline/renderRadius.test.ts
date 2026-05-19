import { describe, expect, it } from "vitest";
import type { VisibleRegion } from "./viewport.ts";
import { renderRadiusLimitVox } from "./renderRadius.ts";

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
