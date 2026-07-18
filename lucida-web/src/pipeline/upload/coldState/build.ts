/**
 * Pure end-to-end cold-state message builder. `Uploader.sendColdState`
 * wraps this and owns the side effect (post the message).
 */
import { Axis } from "../../../axes.ts";
import type { LevelGeometry } from "../../../manifestTypes.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDeltaMessage,
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
  entityByImageId: Map<string, EntitySnapshot>,
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>,
  displayStateByChannel: Record<number, ColdStateDisplayState>,
): ColdStateActiveEntry {
  const entity = entityByImageId.get(entry.imageId);
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

  // Identity fallback is defensive: a missing roster match renders at
  // the unit cube — a clear visual failure, not a silent off-screen one.
  const matrices = matricesByEntity.get(entry.entityId);
  const modelMatrix = matrices?.model ?? identityMatrix();
  const invModelMatrix = matrices?.inv ?? identityMatrix();

  if (entry.kind === "invisible") {
    return {
      kind: "tile",
      entityId: entry.entityId,
      layoutPositionVox: entity?.layoutPositionVox,
      imageId: entry.imageId,
      targetLod: entry.coarsestLod,
      detailOwnedLodRange: [entry.coarsestLod, entry.coarsestLod],
      detailLevel: entry.coarsestLod,
      coarseLevel: null,
      wantedLodLevels: [entry.coarsestLod],
      levels,
      modelMatrix,
      invModelMatrix,
      displayStateByChannel,
    };
  }
  // Narrowed: entry is TileEntry.
  return {
    kind: "tile",
    entityId: entry.entityId,
    layoutPositionVox: entity?.layoutPositionVox,
    imageId: entry.imageId,
    targetLod: entry.targetLod,
    detailOwnedLodRange: entry.detailOwnedLodRange,
    detailLevel: entry.detailLevel,
    coarseLevel: entry.coarseLevel,
    wantedLodLevels: entry.wantedLodLevels,
    levels,
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
  epochs: SceneEpochs;
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
  dsSettings: DatasetSettings | undefined;
}): ColdStateMessage {
  const entityByImageId = new Map(args.entities.map(e => [e.imageId, e]));
  const displayStateByChannel = buildDisplayStateByChannel(
    args.selection.visibleChannels,
    args.dsSettings,
  );
  const coldActiveSet = args.activeSet.map(entry =>
    buildColdActiveEntry(entry, entityByImageId, args.matricesByEntity, displayStateByChannel),
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
    activeSet: coldActiveSet,
    viewMode: args.selection.renderMode,
  };
}

/**
 * Worker-side member id for a planner {@link ActiveSetEntry}, matching
 * `memberIdForColdEntry` (the cold-state-entry form) exactly: routes by
 * `imageId`, suffixed `:ch${channel}`
 * in multi-channel mode. Both forms agree because a delta reconstructs the
 * worker's active set from the same planner entries this walks.
 */
export function* iterateActiveSetMembers(
  activeSet: ActiveSetEntry[],
  visibleChannels: number[],
  multiChannel: boolean,
): Generator<string> {
  for (const entry of activeSet) {
    const base = entry.imageId;
    for (const channel of visibleChannels) {
      yield multiChannel ? `${base}:ch${channel}` : base;
    }
  }
}

/**
 * Dense memberId → entityIndex map computed directly from a planner active set
 * (not a built cold-state message). Walks `activeSet × visibleChannels` in the
 * same canonical order as `computeMemberIndexMap`, so the delta path produces
 * the identical index map a full cold state would — the worker rebuilds its
 * descriptor buffer from the reordered active set in this same order.
 */
export function computeActiveSetIndexMap(
  activeSet: ActiveSetEntry[],
  visibleChannels: number[],
  multiChannel: boolean,
): Map<string, number> {
  const indexByMember = new Map<string, number>();
  let next = 0;
  for (const memberId of iterateActiveSetMembers(activeSet, visibleChannels, multiChannel)) {
    if (!indexByMember.has(memberId)) indexByMember.set(memberId, next++);
  }
  return indexByMember;
}

/**
 * Stable key over EVERY field {@link buildColdActiveEntry} reads from a planner
 * entry to build a descriptor — so two entries with equal keys produce a
 * byte-identical descriptor and one can be reused across a view move.
 *
 * Fields NOT included are those that are view-independent within a view move
 * (levels geometry, layout position, model matrix for tiles, per-channel display
 * state, parent group id) — the caller only emits a delta when nothing but the
 * camera moved, so those are provably unchanged and need not be compared.
 */
export function activeEntryReuseKey(entry: ActiveSetEntry): string | null {
  if (entry.kind === "invisible") {
    return `i|${entry.imageId}|${entry.coarsestLod}`;
  }
  return [
    "t",
    entry.imageId,
    entry.targetLod,
    entry.detailOwnedLodRange[0],
    entry.detailOwnedLodRange[1],
    entry.detailLevel,
    entry.coarseLevel ?? "",
    entry.wantedLodLevels.join(","),
  ].join("|");
}

/**
 * Proven entity-delta input for the O(delta) cold-state path. The caller must
 * derive this from the same producer delta used to reconstruct `activeSet`:
 * changed/entered entries are safe to over-upsert, left ids are removals, and
 * entered ids append in producer order. When unavailable the builder performs
 * its existing full diff.
 */
export interface ColdStateEntityDeltaHint {
  upsertEntries: ActiveSetEntry[];
  upsertEntities: EntitySnapshot[];
  removedImageIds: string[];
  appendedImageIds: string[];
}

/**
 * Pure delta builder for a view move. Diffs the new `activeSet` against
 * `previousActiveSet` (what the worker currently holds) on {@link activeEntryReuseKey}
 * — an O(1)-per-entity scalar compare — and emits only the changed/added
 * descriptors, the removed entity ids, and the full new active-set order.
 *
 * Correctness rests on the caller's gate: the delta is only taken when the sole
 * change is a pure view move (only the view epoch advanced), so an entry whose
 * reuse key is unchanged has a byte-identical descriptor and can be retained.
 * When in doubt an entry is treated as changed (over-send is slow-but-correct).
 */
export function buildColdStateDelta(args: {
  datasetId: string;
  activeSet: ActiveSetEntry[];
  previousActiveSet: ActiveSetEntry[];
  entities: EntitySnapshot[];
  selection: SelectionState;
  visibleRegion: VisibleRegion;
  renderRadiusView?: { detail: number; coarse: number };
  epochs: SceneEpochs;
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
  dsSettings: DatasetSettings | undefined;
  entityDeltaHint?: ColdStateEntityDeltaHint;
}): ColdStateDeltaMessage {
  const displayStateByChannel = buildDisplayStateByChannel(
    args.selection.visibleChannels,
    args.dsSettings,
  );

  if (args.entityDeltaHint) {
    const entityByImageId = new Map(
      args.entityDeltaHint.upsertEntities.map((entity) => [entity.imageId, entity]),
    );
    return {
      type: "coldStateDelta",
      epochs: args.epochs,
      datasetId: args.datasetId,
      currentT: args.selection.t,
      currentZ: args.selection.z,
      visibleRegion: args.visibleRegion,
      renderRadiusView: args.renderRadiusView,
      removedImageIds: [...args.entityDeltaHint.removedImageIds],
      upserts: args.entityDeltaHint.upsertEntries.map((entry) =>
        buildColdActiveEntry(
          entry,
          entityByImageId,
          args.matricesByEntity,
          displayStateByChannel,
        )),
      appendedImageIds: [...args.entityDeltaHint.appendedImageIds],
    };
  }

  const entityByImageId = new Map(args.entities.map(e => [e.imageId, e]));

  const oldByImage = new Map<string, ActiveSetEntry>();
  const oldKeyByImage = new Map<string, string | null>();
  for (const e of args.previousActiveSet) {
    oldByImage.set(e.imageId, e);
    oldKeyByImage.set(e.imageId, activeEntryReuseKey(e));
  }

  const upserts: ColdStateActiveEntry[] = [];
  const activeSetOrder: string[] = [];
  const present = new Set<string>();
  for (const entry of args.activeSet) {
    activeSetOrder.push(entry.imageId);
    present.add(entry.imageId);
    const newKey = activeEntryReuseKey(entry);
    const reusable =
      newKey !== null &&
      oldByImage.has(entry.imageId) &&
      oldKeyByImage.get(entry.imageId) === newKey;
    if (!reusable) {
      upserts.push(
        buildColdActiveEntry(entry, entityByImageId, args.matricesByEntity, displayStateByChannel),
      );
    }
  }

  const removedImageIds: string[] = [];
  for (const e of args.previousActiveSet) {
    if (!present.has(e.imageId)) removedImageIds.push(e.imageId);
  }

  return {
    type: "coldStateDelta",
    epochs: args.epochs,
    datasetId: args.datasetId,
    currentT: args.selection.t,
    currentZ: args.selection.z,
    visibleRegion: args.visibleRegion,
    renderRadiusView: args.renderRadiusView,
    removedImageIds,
    upserts,
    activeSetOrder,
  };
}
