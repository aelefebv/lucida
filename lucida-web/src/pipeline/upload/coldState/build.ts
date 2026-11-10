/**
 * Pure end-to-end cold-state message builder. `Uploader.sendColdState`
 * wraps this and owns the side effect (post the message).
 */
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
import { planeAxes, planeCutting, tczyx, toPlaneFrame, type SpatialAxis } from "../../../renderer/slicePlane.ts";
import { identityMatrix } from "./identity.ts";
import { buildDisplayStateByChannel } from "./displayState.ts";

/**
 * The axis the worker's frame cuts. The slice worker works in the frame of
 * the plane it draws: its X is the axis across the screen, its Y the one
 * down it, and its Z the cut, so an XZ or YZ view reuses every 2-D path an
 * XY one takes. The volume view, and an XY cut, keep X, Y and Z.
 */
export function workerCutAxis(selection: SelectionState): SpatialAxis {
  return selection.renderMode === "slice" ? selection.cut.axis : "z";
}

/**
 * The worker's current Z: the plane the slice view cuts along its cut axis,
 * or the scene's Z in the volume view.
 */
export function workerCutIndex(selection: SelectionState): number {
  return selection.renderMode === "slice" ? selection.cut.index : selection.z;
}

/** `region` in the worker's frame for a view cutting `axis`. */
export function regionInWorkerFrame(region: VisibleRegion, axis: SpatialAxis): VisibleRegion {
  if (axis === "z") return region;
  const [minX, minY, maxX, maxY] = region.xyBoundsVox;
  const [u0, v0, w0] = toPlaneFrame([minX, minY, region.zRangeVox[0]], axis);
  const [u1, v1, w1] = toPlaneFrame([maxX, maxY, region.zRangeVox[1]], axis);
  return {
    ...region,
    xyBoundsVox: [u0, v0, u1, v1],
    zRangeVox: [w0, w1],
    sortCenterVox: region.sortCenterVox && toPlaneFrame(region.sortCenterVox, axis),
    cutAxis: "z",
  };
}

/**
 * A `[T, C, Z, Y, X]` shape as the worker's frame orders it, `[Z, Y, X]`:
 * the cut, the axis down the screen, the axis across it.
 */
function zyxInWorkerFrame(shape: readonly number[], axis: SpatialAxis): [number, number, number] {
  const [across, down, cut] = planeAxes(planeCutting(axis));
  return [shape[tczyx(cut)], shape[tczyx(down)], shape[tczyx(across)]];
}

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
  cutAxis: SpatialAxis = "z",
): ColdStateActiveEntry {
  const entity = entityById.get(entry.entityId);
  const levels = (entity?.levels ?? []).map((lvl: LevelGeometry, idx: number) => {
    const chunkShape = zyxInWorkerFrame(lvl.chunk_shape, cutAxis);
    const levelDims = zyxInWorkerFrame(lvl.shape, cutAxis);
    const gridShape: [number, number, number] = [
      Math.ceil(levelDims[0] / chunkShape[0]),
      Math.ceil(levelDims[1] / chunkShape[1]),
      Math.ceil(levelDims[2] / chunkShape[2]),
    ];
    return { level: idx, chunkShape, gridShape, levelDims };
  });
  // The layout places an image along X and Y. Along the cut it is in its
  // own samples, so only the axes on screen keep their offset.
  const position = entity?.layoutPositionVox;
  const layoutPositionVox = position && cutAxis !== "z"
    ? toPlaneFrame([position[0], position[1], 0], cutAxis).slice(0, 2) as [number, number]
    : position;

  // Identity fallback is defensive: a missing roster match renders at
  // the unit cube — a clear visual failure, not a silent off-screen one.
  const matrices = matricesByEntity.get(entry.entityId);
  const modelMatrix = matrices?.model ?? identityMatrix();
  const invModelMatrix = matrices?.inv ?? identityMatrix();

  return {
    entityId: entry.entityId,
    layoutPositionVox,
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
  const cutAxis = workerCutAxis(args.selection);
  const coldActiveSet = args.activeSet.map(entry =>
    buildColdActiveEntry(entry, entityById, args.matricesByEntity, displayStateByChannel, cutAxis),
  );
  return {
    type: "coldState",
    epochs: args.epochs,
    datasetId: args.datasetId,
    currentT: args.selection.t,
    currentZ: workerCutIndex(args.selection),
    ...(cutAxis !== "z" ? { sliceAxis: cutAxis } : {}),
    visibleChannels: args.selection.visibleChannels,
    visibleRegion: regionInWorkerFrame(args.visibleRegion, cutAxis),
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
  const cutAxis = workerCutAxis(args.selection);

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
        buildColdActiveEntry(entry, entityById, args.matricesByEntity, displayStateByChannel, cutAxis),
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
    currentZ: workerCutIndex(args.selection),
    visibleRegion: regionInWorkerFrame(args.visibleRegion, cutAxis),
    renderRadiusView: args.renderRadiusView,
    wantedChunks: args.wantedChunks,
    removedEntityIds,
    upserts,
    activeSetOrder,
  };
}
