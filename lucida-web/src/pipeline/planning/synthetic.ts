/**
 * Test fixtures for the planning module.
 *
 * Extracted from `index.ts` so production paths don't need to import the
 * synthetic builders. Re-exported from `index.ts` for callers that
 * already import them through the main entry point.
 */

import type {
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
} from "./index.ts";

/**
 * Create a valid {@link EntitySnapshot} with sensible defaults, merged
 * with overrides. PRD #563 / Slice 1 dropped the `numLevels` field —
 * the level count is always derived from `levels.length`. `parentId`
 * defaults to `null`; supply a parent well id to model a Field on a
 * plate.
 */
export function createSyntheticEntity(
  overrides?: Partial<EntitySnapshot>,
): EntitySnapshot {
  return {
    entityId: "entity-0",
    imageId: "image-0",
    kind: "Image",
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    importance: 1,
    levels: [],
    position: [0, 0],
    parentId: null,
    ...overrides,
  };
}

/** Create a valid {@link PlanningSnapshot} with sensible defaults, merged with overrides. */
export function createSyntheticSnapshot(
  overrides?: Partial<PlanningSnapshot>,
): PlanningSnapshot {
  return {
    datasetId: "synthetic-ds",
    epochs: {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
      asset: 0,
      request: 0,
    },
    entities: [],
    visibleRegion: {
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 1],
      effectiveZoom: 1,
      sortCenter: null,
      frustumPlanes: null,
    },
    selection: {
      t: 0,
      c: 0,
      z: 0,
      visibleChannels: [0],
      renderMode: "slice",
      interactionState: "idle",
    },
    previousActiveSet: [],
    assetCatalog: null,
    minimapPending: new Map<string, MinimapChunkCoord[]>(),
    ...overrides,
  };
}
