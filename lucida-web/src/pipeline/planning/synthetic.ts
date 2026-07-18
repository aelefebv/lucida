/** Test fixtures for the planning module. */

import type {
  EntitySnapshot,
  TileSnapshot,
  ImageSnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
  PlanningState,
  GroupSnapshot,
} from "./index.ts";

/**
 * Overrides for {@link createSyntheticEntity}. `kind` selects the
 * {@link EntitySnapshot} variant; `parentId` defaults to
 * `"synthetic-group"` for `kind: "Tile"` and is ignored otherwise.
 */
export interface CreateSyntheticEntityOverrides
  extends Partial<Omit<TileSnapshot, "kind" | "parentId">> {
  kind?: "Image" | "Group" | "Tile";
  parentId?: string;
}

/** Build a valid {@link EntitySnapshot} with defaults, merged with overrides. */
export function createSyntheticEntity(
  overrides?: CreateSyntheticEntityOverrides,
): EntitySnapshot {
  const kind = overrides?.kind ?? "Image";
  const base = {
    entityId: overrides?.entityId ?? "entity-0",
    imageId: overrides?.imageId ?? "image-0",
    visible: overrides?.visible ?? true,
    projectedDiagonalPx: overrides?.projectedDiagonalPx ?? 100,
    projectedAreaPx2: overrides?.projectedAreaPx2 ?? 10000,
    centroidWorld: overrides?.centroidWorld ?? [0, 0, 0],
    idealTargetLod: overrides?.idealTargetLod ?? 0,
    detailLevel: overrides?.detailLevel ?? overrides?.idealTargetLod ?? 0,
    coarseLevel: overrides?.coarseLevel ?? null,
    importance: overrides?.importance ?? 1,
    layoutPositionVox: overrides?.layoutPositionVox ?? [0, 0],
    levels: overrides?.levels ?? [],
    sourceDtype: overrides?.sourceDtype ?? "uint16",
  };
  if (kind === "Tile") {
    const tile: TileSnapshot = {
      kind: "Tile",
      parentId: overrides?.parentId ?? "synthetic-group",
      ...base,
    };
    return tile;
  }
  if (kind === "Group") {
    const group: GroupSnapshot = { kind: "Group", ...base };
    return group;
  }
  const image: ImageSnapshot = { kind: "Image", ...base };
  return image;
}

/**
 * Create a valid {@link PlanningSnapshot} with sensible defaults,
 * merged with overrides. `previousActiveSet` does not live on the
 * snapshot — tests that need to seed prev state should construct a
 * {@link PlanningState} (see {@link createSyntheticState}) and pass
 * it via the second argument to `plan()`.
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
      request: 0,
    },
    entities: [],
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
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
    minimapPending: new Map<string, MinimapChunkCoord[]>(),
    ...overrides,
  };
}

/**
 * Construct a {@link PlanningState} for tests. v1 carries a single
 * tile — `previousActiveSet` — so the helper is a thin defaults +
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
