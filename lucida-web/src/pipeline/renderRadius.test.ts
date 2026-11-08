import { beforeAll, describe, expect, it } from "vitest";
import type { LevelGeometry } from "../manifestTypes.ts";
import { loadWasm } from "../viewProperties.ts";
import type { VisibleRegion } from "./viewport.ts";
import { createSyntheticEntity, enumerateChunks } from "./planning/index.ts";
import {
  chunkClosestDistanceToVisibleCenterVox,
  chunkWithinRenderRadius,
  RENDER_RADIUS_DISABLED,
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

describe("agreement with the core's chunk enumerator", () => {
  beforeAll(loadWasm);

  /** A level from a `[x, y, z]` shape and chunk shape. */
  function level(index: number, [x, y, z]: number[], [cx, cy, cz]: number[]): LevelGeometry {
    const shape = [1, 1, z, y, x];
    const chunk = [1, 1, cz, cy, cx];
    return {
      level_index: index,
      shape,
      chunk_shape: chunk,
      grid_shape: shape.map((n, i) => Math.ceil(n / chunk[i])),
      scale: [1, 1, 1, 1, 1],
    };
  }

  // Edge chunks, a level coarser than level 0, a placed entity, and regions
  // with and without a sort center or a radius basis.
  const pyramid = [level(0, [1000, 700, 90], [64, 64, 16]), level(1, [500, 350, 45], [64, 64, 16])];
  const regions: VisibleRegion[] = [
    visibleRegion({ xyBoundsVox: [0, 0, 1500, 900], zRangeVox: [0, 90] }),
    visibleRegion({ xyBoundsVox: [200, 100, 1300, 800], zRangeVox: [10, 70], sortCenterVox: [710, 333, 41] }),
    visibleRegion({ xyBoundsVox: [-300, -50, 1800, 1200], zRangeVox: [0, 90], radiusBasisVox: 410, sortCenterVox: [1100, 90, 5] }),
  ];
  const volume: VisibleRegion["frustumPlanes"] = [[0, 0, 1, 0]];

  for (const [r, base] of regions.entries()) {
    for (const frustumPlanes of [null, volume]) {
      it(`keeps the same chunks for region ${r} in ${frustumPlanes ? "3-D" : "2-D"}`, () => {
        const region = { ...base, frustumPlanes };
        let [kept, dropped] = [0, 0];
        for (const layoutPositionVox of [[0, 0], [430, 120]] as [number, number][]) {
          const entity = createSyntheticEntity({ levels: pyramid, layoutPositionVox });
          for (const index of [0, 1]) {
            const geo = pyramid[index];
            const geometry = {
              fullDims: [pyramid[0].shape[4], pyramid[0].shape[3], pyramid[0].shape[2]] as [number, number, number],
              levelDims: [geo.shape[4], geo.shape[3], geo.shape[2]] as [number, number, number],
              chunkDims: [geo.chunk_shape[4], geo.chunk_shape[3], geo.chunk_shape[2]] as [number, number, number],
            };
            for (const radiusView of [0, 0.13, 0.37, 0.71, 1.3]) {
              const cells = (radius: number): string[] => {
                const out: string[] = [];
                enumerateChunks(region, 0, [{ entity, level: index, radiusView: radius }]).forEach(0, (x, y, z) =>
                  out.push(`${x},${y},${z}`),
                );
                return out;
              };
              const all = cells(RENDER_RADIUS_DISABLED);
              const expected = all.filter((key) => {
                const [x, y, z] = key.split(",").map(Number);
                return chunkWithinRenderRadius({ region, radiusView, layoutPositionVox, geometry, chunk: { x, y, z } });
              });
              expect(cells(radiusView), `level ${index} at ${layoutPositionVox}, radius ${radiusView}`).toEqual(expected);
              kept += expected.length;
              dropped += all.length - expected.length;
            }
          }
        }
        // The radii both keep and drop chunks, so the cases test the boundary.
        expect(kept).toBeGreaterThan(0);
        expect(dropped).toBeGreaterThan(0);
      });
    }
  }
});
