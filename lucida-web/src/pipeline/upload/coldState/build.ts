/**
 * Pure end-to-end cold-state message builder. `Uploader.sendColdState`
 * wraps this and owns the side effect (post the message).
 */
import { Axis } from "../../../axes.ts";
import type { LevelGeometry } from "../../../manifestTypes.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDisplayState,
  ColdStateMessage,
} from "../../../renderer/workerProtocol.ts";
import type { DatasetSettings } from "../../../tickCommon.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  SelectionState,
} from "../../planning/index.ts";
import type { VisibleRegion } from "../../viewport.ts";
import { identityMatrix } from "./identity.ts";
import { buildDisplayStateByChannel } from "./displayState.ts";

/**
 * Map an `ActiveSetEntry` (discriminated union from the planner) into a
 * flat `ColdStateActiveEntry` (worker's shape). Pure; per-tick caches
 * (matrices, displayState) are passed in by the outer builder.
 */
export function buildColdActiveEntry(
  entry: ActiveSetEntry,
  entityById: Map<string, EntitySnapshot>,
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>,
  displayStateByChannel: Record<number, ColdStateDisplayState>,
): ColdStateActiveEntry {
  const entity = entityById.get(entry.entityId);
  const levels = (entity?.levels ?? []).map((lvl: LevelGeometry, idx: number) => {
    const chunkShape: [number, number, number] = [
      lvl.chunk_shape[Axis.Z], lvl.chunk_shape[Axis.Y], lvl.chunk_shape[Axis.X],
    ];
    const gridShape: [number, number, number] = [
      Math.ceil(lvl.shape[Axis.Z] / lvl.chunk_shape[Axis.Z]),
      Math.ceil(lvl.shape[Axis.Y] / lvl.chunk_shape[Axis.Y]),
      Math.ceil(lvl.shape[Axis.X] / lvl.chunk_shape[Axis.X]),
    ];
    const levelDims: [number, number, number] = [
      lvl.shape[Axis.Z], lvl.shape[Axis.Y], lvl.shape[Axis.X],
    ];
    return { level: idx, chunkShape, gridShape, levelDims };
  });

  // `parentWellId` lets the worker fan out a well-proxy upload to its
  // child fields' descriptors. Narrowing on `kind === "Field"` gives a
  // `FieldSnapshot` whose `parentId` is non-null by construction.
  const parentWellId =
    entity?.kind === "Field" ? entity.parentId : null;

  // Identity fallback is defensive: a missing roster match renders at
  // the unit cube — a clear visual failure, not a silent off-screen one.
  const matrices = matricesByEntity.get(entry.entityId);
  const modelMatrix = matrices?.model ?? identityMatrix();
  const invModelMatrix = matrices?.inv ?? identityMatrix();

  if (entry.kind === "well-as-proxy") {
    return {
      kind: "well-as-proxy",
      entityId: entry.entityId,
      layoutPositionVox: entity?.layoutPositionVox,
      targetLod: 0,
      detailOwnedLodRange: [0, 0],
      detailLevel: 0,
      coarseLevel: null,
      wantedLodLevels: [0],
      levels,
      mode: "well-as-proxy",
      proxyKind: "WellProxy3D",
      proxyAvailable: true,
      wellProxyAvailable: true,
      // Pinned here (vs reusing the computed value above) so the type
      // checker narrows `kind: "well-as-proxy"` without re-deriving.
      parentWellId: null,
      modelMatrix,
      invModelMatrix,
      displayStateByChannel,
    };
  }
  if (entry.kind === "invisible") {
    return {
      kind: "field",
      entityId: entry.entityId,
      layoutPositionVox: entity?.layoutPositionVox,
      imageId: entry.imageId,
      targetLod: entry.coarsestLod,
      detailOwnedLodRange: [entry.coarsestLod, entry.coarsestLod],
      detailLevel: entry.coarsestLod,
      coarseLevel: null,
      wantedLodLevels: [entry.coarsestLod],
      levels,
      // Invisibles surface as `fields-with-detail` so the wanted-set
      // rules don't ask for proxies for an entity that won't render.
      mode: "fields-with-detail",
      proxyKind: undefined,
      proxyAvailable: false,
      wellProxyAvailable: false,
      parentWellId,
      modelMatrix,
      invModelMatrix,
      displayStateByChannel,
    };
  }
  // Narrowed: entry is FieldEntry.
  return {
    kind: "field",
    entityId: entry.entityId,
    layoutPositionVox: entity?.layoutPositionVox,
    imageId: entry.imageId,
    targetLod: entry.targetLod,
    detailOwnedLodRange: entry.detailOwnedLodRange,
    detailLevel: entry.detailLevel,
    coarseLevel: entry.coarseLevel,
    wantedLodLevels: entry.wantedLodLevels,
    levels,
    mode: entry.mode,
    proxyKind: entry.proxyKind,
    proxyAvailable: entry.proxyAvailable,
    wellProxyAvailable: entry.wellProxyAvailable,
    parentWellId,
    modelMatrix,
    invModelMatrix,
    displayStateByChannel,
  };
}

/**
 * Pure end-to-end builder. Per-tick invariant: every call corresponds
 * to a worker atlas rebuild; the chunk delivery tracker is cleared once
 * per tick via `Uploader.onPlanRebuildStart` before the first call.
 */
export function buildColdState(args: {
  datasetId: string;
  activeSet: ActiveSetEntry[];
  entities: EntitySnapshot[];
  selection: SelectionState;
  multiChannel: boolean;
  visibleRegion: VisibleRegion;
  renderRadiusView?: { detail: number; coarse: number };
  desiredProxyKeys?: Iterable<string>;
  epochs: SceneEpochs;
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
  dsSettings: DatasetSettings | undefined;
}): ColdStateMessage {
  const entityById = new Map(args.entities.map(e => [e.entityId, e]));
  const displayStateByChannel = buildDisplayStateByChannel(
    args.selection.visibleChannels,
    args.dsSettings,
  );
  const coldActiveSet = args.activeSet.map(entry =>
    buildColdActiveEntry(entry, entityById, args.matricesByEntity, displayStateByChannel),
  );
  return {
    type: "coldState",
    epochs: args.epochs,
    datasetId: args.datasetId,
    currentT: args.selection.t,
    currentZ: args.selection.z,
    multiChannel: args.multiChannel,
    visibleChannels: args.selection.visibleChannels,
    visibleRegion: args.visibleRegion,
    renderRadiusView: args.renderRadiusView,
    desiredProxyKeys: Array.from(args.desiredProxyKeys ?? []).sort(),
    activeSet: coldActiveSet,
    viewMode: args.selection.renderMode,
  };
}
