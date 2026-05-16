/**
 * Cold-state message builder.
 *
 * `buildColdState` is the end-to-end pure function that maps the planner's
 * per-dataset output (`activeSet`, `entities`, matrices, settings) into
 * the `ColdStateMessage` the GPU worker consumes. The build is mock-free:
 * the `Orchestrator.sendColdState` wrapper is responsible for the side
 * effect (posting the message + clearing the chunk delivery tracker on
 * rebuild — the latter is hoisted to once-per-tick in Slice 5).
 *
 * `buildColdActiveEntry` collapses the three near-identical
 * `well-as-proxy` / `invisible` / `field` variant literals from the
 * pre-refactor `sendColdState` body into one branching function with one
 * shared computation block (levels, parentWellId, matrices). Slice 6d.
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
 * Map an `ActiveSetEntry` (a discriminated union from the planner) into
 * a flat `ColdStateActiveEntry` (the worker's shape). The shared block
 * — levels, parentWellId, model + inverse matrices, displayStateByChannel
 * — is computed once; per-variant fields (mode, targetLod, proxyKind,
 * etc.) layer on top.
 *
 * Pure. The matrices map and the displayStateByChannel record are
 * passed in by the outer builder (per-tick caches).
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

  // Precomputed model matrices. For field entries, sourced from
  // `scene.member_model_matrix`; for `well-as-proxy` entries, from
  // `synthesizeWellRosterEntry`'s AABB. Falls back to identity for
  // entries without a roster match (defensive — descriptor entries
  // for missing roster members would render at the unit cube, which
  // is a clear visual failure rather than a silent off-screen one).
  const matrices = matricesByEntity.get(entry.entityId);
  const modelMatrix = matrices?.model ?? identityMatrix();
  const invModelMatrix = matrices?.inv ?? identityMatrix();

  if (entry.kind === "well-as-proxy") {
    return {
      kind: "well-as-proxy",
      entityId: entry.entityId,
      targetLod: 0,
      detailOwnedLodRange: [0, 0],
      levels,
      mode: "well-as-proxy",
      proxyKind: "WellProxy3D",
      proxyAvailable: true,
      wellProxyAvailable: true,
      // Wells have no parent well; the `parentWellId` we computed above
      // is unconditionally `null` for the Well snapshot branch, but
      // pin it here so the type checker can narrow `kind: "well-as-proxy"`
      // without re-deriving it.
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
      imageId: entry.imageId,
      targetLod: entry.coarsestLod,
      detailOwnedLodRange: [entry.coarsestLod, entry.coarsestLod],
      levels,
      // Invisibles are mode-less in the planner — surface them to
      // the worker as `fields-with-detail` (the legacy encoding)
      // so the wanted-set rules don't ask for proxies for an
      // entity that won't render this tick.
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
    imageId: entry.imageId,
    targetLod: entry.targetLod,
    detailOwnedLodRange: entry.detailOwnedLodRange,
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
 * End-to-end pure builder for a cold-state message. The orchestrator's
 * `sendColdState` shrinks to: build, post, return. All inputs come from
 * the planner output + per-tick caches (matricesByEntity from
 * {@link buildRoster}; dsSettings from the scene settings cache).
 *
 * Per-tick invariant: every call corresponds to a worker atlas rebuild;
 * the orchestrator's chunk delivery tracker is cleared once per tick
 * before any `buildColdState` call (Slice 5, `deliveryTracker.onColdStateRebuild`).
 */
export function buildColdState(args: {
  datasetId: string;
  activeSet: ActiveSetEntry[];
  entities: EntitySnapshot[];
  selection: SelectionState;
  visibleRegion: VisibleRegion;
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
    visibleChannels: args.selection.visibleChannels,
    visibleRegion: args.visibleRegion,
    activeSet: coldActiveSet,
    viewMode: args.selection.renderMode,
  };
}
