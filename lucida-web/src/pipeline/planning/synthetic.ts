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
  PlanningState,
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

/**
 * Create a valid {@link PlanningSnapshot} with sensible defaults,
 * merged with overrides. PRD #563 / Slice 3 dropped
 * `previousActiveSet` from the snapshot — tests that need to seed
 * prev state should construct a {@link PlanningState} (see
 * {@link createSyntheticState}) and pass it via the second argument
 * to `plan()`.
 */
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
    assetCatalog: null,
    minimapPending: new Map<string, MinimapChunkCoord[]>(),
    ...overrides,
  };
}

/**
 * Construct a {@link PlanningState} for tests. v1 carries a single
 * field — `previousActiveSet` — so the helper is a thin defaults +
 * spread. Use this when a test needs to feed a non-empty prev set
 * into `plan(snapshot, state)` (e.g. hysteresis carry-over).
 */
export function createSyntheticState(
  overrides?: Partial<PlanningState>,
): PlanningState {
  return {
    previousActiveSet: [],
    ...overrides,
  };
}
