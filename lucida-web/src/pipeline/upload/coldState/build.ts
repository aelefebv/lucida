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

  // `parentGroupId` lets the worker fan out a group-proxy upload to its
  // child tiles' descriptors. Narrowing on `kind === "Tile"` gives a
  // `TileSnapshot` whose `parentId` is non-null by construction.
  const parentGroupId =
    entity?.kind === "Tile" ? entity.parentId : null;

  // Identity fallback is defensive: a missing roster match renders at
  // the unit cube — a clear visual failure, not a silent off-screen one.
  const matrices = matricesByEntity.get(entry.entityId);
  const modelMatrix = matrices?.model ?? identityMatrix();
  const invModelMatrix = matrices?.inv ?? identityMatrix();

  if (entry.kind === "group-as-proxy") {
    return {
      kind: "group-as-proxy",
      entityId: entry.entityId,
      layoutPositionVox: entity?.layoutPositionVox,
      targetLod: 0,
      detailOwnedLodRange: [0, 0],
      detailLevel: 0,
      coarseLevel: null,
      wantedLodLevels: [0],
      levels,
      mode: "group-as-proxy",
      proxyKind: "GroupProxy3D",
      proxyAvailable: true,
      groupProxyAvailable: true,
      // Pinned here (vs reusing the computed value above) so the type
      // checker narrows `kind: "group-as-proxy"` without re-deriving.
      parentGroupId: null,
      modelMatrix,
      invModelMatrix,
      displayStateByChannel,
    };
  }
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
      // Invisibles surface as `tiles-with-detail` so the wanted-set
      // rules don't ask for proxies for an entity that won't render.
      mode: "tiles-with-detail",
      proxyKind: undefined,
      proxyAvailable: false,
      groupProxyAvailable: false,
      parentGroupId,
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
    mode: entry.mode,
    proxyKind: entry.proxyKind,
    proxyAvailable: entry.proxyAvailable,
    groupProxyAvailable: entry.groupProxyAvailable,
    parentGroupId,
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

/**
 * Worker-side member id for a planner {@link ActiveSetEntry}, matching
 * `memberIdForColdEntry` (the cold-state-entry form) exactly: group-as-proxy
 * routes by `entityId`, everything else by `imageId`, suffixed `:ch${channel}`
 * in multi-channel mode. Both forms agree because a delta reconstructs the
 * worker's active set from the same planner entries this walks.
 */
export function* iterateActiveSetMembers(
  activeSet: ActiveSetEntry[],
  visibleChannels: number[],
  multiChannel: boolean,
): Generator<string> {
  for (const entry of activeSet) {
    const base = entry.kind === "group-as-proxy" ? entry.entityId : entry.imageId;
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
 * Returns `null` for `group-as-proxy`: its model matrix is synthesized from the
 * currently-visible child-tile set (see `synthesizeGroupRosterEntry`), which a
 * view move changes, so a group-as-proxy descriptor is never safe to reuse and
 * is always rebuilt.
 *
 * Fields NOT included are those that are view-independent within a view move
 * (levels geometry, layout position, model matrix for tiles, per-channel display
 * state, parent group id) — the caller only emits a delta when nothing but the
 * camera moved, so those are provably unchanged and need not be compared.
 */
export function activeEntryReuseKey(entry: ActiveSetEntry): string | null {
  if (entry.kind === "group-as-proxy") return null;
  if (entry.kind === "invisible") {
    return `i|${entry.imageId}|${entry.coarsestLod}`;
  }
  return [
    "t",
    entry.imageId,
    entry.targetLod,
    entry.detailOwnedLodRange[0],
    entry.detailOwnedLodRange[1],
    entry.detailLevel ?? "",
    entry.coarseLevel ?? "",
    (entry.wantedLodLevels ?? []).join(","),
    entry.mode,
    entry.proxyKind ?? "",
    entry.proxyAvailable ? 1 : 0,
    entry.groupProxyAvailable ? 1 : 0,
  ].join("|");
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
  desiredProxyKeys?: Iterable<string>;
  epochs: SceneEpochs;
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
  dsSettings: DatasetSettings | undefined;
}): ColdStateDeltaMessage {
  const entityById = new Map(args.entities.map(e => [e.entityId, e]));
  const displayStateByChannel = buildDisplayStateByChannel(
    args.selection.visibleChannels,
    args.dsSettings,
  );

  const oldByEntity = new Map<string, ActiveSetEntry>();
  const oldKeyByEntity = new Map<string, string | null>();
  for (const e of args.previousActiveSet) {
    oldByEntity.set(e.entityId, e);
    oldKeyByEntity.set(e.entityId, activeEntryReuseKey(e));
  }

  const upserts: ColdStateActiveEntry[] = [];
  const activeSetOrder: string[] = [];
  const present = new Set<string>();
  for (const entry of args.activeSet) {
    activeSetOrder.push(entry.entityId);
    present.add(entry.entityId);
    const newKey = activeEntryReuseKey(entry);
    const reusable =
      newKey !== null &&
      oldByEntity.has(entry.entityId) &&
      oldKeyByEntity.get(entry.entityId) === newKey;
    if (!reusable) {
      upserts.push(
        buildColdActiveEntry(entry, entityById, args.matricesByEntity, displayStateByChannel),
      );
    }
  }

  const removedEntityIds: string[] = [];
  for (const e of args.previousActiveSet) {
    if (!present.has(e.entityId)) removedEntityIds.push(e.entityId);
  }

  return {
    type: "coldStateDelta",
    epochs: args.epochs,
    datasetId: args.datasetId,
    currentT: args.selection.t,
    currentZ: args.selection.z,
    visibleRegion: args.visibleRegion,
    renderRadiusView: args.renderRadiusView,
    desiredProxyKeys: Array.from(args.desiredProxyKeys ?? []).sort(),
    removedEntityIds,
    upserts,
    activeSetOrder,
  };
}
