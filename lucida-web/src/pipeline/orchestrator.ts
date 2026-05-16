/**
 * Orchestrator — assembles PlanningSnapshot from live WASM scene state,
 * invokes plan(), and routes the output to CpuCache for fetching and
 * delivery to the GPU worker.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { SceneSettings } from "../tickCommon.ts";
import { Axis } from "../axes.ts";
import type {
  ColdStateMessage,
  MissingChunk,
  MissingProxy,
} from "../renderer/workerProtocol.ts";
import type { DatasetSettings } from "../tickCommon.ts";
import { computeMemberIndexMap } from "../renderer/descriptorBuffer.ts";
// Note: atlas config messages eliminated — worker manages atlases from cold state
import {
  getSceneSettings,
  compositeKey,
} from "../tickCommon.ts";
import { plan, emptyPlanStats } from "./planning/index.ts";
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
import type { CpuCache } from "./fetch/index.ts";
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
import { buildColdState } from "./upload/coldState/build.ts";
import { buildRoster } from "./upload/coldState/roster.ts";
import { buildViewHotState } from "./upload/coldState/hotState.ts";
import { DeliveryTracker } from "./upload/delivery/tracker.ts";
import { WorkerFeedback } from "./upload/delivery/feedback.ts";
import { buildManifestByImage } from "./upload/delivery/manifestIndex.ts";
import { runDrainPass } from "./upload/delivery/drain.ts";
import {
  runChunkResendPass,
  runProxyResendPass,
} from "./upload/delivery/resend.ts";

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

// `synthesizeWellRosterEntry` moved to `upload/coldState/roster.ts` in
// Slice 6b of PRD #607. Re-exported here so existing import sites stay
// working; new call sites should import directly from
// `pipeline/upload/coldState/roster.ts` (or via `pipeline/upload/`).
export { synthesizeWellRosterEntry } from "./upload/coldState/roster.ts";

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

  /**
   * Worker → main-thread feedback handlers. Owns the body of
   * `handleChunksEvicted` and `handleWantedSetDelta`; the orchestrator
   * methods are thin delegations. Constructed eagerly here (no
   * constructor wiring needed) since it only depends on
   * `this.deliveryTracker`, which is initialised above. See Seam G of
   * the dechaos boundary scan.
   */
  private workerFeedback = new WorkerFeedback(this.deliveryTracker);

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

      // 3j. Build member roster + per-entity matrix map from the active
      // set in a single walk (Slice 6c, PRD #607). The roster is
      // consumed by slicePath/volumePath for layer construction; the
      // matrices map is consumed below by `sendColdState` so the worker
      // gets precomputed model matrices baked into descriptor entries.
      //
      // `well-as-proxy` entries are synthesised (their well isn't in
      // `derived.members`); `invisible` entries are skipped (they don't
      // render); `field` entries forward `imageId`, `position`, `mode`.
      // See `buildRoster` for details.
      const { entries: rosterEntries, matricesByEntity } = buildRoster({
        activeSet: result.activeSet,
        entities,
        ctx,
        datasetId: dsId,
      });
      memberRoster.set(dsId, rosterEntries);

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
   * Composition of three extracted passes (see `upload/delivery/`):
   * - {@link runDrainPass} — iterate `cpuCache.drain(budget)` output
   *   and dispatch chunks / proxies that pass `classifyDelivery`.
   * - {@link runChunkResendPass} — re-send chunks the worker evicted
   *   or never received, sourced from `_lastFilteredRequests`.
   * - {@link runProxyResendPass} — same shape for proxies, sourced
   *   from `_lastProxyRequests`.
   *
   * Each pass owns its own counter writes (skips + uploads) onto the
   * shared `currentUploadStats`. The per-tick manifest index built by
   * `buildManifestByImage` eliminates the O(D × I) per-chunk scan the
   * old `sendDeliveryToWorker` did.
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
    const viewMode = ctx.mode;

    // Build per-tick lookup tables: target LOD by image (drives the
    // drain pass's wrongLod filter) and the per-image manifest index
    // (eliminates the per-chunk dataset scan during dispatch).
    const targetLevelByImage = new Map<string, number>();
    for (const requests of this._lastFilteredRequests.values()) {
      for (const req of requests) {
        targetLevelByImage.set(req.imageId, req.level);
      }
    }
    const manifestByImage = buildManifestByImage(ctx.datasets);

    const deliveries = ctx.cpuCache.drain(budget);
    for (const d of deliveries) {
      if (d.kind === "proxy") this.currentUploadStats.drainedProxies++;
      else this.currentUploadStats.drainedChunks++;
    }

    const recordUpload = (bytes: number, isResend: boolean): void => {
      this.recordUploadEvent(tickStart, bytes, isResend);
    };
    const passCtx = {
      tracker: this.deliveryTracker,
      client: ctx.client,
      multiChannel,
      viewMode,
      sliceZ,
      epochs,
      stats: this.currentUploadStats,
      recordUpload,
    } as const;

    const drainRes = runDrainPass({
      deliveries,
      targetByImage: targetLevelByImage,
      manifestByImage,
      ...passCtx,
      remaining: budget,
    });
    let remaining = drainRes.remaining;
    let budgetExhausted = drainRes.budgetExhausted;

    if (!budgetExhausted) {
      const chunkRes = runChunkResendPass({
        requestsByDataset: this._lastFilteredRequests,
        manifestByImage,
        cpuCache: ctx.cpuCache,
        ...passCtx,
        remaining,
      });
      remaining = chunkRes.remaining;
      budgetExhausted = chunkRes.budgetExhausted;
    }

    if (!budgetExhausted) {
      const proxyRes = runProxyResendPass({
        requestsByDataset: this._lastProxyRequests,
        tracker: this.deliveryTracker,
        cpuCache: ctx.cpuCache,
        client: ctx.client,
        epochs,
        stats: this.currentUploadStats,
        recordUpload,
        remaining,
      });
      remaining = proxyRes.remaining;
      budgetExhausted = proxyRes.budgetExhausted;
    }

    this.currentUploadStats.budgetExhausted = budgetExhausted;
    this.publishUploadStats(tickStart);

    return deliveries.length > 0 || budgetExhausted;
  }

  /**
   * Process a worker `chunksEvicted` report. Delegates to
   * {@link WorkerFeedback.handleChunksEvicted} — see that method for
   * the full eviction-vs-skipped semantics.
   */
  handleChunksEvicted(
    workerMemberId: string,
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
  ): void {
    this.workerFeedback.handleChunksEvicted(
      workerMemberId, evicted, skipped, cpuCache,
    );
  }

  /**
   * Process a wanted-set delta from the GPU worker. Delegates to
   * {@link WorkerFeedback.handleWantedSetDelta} — only the proxy
   * branch is meaningful (chunk entries are intentionally ignored
   * post-Slice 3).
   */
  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
  ): void {
    this.workerFeedback.handleWantedSetDelta(missing);
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

  /**
   * Build and send a `ColdStateMessage` to the GPU worker.
   *
   * The pure build lives in `upload/coldState/build.ts`; this wrapper
   * forwards the planner output, posts the message, and returns it so
   * the caller can derive a deterministic entity-index map.
   *
   * Chunk delivery tracker reset is hoisted to once-per-tick in the
   * planning loop (`deliveryTracker.onColdStateRebuild()` at the top of
   * the rebuild path — Slice 5). Calling it here would multi-clear in
   * multi-dataset rebuilds.
   */
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
    const msg = buildColdState({
      datasetId: dsId,
      activeSet,
      entities,
      selection,
      visibleRegion,
      epochs,
      matricesByEntity,
      dsSettings,
    });
    ctx.client.coldState(msg);
    return msg;
  }

  /**
   * Build and send a viewEpoch hot-state message. The pure build lives
   * in `upload/coldState/hotState.ts`; this wrapper just collects the
   * per-dataset ray hit from the WASM scene and emits to the worker.
   *
   * The message must be posted before subsequent render messages so the
   * worker's `rayHitPerEntity` is current when chunk-data eviction fires.
   */
  private sendViewHotState(
    dsId: string,
    cold: ColdStateMessage,
    ctx: TickContext,
    epochs: SceneEpochs,
  ): void {
    const hit = Array.from(ctx.scene.ray_hit_local_image(dsId)) as [number, number, number];
    const msg = buildViewHotState({
      coldMsg: cold,
      rayHit: hit,
      epochs,
      datasetId: dsId,
    });
    ctx.client.viewHotState(msg);
  }
}

