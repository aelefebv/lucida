/** Test fixtures for the planning module. */

import type {
  EntitySnapshot,
  FieldSnapshot,
  ImageSnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
  PlanningState,
  WellSnapshot,
} from "./index.ts";

/**
 * Overrides for {@link createSyntheticEntity}. `kind` selects the
 * {@link EntitySnapshot} variant; `parentId` defaults to
 * `"synthetic-well"` for `kind: "Field"` and is ignored otherwise.
 */
export interface CreateSyntheticEntityOverrides
  extends Partial<Omit<FieldSnapshot, "kind" | "parentId">> {
  kind?: "Image" | "Well" | "Field";
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
    importance: overrides?.importance ?? 1,
    layoutPositionVox: overrides?.layoutPositionVox ?? [0, 0],
    levels: overrides?.levels ?? [],
  };
  if (kind === "Field") {
    const field: FieldSnapshot = {
      kind: "Field",
      parentId: overrides?.parentId ?? "synthetic-well",
      ...base,
    };
    return field;
  }
  if (kind === "Well") {
    const well: WellSnapshot = { kind: "Well", ...base };
    return well;
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
      asset: 0,
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
