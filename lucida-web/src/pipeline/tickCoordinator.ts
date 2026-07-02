/**
 * TickCoordinator — planner role. Builds the `PlanningSnapshot` from live
 * WASM scene state per tick, calls `plan()` per dataset, caches on the
 * epoch ladder, and routes output through {@link Uploader} for
 * cold-state emission and chunk delivery.
 *
 * See `wiki/decisions/0034-orchestrator-split-into-pipeline-upload.md`.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { SceneSettings } from "../tickCommon.ts";
import { Axis } from "../axes.ts";
import {
  getSceneSettings,
  compositeKey,
} from "../tickCommon.ts";
import { computeMemberIndexMap } from "../renderer/descriptorBuffer.ts";
import {
  plan,
  emptyPlanStats,
  planProxyResidencyForInputs,
} from "./planning/index.ts";
import { configStore } from "./planning/configStore.ts";
import { buildPlanningSnapshot } from "./planning/snapshot.ts";
import { buildPlanningDatasetDebug } from "./planning/debug.ts";
import type {
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningState,
  ChunkRequest,
  RequestPlan,
  PlanningSnapshot,
  SelectionState,
} from "./planning/index.ts";
import type { SceneEpochs } from "./epochs.ts";
import type { VisibleRegion } from "./viewport.ts";

// Re-export: canonical declaration lives in `pipeline/planning/index.ts`.
export type { MinimapChunkCoord } from "./planning/index.ts";
import type { CpuCache } from "./fetch/index.ts";
import type { ProxyRequest } from "./planning/index.ts";
import {
  debugStats,
  type OrchDebug,
} from "../debug/debugStats.ts";
import type { ColdStateCauseKey } from "./upload/telemetry/coldState.ts";
import { buildRoster } from "./upload/coldState/roster.ts";
import type { Uploader } from "./upload/uploader.ts";

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

export interface TickCoordinatorResult {
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

interface PlannedDataset {
  dsId: string;
  dsSettings: SceneSettings["allSettings"][string] | undefined;
  snapshot: PlanningSnapshot;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  result: RequestPlan;
}

const VIEWER_INTEREST_TTL_MS = 2_000;
const VIEWER_INTEREST_KEY_CAP = 512;

function emitViewerInterestHint(
  ctx: TickContext,
  datasetId: string,
  selection: SelectionState,
  visibleRegion: VisibleRegion,
  requests: ChunkRequest[],
  generation: number,
): void {
  if (!ctx.sendViewerInterest) return;

  const desired = [];
  const predicted = [];
  for (const req of requests.slice(0, VIEWER_INTEREST_KEY_CAP)) {
    const lane = req.lane === "prefetch" || req.lane === "overview"
      ? "predicted"
      : req.lane === "coarse" || req.lane === "detail" || req.lane === "minimap"
        ? "visible"
        : "background";
    const entry = {
      image_id: req.imageId,
      key: req.chunkKey,
      lane,
    };
    if (lane === "predicted") predicted.push(entry);
    else desired.push(entry);
  }

  ctx.sendViewerInterest({
    dataset_id: datasetId,
    generation,
    t: selection.t,
    z: selection.z,
    channels: selection.visibleChannels,
    mode: selection.renderMode,
    viewport: {
      xy_bounds: visibleRegion.xyBoundsVox,
      z_range: visibleRegion.zRangeVox,
    },
    desired_keys: desired,
    predicted_keys: predicted,
    interaction: selection.interactionState,
    timestamp_ms: Date.now(),
    ttl_ms: VIEWER_INTEREST_TTL_MS,
  });
}

// Re-export: canonical home is `pipeline/upload/coldState/roster.ts`.
export { synthesizeWellRosterEntry } from "./upload/coldState/roster.ts";

export class TickCoordinator {
  private readonly uploader: Uploader;

  /**
   * Per-dataset opaque planner carry-forward state. Stores
   * `result.nextState` from each `plan()` call and threads it back as
   * `state` on the next tick.
   */
  private planningState = new Map<string, PlanningState>();
  private lastEpochs: SceneEpochs | null = null;
  private cachedResult: TickCoordinatorResult | null = null;
  // The core `labels` epoch (label visibility / opacity) at the last cold-state
  // rebuild. Kept out of `SceneEpochs` — which drives planning/fetch/hot-state,
  // none of which key off labels — because it matters to exactly one decision:
  // whether to rebuild the cold state so the descriptor's `labelOverlayOpacity`
  // (and label visibility → wanted set) is refreshed. Mirrors the core keeping
  // `labels` distinct from `selection` "so a renderer can invalidate just the
  // label overlay pass" (see `epoch.rs`). Without consuming it here, a label
  // opacity/visibility change wouldn't invalidate the epoch cache, so the mask
  // wouldn't update until an unrelated epoch (view/selection) advanced.
  private lastLabelsEpoch = -1;
  /**
   * Debug member stats from the most recent non-cache-hit run. Replayed
   * onto `debugStats` on epoch cache hits so the panel doesn't flash
   * `Visible: 0 / 0` between idle ticks.
   */
  private cachedDebugMemberSnapshot: {
    visibleMembers: number;
    totalMembers: number;
    memberStats: typeof debugStats.memberStats;
    selectedLevel: number;
    numLevels: number;
  } | null = null;
  private requestEpoch = 0;
  private _lastRequests: ChunkRequest[] = [];
  /** Per-dataset snapshot of the most recent visible region. Consumed by `orchDebug`. */
  private _lastVisibleRegion = new Map<string, VisibleRegion>();
  /** Per-dataset snapshot of the most recent entity list. */
  private _lastEntities = new Map<string, EntitySnapshot[]>();
  /** Per-dataset entityId → number of CpuCache-cached chunk keys. */
  private _lastCachedKeyCounts = new Map<string, Map<string, number>>();
  /** Per-dataset snapshot of the most recent full `plan()` output. */
  private _lastPlanByDataset = new Map<string, RequestPlan>();

  private configStoreUnsub: () => void;

  constructor(uploader: Uploader) {
    this.uploader = uploader;
    // Config tweaks don't bump any WASM epoch, so without this hook the
    // epoch fast-path would keep returning the cached plan and the
    // user's slider would have no visible effect until something else
    // invalidated the cache.
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
  ): TickCoordinatorResult | null {
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
    // Label overlay epoch (visibility / opacity), tracked outside `SceneEpochs`.
    // `?? 0` tolerates older WASM builds without the field (functional no-op).
    const labelsEpoch: number = rawEpochs.labels ?? 0;

    // Diff against last epochs — drives both the cache-hit decision and
    // per-epoch cause attribution published to coldState telemetry.
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
      if (labelsEpoch !== this.lastLabelsEpoch) causes.push("labels");
      isHit = causes.length === 0;
    }

    if (isHit) {
      this.uploader.coldStateTelemetry.recordHit(tickStart);
      if (debugStats.enabled && debugStats.orch) {
        debugStats.orch.epochCacheHit = true;
        debugStats.orch.coldState = this.uploader.coldStateTelemetry.publish();
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

    // Cold-state rebuild path. CpuCache owns wanted-generation and
    // delivery/rejection state, so the rebuild lifecycle advances there
    // exactly once before the per-dataset loop.
    ctx.cpuCache.onPlanRebuildStart();

    // Step 2 — Settings
    const settings = getSceneSettings(ctx.scene);
    const multiChannel = ctx.scene.multi_channel();

    // Read once per tick so all datasets in this rebuild see the same
    // config even if a UI knob fires between dataset iterations.
    const planningConfig = configStore.get();

    // Step 3 — Per-dataset loop
    const memberRoster = new Map<string, MemberRosterEntry[]>();
    const entityIndexByDataset = new Map<string, Map<string, number>>();
    const plannedDatasets: PlannedDataset[] = [];

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

      // 3c. Track per-entity cache occupancy for telemetry.
      const cachedKeyCountsForDataset = new Map<string, number>();
      for (const entity of entities) {
        const cachedKeys = ctx.cpuCache.snapshot().cached.get(entity.entityId);
        cachedKeyCountsForDataset.set(entity.entityId, cachedKeys?.size ?? 0);
      }
      this._lastCachedKeyCounts.set(dsId, cachedKeyCountsForDataset);

      // 3d. Plan. Opaque carry-forward state travels via {@link PlanningState};
      // `nextState` is stored for the next tick.
      const planningStateForDataset = this.planningState.get(dsId)
        ?? { previousActiveSet: [] };
      const result = plan(snapshot, planningStateForDataset, planningConfig);
      this.planningState.set(dsId, result.nextState);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion.set(dsId, visibleRegion);
      this._lastEntities.set(dsId, entities);
      emitViewerInterestHint(ctx, dsId, selection, visibleRegion, result.requests, this.requestEpoch);

      const entityById = new Map(entities.map(e => [e.entityId, e]));

      // Built before downstream side-effects so the panel reflects what
      // `plan()` produced, not the post-LOD-filter upload-path view.
      if (debugStats.enabled) {
        debugStats.planning.byDataset[dsId] = buildPlanningDatasetDebug(
          dsId, result, entities, entityById, visibleRegion, ctx.cpuCache,
          planningConfig,
        );
      }

      plannedDatasets.push({
        dsId,
        dsSettings,
        snapshot,
        entities,
        visibleRegion,
        selection,
        result,
      });
    }

    const proxyResidency = planProxyResidencyForInputs({
      inputs: plannedDatasets.map((planned) => ({
        snapshot: planned.snapshot,
        activeSet: planned.result.activeSet,
        proxyRequests: planned.result.proxyRequests,
      })),
      config: planningConfig,
    });

    const proxyRequestsByDataset = new Map<string, ProxyRequest[]>();
    for (const req of proxyResidency.admittedProxyRequests) {
      const list = proxyRequestsByDataset.get(req.datasetId) ?? [];
      list.push(req);
      proxyRequestsByDataset.set(req.datasetId, list);
    }

    const desiredProxyKeysByDataset = new Map<string, Set<string>>();
    for (const key of proxyResidency.desiredProxyKeys) {
      const datasetId = key.split("|", 1)[0];
      const set = desiredProxyKeysByDataset.get(datasetId) ?? new Set<string>();
      set.add(key);
      desiredProxyKeysByDataset.set(datasetId, set);
    }

    for (const planned of plannedDatasets) {
      const { dsId, dsSettings, entities, visibleRegion, selection } = planned;
      const result = planned.result;
      const budgetedProxyRequests = proxyRequestsByDataset.get(dsId) ?? [];
      const budgetedResult: RequestPlan = {
        ...result,
        proxyRequests: budgetedProxyRequests,
      };
      this._lastPlanByDataset.set(dsId, budgetedResult);

      // 3e. Build member roster + per-entity matrix map in one walk.
      const { entries: rosterEntries, matricesByEntity } = buildRoster({
        activeSet: result.activeSet,
        entities,
        ctx,
        datasetId: dsId,
      });
      memberRoster.set(dsId, rosterEntries);

      // Drives atlas creation/remap + wanted-set + descriptor buffer
      // build; dsSettings bakes per-channel display state into descriptors.
      const coldMsg = this.uploader.sendColdState({
        ctx,
        datasetId: dsId,
        activeSet: result.activeSet,
        entities,
        selection,
        multiChannel,
        visibleRegion,
        renderRadiusView: {
          detail: planningConfig.detailRenderRadiusView,
          coarse: planningConfig.coarseRenderRadiusView,
        },
        epochs: result.epochs,
        desiredProxyKeys: desiredProxyKeysByDataset.get(dsId) ?? new Set(),
        matricesByEntity,
        dsSettings,
      });
      // Same memberId → entityIndex map the worker builds from cold
      // state — both sides converge because they walk the same iteration order.
      entityIndexByDataset.set(dsId, computeMemberIndexMap(coldMsg));

      // Emit before render messages so `rayHitPerEntity` is current
      // when chunk-data eviction fires. Short-circuits on unchanged viewEpoch.
      this.uploader.sendViewHotStateIfAdvanced({
        ctx,
        datasetId: dsId,
        coldMsg,
        epochs: result.epochs,
      });

      // Submit chunks + proxies in a single call so they don't cancel
      // each other. Cancellation contract: a request omitted by the
      // next plan has its in-flight fetch aborted.
      ctx.cpuCache.submit({
        requests: result.requests,
        activeSet: result.activeSet,
        proxyRequests: budgetedProxyRequests,
        epochs: result.epochs,
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
          // no LOD bookkeeping (-1 sentinel), invisibles report coarsest.
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

    // Step 4 — TickCoordinator debug snapshot
    if (debugStats.enabled) {
      const orchDebug: OrchDebug = {
        activeSet: [],
        laneCount: { detail: 0, coarse: 0, prefetch: 0, overview: 0 },
        chunksByLevel: {},
        topRequests: [],
        members: [],
        hasMixedLevels: false,
        epochCacheHit: false,
        proxyResidency: {
          ...proxyResidency.stats,
          topDecisions: proxyResidency.decisions.slice(0, 20).map((decision) => ({
            datasetId: decision.datasetId,
            wellId: decision.wellId,
            representation: decision.representation,
            proxyCount: decision.proxyKeys.length,
            bytes: decision.bytes,
            reason: decision.reason,
          })),
        },
        // Replaced after `coldStateTelemetry.recordRebuild` below.
        coldState: this.uploader.coldStateTelemetry.publish(),
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

      // Aggregate per-dataset active sets from `previousActiveSet`
      // (the active set produced by the most recent `plan()` call).
      // ActiveSetEntry is a discriminated union; per-variant LOD columns
      // are derived from `kind` (well-as-proxy = 0, field reads from entry,
      // invisible reports coarsest).
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
          else if (r.lane === "coarse") orchDebug.laneCount.coarse++;
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

      // OrchDebug exposes one `visibleRegion`; pick the first dataset
      // (insertion order = dataset iteration order in step 3).
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
    const outputEpochs: SceneEpochs = { ...currentEpochs, request: this.requestEpoch };
    this.lastEpochs = outputEpochs;
    this.lastLabelsEpoch = labelsEpoch;
    this.cachedResult = { memberRoster, settings, multiChannel, epochs: outputEpochs, entityIndexByDataset };
    if (debugStats.enabled) {
      this.cachedDebugMemberSnapshot = {
        visibleMembers: debugStats.visibleMembers,
        totalMembers: debugStats.totalMembers,
        memberStats: [...debugStats.memberStats],
        selectedLevel: debugStats.selectedLevel,
        numLevels: debugStats.numLevels,
      };
    }

    // Record cause + duration after step 4 so the OrchDebug published
    // this tick reflects this rebuild.
    const tickEnd = performance.now();
    this.uploader.coldStateTelemetry.recordRebuild(
      tickStart, causes, tickEnd - tickStart,
    );
    if (debugStats.enabled && debugStats.orch) {
      debugStats.orch.coldState = this.uploader.coldStateTelemetry.publish();
    }

    return this.cachedResult;
  }

  /**
   * Clear planner-side per-dataset state on dataset removal. Upload-side
   * cleanup is the Uploader's responsibility.
   *
   * The id is ambiguous (datasetId, imageId, or `${imageId}:ch${c}`). The
   * dataset-removal path sees one explicit datasetId call plus per-member
   * calls; member-shaped ids are no-ops against the datasetId-keyed maps.
   */
  clearMemberResources(workerMemberId: string): void {
    delete debugStats.planning.byDataset[workerMemberId];
    this._lastPlanByDataset.delete(workerMemberId);
    this._lastEntities.delete(workerMemberId);
    this._lastVisibleRegion.delete(workerMemberId);
    this._lastCachedKeyCounts.delete(workerMemberId);
    // Without this delete, a dataset removed and re-added would keep
    // its prior `PlanningState` (`previousActiveSet` etc.) across the gap.
    this.planningState.delete(workerMemberId);
  }

  /** Per-dataset snapshot of the most recent `plan()` output. Live Map — do not mutate. */
  getLastPlans(): ReadonlyMap<string, RequestPlan> {
    return this._lastPlanByDataset;
  }

  /**
   * Debug helper: synthesize a single-proxy `RequestPlan` and submit it
   * to CpuCache. Exposed on `window.__orch.tickCoordinator` by App.tsx
   * for dev-console invocation.
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
}
