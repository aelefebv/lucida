/**
 * Orchestrator — assembles PlanningSnapshot from live WASM scene state,
 * invokes plan(), and routes the output to CpuCache for fetching and
 * delivery to the GPU worker.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { SceneSettings } from "../tickCommon.ts";
import type { DatasetManifest, LevelGeometry } from "../manifestTypes.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ColdStateDisplayState,
  ViewHotStateMessage,
  MissingChunk as MissingChunkLite,
  MissingProxy as MissingProxyLite,
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
  PlanningEpochs,
  EntitySnapshot,
  MinimapChunkCoord,
  VisibleRegion,
  SelectionState,
  ChunkRequest,
  RequestPlan,
} from "./planning/index.ts";

// Re-export so existing call sites that imported `MinimapChunkCoord`
// from the orchestrator (e.g. `slicePath.ts`, `volumePath.ts`,
// `renderLoop.ts`, `minimapPath.ts`) keep working unchanged. Slice 5
// of PRD #545 consolidated the canonical declaration into
// `pipeline/planning/index.ts` since the type is now part of the
// planning snapshot's public shape.
export type { MinimapChunkCoord } from "./planning/index.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
} from "./cpuCache.ts";
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

// ---------------------------------------------------------------------------
// Cold-state rebuild telemetry constants
// ---------------------------------------------------------------------------
//
// `planAndFetch` either takes the epoch fast-path (cache hit) or runs a full
// rebuild. We track both paths so the panel can show hit rate, rebuild rate,
// per-epoch cause attribution, and timing — and so we can flag pathological
// non-view churn.

/** Rolling-window size for hit/rebuild rates and cause attribution. */
const COLD_STATE_WINDOW_MS = 1000;

/** Bounded sample buffer for p50/p95 rebuild duration. */
const COLD_STATE_DURATION_SAMPLES = 60;

/**
 * Threshold above which sustained non-view rebuild churn is considered
 * pathological. View-epoch churn is expected during camera motion;
 * other epochs (selection, content, layout, asset) bumping at >30/s is
 * almost always a bug.
 */
const COLD_STATE_CHURN_THRESHOLD_PER_SEC = 30;

/** How long the rate must stay above threshold before a log fires. */
const COLD_STATE_CHURN_SUSTAIN_MS = 2000;

/** Don't re-log churn more often than this. */
const COLD_STATE_CHURN_LOG_RATE_LIMIT_MS = 2000;

/** Per-epoch cause keys we attribute rebuilds to. */
type ColdStateCauseKey = "content" | "layout" | "view" | "selection" | "asset";

// ---------------------------------------------------------------------------
// Upload (CPU → GPU hand-off) telemetry constants
// ---------------------------------------------------------------------------

/** Rolling window for bytes/sec, uploads/sec, ratios, exhausted-tick count. */
const UPLOAD_WINDOW_MS = 1000;

/** Bounded sample buffer for p50/p95 upload byte size. */
const UPLOAD_SIZE_SAMPLES = 120;

/** Consecutive ticks of `budgetExhausted=true` before logging. */
const UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD = 3;

/** Resend ratio above which `upload.resend_storm` arms (atlas thrashing). */
const UPLOAD_RESEND_RATIO_THRESHOLD = 0.5;

/** Filter ratio above which `upload.drain_waste` arms (decoded chunks unwanted). */
const UPLOAD_FILTER_RATIO_THRESHOLD = 0.5;

/**
 * Sustain duration for resend_storm and drain_waste before a log fires.
 * Mirrors the cold-state churn pattern — short bursts during transitions
 * (e.g. zoom transitions) are normal and shouldn't spam the console.
 */
const UPLOAD_LOG_SUSTAIN_MS = 2000;

/** Don't re-log the same condition more often than this. */
const UPLOAD_LOG_RATE_LIMIT_MS = 2000;

/** A visible member for render layer construction. */
export interface MemberRosterEntry {
  imageId: string;
  position: [number, number];
  /**
   * S8: entity id from the planning active set entry that produced this
   * roster member. Forwarded to the GPU worker per-layer so it can look
   * up the proxy descriptor for shader binding.
   */
  entityId?: string;
  /**
   * S8: promotion mode from the planning active set entry. Drives the
   * shader's `renderMode` branch (well-as-proxy direct sample vs
   * detail+proxy fallback). Optional for backward compat.
   */
  mode?: "well-as-proxy" | "fields-with-proxy-fallback" | "fields-with-detail";
  /**
   * S8: optional precomputed world-space model matrix for the
   * `[0,1]^3` unit cube that bounds this member. When present, the
   * render path uses it instead of querying `scene.member_model_matrix`.
   * Used by `well-as-proxy` entries because wells aren't in
   * `derived.members` and therefore have no native model matrix.
   * Column-major 4×4. `invModelMatrix` is the matching inverse.
   */
  modelMatrix?: Float32Array;
  invModelMatrix?: Float32Array;
  /**
   * S8 fix: optional 2D world-space footprint of the member (in voxel
   * units, the same coordinate frame as `position`). When present, the
   * slice path uses these instead of the dataset's per-image dataW/dataH
   * for layer sizing — necessary for synthesized `well-as-proxy`
   * entries whose footprint spans multiple field images.
   */
  dataW?: number;
  dataH?: number;
}

export interface OrchestratorResult {
  /** Per-dataset roster of members that need render layers, keyed by dsId. */
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  multiChannel: boolean;
  epochs: PlanningEpochs;
  /**
   * M1 (DOMAINS step 8a): per-dataset memberId → entity index map. Both
   * the worker (when building the descriptor buffer) and the render
   * paths (when assembling layers) read from this map. Computed
   * deterministically from the same `cold.activeSet × cold.visibleChannels`
   * iteration the worker uses, so indices agree by construction.
   */
  entityIndexByDataset: Map<string, Map<string, number>>;
}

/**
 * S8: build a synthetic roster entry for a `well-as-proxy` entry.
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
 */
function synthesizeWellRosterEntry(
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
    // EntitySnapshot.position is already in voxel coords (from
    // `scene.member_positions`).
    const fx = field.position[0];
    const fy = field.position[1];
    const lvl0 = field.levels[0];
    if (lvl0) {
      const fw = lvl0.shape[4]; // X
      const fh = lvl0.shape[3]; // Y
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
  private previousActiveSet = new Map<string, ActiveSetEntry[]>();
  private lastEpochs: PlanningEpochs | null = null;
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
   * M3 (DOMAINS step 8a): per-dataset last-emitted viewEpoch. Tracked so
   * `viewHotState` only fires when the camera-ray pick may have moved.
   * Cleared on dataset removal.
   */
  private lastViewEpochByDataset = new Map<string, number>();
  private _lastRequests: ChunkRequest[] = [];
  private _lastVisibleRegion: VisibleRegion | null = null;
  private _lastEntities: EntitySnapshot[] = [];
  private _lastCachedKeyCounts = new Map<string, number>();
  /** Last filtered requests, kept for the deliverToWorker resend pass on cache hits. */
  private _lastFilteredRequests: ChunkRequest[] = [];
  /**
   * Per-dataset snapshot of the most recent full `plan()` output. Held so
   * the DebugPanel "dump" buttons can print all datasets, not just the
   * last one in iteration order. Cleared per-dataset by
   * {@link clearMemberResources}.
   */
  private _lastPlanByDataset = new Map<string, RequestPlan>();
  /**
   * Last proxy requests produced by `plan()`, kept for the deliverToWorker
   * proxy resend pass on cache hits (see `:735-751`). Not re-submitted to
   * CpuCache — fetches stay alive on their own now that submit is additive.
   */
  private _lastProxyRequests: ProxyRequest[] = [];

  // Delivery state — tracks what's been sent to the GPU worker
  private deliverySentToWorker = new Map<string, Set<string>>();

  /**
   * Chunks the GPU worker has reported as `skipped` (atlas full +
   * incoming farther than the farthest existing slot). The resend pass
   * checks this set before attempting an upload; without it, the
   * pass would re-send the same too-far chunks every tick because
   * `handleChunksEvicted` removes them from `deliverySentToWorker`,
   * driving the `upload.resend_storm` and `upload.budget_exhausted`
   * anomalies. Cleared on every cold-state rebuild — the camera or
   * active set may have shifted enough that previously-too-far chunks
   * now fit. Keyed by workerMemberId (mirrors `deliverySentToWorker`).
   */
  private deliveryRejectedByWorker = new Map<string, Set<string>>();

  /**
   * Reverse lookup from `workerMemberId` to `entityId`, rebuilt during
   * the rebuild path from `_lastFilteredRequests`. Needed by
   * `handleChunksEvicted` to resolve the cpuCache entityId for
   * `markRejected` calls — workerMemberId is composite for multi-channel
   * (`imageId:chN`) and may differ from entityId entirely (plate fields).
   */
  private widToEntityId = new Map<string, string>();

  /**
   * Tracks proxies already uploaded to the GPU worker. Composite key:
   * `${datasetId}|${entityId}|${proxyKind}|${t}|${c}`. Mirrors
   * `deliverySentToWorker` for chunks: cleared on full-plan ticks,
   * cleared per-entry by `handleWantedSetDelta` when the worker reports
   * a `MissingProxy`, and consulted by `deliverToWorker`'s proxy resend
   * pass. Without it the cache-hit short-circuit (which re-submits
   * `_lastProxyRequests` every tick) would re-emit and re-upload every
   * cached proxy on every animation frame.
   */
  private proxyDeliveredToWorker = new Set<string>();

  /** Wanted-set from the GPU worker — entityId → Set<chunkKey> of missing chunks. */
  private workerWantedSet = new Map<string, Set<string>>();

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
    const currentEpochs: PlanningEpochs = {
      content: rawEpochs.content,
      layout: rawEpochs.layout,
      view: rawEpochs.view,
      selection: rawEpochs.selection,
      // `asset_epoch()` is the authoritative source. Older WASM builds
      // without the binding fall back to 0 (functional no-op for S3).
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
    // that previously-too-far chunks may now fit. The per-dataset loop
    // below re-populates `widToEntityId` from the new
    // `_lastFilteredRequests`.
    this.deliveryRejectedByWorker.clear();
    this.widToEntityId.clear();
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
      // Slice 4 (PRD #545) extracted the WASM → snapshot translation
      // into `planning/snapshot.ts`. Slice 5 wires `minimapPendingFetch`
      // through the same call site so the planner emits minimap-lane
      // requests at the highest priority (ADR 0023).
      const built = buildPlanningSnapshot({
        scene: ctx.scene,
        datasetId: dsId,
        dataset: ds,
        dsSettings,
        prevActiveSet: this.previousActiveSet.get(dsId) ?? [],
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
      for (const entity of entities) {
        const cachedKeys = ctx.cpuCache.snapshot().cached.get(entity.entityId);
        this._lastCachedKeyCounts.set(entity.entityId, cachedKeys?.size ?? 0);
      }

      // 3d. Plan
      const result = plan(snapshot, planningConfig);
      this.previousActiveSet.set(dsId, result.activeSet);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion = visibleRegion;
      this._lastEntities = entities;
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

      // Annotate proxy requests with the real dataset id (Planning emits
      // an empty default since it has no per-dataset context).
      for (const pr of result.proxyRequests) {
        pr.datasetId = dsId;
      }
      this._lastProxyRequests = result.proxyRequests;

      // 3i. Track this dataset's requests for re-send / wid-mapping.
      // PRD #545 dropped the LOD-filter step that previously gated the
      // request stream to `entry.targetLod`: planning now emits exactly
      // one level per entity, so the filter is a no-op. `_lastFilteredRequests`
      // keeps its name for compatibility with the re-send loop below.
      this._lastFilteredRequests = result.requests;
      // Build wid → entityId for this dataset so handleChunksEvicted
      // can resolve `cpuCache.markRejected(entityId, ...)` from the
      // worker's report (which carries workerMemberId, not entityId).
      // Multi-dataset case: rebuilt cumulatively across the loop since
      // we clear once at the top of the rebuild path.
      for (const req of result.requests) {
        const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
        this.widToEntityId.set(wid, req.entityId);
      }
      // Note: proxy delivery tracking is NOT cleared here. Worker proxy pools
      // persist across cold states (they're created lazily in getOrCreateProxyPool
      // and only destroyed on dataset removal). Re-sending proxies on every full
      // plan would upload-spam them every time a view epoch bumps (e.g., wheel
      // scroll). When the worker actually evicts a proxy, its wantedSetDelta
      // reports it as missing and handleWantedSetDelta clears the per-entry
      // tracking, triggering re-delivery on the next tick.

      // Annotate requests with the real dataset ID (entityId may differ for plates)
      for (const req of result.requests) {
        req.datasetId = dsId;
      }

      // 3j. Build member roster from active set for render layer construction.
      // S8: forward the planning entry's entityId + mode so the render
      // path can dispatch per-mode (well-as-proxy emits one layer per
      // well; field modes iterate fields).
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
        if (entry.mode === "well-as-proxy") {
          // Synthetic well member. Compute AABB from constituent fields.
          const childFields = fieldsByWell.get(entry.entityId) ?? [];
          if (childFields.length === 0) continue; // no geometry to render
          const synth = synthesizeWellRosterEntry(ctx, dsId, entry.entityId, childFields);
          if (synth) rosterEntries.push(synth);
          continue;
        }
        const entity = entityById.get(entry.entityId);
        if (entity) {
          rosterEntries.push({
            imageId: entity.imageId,
            position: entity.position,
            entityId: entry.entityId,
            mode: entry.mode,
          });
        }
      }
      memberRoster.set(dsId, rosterEntries);

      // M1: build a model-matrix lookup keyed by entityId so cold state
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
      // wanted-set + descriptor buffer build. M2: passes dataset
      // settings so per-channel display state (contrast/gamma/opacity/
      // colormap) gets baked into descriptor entries.
      const coldMsg = this.sendColdState(
        dsId, result.activeSet, entities, selection, visibleRegion,
        currentEpochs, ctx, matricesByEntity, dsSettings,
      );
      // M1: compute the same memberId → entityIndex map the worker
      // builds from cold state. Both sides converge by construction
      // because they walk the same canonical iteration order.
      entityIndexByDataset.set(dsId, computeMemberIndexMap(coldMsg));

      // M3: emit viewEpoch hot-state with per-entity ray-pick coords.
      // Posted before subsequent render messages so the worker's
      // `rayHitPerEntity` is current when chunk-data eviction fires.
      // Keyed by memberId (imageId or imageId:chN) — same convention
      // chunk-data uses for `findFarthestSlot` distance lookups.
      const lastView = this.lastViewEpochByDataset.get(dsId);
      if (lastView !== currentEpochs.view) {
        this.sendViewHotState(dsId, coldMsg, ctx, currentEpochs);
        this.lastViewEpochByDataset.set(dsId, currentEpochs.view);
      }

      // Clear chunk delivery tracking so chunks are re-sent for the new state.
      // Worker rebuilds slice/volume atlas pools on each cold state, so all
      // chunks must be re-uploaded to fill the rebuilt atlases.
      this.deliverySentToWorker.clear();

      // Submit chunk + proxy requests in a single call so they don't
      // cancel each other. Proxies sit in their own queue inside
      // CpuCache but share the cancellation contract: if the next
      // plan omits a request, its in-flight fetch is aborted.
      //
      // Slice 5 of PRD #545 deleted the inline minimap-injection
      // block that previously appended overview-lane requests at
      // priority 2000. Minimap requests now arrive through
      // `result.requests` with `lane: "minimap"` and
      // `priority: MINIMAP_LANE_OFFSET` (= 0, highest priority).
      // The orchestrator's `req.datasetId = dsId` mutation above
      // covers minimap requests for free since they're emitted into
      // the same array.
      ctx.cpuCache.submit({
        requests: result.requests,
        activeSet: result.activeSet,
        proxyRequests: result.proxyRequests,
        epochs: currentEpochs,
        stats: result.stats,
      });

      // Debug stats
      if (debugStats.enabled) {
        for (const entity of entities) {
          debugStats.totalMembers++;
          debugStats.visibleMembers++;
          const activeEntry = result.activeSet.find(
            (a) => a.entityId === entity.entityId,
          );
          const tl = activeEntry?.targetLod ?? -1;
          const memberKey = multiChannel
            ? compositeKey(entity.imageId, selection.c)
            : entity.imageId;
          debugStats.memberStats.push({
            id: memberKey,
            level: tl,
            numLevels: entity.numLevels,
            chunksNeeded: result.requests.filter(
              (r) => r.entityId === entity.entityId && r.lane !== "prefetch",
            ).length,
            chunksSent: 0,
          });
          if (tl >= 0) {
            debugStats.selectedLevel = tl;
            debugStats.numLevels = entity.numLevels;
          }
        }
      }
    }

    // Step 4 — Orchestrator debug snapshot
    if (debugStats.enabled) {
      // Collect from all datasets' plans (last dataset wins for activeSet — fine for single-dataset debug)
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
      // Re-run is wasteful, so store last result. For now just use previousActiveSet.
      for (const [, activeSet] of this.previousActiveSet) {
        for (const entry of activeSet) {
          orchDebug.activeSet.push({
            entityId: entry.entityId,
            mode: entry.mode,
            targetLod: entry.targetLod,
            coarsestDetailLod: entry.coarsestDetailLod,
            detailOwnedLodRange: entry.detailOwnedLodRange,
          });
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

      // Coordinate diagnostic
      orchDebug.visibleRegion = this._lastVisibleRegion
        ? {
            xyBounds: this._lastVisibleRegion.xyBounds,
            zRange: this._lastVisibleRegion.zRange,
            effectiveZoom: this._lastVisibleRegion.effectiveZoom,
          }
        : null;
      orchDebug.entityDiag = this._lastEntities.slice(0, 5).map(e => ({
        entityId: e.entityId,
        position: e.position,
        fullShape: e.levels.length > 0
          ? [e.levels[0].shape[4], e.levels[0].shape[3]] as [number, number]
          : null,
        cachedKeys: this._lastCachedKeyCounts.get(e.entityId) ?? 0,
      }));

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
   * Deliver decoded chunks to the GPU worker via RenderClient.
   * Replaces uploadChunksForMembers() -- called from slicePath/volumePath after S5.3.
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

    // Build target level map from current plan for LOD filtering
    const targetLevelByImage = new Map<string, number>();
    for (const req of this._lastFilteredRequests) {
      targetLevelByImage.set(req.imageId, req.level);
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
        // S5: proxies are routed to a dedicated worker message. The
        // worker stub just logs receipt — S7 lands the actual GPU
        // upload.
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
    if (!budgetExhausted && this._lastFilteredRequests.length > 0) {
      for (const req of this._lastFilteredRequests) {
        if (budgetExhausted) break;
        if (req.lane === "prefetch") continue;
        this.currentUploadStats.resendChunksConsidered++;

        const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
        const ss = this.deliverySentToWorker.get(wid);
        if (ss?.has(req.chunkKey)) {
          this.currentUploadStats.resendChunksAlreadySent++;
          continue;
        }

        // Worker rejected this chunk under the current camera (atlas
        // full + too far). Don't re-attempt until the next cold-state
        // rebuild clears `deliveryRejectedByWorker`.
        if (this.deliveryRejectedByWorker.get(wid)?.has(req.chunkKey)) {
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

    // Re-send proxies the worker has evicted (or never received because
    // the previous tick cleared `proxyDeliveredToWorker`). Mirrors the
    // chunk resend pass: iterate the last-known proxy request set, skip
    // anything already tracked as delivered, and look up the cached
    // entry via `getCachedProxy`. New deliveries (above) populate
    // `proxyDeliveredToWorker` themselves; this pass closes the gap
    // for cache hits where `submit()` is now a no-op.
    if (!budgetExhausted && this._lastProxyRequests.length > 0) {
      for (const req of this._lastProxyRequests) {
        if (budgetExhausted) break;
        this.currentUploadStats.resendProxiesConsidered++;

        if (this.proxyDeliveredToWorker.has(this.proxyKeyFromRequest(req))) {
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
   * driving `upload.resend_storm`. We add them to
   * `deliveryRejectedByWorker` so the resend pass can short-circuit,
   * and forward to `cpuCache.markRejected` so the cache stops
   * re-fetching them under eviction churn.
   *
   * Both sets are removed from `deliverySentToWorker` (skipped chunks
   * were optimistically added there by `sendDeliveryToWorker`). Both
   * are also removed from `deliveryRejectedByWorker` for evicted
   * chunks, since acceptance + later eviction proves the chunk was
   * deliverable.
   */
  handleChunksEvicted(
    workerMemberId: string,
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
  ): void {
    const sentSet = this.deliverySentToWorker.get(workerMemberId);
    if (sentSet) {
      for (const key of evicted) sentSet.delete(key);
      for (const key of skipped) sentSet.delete(key);
    }

    if (evicted.length > 0) {
      const rejectedSet = this.deliveryRejectedByWorker.get(workerMemberId);
      if (rejectedSet) {
        for (const key of evicted) rejectedSet.delete(key);
      }
    }

    if (skipped.length > 0) {
      let rejectedSet = this.deliveryRejectedByWorker.get(workerMemberId);
      if (!rejectedSet) {
        rejectedSet = new Set();
        this.deliveryRejectedByWorker.set(workerMemberId, rejectedSet);
      }
      const entityId = this.widToEntityId.get(workerMemberId);
      for (const key of skipped) {
        rejectedSet.add(key);
        if (entityId) cpuCache.markRejected(entityId, key);
      }
    }
  }

  /**
   * Process a wanted-set delta from the GPU worker.
   *
   * S7: accepts a discriminated union over chunks and proxies.
   *  - chunk: land in `workerWantedSet` (existing chunk-resend logic).
   *  - proxy: clear the entry from `proxyDeliveredToWorker` so the
   *    next tick's resend pass picks it up via `getCachedProxy`.
   *
   * (S7's earlier note about not tracking proxy resends is now
   * obsolete — see PRD #409 / S2: the cache-hit short-circuit means
   * we can't rely on `submit()` re-emission.)
   */
  handleWantedSetDelta(
    missing: Array<MissingChunkLite | MissingProxyLite>,
  ): void {
    this.workerWantedSet.clear();
    for (const entry of missing) {
      switch (entry.kind) {
        case "chunk": {
          let set = this.workerWantedSet.get(entry.entityId);
          if (!set) {
            set = new Set();
            this.workerWantedSet.set(entry.entityId, set);
          }
          set.add(entry.chunkKey);
          break;
        }
        case "proxy": {
          this.proxyDeliveredToWorker.delete(this.proxyKeyFromMissing(entry));
          break;
        }
      }
    }
  }

  /** Get all tracked worker member IDs (for multi-channel transition cleanup). */
  getTrackedMemberIds(): string[] {
    return [...this.deliverySentToWorker.keys()];
  }

  /** Clear all delivery state for a member (e.g. on dataset removal). */
  clearMemberResources(workerMemberId: string): void {
    this.deliverySentToWorker.delete(workerMemberId);
    this.deliveryRejectedByWorker.delete(workerMemberId);
    this.widToEntityId.delete(workerMemberId);
    // Drop proxy delivery tracking entries scoped to this member's dataset
    // so a re-add of the same dataset doesn't skip resends. Keys are
    // `${datasetId}|${entityId}|${kind}|${t}|${c}` — workerMemberId is
    // either a datasetId, an imageId, or `${imageId}:ch${c}`. We do a
    // best-effort prefix match on datasetId-shaped keys; benign if no
    // match (the worker recreates pools on next request anyway).
    const prefix = `${workerMemberId}|`;
    for (const key of this.proxyDeliveredToWorker) {
      if (key.startsWith(prefix)) this.proxyDeliveredToWorker.delete(key);
    }
    // M3: drop the cached lastViewEpoch entry. If `workerMemberId` is a
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
    epochs: PlanningEpochs,
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
    let sentSet = this.deliverySentToWorker.get(workerMemberId);
    if (!sentSet) {
      sentSet = new Set();
      this.deliverySentToWorker.set(workerMemberId, sentSet);
    }

    if (sentSet.has(delivery.chunkKey)) {
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
      const fullResDepth = imageSpec.multiscale.levels[0].shape[2];
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

    sentSet.add(delivery.chunkKey);
    return delivery.data.byteLength;
  }

  /**
   * S5: forward a proxy delivery to the GPU worker. The worker stub
   * just logs receipt; S7 will hook this up to real GPU residency.
   *
   * Records the composite key in `proxyDeliveredToWorker` so subsequent
   * cache-hit ticks (which re-submit `_lastProxyRequests`) can short-
   * circuit without re-uploading.
   */
  private sendProxyDeliveryToWorker(
    ctx: TickContext,
    delivery: ReadyProxyDelivery,
    epochs: PlanningEpochs,
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
    this.proxyDeliveredToWorker.add(this.proxyKeyFromDelivery(delivery));
    return delivery.data.byteLength;
  }

  /**
   * Composite key used by `proxyDeliveredToWorker`. Two small helpers —
   * one for `ReadyProxyDelivery` (uses `proxyKind`) and one for
   * `ProxyRequest` / `MissingProxy` (uses `kind` / `proxyKind`) — keep
   * each call site honest about which shape it has without runtime
   * branching.
   */
  private proxyKeyFromDelivery(delivery: ReadyProxyDelivery): string {
    return `${delivery.datasetId}|${delivery.entityId}|${delivery.proxyKind}|${delivery.t}|${delivery.c}`;
  }

  private proxyKeyFromRequest(req: ProxyRequest): string {
    return `${req.datasetId}|${req.entityId}|${req.kind}|${req.t}|${req.c}`;
  }

  private proxyKeyFromMissing(missing: MissingProxyLite): string {
    return `${missing.datasetId}|${missing.entityId}|${missing.proxyKind}|${missing.t}|${missing.c}`;
  }

  /**
   * Test-only accessor for the proxy-delivered tracking set. Marked
   * `// @internal` — used by `orchestrator.test.ts` to assert the
   * cache-hit short-circuit no longer re-uploads cached proxies.
   *
   * @internal
   */
  getProxyDeliveredKeys(): Set<string> {
    return this.proxyDeliveredToWorker;
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
    const epochs: PlanningEpochs = this.lastEpochs ?? {
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
    epochs: PlanningEpochs,
    ctx: TickContext,
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>,
    dsSettings: DatasetSettings | undefined,
  ): ColdStateMessage {
    const entityById = new Map(entities.map(e => [e.entityId, e]));

    const identityMatrix = (): Float32Array => {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    };

    // M2: build per-channel display state once per cold-state assembly.
    // Single-channel: lone visible channel falls back to dataset-level
    // contrast/gamma when no per-channel override exists. Multi-channel:
    // each visible channel gets its own override (already validated by
    // the planning entry-iteration above). Mirrors the source the old
    // per-frame layer params used in volumePath.ts / slicePath.ts.
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

    const coldActiveSet: ColdStateActiveEntry[] = activeSet.map(entry => {
      const entity = entityById.get(entry.entityId);
      const levels = (entity?.levels ?? []).map((lvl: LevelGeometry, idx: number) => {
        const chunkShape: [number, number, number] = [
          lvl.chunk_shape[2], lvl.chunk_shape[3], lvl.chunk_shape[4],
        ];
        const gridShape: [number, number, number] = [
          Math.ceil(lvl.shape[2] / lvl.chunk_shape[2]),
          Math.ceil(lvl.shape[3] / lvl.chunk_shape[3]),
          Math.ceil(lvl.shape[4] / lvl.chunk_shape[4]),
        ];
        const levelDims: [number, number, number] = [
          lvl.shape[2], lvl.shape[3], lvl.shape[4],
        ];
        return { level: idx, chunkShape, gridShape, levelDims };
      });

      // S7: forward Planning's promotion mode + proxy availability so
      // the worker's wanted-set knows whether to ask for proxies.
      // `parentWellId` lets the worker fan out a well-proxy upload to
      // its child fields' descriptors.
      const parentWellId =
        entity?.kind === "Field" ? (entity.parentId ?? null) : null;

      // M1: precomputed model matrices. For field entries, sourced from
      // `scene.member_model_matrix`; for `well-as-proxy` entries, from
      // `synthesizeWellRosterEntry`'s AABB. Falls back to identity for
      // entries without a roster match (defensive — descriptor entries
      // for missing roster members would render at the unit cube, which
      // is a clear visual failure rather than a silent off-screen one).
      const matrices = matricesByEntity.get(entry.entityId);
      const modelMatrix = matrices?.model ?? identityMatrix();
      const invModelMatrix = matrices?.inv ?? identityMatrix();

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
   * M3 (DOMAINS step 8a): build and send a viewEpoch hot-state message.
   * Walks the same canonical iteration as `buildDescriptorBuffer` so the
   * memberIds match what the worker uses to key chunk-eviction distance
   * lookups. One ray-pick per dataset (the WASM scene's
   * `ray_hit_local_image` is a per-dataset query) replicated to every
   * member, including per-channel composite keys.
   */
  private sendViewHotState(
    dsId: string,
    cold: ColdStateMessage,
    ctx: TickContext,
    epochs: PlanningEpochs,
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

