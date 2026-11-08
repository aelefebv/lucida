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
  WantedMemberChunks,
} from "../../../renderer/workerProtocol.ts";
import type { ResolvedLayer } from "../../../resolvedLayers.ts";
import type { SampleFormat } from "../../../renderer/dataTypeUtil.ts";
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

  // Identity fallback is defensive: a missing roster match renders at
  // the unit cube — a clear visual failure, not a silent off-screen one.
  const matrices = matricesByEntity.get(entry.entityId);
  const modelMatrix = matrices?.model ?? identityMatrix();
  const invModelMatrix = matrices?.inv ?? identityMatrix();

  return {
    entityId: entry.entityId,
    layoutPositionVox: entity?.layoutPositionVox,
    imageId: entry.imageId,
    // An invisible entity keeps only its coarsest level and no coarse tier.
    detailLevels: entry.kind === "invisible" ? [entry.coarsestLod] : entry.detailLevels,
    coarseLevel: entry.kind === "invisible" ? null : entry.coarseLevel,
    levels,
    modelMatrix,
    invModelMatrix,
    displayStateByChannel,
  };
}

/**
 * Pure end-to-end builder. Per-tick invariant: every call corresponds
 * to a worker atlas rebuild; the chunk delivery tracker is cleared once
 * per tick via `CpuCache.onPlanRebuildStart` before the first call.
 */
export function buildColdState(args: {
  datasetId: string;
  activeSet: ActiveSetEntry[];
  entities: EntitySnapshot[];
  selection: SelectionState;
  visibleRegion: VisibleRegion;
  renderRadiusView?: { detail: number; coarse: number };
  wantedChunks: WantedMemberChunks[];
  epochs: SceneEpochs;
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
  layer: ResolvedLayer | undefined;
  sampleFormat: SampleFormat;
}): ColdStateMessage {
  const entityById = new Map(args.entities.map(e => [e.entityId, e]));
  const displayStateByChannel = buildDisplayStateByChannel(
    args.layer,
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
    renderRadiusView: args.renderRadiusView,
    wantedChunks: args.wantedChunks,
    activeSet: coldActiveSet,
    viewMode: args.selection.renderMode,
    sampleFormat: args.sampleFormat,
  };
}

/**
 * Worker-side member id for a planner {@link ActiveSetEntry}, matching
 * `memberIdForColdEntry` (the cold-state-entry form) exactly: the `imageId`,
 * suffixed `:ch${channel}`. Both forms agree because a delta reconstructs the
 * worker's active set from the same planner entries this walks.
 */
export function* iterateActiveSetMembers(
  activeSet: ActiveSetEntry[],
  visibleChannels: number[],
): Generator<string> {
  for (const entry of activeSet) {
    for (const channel of visibleChannels) {
      yield `${entry.imageId}:ch${channel}`;
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
): Map<string, number> {
  const indexByMember = new Map<string, number>();
  let next = 0;
  for (const memberId of iterateActiveSetMembers(activeSet, visibleChannels)) {
    if (!indexByMember.has(memberId)) indexByMember.set(memberId, next++);
  }
  return indexByMember;
}

/**
 * Stable key over every view-dependent field {@link buildColdActiveEntry}
 * reads from a planner entry, so equal keys mean a byte-identical descriptor
 * that can be reused across a view move. Fields left out cannot change when
 * only the camera moved, which is the only case the caller emits a delta for.
 */
export function activeEntryReuseKey(entry: ActiveSetEntry): string {
  if (entry.kind === "invisible") {
    return `i|${entry.imageId}|${entry.coarsestLod}`;
  }
  return ["t", entry.imageId, entry.detailLevels.join(","), entry.coarseLevel ?? ""].join("|");
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
  /** The changed entries; see `ColdStateDeltaMessage.wantedChunks`. */
  wantedChunks: WantedMemberChunks[];
  epochs: SceneEpochs;
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
  layer: ResolvedLayer | undefined;
}): ColdStateDeltaMessage {
  const entityById = new Map(args.entities.map(e => [e.entityId, e]));
  const displayStateByChannel = buildDisplayStateByChannel(
    args.layer,
  );

  const oldKeyByEntity = new Map<string, string>();
  for (const e of args.previousActiveSet) {
    oldKeyByEntity.set(e.entityId, activeEntryReuseKey(e));
  }

  const upserts: ColdStateActiveEntry[] = [];
  const activeSetOrder: string[] = [];
  const present = new Set<string>();
  for (const entry of args.activeSet) {
    activeSetOrder.push(entry.entityId);
    present.add(entry.entityId);
    if (oldKeyByEntity.get(entry.entityId) !== activeEntryReuseKey(entry)) {
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
    wantedChunks: args.wantedChunks,
    removedEntityIds,
    upserts,
    activeSetOrder,
  };
}
