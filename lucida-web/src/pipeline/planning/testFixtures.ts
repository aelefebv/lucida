import type { LevelGeometry } from "../../manifestTypes.ts";
import {
  chunkKey,
  createSyntheticEntity,
  createSyntheticSnapshot,
  type MinimapChunkCoord,
} from "./index.ts";

export function level(
  levelIndex: number,
  shape: [number, number, number, number, number],
  chunkShape: [number, number, number, number, number],
  gridShape: [number, number, number, number, number],
): LevelGeometry {
  return {
    level_index: levelIndex,
    shape,
    chunk_shape: chunkShape,
    grid_shape: gridShape,
    scale: [1, 1, 1, 1, 1],
  };
}

export function planningPyramid(): LevelGeometry[] {
  return [
    level(0, [3, 2, 1, 128, 128], [1, 1, 1, 64, 64], [3, 2, 1, 2, 2]),
    level(1, [3, 2, 1, 64, 64], [1, 1, 1, 64, 64], [3, 2, 1, 1, 1]),
  ];
}

export function syntheticImage(
  overrides: Parameters<typeof createSyntheticEntity>[0] = {},
) {
  return createSyntheticEntity({
    entityId: "image-entity",
    imageId: "image-0",
    kind: "Image",
    detailLevel: 0,
    coarseLevel: 1,
    idealTargetLod: 0,
    levels: planningPyramid(),
    ...overrides,
  });
}

export function syntheticPlanningSnapshot(
  overrides: Parameters<typeof createSyntheticSnapshot>[0] = {},
) {
  return createSyntheticSnapshot({
    datasetId: "ds-1",
    entities: [syntheticImage()],
    visibleRegion: {
      xyBoundsVox: [0, 0, 128, 128],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    ...overrides,
  });
}

export function minimapCoord(x: number): MinimapChunkCoord {
  return {
    level: 1,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x,
    key: chunkKey(1, 0, 0, 0, 0, x),
  };
}
