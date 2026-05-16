/**
 * Orchestrator — assembles PlanningSnapshot from live WASM scene state,
 * invokes plan(), and routes the output to CpuCache for fetching and
 * delivery to the GPU worker.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { SceneSettings } from "../tickCommon.ts";
import { Axis } from "../axes.ts";
import type { DatasetManifest, LevelGeometry } from "../manifestTypes.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ColdStateDisplayState,
  ViewHotStateMessage,
  MissingChunk,
  MissingProxy,
} from "../renderer/workerProtocol.ts";
import type { DatasetSettings } from "../tickCommon.ts";
import { computeMemberIndexMap, iterateColdMembers } from "../renderer/descriptorBuffer.ts";
// Note: atlas config messages eliminated — worker manages atlases from cold state
import {
  getSceneSettings,
  compositeKey,
} from "../tickCommon.ts";
import { plan, emptyPlanStats, groupByWell } from "./planning/index.ts";
import { configStore } from "./planning/configStore.ts";
import { buildPlanningSnapshot } from "./planning/snapshot.ts";
import { buildPlanningDatasetDebug } from "./planning/debug.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningState,
  SelectionState,
  ChunkRequest,
  RequestPlan,
} from "./planning/index.ts";
import type { SceneEpochs } from "./epochs.ts";
import type { VisibleRegion } from "./viewport.ts";

// Re-export so existing call sites that imported `MinimapChunkCoord`
// from the orchestrator (e.g. `slicePath.ts`, `volumePath.ts`,
// `renderLoop.ts`, `minimapPath.ts`) keep working unchanged. The
// canonical declaration lives in `pipeline/planning/index.ts` since
// the type is part of the planning snapshot's public shape.
export type { MinimapChunkCoord } from "./planning/index.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
} from "./fetch/index.ts";
import type { ProxyRequest } from "./planning/index.ts";
import {
  debugStats,
  emptyColdStateDebug,
  emptyUploadTickStats,
  type OrchDebug,
  type ColdStateDebug,
  type ColdStateCauseCounts,
  type UploadTickStats,
  type UploadRollingStats,
} from "../debug/debugStats.ts";
import { debugLog } from "../debug/logging.ts";
import {
  COLD_STATE_CHURN_LOG_RATE_LIMIT_MS,
  COLD_STATE_CHURN_SUSTAIN_MS,
  COLD_STATE_CHURN_THRESHOLD_PER_SEC,
  COLD_STATE_DURATION_SAMPLES,
  COLD_STATE_WINDOW_MS,
  UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
  UPLOAD_FILTER_RATIO_THRESHOLD,
  UPLOAD_LOG_RATE_LIMIT_MS,
  UPLOAD_LOG_SUSTAIN_MS,
  UPLOAD_RESEND_RATIO_THRESHOLD,
  UPLOAD_SIZE_SAMPLES,
  UPLOAD_WINDOW_MS,
} from "./upload/constants.ts";
import {
  proxyKeyFromDelivery,
  proxyKeyFromRequest,
} from "./upload/proxyKeys.ts";
import { identityMatrix } from "./upload/coldState/identity.ts";
import { DeliveryTracker } from "./upload/delivery/tracker.ts";

/** Per-epoch cause keys we attribute rebuilds to. */
type ColdStateCauseKey = "content" | "layout" | "view" | "selection" | "asset";

/** A visible member for render layer construction. */
export interface MemberRosterEntry {
  imageId: string;
  position: [number, number];
  /**
   * Entity id from the planning active set entry that produced this
   * roster member. Forwarded to the GPU worker per-layer so it can look
   * up the proxy descriptor for shader binding.
   */
  entityId?: string;
  /**
   * Promotion mode from the planning active set entry. Drives the
   * shader's `renderMode` branch (well-as-proxy direct sample vs
   * detail+proxy fallback). Optional for backward compat.
   */
  mode?: "well-as-proxy" | "fields-with-proxy-fallback" | "fields-with-detail";
  /**
   * Optional precomputed world-space model matrix for the `[0,1]^3` unit
   * cube that bounds this member. When present, the render path uses it
   * instead of querying `scene.member_model_matrix`. Used by
   * `well-as-proxy` entries because wells aren't in `derived.members`
   * and therefore have no native model matrix. Column-major 4×4.
   * `invModelMatrix` is the matching inverse.
   */
  modelMatrix?: Float32Array;
  invModelMatrix?: Float32Array;
  /**
   * Optional 2D world-space footprint of the member (in voxel units, the
   * same coordinate frame as `position`). When present, the slice path
   * uses these instead of the dataset's per-image dataW/dataH for layer
   * sizing — necessary for synthesized `well-as-proxy` entries whose
   * footprint spans multiple field images.
   */
  dataW?: number;
  dataH?: number;
}

export interface OrchestratorResult {
  /** Per-dataset roster of members that need render layers, keyed by dsId. */
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  multiChannel: boolean;
  epochs: SceneEpochs;
  /**
   * Per-dataset memberId → entity index map. Both the worker (when
   * building the descriptor buffer) and the render paths (when
   * assembling layers) read from this map. Computed deterministically
   * from the same `cold.activeSet × cold.visibleChannels` iteration the
   * worker uses, so indices agree by construction.
   */
  entityIndexByDataset: Map<string, Map<string, number>>;
}

/**
 * Build a synthetic roster entry for a `well-as-proxy` entry.
 *
 * Wells aren't in `derived.members` so `scene.member_model_matrix` would
 * return identity for them; instead we compute the well's world-space
 * AABB by unioning each visible field's `[0,1]^3` cube transformed by
 * its own model matrix, then build a translate+scale matrix that maps
 * `[0,1]^3` onto that AABB. The shader marches a ray through this
 * synthetic cube and samples the well's proxy texture once per fragment.
 *
 * Returns `null` if no field model matrices were available (defensive;
 * caller already filters out wells with zero visible fields).
 *
 * @internal Exported for unit tests; not part of the public surface.
 */
export function synthesizeWellRosterEntry(
  ctx: TickContext,
  dsId: string,
  wellEntityId: string,
  childFields: EntitySnapshot[],
): MemberRosterEntry | null {
  // 3D AABB (in 3D world-space, post Y-flip + global correction). Drives
  // the volume path's `modelMatrix` for ray-marching the well as one
  // synthetic cube.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let validCornerCount = 0;
  // 2D AABB (in voxel space). Drives the slice path's `position` and
  // `dataW/dataH` for rendering the well as a flat quad. Voxel-space is
  // a different frame from the 3D model matrix output (no Y-flip, no
  // global scaling), so we must compute it independently.
  let min2DX = Infinity, min2DY = Infinity;
  let max2DX = -Infinity, max2DY = -Infinity;
  let valid2DCount = 0;
  for (const field of childFields) {
    // 2D voxel-space AABB from the field's own position + level0 shape.
    // EntitySnapshot.layoutPositionVox is already in voxel coords (from
    // `scene.member_positions`).
    const fx = field.layoutPositionVox[0];
    const fy = field.layoutPositionVox[1];
    const lvl0 = field.levels[0];
    if (lvl0) {
      const fw = lvl0.shape[Axis.X];
      const fh = lvl0.shape[Axis.Y];
      min2DX = Math.min(min2DX, fx);
      min2DY = Math.min(min2DY, fy);
      max2DX = Math.max(max2DX, fx + fw);
      max2DY = Math.max(max2DY, fy + fh);
      valid2DCount++;
    }

    // 3D world AABB via the field's model matrix.
    const model = ctx.scene.member_model_matrix(dsId, field.imageId);
    if (model.length !== 16) continue;
    for (let i = 0; i < 8; i++) {
      const cx = i & 1;
      const cy = (i >> 1) & 1;
      const cz = (i >> 2) & 1;
      const wx = model[0] * cx + model[4] * cy + model[8] * cz + model[12];
      const wy = model[1] * cx + model[5] * cy + model[9] * cz + model[13];
      const wz = model[2] * cx + model[6] * cy + model[10] * cz + model[14];
      const ww = model[3] * cx + model[7] * cy + model[11] * cz + model[15];
      if (ww === 0) continue;
      const x = wx / ww;
      const y = wy / ww;
      const z = wz / ww;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      validCornerCount++;
    }
  }
  if (validCornerCount === 0 || valid2DCount === 0) return null;
  const sx = maxX - minX;
  const sy = maxY - minY;
  const sz = maxZ - minZ;
  if (sx === 0 || sy === 0 || sz === 0) return null;
  const sx2D = max2DX - min2DX;
  const sy2D = max2DY - min2DY;
  if (sx2D === 0 || sy2D === 0) return null;
  // Column-major 3D model matrix: scale + translate so [0,1]^3 → world AABB.
  const model = new Float32Array([
    sx,   0,    0,    0,
    0,    sy,   0,    0,
    0,    0,    sz,   0,
    minX, minY, minZ, 1,
  ]);
  const inv = new Float32Array([
    1 / sx,         0,              0,              0,
    0,              1 / sy,         0,              0,
    0,              0,              1 / sz,         0,
    -minX / sx,     -minY / sy,     -minZ / sz,     1,
  ]);
  return {
    // imageId stays empty per planning's `well-as-proxy` convention; the
    // worker uses entityId for descriptor lookup, not imageId.
    imageId: wellEntityId,
    // 2D voxel-space position + size for the slice path. Independent of
    // the 3D model matrix above (different coordinate frame).
    position: [min2DX, min2DY],
    entityId: wellEntityId,
    mode: "well-as-proxy",
    modelMatrix: model,
    invModelMatrix: inv,
    dataW: sx2D,
    dataH: sy2D,
  };
}

export class Orchestrator {
  /**
   * Per-dataset opaque planner carry-forward state. The orchestrator
   * stores `result.nextState` after each `plan()` call and threads the
   * matching entry back as the `state` argument on the next tick.
   *
   * The seam between the planner and its caller is the
   * {@link PlanningState} container; future planner state (per-well
   * stickiness, anticipation hints) extends {@link PlanningState}
   * without touching the orchestrator.
   */
  private planningState = new Map<string, PlanningState>();
  private lastEpochs: SceneEpochs | null = null;
  private cachedResult: OrchestratorResult | null = null;
  /**
   * Snapshot of debug member stats produced during the most recent
   * non-cache-hit planning run. Replayed onto `debugStats` when an
   * epoch cache hit returns early; otherwise the panel would show
   * `Visible: 0 / 0` for every idle tick even though the same N
   * members are still being rendered. See DebugPanel "Render" tab.
   */
  private cachedDebugMemberSnapshot: {
    visibleMembers: number;
    totalMembers: number;
    memberStats: typeof debugStats.memberStats;
    selectedLevel: number;
    numLevels: number;
  } | null = null;
  private requestEpoch = 0;
  /**
   * Per-dataset last-emitted viewEpoch. Tracked so `viewHotState` only
   * fires when the camera-ray pick may have moved. Cleared on dataset
   * removal.
   */
  private lastViewEpochByDataset = new Map<string, number>();
  private _lastRequests: ChunkRequest[] = [];
  /**
   * Per-dataset snapshot of the most recent visible region. Keyed by
   * datasetId. Consumed by the `orchDebug` aggregator (which iterates
   * every dataset). Cleared per-dataset by {@link clearMemberResources}.
   */
  private _lastVisibleRegion = new Map<string, VisibleRegion>();
  /**
   * Per-dataset snapshot of the most recent entity list. Keyed by
   * datasetId. Same shape and lifecycle as {@link _lastVisibleRegion}.
   */
  private _lastEntities = new Map<string, EntitySnapshot[]>();
  /**
   * Per-dataset cached-key counts. Outer key is datasetId; inner map
   * is entityId → number of CpuCache-cached chunk keys. Consumed by
   * the `orchDebug` aggregator.
   */
  private _lastCachedKeyCounts = new Map<string, Map<string, number>>();
  /**
   * Per-dataset last filtered requests, kept for the deliverToWorker
   * resend pass on cache hits. Keyed by datasetId so multi-dataset
   * rebuilds preserve every dataset's requests (previously a flat
   * `ChunkRequest[]` was last-dataset-wins; see #613).
   */
  private _lastFilteredRequests = new Map<string, ChunkRequest[]>();
  /**
   * Per-dataset snapshot of the most recent full `plan()` output. Held so
   * the DebugPanel "dump" buttons can print all datasets, not just the
   * last one in iteration order. Cleared per-dataset by
   * {@link clearMemberResources}.
   */
  private _lastPlanByDataset = new Map<string, RequestPlan>();
  /**
   * Per-dataset last proxy requests produced by `plan()`, kept for the
   * deliverToWorker proxy resend pass on cache hits (see `:735-751`).
   * Not re-submitted to CpuCache — fetches stay alive on their own now
   * that submit is additive. Keyed by datasetId so multi-dataset
   * rebuilds preserve every dataset's proxy requests (see #613).
   */
  private _lastProxyRequests = new Map<string, ProxyRequest[]>();

  /**
   * Delivery state for both chunks and proxies. Owns four maps that
   * were previously scattered as orchestrator fields
   * (`deliverySentToWorker`, `deliveryRejectedByWorker`, `widToEntityId`,
   * `proxyDeliveredToWorker`). The implicit lifetime invariants
   * ("clear sent / rejected / wid on every cold-state rebuild", "proxy
   * delivery survives cold state") are encoded as method contracts on
   * the tracker. See Seam F of the dechaos boundary scan.
   */
  private deliveryTracker = new DeliveryTracker();

  // -------------------------------------------------------------------------
  // Cold-state rebuild telemetry. See COLD_STATE_* constants above.
  // -------------------------------------------------------------------------

  /**
   * Rolling 1s window of cold-state events. Each tick of `planAndFetch`
   * appends one entry (either a hit or a rebuild); entries older than
   * `COLD_STATE_WINDOW_MS` are pruned in {@link pruneColdStateWindow}.
   * The DebugPanel "Render" tab + header pulse derive from this.
   */
  private coldStateEvents: Array<{
    at: number;
    kind: "hit" | "rebuild";
    /** Empty for hits and for the very first rebuild (no prior epochs to diff). */
    causes: ColdStateCauseKey[];
    /** Wall-clock duration of the rebuild path; undefined for hits. */
    durationMs?: number;
  }> = [];
  private coldStateRebuildCount = 0;
  private coldStateHitCount = 0;
  private coldStateCauseTotal: ColdStateCauseCounts = {
    content: 0, layout: 0, view: 0, selection: 0, asset: 0,
  };
  /** Bounded sample buffer for p50/p95 rebuild duration. FIFO. */
  private coldStateRebuildDurations: number[] = [];
  private coldStateLastRebuildAt = 0;
  private coldStateLastRebuildMs: number | null = null;
  /**
   * Cached `ColdStateDebug` snapshot. Updated each tick by
   * {@link publishColdStateDebug}. Read by both the hit and rebuild
   * branches of `planAndFetch` to populate `debugStats.orch.coldState`.
   */
  private coldStateDebug: ColdStateDebug = emptyColdStateDebug();
  /**
   * Sustained-non-view-churn detector. `aboveThresholdSince` tracks the
   * timestamp at which we crossed `COLD_STATE_CHURN_THRESHOLD_PER_SEC`;
   * `lastLogAt` rate-limits `cold_state.churn` events.
   */
  private coldStateChurnState = {
    aboveThresholdSince: null as number | null,
    lastLogAt: 0,
  };

  // -------------------------------------------------------------------------
  // Upload telemetry (deliverToWorker). See UPLOAD_* constants above.
  // -------------------------------------------------------------------------

  /**
   * Per-tick stats for the in-progress `deliverToWorker` call. Reset
   * to zero at the start of each call; sendDeliveryToWorker /
   * sendProxyDeliveryToWorker mutate the skip/byte fields directly.
   * Published to debugStats and pushed onto the rolling window at end
   * of tick.
   */
  private currentUploadStats: UploadTickStats = emptyUploadTickStats();

  /**
   * Rolling 1s window of upload events. Each successful upload (drain
   * or resend, chunk or proxy) appends one entry; pruned on each
   * `deliverToWorker` call.
   */
  private uploadEvents: Array<{
    at: number;
    bytes: number;
    isResend: boolean;
  }> = [];
  /**
   * Rolling 1s window of per-tick aggregates. Lets us compute the
   * filter ratio (drained vs filtered) and the
   * `budgetExhaustedTicksLastSecond` count without re-summing per
   * upload event.
   */
  private uploadTickWindow: Array<{
    at: number;
    drained: number;
    drainedChunks: number;
    uploaded: number;
    skipped: number;
    skippedPrefetch: number;
    skippedOverview: number;
    skippedWrongLod: number;
    skippedAlreadySent: number;
    skippedNoMeta: number;
    budgetExhausted: boolean;
  }> = [];
  /** Bounded sample buffer for p50/p95 upload size. FIFO. */
  private uploadSizeSamples: number[] = [];
  private uploadTotalBytes = 0;
  private uploadTotalUploads = 0;
  private uploadConsecutiveExhausted = 0;
  /** Sustained-condition state for the three upload log events. */
  private uploadLogState = {
    budgetExhaustedLastLogAt: 0,
    resendStormSince: null as number | null,
    resendStormLastLogAt: 0,
    drainWasteSince: null as number | null,
    drainWasteLastLogAt: 0,
  };

  /**
   * Unsubscribe from the planning configStore. Called from {@link dispose}
   * so the orchestrator doesn't leak subscriptions in tests that
   * construct it standalone. The render loop singleton lives for the app
   * lifetime so `dispose` is rarely needed in production.
   */
  private configStoreUnsub: () => void;

  constructor() {
    // Subscribe to live planning-config changes. A config tweak doesn't
    // bump any WASM epoch, so without this hook the orchestrator's
    // epoch fast-path would keep returning the cached plan and the
    // user's slider would have no visible effect until something else
    // (camera motion, selection change) invalidated the cache.
    //
    // The render loop separately calls `markInteractiveDirty()` from
    // its own configStore subscription (so a frame is requested
    // promptly); here we just clear the cache so that frame produces a
    // fresh plan from the new config values.
    this.configStoreUnsub = configStore.subscribe(() => {
      this.lastEpochs = null;
      this.cachedResult = null;
    });
  }

  /** Tear down subscriptions held by this orchestrator. */
  dispose(): void {
    this.configStoreUnsub();
  }

  planAndFetch(
    ctx: TickContext,
    minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  ): OrchestratorResult | null {
    const tickStart = performance.now();

    // Step 1 — Epoch check
    const rawEpochs = JSON.parse(ctx.scene.epochs());
    const currentEpochs: SceneEpochs = {
      content: rawEpochs.content,
      layout: rawEpochs.layout,
      view: rawEpochs.view,
      selection: rawEpochs.selection,
      // `asset_epoch()` is the authoritative source. Older WASM builds
      // without the binding fall back to 0 (functional no-op).
      asset:
        typeof ctx.scene.asset_epoch === "function"
          ? ctx.scene.asset_epoch()
          : (rawEpochs.asset ?? 0),
      request: this.requestEpoch,
    };

    // Diff against last epochs — drives both the cache-hit decision and
    // the per-epoch cause attribution we publish to coldState telemetry.
    // The first call sees `lastEpochs == null` and falls through to
    // rebuild with empty causes (init has no causes to attribute).
    const hasPrior = this.lastEpochs !== null && this.cachedResult !== null;
    let isHit = false;
    const causes: ColdStateCauseKey[] = [];
    if (hasPrior) {
      const last = this.lastEpochs!;
      if (currentEpochs.content !== last.content) causes.push("content");
      if (currentEpochs.layout !== last.layout) causes.push("layout");
      if (currentEpochs.view !== last.view) causes.push("view");
      if (currentEpochs.selection !== last.selection) causes.push("selection");
      if (currentEpochs.asset !== last.asset) causes.push("asset");
      isHit = causes.length === 0;
    }

    if (isHit) {
      this.recordColdStateHit(tickStart);
      if (debugStats.enabled && debugStats.orch) {
        debugStats.orch.epochCacheHit = true;
        debugStats.orch.coldState = this.coldStateDebug;
      }
      // Replay member stats from the last full planning run so the panel
      // doesn't blink to "Visible: 0 / 0" between non-planning ticks.
      if (debugStats.enabled && this.cachedDebugMemberSnapshot) {
        const s = this.cachedDebugMemberSnapshot;
        debugStats.visibleMembers = s.visibleMembers;
        debugStats.totalMembers = s.totalMembers;
        debugStats.memberStats = [...s.memberStats];
        debugStats.selectedLevel = s.selectedLevel;
        debugStats.numLevels = s.numLevels;
      }
      return this.cachedResult;
    }

    // Cold-state rebuild path. Drop worker-rejection state on both
    // sides — the camera, active set, or selection has shifted enough
    // that previously-too-far chunks may now fit. `onColdStateRebuild`
    // clears chunk sent / rejected / wid-to-entity tracking in one
    // shot; the per-dataset loop below re-populates wid→entity from
    // the new `_lastFilteredRequests` via `recordMember`. Proxy
    // tracking survives — worker proxy pools persist across cold state.
    this.deliveryTracker.onColdStateRebuild();
    ctx.cpuCache.clearRejected();

    // Step 2 — Settings
    const settings = getSceneSettings(ctx.scene);
    const multiChannel = ctx.scene.multi_channel();

    // Read the live config once per tick. Holding a single reference keeps
    // every dataset in this rebuild in sync even if a UI knob fires between
    // dataset iterations (the subscriber-side cache invalidation will
    // re-rebuild on the next tick from the new value).
    const planningConfig = configStore.get();

    // Step 3 — Per-dataset loop
    const memberRoster = new Map<string, MemberRosterEntry[]>();
    const entityIndexByDataset = new Map<string, Map<string, number>>();

    for (const [dsId, ds] of ctx.datasets) {
      // 3a. Skip invisible datasets
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) continue;

      // 3b. Build the planning snapshot from live WASM state. Returns
      // null when `view_query` produces no visible entities (dataset
      // not yet registered, etc.) — skip the dataset in that case.
      // `minimapPendingFetch` flows through into the snapshot so the
      // planner emits minimap-lane requests at the highest priority
      // (see ADR 0023).
      const built = buildPlanningSnapshot({
        scene: ctx.scene,
        datasetId: dsId,
        dataset: ds,
        dsSettings,
        assetCatalog: ctx.assetCatalog.snapshot(),
        minimapPending: minimapPendingFetch,
        mode: ctx.mode as "slice" | "volume",
        multiChannel,
        currentEpochs,
        requestEpoch: this.requestEpoch,
        config: planningConfig,
      });
      if (!built) continue;
      const { snapshot, entities, visibleRegion, selection } = built;

      // 3c. Track per-entity cache occupancy for telemetry. Planning no
      // longer filters cached chunks (CpuCache.submit() refreshes them
      // and dedups internally), so _lastFilteredRequests sees every
      // requested chunk and the re-send loop can find any of them.
      const cachedKeyCountsForDataset = new Map<string, number>();
      for (const entity of entities) {
        const cachedKeys = ctx.cpuCache.snapshot().cached.get(entity.entityId);
        cachedKeyCountsForDataset.set(entity.entityId, cachedKeys?.size ?? 0);
      }
      this._lastCachedKeyCounts.set(dsId, cachedKeyCountsForDataset);

      // 3d. Plan. The opaque carry-forward state travels separately
      // from the snapshot via {@link PlanningState}; we store the
      // planner-returned `nextState` for the next tick.
      const planningStateForDataset = this.planningState.get(dsId)
        ?? { previousActiveSet: [] };
      const result = plan(snapshot, planningStateForDataset, planningConfig);
      this.planningState.set(dsId, result.nextState);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion.set(dsId, visibleRegion);
      this._lastEntities.set(dsId, entities);
      this._lastPlanByDataset.set(dsId, result);

      const entityById = new Map(entities.map(e => [e.entityId, e]));

      // Per-dataset planning debug snapshot (lanes, per-LOD breakdown,
      // wells-by-mode, focal entity, culling stages, catalog
      // degradations). Computed before downstream side-effects so the
      // panel reflects what `plan()` actually produced for this dataset
      // — not, for example, the post-LOD-filter view used by the upload
      // path. Cache-hit ticks leave the previous snapshot in place.
      if (debugStats.enabled) {
        debugStats.planning.byDataset[dsId] = buildPlanningDatasetDebug(
          dsId, result, entities, entityById, visibleRegion, ctx.cpuCache,
          planningConfig,
        );
      }

      // The planner stamps `datasetId` onto every ChunkRequest and
      // ProxyRequest at emit time (from `snapshot.datasetId`); no
      // post-`plan()` mutation pass is needed here.
      this._lastProxyRequests.set(dsId, result.proxyRequests);

      // 3i. Track this dataset's requests for re-send / wid-mapping.
      // No LOD-filter step gates the request stream: planning emits
      // exactly one level per entity. `_lastFilteredRequests` keeps
      // its historical name for compatibility with the re-send loop
      // below. Per-dataset map so multi-dataset rebuilds preserve every
      // dataset's requests (see #613).
      this._lastFilteredRequests.set(dsId, result.requests);
      // Build wid → entityId for this dataset so handleChunksEvicted
      // can resolve `cpuCache.markRejected(entityId, ...)` from the
      // worker's report (which carries workerMemberId, not entityId).
      // Pre-populated here at plan time so an eviction that arrives
      // before any chunk has been sent still resolves the entityId.
      // Multi-dataset case: rebuilt cumulatively across the loop since
      // `onColdStateRebuild` clears once at the top of the rebuild path.
      for (const req of result.requests) {
        const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
        this.deliveryTracker.recordMember(wid, req.entityId);
      }
      // Note: proxy delivery tracking is NOT cleared here. Worker proxy pools
      // persist across cold states (they're created lazily in getOrCreateProxyPool
      // and only destroyed on dataset removal). Re-sending proxies on every full
      // plan would upload-spam them every time a view epoch bumps (e.g., wheel
      // scroll). When the worker actually evicts a proxy, its wantedSetDelta
      // reports it as missing and handleWantedSetDelta clears the per-entry
      // tracking, triggering re-delivery on the next tick.

      // 3j. Build member roster from active set for render layer construction.
      // Forward the planning entry's entityId + mode so the render path
      // can dispatch per-mode (well-as-proxy emits one layer per well;
      // field modes iterate fields).
      //
      // For `well-as-proxy` entries the well typically isn't in the
      // visible_entities query result (which iterates `derived.members`
      // — image-level members only). We synthesize a roster entry by
      // computing the well's world-space AABB from its visible fields,
      // building a precomputed model matrix that maps the unit cube
      // [0,1]^3 onto that AABB, and stashing the well's entityId for
      // proxy descriptor lookup in the worker.
      // Use the planning module's canonical well-grouping (ADR 0025) so
      // the orchestrator agrees with `assignModes` on which fields make
      // up each well group. `groupByWell` filters to visible entities;
      // `well-as-proxy` entries only exist for groups with at least one
      // visible field, so the AABB built from this map matches what
      // planning saw when it picked the mode.
      const fieldsByWell = new Map<string, EntitySnapshot[]>();
      for (const group of groupByWell(entities)) {
        if (group.fields.length > 0) {
          fieldsByWell.set(group.wellId, group.fields);
        }
      }
      const rosterEntries: MemberRosterEntry[] = [];
      for (const entry of result.activeSet) {
        if (entry.kind === "well-as-proxy") {
          // Synthetic well member. Compute AABB from constituent fields.
          const childFields = fieldsByWell.get(entry.entityId) ?? [];
          if (childFields.length === 0) continue; // no geometry to render
          const synth = synthesizeWellRosterEntry(ctx, dsId, entry.entityId, childFields);
          if (synth) rosterEntries.push(synth);
          continue;
        }
        // Invisible entries don't render — skip them in the roster.
        if (entry.kind === "invisible") continue;
        // Narrowed: entry is FieldEntry below.
        const entity = entityById.get(entry.entityId);
        if (entity) {
          rosterEntries.push({
            imageId: entity.imageId,
            position: entity.layoutPositionVox,
            entityId: entry.entityId,
            mode: entry.mode,
          });
        }
      }
      memberRoster.set(dsId, rosterEntries);

      // Build a model-matrix lookup keyed by entityId so cold state
      // includes precomputed model matrices (worker can't query WASM,
      // and `well-as-proxy` matrices were already synthesised here).
      const matricesByEntity = new Map<string, { model: Float32Array; inv: Float32Array }>();
      for (const r of rosterEntries) {
        if (!r.entityId) continue;
        const model = r.modelMatrix
          ?? new Float32Array(ctx.scene.member_model_matrix(dsId, r.imageId));
        const inv = r.invModelMatrix
          ?? new Float32Array(ctx.scene.inv_member_model_matrix(dsId, r.imageId));
        matricesByEntity.set(r.entityId, { model, inv });
      }

      // Send cold state to the worker — drives atlas creation/remap +
      // wanted-set + descriptor buffer build. Passes dataset settings so
      // per-channel display state (contrast/gamma/opacity/colormap) gets
      // baked into descriptor entries.
      const coldMsg = this.sendColdState(
        dsId, result.activeSet, entities, selection, visibleRegion,
        currentEpochs, ctx, matricesByEntity, dsSettings,
      );
      // Compute the same memberId → entityIndex map the worker builds
      // from cold state. Both sides converge by construction because
      // they walk the same canonical iteration order.
      entityIndexByDataset.set(dsId, computeMemberIndexMap(coldMsg));

      // Emit viewEpoch hot-state with per-entity ray-pick coords. Posted
      // before subsequent render messages so the worker's
      // `rayHitPerEntity` is current when chunk-data eviction fires.
      // Keyed by memberId (imageId or imageId:chN) — same convention
      // chunk-data uses for `findFarthestSlot` distance lookups.
      const lastView = this.lastViewEpochByDataset.get(dsId);
      if (lastView !== currentEpochs.view) {
        this.sendViewHotState(dsId, coldMsg, ctx, currentEpochs);
        this.lastViewEpochByDataset.set(dsId, currentEpochs.view);
      }

      // Chunk delivery tracking was cleared once at the top of the
      // rebuild path via `deliveryTracker.onColdStateRebuild()` — see
      // the comment above the call. The worker rebuilds slice/volume
      // atlas pools on each cold state, so all chunks must be re-
      // uploaded to fill the rebuilt atlases; the tracker reset
      // ensures the resend pass sees every chunk as un-sent.

      // Submit chunk + proxy requests in a single call so they don't
      // cancel each other. Proxies sit in their own queue inside
      // CpuCache but share the cancellation contract: if the next
      // plan omits a request, its in-flight fetch is aborted.
      //
      // Minimap requests arrive through `result.requests` with
      // `lane: "minimap"` and `priority: MINIMAP_LANE_OFFSET` (= 0,
      // highest priority); the planner stamps `datasetId` on every
      // emitted request directly, so no orchestrator-side mutation
      // is needed.
      ctx.cpuCache.submit({
        requests: result.requests,
        activeSet: result.activeSet,
        proxyRequests: result.proxyRequests,
        epochs: currentEpochs,
        stats: result.stats,
        // `nextState` is required on RequestPlan but unused by submit();
        // forward the planner's pointer so the shape stays honest.
        nextState: result.nextState,
      });

      // Debug stats
      if (debugStats.enabled) {
        for (const entity of entities) {
          debugStats.totalMembers++;
          debugStats.visibleMembers++;
          const activeEntry = result.activeSet.find(
            (a) => a.entityId === entity.entityId,
          );
          // Only field entries carry `targetLod`; well-as-proxy has
          // no LOD bookkeeping, invisibles report their coarsest LOD
          // instead. Surface -1 for non-field entries to mirror the
          // historical "no level selected" sentinel.
          const tl =
            activeEntry?.kind === "field"
              ? activeEntry.targetLod
              : activeEntry?.kind === "invisible"
                ? activeEntry.coarsestLod
                : -1;
          const memberKey = multiChannel
            ? compositeKey(entity.imageId, selection.c)
            : entity.imageId;
          debugStats.memberStats.push({
            id: memberKey,
            level: tl,
            numLevels: entity.levels.length,
            chunksNeeded: result.requests.filter(
              (r) => r.entityId === entity.entityId && r.lane !== "prefetch",
            ).length,
            chunksSent: 0,
          });
          if (tl >= 0) {
            debugStats.selectedLevel = tl;
            debugStats.numLevels = entity.levels.length;
          }
        }
      }
    }

    // Step 4 — Orchestrator debug snapshot
    if (debugStats.enabled) {
      // Aggregate from all per-dataset state (active sets, visible
      // regions, entity diagnostics, cached-key counts). Multi-dataset
      // rebuilds previously kept only the last-processed dataset's
      // snapshot for these fields; #613 made the underlying state
      // per-dataset, so the aggregator now walks every entry.
      const orchDebug: OrchDebug = {
        activeSet: [],
        laneCount: { detail: 0, prefetch: 0, overview: 0 },
        chunksByLevel: {},
        topRequests: [],
        members: [],
        hasMixedLevels: false,
        epochCacheHit: false,
        // Replaced after `recordColdStateRebuild` below — placeholder
        // here so the type checks during the in-progress assembly.
        coldState: this.coldStateDebug,
        visibleRegion: null,
        entityDiag: [],
      };

      // Aggregate from member roster
      for (const [_key, entries] of memberRoster) {
        for (const m of entries) {
          orchDebug.members.push({
            imageId: m.imageId,
            position: m.position,
            neededCount: 0,
            prefetchCount: 0,
            uploadLevel: undefined,
            chunksByLevel: {},
            mixedLevels: false,
          });
        }
      }

      // Aggregate from all per-dataset plan results
      // Re-run is wasteful, so we read the planner's carry-forward
      // state — its `previousActiveSet` field is exactly the active
      // set produced by the most recent `plan()` call for that dataset.
      //
      // ActiveSetEntry is a discriminated union; per-variant fields
      // are derived from `kind`:
      //   - well-as-proxy → mode column reads "well-as-proxy",
      //     LOD columns are zero (no LOD bookkeeping for this variant);
      //   - field        → mode column reads the field's promotion mode,
      //     LOD columns come from the field entry;
      //   - invisible    → mode column reads "invisible", LOD columns
      //     report the entity's coarsest LOD (the only level it owns).
      for (const [, state] of this.planningState) {
        for (const entry of state.previousActiveSet) {
          if (entry.kind === "well-as-proxy") {
            orchDebug.activeSet.push({
              entityId: entry.entityId,
              mode: "well-as-proxy",
              targetLod: 0,
              coarsestDetailLod: 0,
              detailOwnedLodRange: [0, 0],
            });
          } else if (entry.kind === "field") {
            orchDebug.activeSet.push({
              entityId: entry.entityId,
              mode: entry.mode,
              targetLod: entry.targetLod,
              coarsestDetailLod: entry.coarsestDetailLod,
              detailOwnedLodRange: entry.detailOwnedLodRange,
            });
          } else {
            // invisible
            orchDebug.activeSet.push({
              entityId: entry.entityId,
              mode: "invisible",
              targetLod: entry.coarsestLod,
              coarsestDetailLod: entry.coarsestLod,
              detailOwnedLodRange: [entry.coarsestLod, entry.coarsestLod],
            });
          }
        }
      }

      // Store last plan's request stats (use the last dataset's plan for simplicity)
      if (this._lastRequests) {
        for (const r of this._lastRequests) {
          if (r.lane === "detail") orchDebug.laneCount.detail++;
          else if (r.lane === "prefetch") orchDebug.laneCount.prefetch++;
          else orchDebug.laneCount.overview++;
          orchDebug.chunksByLevel[r.level] = (orchDebug.chunksByLevel[r.level] ?? 0) + 1;
        }
        orchDebug.topRequests = this._lastRequests.slice(0, 20).map(r => ({
          entityId: r.entityId,
          level: r.level,
          t: r.t, c: r.c, z: r.z, y: r.y, x: r.x,
          lane: r.lane,
          priority: r.priority,
          chunkKey: r.chunkKey,
        }));
      }

      // Coordinate diagnostic. OrchDebug exposes a single
      // `visibleRegion` field; pick the first dataset's region (insertion
      // order matches dataset iteration in step 3) so it's deterministic
      // and matches the single-dataset case verbatim. Multi-dataset
      // consumers wanting every region can read the per-dataset map
      // directly via the orchestrator (debug surface only).
      const firstVisibleRegion = this._lastVisibleRegion.values().next().value;
      orchDebug.visibleRegion = firstVisibleRegion
        ? {
            xyBounds: firstVisibleRegion.xyBoundsVox,
            zRange: firstVisibleRegion.zRangeVox,
            effectiveZoom: firstVisibleRegion.effectiveZoom,
          }
        : null;
      // entityDiag is a flat array on the wire; aggregate the first
      // 5 entities across every dataset so multi-dataset debug isn't
      // truncated to the last-processed dataset's first 5 (the prior
      // last-dataset-wins behavior).
      const entityDiagEntries: OrchDebug["entityDiag"] = [];
      for (const [dsId, entities] of this._lastEntities) {
        const cachedKeyCountsForDataset = this._lastCachedKeyCounts.get(dsId);
        for (const e of entities) {
          if (entityDiagEntries.length >= 5) break;
          entityDiagEntries.push({
            entityId: e.entityId,
            position: e.layoutPositionVox,
            fullShape: e.levels.length > 0
              ? [e.levels[0].shape[Axis.X], e.levels[0].shape[Axis.Y]] as [number, number]
              : null,
            cachedKeys: cachedKeyCountsForDataset?.get(e.entityId) ?? 0,
          });
        }
        if (entityDiagEntries.length >= 5) break;
      }
      orchDebug.entityDiag = entityDiagEntries;

      debugStats.orch = orchDebug;
    }

    // Step 5 — Cache and return
    this.lastEpochs = currentEpochs;
    this.cachedResult = { memberRoster, settings, multiChannel, epochs: currentEpochs, entityIndexByDataset };
    if (debugStats.enabled) {
      this.cachedDebugMemberSnapshot = {
        visibleMembers: debugStats.visibleMembers,
        totalMembers: debugStats.totalMembers,
        memberStats: [...debugStats.memberStats],
        selectedLevel: debugStats.selectedLevel,
        numLevels: debugStats.numLevels,
      };
    }

    // Cold-state telemetry: record this rebuild's cause + duration, then
    // refresh the snapshot we attached to orchDebug above. Doing this
    // *after* step 4 means the OrchDebug published this tick reflects
    // the rebuild we just did.
    const tickEnd = performance.now();
    this.recordColdStateRebuild(tickStart, causes, tickEnd - tickStart);
    if (debugStats.enabled && debugStats.orch) {
      debugStats.orch.coldState = this.coldStateDebug;
    }

    return this.cachedResult;
  }

  // -------------------------------------------------------------------------
  // Cold-state telemetry helpers — see private fields above for state.
  // -------------------------------------------------------------------------

  private recordColdStateHit(now: number): void {
    this.coldStateHitCount++;
    this.coldStateEvents.push({ at: now, kind: "hit", causes: [] });
    this.pruneColdStateWindow(now);
    this.publishColdStateDebug();
  }

  private recordColdStateRebuild(
    now: number,
    causes: ColdStateCauseKey[],
    durationMs: number,
  ): void {
    this.coldStateRebuildCount++;
    for (const c of causes) this.coldStateCauseTotal[c]++;
    this.coldStateLastRebuildAt = now;
    this.coldStateLastRebuildMs = durationMs;
    this.coldStateRebuildDurations.push(durationMs);
    if (this.coldStateRebuildDurations.length > COLD_STATE_DURATION_SAMPLES) {
      this.coldStateRebuildDurations.shift();
    }
    this.coldStateEvents.push({ at: now, kind: "rebuild", causes, durationMs });
    this.pruneColdStateWindow(now);
    this.maybeLogColdStateChurn(now);
    this.publishColdStateDebug();
  }

  private pruneColdStateWindow(now: number): void {
    const cutoff = now - COLD_STATE_WINDOW_MS;
    while (this.coldStateEvents.length > 0 && this.coldStateEvents[0].at < cutoff) {
      this.coldStateEvents.shift();
    }
  }

  /**
   * Sustained-non-view-churn detector. Camera motion legitimately bumps
   * `view` at high rates, so we ignore it here; any *other* epoch
   * sustaining > {@link COLD_STATE_CHURN_THRESHOLD_PER_SEC} for >
   * {@link COLD_STATE_CHURN_SUSTAIN_MS} fires one rate-limited log line
   * with the dominant cause. Mirrors the `cache.backpressure` pattern.
   */
  private maybeLogColdStateChurn(now: number): void {
    let nonViewRebuilds = 0;
    const causeCounts: Record<string, number> = {};
    for (const e of this.coldStateEvents) {
      if (e.kind !== "rebuild") continue;
      let nonView = false;
      for (const c of e.causes) {
        if (c === "view") continue;
        nonView = true;
        causeCounts[c] = (causeCounts[c] ?? 0) + 1;
      }
      if (nonView) nonViewRebuilds++;
    }

    const above = nonViewRebuilds > COLD_STATE_CHURN_THRESHOLD_PER_SEC;
    if (!above) {
      this.coldStateChurnState.aboveThresholdSince = null;
      return;
    }

    if (this.coldStateChurnState.aboveThresholdSince === null) {
      this.coldStateChurnState.aboveThresholdSince = now;
      return;
    }

    const sustainedFor = now - this.coldStateChurnState.aboveThresholdSince;
    const sinceLastLog = now - this.coldStateChurnState.lastLogAt;
    if (sustainedFor < COLD_STATE_CHURN_SUSTAIN_MS) return;
    if (sinceLastLog < COLD_STATE_CHURN_LOG_RATE_LIMIT_MS) return;

    const dominant =
      Object.entries(causeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
    debugLog("orch", "cold_state.churn", {
      rebuildsLastSec: this.coldStateEvents.filter(e => e.kind === "rebuild").length,
      nonViewRebuildsLastSec: nonViewRebuilds,
      dominantCause: dominant,
      causeCountsLastSec: causeCounts,
      sustainedMs: Math.round(sustainedFor),
    });
    this.coldStateChurnState.lastLogAt = now;
  }

  private publishColdStateDebug(): void {
    let rebuilds = 0;
    let hits = 0;
    const causeLastSecond: ColdStateCauseCounts = {
      content: 0, layout: 0, view: 0, selection: 0, asset: 0,
    };
    for (const e of this.coldStateEvents) {
      if (e.kind === "rebuild") {
        rebuilds++;
        for (const c of e.causes) causeLastSecond[c]++;
      } else {
        hits++;
      }
    }
    const total = rebuilds + hits;

    let p50: number | null = null;
    let p95: number | null = null;
    if (this.coldStateRebuildDurations.length > 0) {
      const sorted = [...this.coldStateRebuildDurations].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    this.coldStateDebug = {
      rebuilds: this.coldStateRebuildCount,
      cacheHits: this.coldStateHitCount,
      hitRate: total > 0 ? hits / total : NaN,
      rebuildsLastSecond: rebuilds,
      hitsLastSecond: hits,
      causeLastSecond,
      causeTotal: { ...this.coldStateCauseTotal },
      lastRebuildMs: this.coldStateLastRebuildMs,
      rebuildP50Ms: p50,
      rebuildP95Ms: p95,
      lastRebuildAt: this.coldStateLastRebuildAt,
    };
  }

  // -------------------------------------------------------------------------
  // Upload telemetry helpers — see UPLOAD_* constants and private fields above.
  // -------------------------------------------------------------------------

  /** Record one upload event (drain-path or resend-path) into the rolling window. */
  private recordUploadEvent(now: number, bytes: number, isResend: boolean): void {
    this.uploadEvents.push({ at: now, bytes, isResend });
    this.uploadSizeSamples.push(bytes);
    if (this.uploadSizeSamples.length > UPLOAD_SIZE_SAMPLES) {
      this.uploadSizeSamples.shift();
    }
    this.uploadTotalBytes += bytes;
    this.uploadTotalUploads += 1;
  }

  /**
   * Aggregate `currentUploadStats` into the rolling window, derive
   * rolling stats, fire anomaly logs, and publish to debugStats.
   * Called at the end of each `deliverToWorker` invocation.
   */
  private publishUploadStats(now: number): void {
    const skipped =
      this.currentUploadStats.skippedPrefetch +
      this.currentUploadStats.skippedOverview +
      this.currentUploadStats.skippedWrongLod +
      this.currentUploadStats.skippedAlreadySent +
      this.currentUploadStats.skippedNoMeta;
    const drained =
      this.currentUploadStats.drainedChunks + this.currentUploadStats.drainedProxies;
    const uploaded =
      this.currentUploadStats.uploadedChunks + this.currentUploadStats.uploadedProxies;
    this.uploadTickWindow.push({
      at: now,
      drained,
      drainedChunks: this.currentUploadStats.drainedChunks,
      uploaded,
      skipped,
      skippedPrefetch: this.currentUploadStats.skippedPrefetch,
      skippedOverview: this.currentUploadStats.skippedOverview,
      skippedWrongLod: this.currentUploadStats.skippedWrongLod,
      skippedAlreadySent: this.currentUploadStats.skippedAlreadySent,
      skippedNoMeta: this.currentUploadStats.skippedNoMeta,
      budgetExhausted: this.currentUploadStats.budgetExhausted,
    });

    const cutoff = now - UPLOAD_WINDOW_MS;
    while (this.uploadEvents.length > 0 && this.uploadEvents[0].at < cutoff) {
      this.uploadEvents.shift();
    }
    while (this.uploadTickWindow.length > 0 && this.uploadTickWindow[0].at < cutoff) {
      this.uploadTickWindow.shift();
    }

    let bytesInWindow = 0;
    let uploadsInWindow = 0;
    let resendUploads = 0;
    for (const e of this.uploadEvents) {
      bytesInWindow += e.bytes;
      uploadsInWindow += 1;
      if (e.isResend) resendUploads += 1;
    }
    let drainedInWindow = 0;
    let drainedChunksInWindow = 0;
    let skippedInWindow = 0;
    let exhaustedTicks = 0;
    let winSkippedPrefetch = 0;
    let winSkippedOverview = 0;
    let winSkippedWrongLod = 0;
    let winSkippedAlreadySent = 0;
    let winSkippedNoMeta = 0;
    for (const t of this.uploadTickWindow) {
      drainedInWindow += t.drained;
      drainedChunksInWindow += t.drainedChunks;
      skippedInWindow += t.skipped;
      winSkippedPrefetch += t.skippedPrefetch;
      winSkippedOverview += t.skippedOverview;
      winSkippedWrongLod += t.skippedWrongLod;
      winSkippedAlreadySent += t.skippedAlreadySent;
      winSkippedNoMeta += t.skippedNoMeta;
      if (t.budgetExhausted) exhaustedTicks += 1;
    }
    const skippedInWindowByCause = {
      skippedPrefetch: winSkippedPrefetch,
      skippedOverview: winSkippedOverview,
      skippedWrongLod: winSkippedWrongLod,
      skippedAlreadySent: winSkippedAlreadySent,
      skippedNoMeta: winSkippedNoMeta,
    };
    // Upload-bound counts: chunks that were *meant* to upload to the
    // main GPU atlas. Excludes prefetch (cache-only), overview
    // (minimap path), and proxies (separate atlas + always-uploads).
    const drainedUploadBoundInWindow =
      drainedChunksInWindow - winSkippedPrefetch - winSkippedOverview;
    const skippedUploadBoundInWindow =
      winSkippedWrongLod + winSkippedAlreadySent + winSkippedNoMeta;

    let p50: number | null = null;
    let p95: number | null = null;
    if (this.uploadSizeSamples.length > 0) {
      const sorted = [...this.uploadSizeSamples].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    const rolling: UploadRollingStats = {
      // Window is exactly UPLOAD_WINDOW_MS = 1000 ms, so bytes-in-window
      // equals bytes-per-sec by construction.
      bytesPerSec: bytesInWindow,
      uploadsPerSec: uploadsInWindow,
      resendRatio: uploadsInWindow > 0 ? resendUploads / uploadsInWindow : NaN,
      filterRatio:
        drainedUploadBoundInWindow > 0
          ? skippedUploadBoundInWindow / drainedUploadBoundInWindow
          : NaN,
      uploadSizeP50: p50,
      uploadSizeP95: p95,
      totalBytes: this.uploadTotalBytes,
      totalUploads: this.uploadTotalUploads,
      budgetExhaustedTicksLastSecond: exhaustedTicks,
    };

    this.maybeLogUploadAnomalies(now, rolling, {
      drainedInWindow,
      skippedInWindow,
      drainedUploadBoundInWindow,
      skippedUploadBoundInWindow,
      byCause: skippedInWindowByCause,
    });

    if (debugStats.enabled) {
      debugStats.upload = {
        tick: { ...this.currentUploadStats },
        rolling,
      };
    }
  }

  /**
   * Three sustained-anomaly detectors:
   *
   * 1. `upload.budget_exhausted_sustained` — N consecutive ticks where
   *    `budgetExhausted=true`. Indicates the CPU→GPU pipe is saturated;
   *    upload work is being deferred to subsequent ticks.
   * 2. `upload.resend_storm` — most uploads come from the resend pass,
   *    sustained > 2s. Worker is evicting faster than fresh decodes
   *    can fill; usually pool capacity vs working set mismatch.
   * 3. `upload.drain_waste` — most drained chunks are filtered out,
   *    sustained > 2s. Decode pool is burning cycles on chunks the GPU
   *    no longer wants — often a planning/wanted-set sync issue.
   */
  private maybeLogUploadAnomalies(
    now: number,
    rolling: UploadRollingStats,
    window: {
      drainedInWindow: number;
      skippedInWindow: number;
      drainedUploadBoundInWindow: number;
      skippedUploadBoundInWindow: number;
      byCause: {
        skippedPrefetch: number;
        skippedOverview: number;
        skippedWrongLod: number;
        skippedAlreadySent: number;
        skippedNoMeta: number;
      };
    },
  ): void {
    // 1. Sustained budget exhaustion — count consecutive ticks.
    if (this.currentUploadStats.budgetExhausted) {
      this.uploadConsecutiveExhausted += 1;
      if (
        this.uploadConsecutiveExhausted >= UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD &&
        now - this.uploadLogState.budgetExhaustedLastLogAt >= UPLOAD_LOG_RATE_LIMIT_MS
      ) {
        debugLog("orch", "upload.budget_exhausted_sustained", {
          consecutiveTicks: this.uploadConsecutiveExhausted,
          bytesUploadedThisTick: this.currentUploadStats.bytesUploaded,
          bytesBudget: this.currentUploadStats.bytesBudget,
        });
        this.uploadLogState.budgetExhaustedLastLogAt = now;
      }
    } else {
      this.uploadConsecutiveExhausted = 0;
    }

    // 2. Resend storm.
    if (
      !Number.isNaN(rolling.resendRatio) &&
      rolling.resendRatio > UPLOAD_RESEND_RATIO_THRESHOLD
    ) {
      if (this.uploadLogState.resendStormSince === null) {
        this.uploadLogState.resendStormSince = now;
      } else {
        const sustained = now - this.uploadLogState.resendStormSince;
        if (
          sustained >= UPLOAD_LOG_SUSTAIN_MS &&
          now - this.uploadLogState.resendStormLastLogAt >= UPLOAD_LOG_RATE_LIMIT_MS
        ) {
          debugLog("orch", "upload.resend_storm", {
            resendRatio: rolling.resendRatio,
            uploadsPerSec: rolling.uploadsPerSec,
            sustainedMs: Math.round(sustained),
          });
          this.uploadLogState.resendStormLastLogAt = now;
        }
      }
    } else {
      this.uploadLogState.resendStormSince = null;
    }

    // 3. Drain waste.
    if (
      !Number.isNaN(rolling.filterRatio) &&
      rolling.filterRatio > UPLOAD_FILTER_RATIO_THRESHOLD
    ) {
      if (this.uploadLogState.drainWasteSince === null) {
        this.uploadLogState.drainWasteSince = now;
      } else {
        const sustained = now - this.uploadLogState.drainWasteSince;
        if (
          sustained >= UPLOAD_LOG_SUSTAIN_MS &&
          now - this.uploadLogState.drainWasteLastLogAt >= UPLOAD_LOG_RATE_LIMIT_MS
        ) {
          debugLog("orch", "upload.drain_waste", {
            // filterRatio is now upload-bound: skipped non-prefetch /
            // (drained chunks − prefetch − overview). High = real
            // planning/wanted-set sync issue (chunks meant to upload
            // got filtered for stale-LOD, already-sent, or no-meta).
            filterRatio: rolling.filterRatio,
            drainedUploadBoundInWindow: window.drainedUploadBoundInWindow,
            skippedUploadBoundInWindow: window.skippedUploadBoundInWindow,
            skippedWrongLod: window.byCause.skippedWrongLod,
            skippedAlreadySent: window.byCause.skippedAlreadySent,
            skippedNoMeta: window.byCause.skippedNoMeta,
            // Informational — prefetch/overview decode load doesn't
            // count toward the ratio, but it's useful context for
            // "was the decode pool busy this window?".
            skippedPrefetch: window.byCause.skippedPrefetch,
            skippedOverview: window.byCause.skippedOverview,
            sustainedMs: Math.round(sustained),
          });
          this.uploadLogState.drainWasteLastLogAt = now;
        }
      }
    } else {
      this.uploadLogState.drainWasteSince = null;
    }
  }

  /**
   * Deliver decoded chunks to the GPU worker via RenderClient. Called
   * from slicePath/volumePath.
   *
   * Telemetry: writes per-tick stats to `currentUploadStats` and pushes
   * to the rolling window via `publishUploadStats`. Skip reasons are
   * incremented either inline (for lane / wrong-lod filters that the
   * caller checks) or inside `sendDeliveryToWorker` (for the
   * already-sent / no-meta cases the helper detects).
   */
  deliverToWorker(
    ctx: TickContext,
    budget: number,
    sliceZ: number | null,
  ): boolean {
    const tickStart = performance.now();
    this.currentUploadStats = emptyUploadTickStats();
    this.currentUploadStats.bytesBudget = budget;

    const multiChannel = ctx.scene.multi_channel();
    const epochs = this.lastEpochs ?? { content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 };
    let remaining = budget;
    let budgetExhausted = false;

    // Build target level map from current plan for LOD filtering.
    // Merge across all datasets so multi-dataset rebuilds see every
    // dataset's requested levels, not just the last-processed one
    // (see #613).
    const targetLevelByImage = new Map<string, number>();
    for (const requests of this._lastFilteredRequests.values()) {
      for (const req of requests) {
        targetLevelByImage.set(req.imageId, req.level);
      }
    }

    // Drain new deliveries from CpuCache
    const deliveries = ctx.cpuCache.drain(budget);
    for (const d of deliveries) {
      if (d.kind === "proxy") this.currentUploadStats.drainedProxies++;
      else this.currentUploadStats.drainedChunks++;
    }

    // Send each delivery to the worker.
    for (const delivery of deliveries) {
      if (delivery.kind === "proxy") {
        // Proxies are routed to a dedicated worker message.
        const sent = this.sendProxyDeliveryToWorker(ctx, delivery, epochs);
        if (sent > 0) {
          this.currentUploadStats.uploadedProxies++;
          this.currentUploadStats.bytesUploaded += sent;
          this.recordUploadEvent(tickStart, sent, false);
          remaining -= sent;
          if (remaining <= 0) {
            budgetExhausted = true;
            break;
          }
        }
        continue;
      }
      // Chunk path. Skip prefetch (pre-cached for future timepoints),
      // overview (minimap path), and wrong-LOD chunks (stale requests
      // from a previous plan).
      if (delivery.lane === "prefetch") {
        this.currentUploadStats.skippedPrefetch++;
        continue;
      }
      if (delivery.lane === "overview") {
        this.currentUploadStats.skippedOverview++;
        continue;
      }
      const target = targetLevelByImage.get(delivery.imageId);
      if (target === undefined || delivery.level !== target) {
        this.currentUploadStats.skippedWrongLod++;
        continue;
      }
      const sent = this.sendDeliveryToWorker(ctx, delivery, multiChannel, sliceZ, epochs);
      if (sent > 0) {
        this.currentUploadStats.uploadedChunks++;
        this.currentUploadStats.bytesUploaded += sent;
        this.recordUploadEvent(tickStart, sent, false);
        remaining -= sent;
        if (remaining <= 0) {
          budgetExhausted = true;
          break;
        }
      }
      // sent === 0 → skippedAlreadySent or skippedNoMeta — the helper
      // mutated currentUploadStats accordingly.
    }

    // Re-send evicted chunks (budget permitting).
    // Use _lastFilteredRequests (target-level only) to avoid flipping the atlas
    // config between levels, which clears the sent set and causes flickering.
    // Iterate every dataset's requests so multi-dataset rebuilds resend
    // for every dataset, not just the last-processed one (see #613).
    if (!budgetExhausted) {
      outer: for (const requests of this._lastFilteredRequests.values()) {
        for (const req of requests) {
          if (budgetExhausted) break outer;
          if (req.lane === "prefetch") continue;
          this.currentUploadStats.resendChunksConsidered++;

          const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
          if (this.deliveryTracker.wasChunkSent(wid, req.chunkKey)) {
            this.currentUploadStats.resendChunksAlreadySent++;
            continue;
          }

          // Worker rejected this chunk under the current camera (atlas
          // full + too far). Don't re-attempt until the next cold-state
          // rebuild clears the tracker's rejection state.
          if (this.deliveryTracker.wasChunkRejected(wid, req.chunkKey)) {
            this.currentUploadStats.resendChunksRejected++;
            continue;
          }

          const cached = ctx.cpuCache.getCachedChunk(req.entityId, req.chunkKey);
          if (!cached) {
            this.currentUploadStats.resendChunksNotCached++;
            continue;
          }

          const sent = this.sendDeliveryToWorker(ctx, cached, multiChannel, sliceZ, epochs);
          if (sent > 0) {
            this.currentUploadStats.resendChunkUploads++;
            this.currentUploadStats.bytesUploaded += sent;
            this.recordUploadEvent(tickStart, sent, true);
            remaining -= sent;
            if (remaining <= 0) budgetExhausted = true;
          }
        }
      }
    }

    // Re-send proxies the worker has evicted (or never received because
    // the previous tick cleared the tracker's proxy-delivered entry).
    // Mirrors the chunk resend pass: iterate the last-known proxy
    // request set, skip anything already tracked as delivered, and
    // look up the cached entry via `getCachedProxy`. New deliveries
    // (above) populate the tracker themselves; this pass closes the
    // gap for cache hits where `submit()` is now a no-op. Iterate
    // every dataset's proxy requests so multi-dataset rebuilds resend
    // for every dataset, not just the last-processed one (see #613).
    if (!budgetExhausted) {
      outer: for (const requests of this._lastProxyRequests.values()) {
        for (const req of requests) {
          if (budgetExhausted) break outer;
          this.currentUploadStats.resendProxiesConsidered++;

          if (this.deliveryTracker.wasProxyDelivered(proxyKeyFromRequest(req))) {
            this.currentUploadStats.resendProxiesAlreadyDelivered++;
            continue;
          }

          const cached = ctx.cpuCache.getCachedProxy(
            req.datasetId, req.entityId, req.kind, req.t, req.c,
          );
          if (!cached) {
            this.currentUploadStats.resendProxiesNotCached++;
            continue;
          }

          const sent = this.sendProxyDeliveryToWorker(ctx, cached, epochs);
          if (sent > 0) {
            this.currentUploadStats.resendProxyUploads++;
            this.currentUploadStats.bytesUploaded += sent;
            this.recordUploadEvent(tickStart, sent, true);
            remaining -= sent;
            if (remaining <= 0) budgetExhausted = true;
          }
        }
      }
    }

    this.currentUploadStats.budgetExhausted = budgetExhausted;
    this.publishUploadStats(tickStart);

    return deliveries.length > 0 || budgetExhausted;
  }

  /**
   * Process a worker `chunksEvicted` report.
   *
   * `evicted` chunks were in the atlas and got displaced by closer
   * arrivals — they should be re-eligible for upload (the orch may
   * still want them under the same plan).
   *
   * `skipped` chunks never made it into the atlas (full + incoming
   * farther than the farthest existing slot). Without rejection
   * tracking they would be re-sent every tick by the resend pass,
   * driving `upload.resend_storm`. The tracker adds them to its
   * rejected set so the resend pass can short-circuit; the orchestrator
   * then forwards each skipped-with-known-entityId to
   * `cpuCache.markRejected` so the cache stops re-fetching them
   * under eviction churn.
   *
   * Both sets are removed from the tracker's sent set (skipped chunks
   * were optimistically added there by `sendDeliveryToWorker`).
   * Evicted chunks are also removed from the rejected set since
   * acceptance + later eviction proves the chunk was deliverable.
   */
  handleChunksEvicted(
    workerMemberId: string,
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
  ): void {
    const { rejectedNew } = this.deliveryTracker.markChunkEvicted(
      workerMemberId, evicted, skipped,
    );
    for (const { entityId, chunkKey } of rejectedNew) {
      cpuCache.markRejected(entityId, chunkKey);
    }
  }

  /**
   * Process a wanted-set delta from the GPU worker.
   *
   * For each missing proxy, clear the entry from the tracker's
   * proxy-delivered set so the next tick's resend pass picks it up
   * via `getCachedProxy`. Chunk entries are ignored: the chunk-resend
   * path is driven by `cpuCache` drain order plus the upload-pass
   * lane/LOD filter in `deliverToWorker` — there is no per-chunk
   * worker-wanted-set on the orchestrator.
   *
   * Proxy resends must be tracked (not just chunk resends): the
   * cache-hit short-circuit means we can't rely on `submit()`
   * re-emission to recover from a worker-side eviction.
   */
  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
  ): void {
    for (const entry of missing) {
      if (entry.kind === "proxy") {
        this.deliveryTracker.clearProxyDelivered(entry);
      }
    }
  }

  /** Get all tracked worker member IDs (for multi-channel transition cleanup). */
  getTrackedMemberIds(): string[] {
    return [...this.deliveryTracker.trackedKeys()];
  }

  /** Clear all delivery state for a member (e.g. on dataset removal). */
  clearMemberResources(workerMemberId: string): void {
    // Two-pronged cleanup: chunk-side tracking is keyed by
    // workerMemberId, proxy-side tracking is keyed by composite
    // `${datasetId}|...`. `workerMemberId` here is either a datasetId,
    // an imageId, or `${imageId}:ch${c}` — the id shape is ambiguous,
    // so we call both. Each is a no-op when the id doesn't match its
    // expected shape; the worker recreates pools on next request
    // anyway.
    this.deliveryTracker.clearMember(workerMemberId);
    this.deliveryTracker.clearDataset(workerMemberId);
    // Drop the cached lastViewEpoch entry. If `workerMemberId` is a
    // bare datasetId this clears the right entry; for imageId-shaped IDs
    // it's a no-op (the dataset entry survives, which is correct — the
    // dataset itself wasn't removed).
    this.lastViewEpochByDataset.delete(workerMemberId);

    // Drop the planning debug entry. Same dataset-vs-member ambiguity:
    // member ids never match a key in `planning.byDataset`, so the delete
    // is a no-op for those calls. Dataset removal sees both an explicit
    // dataset call and per-member calls; one of them clears.
    delete debugStats.planning.byDataset[workerMemberId];
    this._lastPlanByDataset.delete(workerMemberId);

    // Drop per-dataset state added in #613. All keyed by datasetId; for
    // member-shaped ids these are no-ops, which matches the
    // best-effort cleanup pattern above.
    this._lastFilteredRequests.delete(workerMemberId);
    this._lastProxyRequests.delete(workerMemberId);
    this._lastEntities.delete(workerMemberId);
    this._lastVisibleRegion.delete(workerMemberId);
    this._lastCachedKeyCounts.delete(workerMemberId);
    // Previously absent — without this delete, a dataset removed and
    // re-added kept its prior `PlanningState` (`previousActiveSet` etc.)
    // across the gap. See dechaos contract-scan Verified-assumption #3.
    this.planningState.delete(workerMemberId);
  }

  /**
   * Snapshot of the most recent full `plan()` output per dataset. Used
   * by the DebugPanel "dump" buttons to print categorized request lists.
   * Returns the live Map — callers must not mutate.
   */
  getLastPlans(): ReadonlyMap<string, RequestPlan> {
    return this._lastPlanByDataset;
  }

  /**
   * Send a single chunk delivery to the GPU worker, emitting atlas config if the
   * state key changed and the chunk data itself.  Returns bytes sent (0 if skipped).
   */
  private sendDeliveryToWorker(
    ctx: TickContext,
    delivery: ReadyChunkDelivery,
    multiChannel: boolean,
    sliceZ: number | null,
    epochs: SceneEpochs,
  ): number {
    const viewMode = ctx.mode;
    const workerMemberId = multiChannel ? `${delivery.imageId}:ch${delivery.c}` : delivery.imageId;

    // Find dataset for this delivery
    let dsManifest: DatasetManifest | null = null;
    for (const [, ds] of ctx.datasets) {
      if (ds.manifest.images.some(img => img.image_id === delivery.imageId)) {
        dsManifest = ds.manifest;
        break;
      }
    }
    if (!dsManifest) {
      this.currentUploadStats.skippedNoMeta++;
      return 0;
    }

    const imageSpec = dsManifest.images.find(img => img.image_id === delivery.imageId);
    if (!imageSpec) {
      this.currentUploadStats.skippedNoMeta++;
      return 0;
    }
    const levelMeta = imageSpec.multiscale.levels[delivery.level];
    if (!levelMeta) {
      this.currentUploadStats.skippedNoMeta++;
      return 0;
    }

    const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;    // [T, C, Z, Y, X]
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;

    // Send chunk data if not already sent
    if (this.deliveryTracker.wasChunkSent(workerMemberId, delivery.chunkKey)) {
      this.currentUploadStats.skippedAlreadySent++;
      return 0;
    }

    const chunkData = {
      data: delivery.data,
      dataType: delivery.dataType,
      x: delivery.x, y: delivery.y, z: delivery.z,
      key: delivery.chunkKey,
    };

    if (viewMode === "slice") {
      const fullResDepth = imageSpec.multiscale.levels[0].shape[Axis.Z];
      ctx.client.sliceChunkData(
        workerMemberId, [chunkData],
        delivery.level, sliceZ!, delivery.t, delivery.c,
        levelWidth, levelHeight, chunkX, chunkY, chunkZ,
        fullResDepth, levelDepth, sliceZ!,
        epochs,
      );
    } else {
      ctx.client.volumeChunkData(
        workerMemberId, [chunkData],
        delivery.level, delivery.t, delivery.c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
        epochs,
      );
    }

    this.deliveryTracker.markChunkSent(workerMemberId, delivery.entityId, delivery.chunkKey);
    return delivery.data.byteLength;
  }

  /**
   * Forward a proxy delivery to the GPU worker.
   *
   * Records the composite key in the tracker's proxy-delivered set so
   * subsequent cache-hit ticks (which re-submit `_lastProxyRequests`)
   * can short-circuit without re-uploading.
   */
  private sendProxyDeliveryToWorker(
    ctx: TickContext,
    delivery: ReadyProxyDelivery,
    epochs: SceneEpochs,
  ): number {
    ctx.client.proxyAssetData(
      delivery.datasetId,
      delivery.entityId,
      delivery.imageId,
      delivery.proxyKind,
      delivery.t,
      delivery.c,
      delivery.header.dims,
      delivery.data,
      epochs,
    );
    this.deliveryTracker.markProxyDelivered(proxyKeyFromDelivery(delivery));
    return delivery.data.byteLength;
  }

  /**
   * Test-only accessor for the proxy-delivered tracking set. Marked
   * `// @internal` — used by `orchestrator.test.ts` to assert the
   * cache-hit short-circuit no longer re-uploads cached proxies.
   *
   * @internal
   */
  getProxyDeliveredKeys(): Set<string> {
    return this.deliveryTracker.getProxyDeliveredKeys();
  }

  /**
   * Debug helper for HITL: synthesize a single-proxy `RequestPlan`,
   * submit it to CpuCache, and rely on the normal subscribe → tick →
   * `deliverToWorker` path to forward the result to the GPU worker.
   *
   * Intended to be called from the dev console, e.g.
   * `window.__lucidaOrchestrator.requestTestProxy(...)`. App.tsx exposes
   * the orchestrator on `window` for this purpose.
   *
   * Returns immediately — the result lands in the worker asynchronously.
   */
  requestTestProxy(
    cpuCache: CpuCache,
    datasetId: string,
    entityId: string,
    imageId: string,
    kind: "WellProxy3D" | "FieldProxy3D",
    t: number,
    c: number,
  ): void {
    const proxyRequest: ProxyRequest = {
      datasetId,
      entityId,
      imageId,
      kind,
      t,
      c,
      priority: 0,
    };
    const epochs: SceneEpochs = this.lastEpochs ?? {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
      asset: 0,
      request: 0,
    };
    cpuCache.submit({
      requests: [],
      activeSet: [],
      proxyRequests: [proxyRequest],
      epochs,
      stats: emptyPlanStats(),
      // submit() doesn't read nextState; placeholder so the literal
      // satisfies RequestPlan's contract.
      nextState: { previousActiveSet: [] },
    });
  }

  /** Build and send a ColdStateMessage to the GPU worker. Returns the
   *  message so the caller can derive a deterministic entity-index map. */
  private sendColdState(
    dsId: string,
    activeSet: ActiveSetEntry[],
    entities: EntitySnapshot[],
    selection: SelectionState,
    visibleRegion: VisibleRegion,
    epochs: SceneEpochs,
    ctx: TickContext,
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>,
    dsSettings: DatasetSettings | undefined,
  ): ColdStateMessage {
    const entityById = new Map(entities.map(e => [e.entityId, e]));

    // Build per-channel display state once per cold-state assembly.
    // Single-channel: lone visible channel falls back to dataset-level
    // contrast/gamma when no per-channel override exists. Multi-channel:
    // each visible channel gets its own override (already validated by
    // the planning entry-iteration above).
    const opacity = dsSettings?.opacity ?? 1;
    const dsContrastMin = dsSettings?.contrast_min ?? 0;
    const dsContrastMax = dsSettings?.contrast_max ?? 65535;
    const dsGamma = dsSettings?.gamma ?? 1;
    const displayStateByChannel: Record<number, ColdStateDisplayState> = {};
    for (const ch of selection.visibleChannels) {
      const chSettings = dsSettings?.channel_settings?.[ch];
      displayStateByChannel[ch] = {
        contrastMin: chSettings?.contrast_min ?? dsContrastMin,
        contrastMax: chSettings?.contrast_max ?? dsContrastMax,
        gamma: chSettings?.gamma ?? dsGamma,
        opacity,
        colormapName: chSettings?.colormap ?? "gray",
        channelMask: 1 << (ch & 31),
      };
    }

    // ActiveSetEntry is a discriminated union, but the worker's
    // `ColdStateActiveEntry` stays flat (it talks to the worker over
    // a separate seam). Each variant maps onto the cold shape with
    // explicit per-variant defaults — `well-as-proxy` has no LOD
    // bookkeeping and an empty imageId, `invisible` collapses to its
    // coarsest LOD with no proxy availability, and `field` forwards
    // its fields verbatim.
    const coldActiveSet: ColdStateActiveEntry[] = activeSet.map(entry => {
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

      // Forward Planning's promotion mode + proxy availability so the
      // worker's wanted-set knows whether to ask for proxies.
      // `parentWellId` lets the worker fan out a well-proxy upload to
      // its child fields' descriptors. Narrowing on `kind === "Field"`
      // gives a `FieldSnapshot` whose `parentId` is non-null by
      // construction.
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
          entityId: entry.entityId,
          imageId: "",
          targetLod: 0,
          detailOwnedLodRange: [0, 0],
          levels,
          mode: "well-as-proxy",
          proxyKind: "WellProxy3D",
          proxyAvailable: true,
          wellProxyAvailable: true,
          parentWellId,
          modelMatrix,
          invModelMatrix,
          displayStateByChannel,
        };
      }
      if (entry.kind === "invisible") {
        return {
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
    });

    const msg: ColdStateMessage = {
      type: "coldState",
      epochs,
      datasetId: dsId,
      currentT: selection.t,
      currentZ: selection.z,
      visibleChannels: selection.visibleChannels,
      visibleRegion,
      activeSet: coldActiveSet,
      viewMode: selection.renderMode,
    };

    ctx.client.coldState(msg);
    return msg;
  }

  /**
   * Build and send a viewEpoch hot-state message. Walks the same
   * canonical iteration as `buildDescriptorBuffer` so the memberIds
   * match what the worker uses to key chunk-eviction distance lookups.
   * One ray-pick per dataset (the WASM scene's `ray_hit_local_image` is
   * a per-dataset query) replicated to every member, including
   * per-channel composite keys.
   */
  private sendViewHotState(
    dsId: string,
    cold: ColdStateMessage,
    ctx: TickContext,
    epochs: SceneEpochs,
  ): void {
    const hit = Array.from(ctx.scene.ray_hit_local_image(dsId)) as [number, number, number];
    const rayHitsByEntity: Array<[string, [number, number, number]]> = [];
    const seen = new Set<string>();
    for (const { memberId } of iterateColdMembers(cold)) {
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      rayHitsByEntity.push([memberId, hit]);
    }
    const msg: ViewHotStateMessage = {
      type: "viewHotState",
      epochs,
      datasetId: dsId,
      rayHitsByEntity,
    };
    ctx.client.viewHotState(msg);
  }
}

