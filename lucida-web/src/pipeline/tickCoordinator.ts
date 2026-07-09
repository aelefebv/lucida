/**
 * TickCoordinator — planner role. Builds the `PlanningSnapshot` from live
 * WASM scene state per tick, calls `plan()` per dataset, caches on the
 * epoch ladder, and routes output through {@link Uploader} for
 * cold-state emission and chunk delivery.
 *
 * See `wiki/decisions/0034-orchestrator-split-into-pipeline-upload.md`.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { DatasetSettings, SceneSettings } from "../tickCommon.ts";
import { Axis } from "../axes.ts";
import {
  getActiveChannels,
  getSceneSettings,
  compositeKey,
} from "../tickCommon.ts";
import { buildDisplayStateByChannel } from "./upload/coldState/displayState.ts";
import type { ColdStateDisplayState } from "../renderer/workerProtocol.ts";
import { computeMemberIndexMap } from "../renderer/descriptorBuffer.ts";
import {
  plan,
  emptyPlanStats,
  planProxyResidencyForInputs,
} from "./planning/index.ts";
import { configStore } from "./planning/configStore.ts";
import { buildPlanningSnapshot } from "./planning/snapshot.ts";
import { buildPlanningDatasetDebug } from "./planning/debug.ts";
import { computeLabelChunkRequests } from "./planning/labelRequests.ts";
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
  DEBUG_MEMBER_ROW_CAP,
  debugStats,
  type OrchDebug,
} from "../debug/debugStats.ts";
import type { ColdStateCauseKey } from "./upload/telemetry/coldState.ts";
import { orchTelemetryActive } from "./upload/telemetry/active.ts";
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
   * shader's `renderMode` branch (group-as-proxy direct sample vs
   * detail+proxy fallback). Optional for backward compat.
   */
  mode?: "group-as-proxy" | "tiles-with-proxy-fallback" | "tiles-with-detail";
  /**
   * Optional precomputed world-space model matrix for the `[0,1]^3` unit
   * cube that bounds this member. When present, the render path uses it
   * instead of querying `scene.member_model_matrix`. Used by
   * `group-as-proxy` entries because groups aren't in `derived.members`
   * and therefore have no native model matrix. Column-major 4×4.
   * `invModelMatrix` is the matching inverse.
   */
  modelMatrix?: Float32Array;
  invModelMatrix?: Float32Array;
  /**
   * Optional 2D world-space footprint of the member (in voxel units, the
   * same coordinate frame as `position`). When present, the slice path
   * uses these instead of the dataset's per-image dataW/dataH for layer
   * sizing — necessary for synthesized `group-as-proxy` entries whose
   * footprint spans multiple tile images.
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

/**
 * Coalescing window for interactive view changes (pan/zoom). During a
 * continuous camera move the render pass already reflects the fresh
 * camera every frame from the cached roster, so the O(visible-entities)
 * residency rebuild is skipped and only re-run at this coarse cadence —
 * enough to fetch tiles that scroll into view while the view keeps
 * moving. The trailing rebuild after the view settles applies the final
 * viewport.
 */
const VIEW_REPLAN_INTERVAL_MS = 200;

/**
 * Coalescing window for interactive selection changes (T/C/Z scrub,
 * contrast/gamma/colormap/display drag). The leading change rebuilds
 * promptly; further changes within this window coalesce so a continuous
 * scrub updates content at this cadence instead of rebuilding every
 * frame. The trailing rebuild after the window guarantees the settled
 * value always renders.
 */
const SELECTION_COALESCE_INTERVAL_MS = 150;

/**
 * Minimum spacing between per-member sent-count refreshes on epoch-hit
 * ticks. Sent counts advance between rebuilds as the upload path drains
 * the cache, so the replayed rows are recomputed from the delivery
 * ledger — but not on every idle frame; the panel only polls ~5×/s.
 */
const MEMBER_SENT_REFRESH_MS = 250;

/**
 * Per-dataset carry-forward captured at each full rebuild. Lets the next
 * rebuild prove — cheaply, without re-running the O(active-set) rebuild —
 * that the ONLY thing that changed is the per-channel intensity display
 * state (contrast / gamma / colormap / opacity). When that holds, a small
 * descriptor patch is pushed to the worker instead of replanning; any other
 * change falls through to a full rebuild.
 *
 * Every non-display signal the render depends on is captured here, so a
 * match guarantees the reused roster + residency are still exact. When any
 * signal is uncertain the caller falls back to a full rebuild.
 */
interface DatasetRebuildSignature {
  /** Visible channels this rebuild planned for. */
  visibleChannels: number[];
  /** Per-channel intensity display state emitted to the worker. */
  displayState: Record<number, ColdStateDisplayState>;
  /** Full [start, end) voxel z-range this rebuild planned for. */
  zRangeVox: [number, number];
  /**
   * Serialized dataset settings with only the pure intensity-display
   * fields removed. Any other field — visibility, blend mode, render mode,
   * detail-level override, channel visibility, per-label state, or a field
   * added in the future — is retained, so it forces a rebuild by default
   * until proven display-only.
   */
  nonDisplayKey: string;
}

/**
 * Visible channels for a dataset, matching the assembly in
 * `buildPlanningSnapshot`: multi-channel fans out to every visible
 * channel; single-channel plans only the current channel.
 */
function computeVisibleChannels(
  multiChannel: boolean,
  dsSettings: DatasetSettings | undefined,
  sceneC: number,
): number[] {
  if (multiChannel && dsSettings?.channel_settings?.length) {
    return getActiveChannels(dsSettings);
  }
  return [sceneC];
}

function numberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A dataset's settings with only the pure intensity-display fields
 * removed. Those fields — dataset-level contrast / gamma / opacity and
 * per-channel contrast / gamma / colormap — are the entire payload of the
 * display patch, so a change confined to them (and nothing else) can take
 * the display-only path. Every other field is kept by construction (spread
 * rest), including a field added in the future, so it stays in the
 * fingerprint and forces a full rebuild. Per-channel `visible` is kept
 * because it drives the visible-channel set. Does not mutate its input.
 */
function nonDisplayDatasetShape(ds: DatasetSettings): unknown {
  const {
    contrast_min: _cmin,
    contrast_max: _cmax,
    gamma: _gamma,
    opacity: _opacity,
    channel_settings,
    ...rest
  } = ds;
  void _cmin; void _cmax; void _gamma; void _opacity;
  const channels = (channel_settings ?? []).map((ch) => {
    const {
      contrast_min: _ccmin,
      contrast_max: _ccmax,
      gamma: _cgamma,
      colormap: _colormap,
      ...chRest
    } = ch;
    void _ccmin; void _ccmax; void _cgamma; void _colormap;
    return chRest;
  });
  return { ...rest, channel_settings: channels };
}

/**
 * Fingerprint of everything about a dataset's settings EXCEPT the pure
 * intensity-display fields. Equal fingerprints across two ticks prove no
 * non-display setting changed: `label_settings`, blend mode, render mode,
 * detail-level override, channel visibility, and dataset visibility are all
 * retained. `opacity` is a per-fragment alpha with no effect on translucent
 * draw order (layer/quad order is fixed by roster + layer order, never
 * opacity), so it is treated as display; blend mode changes compositing, so
 * it stays in the fingerprint and forces a rebuild.
 */
function nonDisplayKeyForDataset(ds: DatasetSettings | undefined): string {
  return JSON.stringify(ds ? nonDisplayDatasetShape(ds) : null);
}

/**
 * The [start, end) voxel z-range WASM currently reports for a dataset —
 * the same value {@link buildPlanningSnapshot} reads, with matching null
 * handling so the fast-path comparison lines up with the captured range
 * exactly. Read directly (rather than inferred from `scene.z()`, which is
 * only the slab START) so the display-only path notices a z-slab extension
 * — which moves the range END — and falls through to a full rebuild.
 */
function readZRangeVox(
  scene: TickContext["scene"],
  datasetId: string,
): [number, number] {
  const raw = scene.visible_region(datasetId);
  if (!raw || raw === "null") return [0, 1];
  const parsed = JSON.parse(raw) as { z_range?: [number, number] } | null;
  return parsed?.z_range ?? [0, 1];
}

/**
 * True when two intensity display states are value-equal
 * (order-independent). Compares only the fields the display patch carries
 * and can change: contrast, gamma, opacity, and colormap. `channelMask` is
 * a pure function of the channel index (already pinned via
 * `visibleChannels`), and `colormapMode` / `labelOpacity` are constant on
 * the intensity path — label-overlay state never reaches here because a
 * `label_settings` change fails the non-display fingerprint first.
 */
function displayStatesEqual(
  a: Record<number, ColdStateDisplayState>,
  b: Record<number, ColdStateDisplayState>,
): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    const da = a[key as unknown as number];
    const db = b[key as unknown as number];
    if (!db) return false;
    if (
      da.contrastMin !== db.contrastMin ||
      da.contrastMax !== db.contrastMax ||
      da.gamma !== db.gamma ||
      da.opacity !== db.opacity ||
      da.colormapName !== db.colormapName
    ) {
      return false;
    }
  }
  return true;
}

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
export { synthesizeGroupRosterEntry } from "./upload/coldState/roster.ts";

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
  /**
   * Timestamp (`performance.now()`) at the COMPLETION of the last full
   * rebuild. Interactive view/selection changes within a coalescing
   * window of this are served from the cached result instead of paying
   * another O(visible-entities) rebuild. Stamped at completion — not at
   * the start of the tick — so the window measures idle time since the
   * rebuild finished. Anchoring it at the start would charge the
   * rebuild's own wall-clock cost against the window, so a rebuild that
   * runs longer than the window (routine on a wide collection, where a
   * single rebuild is tens to hundreds of ms) would leave every
   * following interactive frame already past the window and coalescing
   * would never engage on exactly the collections it exists to protect.
   */
  private lastRebuildAt = Number.NEGATIVE_INFINITY;
  /**
   * True when an interactive (view/selection) change was coalesced —
   * skipped this tick — and its trailing rebuild has not yet run. The
   * render loop reads this to keep ticking until the coalescing window
   * elapses and the rebuild fires, so the settled state always renders
   * even if the user has stopped interacting (the trailing-edge
   * guarantee). While it is set, `lastEpochs` is deliberately left stale
   * so the pending change is re-detected next tick and never lost.
   */
  private pendingDeferredRebuild = false;
  /**
   * Scene scalars captured at the last full rebuild. The display-only fast
   * path consults these (with {@link lastRebuildByDataset}) to prove the
   * change is a pure intensity-display edit. The z-range lives per-dataset
   * in {@link DatasetRebuildSignature} (it is per-dataset voxel space and
   * carries the slab END, which `scene.z()` omits).
   */
  private lastRebuildScalars: {
    t: number;
    c: number;
    mode: "slice" | "volume";
    multiChannel: boolean;
  } | null = null;
  /** Layer participation + order (JSON) at the last full rebuild. */
  private lastLayerOrderKey = "";
  /** Settings-visible dataset ids at the last full rebuild. */
  private lastVisibleDatasetIds = new Set<string>();
  /** Per-planned-dataset carry-forward for the display-only fast path. */
  private readonly lastRebuildByDataset = new Map<string, DatasetRebuildSignature>();
  /**
   * Debug member stats from the most recent non-cache-hit run. Replayed
   * onto `debugStats` on epoch cache hits so the panel doesn't flash
   * `Visible: 0 / 0` between idle ticks.
   */
  private cachedDebugMemberSnapshot: {
    visibleMembers: number;
    totalMembers: number;
    memberStats: typeof debugStats.memberStats;
    /** Uncapped count of members with pending requests (rows are capped). */
    memberStatsActiveTotal: number;
    /**
     * Planned (non-prefetch) chunk requests backing each `memberStats`
     * row, index-aligned. Lets epoch-hit ticks recompute each row's
     * sent count from the delivery ledger instead of replaying the
     * rebuild-time values.
     */
    memberChunkRefs: ChunkRequest[][];
    selectedLevel: number;
    numLevels: number;
  } | null = null;
  /** Last time the replayed rows' sent counts were recomputed. Starts
   *  at -Infinity so the first epoch-hit tick always refreshes. */
  private lastMemberSentRefreshAt = -Infinity;
  private requestEpoch = 0;
  private _lastRequests: ChunkRequest[] = [];
  /** Per-dataset snapshot of the most recent visible region. Consumed by `orchDebug`. */
  private _lastVisibleRegion = new Map<string, VisibleRegion>();
  /** Per-dataset snapshot of the most recent entity list. */
  private _lastEntities = new Map<string, EntitySnapshot[]>();
  /** Per-dataset snapshot of the most recent full `plan()` output. */
  private _lastPlanByDataset = new Map<string, RequestPlan>();

  private configStoreUnsub: () => void;

  /**
   * The planner entry point. Defaults to the module-level {@link plan};
   * injectable so tests can pass a spy/stub directly instead of
   * `vi.resetModules()`-mocking the planning singleton (that pattern raced
   * across shuffled tests — see lucida-i7r). Production never passes it.
   */
  private readonly planFn: typeof plan;

  constructor(uploader: Uploader, planFn: typeof plan = plan) {
    this.uploader = uploader;
    this.planFn = planFn;
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
      isHit = causes.length === 0;
    }

    // Coalescing gate. A full rebuild is O(visible-entities) (descriptor
    // build + O(N) worker cold-state message), so paying it on every
    // interactive frame collapses frame rate on a wide collection. When
    // only interactive-class epochs moved, serve the cached result and
    // defer the rebuild:
    //   - view only (pan/zoom): the render pass reads the camera fresh
    //     every frame and transforms the cached roster's world-space
    //     positions at draw time, so a moved camera renders correctly
    //     from the cached roster. Replan only at a coarse cadence to
    //     fetch tiles that scroll into view.
    //   - selection (T/C/Z, contrast/gamma/colormap/display): the
    //     leading change rebuilds promptly, then further changes within
    //     the window coalesce so a continuous scrub doesn't rebuild
    //     every frame.
    // Structural changes (content/layout/asset) are never coalesced —
    // a newly-added dataset, layout change, or catalog change must
    // render immediately.
    let coalescedSkip = false;
    if (!isHit && hasPrior) {
      const structural =
        causes.includes("content") ||
        causes.includes("layout") ||
        causes.includes("asset");
      if (!structural) {
        const interval = causes.includes("selection")
          ? SELECTION_COALESCE_INTERVAL_MS
          : VIEW_REPLAN_INTERVAL_MS;
        if (tickStart - this.lastRebuildAt < interval) {
          coalescedSkip = true;
          // Leave `lastEpochs` stale so the change is re-detected next
          // tick, and flag the deferral so the render loop keeps ticking
          // until the window elapses and the trailing rebuild lands.
          this.pendingDeferredRebuild = true;
        }
      }
    }

    if (isHit || coalescedSkip) {
      // A genuine cache hit (no interactive epochs moved) clears any owed
      // deferral: nothing is left to rebuild, so the loop must be free to
      // go idle. A coalesced skip is the opposite — it keeps the flag set
      // (assigned above) so the render loop keeps ticking until the
      // trailing rebuild lands. The two are mutually exclusive
      // (`coalescedSkip` is only ever set when `!isHit`), so clearing here
      // can never drop a live deferral. Without this, a cache hit that
      // arrives while a deferral is still owed (reachable only if an epoch
      // counter regresses, e.g. a scene reset) would leave the flag stuck
      // true forever and spin the loop at full frame rate.
      if (isHit) {
        this.pendingDeferredRebuild = false;
      }
      this.serveCachedDebug(ctx, tickStart);
      return this.cachedResult;
    }

    // Past the coalescing gate. Read the shared inputs once so all datasets
    // and the display-only fast path below see the same config.
    const settings = getSceneSettings(ctx.scene);
    const multiChannel = ctx.scene.multi_channel();
    const planningConfig = configStore.get();

    const structural =
      causes.includes("content") ||
      causes.includes("layout") ||
      causes.includes("asset");
    const selectionOnly =
      !structural && causes.length === 1 && causes[0] === "selection";

    // Display-only fast path — a per-channel intensity edit (contrast /
    // gamma / colormap / opacity) with nothing else changed. When it can
    // prove that, the camera, T/Z/C, z-range, visible set, and every
    // non-display setting are unchanged, so the visible set, active set,
    // and residency are all identical; only the shader's display fields
    // differ. Push a cheap descriptor patch to the worker and reuse the
    // cached roster instead of paying a full O(active-set) replan +
    // cold-state rebuild. No plan()/roster/submit runs. Any non-display
    // change fails the proof inside and falls through to the full rebuild.
    if (
      selectionOnly &&
      this.tryDisplayOnlyUpdate({ ctx, currentEpochs, settings, multiChannel, tickStart })
    ) {
      this.serveCachedDebug(ctx, tickStart);
      return this.cachedResult;
    }

    // Full rebuild (structural change, a non-display selection change, a
    // view move, the coalescing window elapsing, or the first/forced plan).
    // Clear any pending deferral — the settled state is being applied now.
    // The coalescing anchor (`lastRebuildAt`) is stamped at rebuild
    // COMPLETION further below, not here, so the window measures idle time
    // since the rebuild finished rather than charging the rebuild's own
    // duration against it.
    this.pendingDeferredRebuild = false;

    // CpuCache owns wanted-generation and delivery/rejection state, so the
    // rebuild lifecycle advances there exactly once before the per-dataset
    // loop.
    ctx.cpuCache.onPlanRebuildStart();

    // One CPU-cache snapshot per rebuild, taken only when a debug surface
    // will read it. `snapshot()` walks every resident entity in the chunk
    // and overview stores, so it must never run per-entity or per-dataset
    // — with tens of thousands of visible entities that walk would
    // dominate the rebuild. Every debug consumer below (planning panel,
    // entityDiag) shares this single copy.
    const cacheSnapshot = debugStats.enabled ? ctx.cpuCache.snapshot() : null;

    const memberRoster = new Map<string, MemberRosterEntry[]>();
    const entityIndexByDataset = new Map<string, Map<string, number>>();
    const plannedDatasets: PlannedDataset[] = [];
    // Index-aligned with the rows pushed to `debugStats.memberStats`
    // below (the render loop resets those per tick); captured into the
    // member snapshot so epoch-hit ticks can refresh sent counts.
    const memberChunkRefs: ChunkRequest[][] = [];

    for (const [dsId, ds] of ctx.datasets) {
      // Skip invisible datasets.
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) continue;

      // Build the planning snapshot from live WASM state. Returns null
      // when `view_query` produces no visible entities (dataset not yet
      // registered, etc.) — skip the dataset in that case.
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

      // Plan. Opaque carry-forward state travels via {@link PlanningState};
      // `nextState` is stored for the next tick.
      const planningStateForDataset = this.planningState.get(dsId)
        ?? { previousActiveSet: [] };
      const result = this.planFn(snapshot, planningStateForDataset, planningConfig);
      this.planningState.set(dsId, result.nextState);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion.set(dsId, visibleRegion);
      this._lastEntities.set(dsId, entities);
      emitViewerInterestHint(ctx, dsId, selection, visibleRegion, result.requests, this.requestEpoch);

      // Built before downstream side-effects so the panel reflects what
      // `plan()` produced, not the post-LOD-filter upload-path view.
      if (cacheSnapshot !== null) {
        const entityById = new Map(entities.map(e => [e.entityId, e]));
        debugStats.planning.byDataset[dsId] = buildPlanningDatasetDebug(
          dsId, result, entities, entityById, visibleRegion, cacheSnapshot,
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

    // Rebuild the display-only fast-path signatures from scratch: datasets
    // that no longer plan (turned invisible / scrolled fully out) drop out.
    this.lastRebuildByDataset.clear();

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

      // 3d. Build member roster + per-entity matrix map in one walk.
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

      // Categorical label overlays are invisible to the WASM planner
      // (labels live outside `manifest.images`/`entities`), so their chunk
      // requests are synthesized here from the label's own geometry and
      // merged into the fetch plan. In `slice` mode the label's mapped
      // Z-plane is fetched; in `volume` mode the whole label volume (every
      // z-chunk) is fetched for the 3D first-hit surface. Scoped under each
      // label's own image id, so they never perturb intensity-chunk eviction.
      const labelRequests = computeLabelChunkRequests({
        datasetId: dsId,
        manifest: ctx.datasets.get(dsId)!.manifest,
        t: selection.t,
        z: selection.z,
        // Fetch only the labels the render path will draw (visible +
        // eligible), so a hidden label is neither fetched nor drawn.
        labelSettings: dsSettings?.label_settings,
        mode: ctx.mode as "slice" | "volume",
      });
      const requestsWithLabels =
        labelRequests.length > 0
          ? [...result.requests, ...labelRequests]
          : result.requests;

      // Submit chunks + proxies in a single call so they don't cancel
      // each other. Cancellation contract: a request omitted by the
      // next plan has its in-flight fetch aborted.
      ctx.cpuCache.submit({
        requests: requestsWithLabels,
        activeSet: result.activeSet,
        proxyRequests: budgetedProxyRequests,
        epochs: result.epochs,
        stats: result.stats,
        // `nextState` is required on RequestPlan but unused by submit();
        // forward the planner's pointer so the shape stays honest.
        nextState: result.nextState,
      });

      // Debug stats. Everything here must stay O(entities + requests):
      // a wide collection has tens of thousands of visible entities, and
      // a per-entity scan of the active set or request list froze the
      // page for seconds with the panel open. Per-member ROWS are also
      // bounded (DEBUG_MEMBER_ROW_CAP) — the scalar counters keep the
      // full population visible.
      if (debugStats.enabled) {
        const activeByEntity = new Map(
          result.activeSet.map((a) => [a.entityId, a]),
        );
        const requestsByEntity = new Map<string, ChunkRequest[]>();
        for (const r of result.requests) {
          if (r.lane === "prefetch") continue;
          const list = requestsByEntity.get(r.entityId);
          if (list) list.push(r);
          else requestsByEntity.set(r.entityId, [r]);
        }
        for (const entity of entities) {
          debugStats.totalMembers++;
          debugStats.visibleMembers++;
          const activeEntry = activeByEntity.get(entity.entityId);
          // Only tile entries carry `targetLod`; group-as-proxy has
          // no LOD bookkeeping (-1 sentinel), invisibles report coarsest.
          const tl =
            activeEntry?.kind === "tile"
              ? activeEntry.targetLod
              : activeEntry?.kind === "invisible"
                ? activeEntry.coarsestLod
                : -1;
          // Rows only for members with pending chunk requests — the
          // panel filters to `chunksNeeded > 0` anyway — and row-capped.
          const entityRequests = requestsByEntity.get(entity.entityId);
          const chunksNeeded = entityRequests?.length ?? 0;
          if (chunksNeeded > 0 && entityRequests) {
            debugStats.memberStatsActiveTotal++;
            if (debugStats.memberStats.length < DEBUG_MEMBER_ROW_CAP) {
              const memberKey = multiChannel
                ? compositeKey(entity.imageId, selection.c)
                : entity.imageId;
              // Delivery state clears at rebuild start (atlas remap), so
              // this usually reads 0 here and climbs on epoch-hit ticks
              // as the upload path re-sends — the honest signal.
              let chunksSent = 0;
              for (const r of entityRequests) {
                if (ctx.cpuCache.isChunkSent(r)) chunksSent++;
              }
              debugStats.memberStats.push({
                id: memberKey,
                level: tl,
                numLevels: entity.levels.length,
                chunksNeeded,
                chunksSent,
              });
              memberChunkRefs.push(entityRequests);
            }
          }
          if (tl >= 0) {
            debugStats.selectedLevel = tl;
            debugStats.numLevels = entity.levels.length;
          }
        }
      }

      // Capture this dataset's display-only fast-path signature: the
      // display state now on the worker, plus every non-display signal a
      // later intensity-display edit must prove unchanged (visible
      // channels, the full z-range, and the stripped settings fingerprint).
      this.lastRebuildByDataset.set(dsId, {
        visibleChannels: selection.visibleChannels,
        displayState: buildDisplayStateByChannel(selection.visibleChannels, dsSettings),
        zRangeVox: visibleRegion.zRangeVox,
        nonDisplayKey: nonDisplayKeyForDataset(dsSettings),
      });
    }

    // Step 4 — TickCoordinator debug snapshot
    if (debugStats.enabled) {
      const orchDebug: OrchDebug = {
        activeSet: [],
        activeSetTotal: 0,
        activeSetModeCounts: {
          groupAsProxy: 0,
          tilesProxyFallback: 0,
          tilesDetail: 0,
          invisible: 0,
        },
        laneCount: { detail: 0, coarse: 0, prefetch: 0, overview: 0 },
        chunksByLevel: {},
        topRequests: [],
        members: [],
        membersTotal: 0,
        hasMixedLevels: false,
        epochCacheHit: false,
        proxyResidency: {
          ...proxyResidency.stats,
          topDecisions: proxyResidency.decisions.slice(0, 20).map((decision) => ({
            datasetId: decision.datasetId,
            groupId: decision.groupId,
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

      // Aggregate from member roster. Rows are capped (wide collections
      // have tens of thousands of members); `membersTotal` carries the
      // full count for the panel's "+N more" line.
      for (const [_key, entries] of memberRoster) {
        for (const m of entries) {
          orchDebug.membersTotal++;
          if (orchDebug.members.length >= DEBUG_MEMBER_ROW_CAP) continue;
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
      // are derived from `kind` (group-as-proxy = 0, tile reads from entry,
      // invisible reports coarsest). Mode COUNTS run over the full set;
      // row emission is capped like the other per-member arrays.
      const modeCounts = orchDebug.activeSetModeCounts;
      for (const [, state] of this.planningState) {
        for (const entry of state.previousActiveSet) {
          orchDebug.activeSetTotal++;
          if (entry.kind === "group-as-proxy") {
            modeCounts.groupAsProxy++;
          } else if (entry.kind === "invisible") {
            modeCounts.invisible++;
          } else if (entry.mode === "tiles-with-proxy-fallback") {
            modeCounts.tilesProxyFallback++;
          } else {
            modeCounts.tilesDetail++;
          }
          if (orchDebug.activeSet.length >= DEBUG_MEMBER_ROW_CAP) continue;
          if (entry.kind === "group-as-proxy") {
            orchDebug.activeSet.push({
              entityId: entry.entityId,
              mode: "group-as-proxy",
              targetLod: 0,
              coarsestDetailLod: 0,
              detailOwnedLodRange: [0, 0],
            });
          } else if (entry.kind === "tile") {
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
      for (const [, entities] of this._lastEntities) {
        for (const e of entities) {
          if (entityDiagEntries.length >= 5) break;
          entityDiagEntries.push({
            entityId: e.entityId,
            position: e.layoutPositionVox,
            fullShape: e.levels.length > 0
              ? [e.levels[0].shape[Axis.X], e.levels[0].shape[Axis.Y]] as [number, number]
              : null,
            // Occupancy is counted lazily for just the entries shown
            // here, against the shared per-rebuild cache snapshot.
            cachedKeys: cacheSnapshot?.cached.get(e.entityId)?.size ?? 0,
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
    this.cachedResult = { memberRoster, settings, multiChannel, epochs: outputEpochs, entityIndexByDataset };

    // Capture the scene scalars, layer order, and visible-dataset set this
    // rebuild planned against, so the display-only fast path has a baseline
    // to prove against. `lastRebuildByDataset` was repopulated per dataset
    // above (each carries its own z-range).
    this.lastRebuildScalars = {
      t: ctx.scene.t(),
      c: ctx.scene.c(),
      mode: ctx.mode as "slice" | "volume",
      multiChannel,
    };
    this.lastLayerOrderKey = JSON.stringify(settings.layerOrder);
    this.lastVisibleDatasetIds = new Set<string>();
    for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
      if (dsSettings.visible) this.lastVisibleDatasetIds.add(dsId);
    }
    if (debugStats.enabled) {
      this.cachedDebugMemberSnapshot = {
        visibleMembers: debugStats.visibleMembers,
        totalMembers: debugStats.totalMembers,
        memberStats: [...debugStats.memberStats],
        memberStatsActiveTotal: debugStats.memberStatsActiveTotal,
        memberChunkRefs,
        selectedLevel: debugStats.selectedLevel,
        numLevels: debugStats.numLevels,
      };
    }

    // Stamp the coalescing anchor at rebuild COMPLETION. The window then
    // measures idle time since the rebuild finished, so coalescing engages
    // for the next interactive frame regardless of how long this rebuild
    // took — the property that makes the fast-path effective on a wide
    // collection, where a single rebuild can exceed the window on its own.
    const rebuildEnd = performance.now();
    this.lastRebuildAt = rebuildEnd;

    // Record cause + duration after step 4 so the OrchDebug published
    // this tick reflects this rebuild. Gated like recordHit above: the
    // rebuild window, cause attribution, and churn detector only run
    // while observable.
    if (orchTelemetryActive()) {
      this.uploader.coldStateTelemetry.recordRebuild(
        tickStart, causes, rebuildEnd - tickStart,
      );
    }
    if (debugStats.enabled && debugStats.orch) {
      debugStats.orch.coldState = this.uploader.coldStateTelemetry.publish();
    }

    return this.cachedResult;
  }

  /**
   * Cold-state window telemetry + debug member-stat replay for a tick that
   * serves the cached result instead of rebuilding (a genuine cache hit, a
   * coalesced skip, or the display-only fast path). Keeps the panel from
   * blinking to "Visible: 0 / 0" between rebuilds and refreshes sent counts
   * from the delivery ledger as idle fill lands.
   */
  private serveCachedDebug(ctx: TickContext, tickStart: number): void {
    // Aggregates only while someone can observe it — the panel
    // (debugStats) or the `orch` log category.
    if (orchTelemetryActive()) {
      this.uploader.coldStateTelemetry.recordHit(tickStart);
    }
    if (debugStats.enabled && debugStats.orch) {
      debugStats.orch.epochCacheHit = true;
      debugStats.orch.coldState = this.uploader.coldStateTelemetry.publish();
    }
    if (debugStats.enabled && this.cachedDebugMemberSnapshot) {
      const s = this.cachedDebugMemberSnapshot;
      // Sent counts keep advancing between rebuilds as the upload path
      // drains the cache; refresh the replayed rows from the delivery
      // ledger (throttled) so idle fill shows as progress instead of
      // freezing at the rebuild-time counts.
      const now = performance.now();
      if (now - this.lastMemberSentRefreshAt >= MEMBER_SENT_REFRESH_MS) {
        this.lastMemberSentRefreshAt = now;
        for (let i = 0; i < s.memberStats.length; i++) {
          const refs = s.memberChunkRefs[i];
          if (!refs) continue;
          let sent = 0;
          for (const r of refs) {
            if (ctx.cpuCache.isChunkSent(r)) sent++;
          }
          s.memberStats[i].chunksSent = sent;
        }
      }
      debugStats.visibleMembers = s.visibleMembers;
      debugStats.totalMembers = s.totalMembers;
      debugStats.memberStats = [...s.memberStats];
      debugStats.memberStatsActiveTotal = s.memberStatsActiveTotal;
      debugStats.selectedLevel = s.selectedLevel;
      debugStats.numLevels = s.numLevels;
    }
  }

  /**
   * The display-only fast path. Fires only when it can PROVE the sole
   * change since the last rebuild is the per-channel intensity display
   * state (contrast / gamma / colormap / opacity). It proves this
   * conservatively — every non-display signal must match the captured
   * baseline, and the settings fingerprint retains any unrecognized field —
   * so a change to anything else (a bundled `label_settings` toggle, a
   * z-slab extension, a channel-visibility flip, blend mode, layer order, a
   * field added later, …) fails the proof and the caller falls through to a
   * full rebuild. When it fires it pushes a small descriptor patch to the
   * worker and reuses the cached roster — no plan(), roster, submit, or
   * proxy residency.
   *
   * Returns `true` when it fully handled the tick (caller serves the cached
   * result); `false` when the change is not provably display-only, or when
   * nothing display-relevant actually changed. On `false` no worker message
   * is sent.
   */
  private tryDisplayOnlyUpdate(args: {
    ctx: TickContext;
    currentEpochs: SceneEpochs;
    settings: SceneSettings;
    multiChannel: boolean;
    tickStart: number;
  }): boolean {
    const { ctx, currentEpochs, settings, multiChannel, tickStart } = args;
    if (
      this.cachedResult === null ||
      this.lastRebuildScalars === null ||
      this.lastRebuildByDataset.size === 0
    ) {
      return false;
    }

    // Scene scalars must be unchanged — a T/C or mode change needs
    // different chunks, and multi-channel mode changes the member shape.
    // (Z is proven per-dataset below via the full z-range, which also
    // catches a slab extension that `scene.z()` alone would miss.)
    const scalars = this.lastRebuildScalars;
    if (
      ctx.scene.t() !== scalars.t ||
      ctx.scene.c() !== scalars.c ||
      (ctx.mode as "slice" | "volume") !== scalars.mode ||
      multiChannel !== scalars.multiChannel
    ) {
      return false;
    }
    const sceneC = scalars.c;

    // Layer participation + order must be unchanged — a reorder changes the
    // composite draw order, which is applied from the roster.
    if (JSON.stringify(settings.layerOrder) !== this.lastLayerOrderKey) return false;

    // The set of settings-visible datasets must be unchanged — a
    // visibility toggle also bumps the selection epoch but changes the
    // roster, so it needs a real rebuild. (Catches a dataset turning
    // visible, which would otherwise never appear in the per-dataset loop
    // below.)
    let visibleCount = 0;
    for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
      if (!dsSettings.visible) continue;
      visibleCount++;
      if (!this.lastVisibleDatasetIds.has(dsId)) return false;
    }
    if (visibleCount !== this.lastVisibleDatasetIds.size) return false;

    // Precheck (no side effects). For every planned dataset prove: still
    // visible; its non-display settings fingerprint (label state, blend
    // mode, render mode, detail override, channel visibility, …) unchanged;
    // its full z-range unchanged; its visible-channel set unchanged. Only
    // then is a display difference safe to push as a patch. Fresh display
    // state is computed once and reused for the push.
    const updates: Array<{
      dsId: string;
      displayState: Record<number, ColdStateDisplayState>;
      changed: boolean;
    }> = [];
    let anyDisplayChanged = false;
    for (const [dsId, sig] of this.lastRebuildByDataset) {
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) return false;
      if (nonDisplayKeyForDataset(dsSettings) !== sig.nonDisplayKey) return false;
      const zRange = readZRangeVox(ctx.scene, dsId);
      if (zRange[0] !== sig.zRangeVox[0] || zRange[1] !== sig.zRangeVox[1]) {
        return false;
      }
      const visibleChannels = computeVisibleChannels(multiChannel, dsSettings, sceneC);
      if (!numberArraysEqual(visibleChannels, sig.visibleChannels)) return false;
      const displayState = buildDisplayStateByChannel(visibleChannels, dsSettings);
      const changed = !displayStatesEqual(displayState, sig.displayState);
      if (changed) anyDisplayChanged = true;
      updates.push({ dsId, displayState, changed });
    }
    if (!anyDisplayChanged) return false;

    // Eligible. Push a display patch for each dataset whose display
    // actually changed, and refresh its cached signature so a later tick
    // compares against the value now on the worker.
    for (const u of updates) {
      if (!u.changed) continue;
      this.uploader.sendColdStateDisplay({
        ctx,
        datasetId: u.dsId,
        displayStateByChannel: u.displayState,
      });
      const sig = this.lastRebuildByDataset.get(u.dsId);
      if (sig) sig.displayState = u.displayState;
    }

    // Refresh the reused result's settings so display-field readers of the
    // cached settings (e.g. the minimap's contrast/colormap) see current
    // values. Only intensity-display fields can differ here — the proof
    // above pinned everything else — so the roster, geometry, layer order,
    // and blend modes are unchanged.
    this.cachedResult = { ...this.cachedResult, settings };

    // The change is fully applied — advance the epoch anchor so the loop
    // can idle, re-anchor coalescing, and clear any owed deferral.
    this.lastEpochs = currentEpochs;
    this.lastRebuildAt = tickStart;
    this.pendingDeferredRebuild = false;
    return true;
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
    // Without this delete, a dataset removed and re-added would keep
    // its prior `PlanningState` (`previousActiveSet` etc.) across the gap.
    this.planningState.delete(workerMemberId);
    // Drop the skip-decision signature so a fast path can never reuse a
    // removed dataset's roster. (It is also rebuilt from scratch on the
    // next full rebuild.)
    this.lastRebuildByDataset.delete(workerMemberId);
    this.lastVisibleDatasetIds.delete(workerMemberId);
  }

  /** Per-dataset snapshot of the most recent `plan()` output. Live Map — do not mutate. */
  getLastPlans(): ReadonlyMap<string, RequestPlan> {
    return this._lastPlanByDataset;
  }

  /**
   * True when an interactive change was coalesced this tick and its
   * trailing rebuild is still owed. The render loop keeps ticking while
   * this holds so the rebuild fires — and renders — once the coalescing
   * window elapses, even if the user has stopped interacting. Clears the
   * next time a full rebuild runs.
   */
  hasPendingRebuild(): boolean {
    return this.pendingDeferredRebuild;
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
    kind: "GroupProxy3D" | "TileProxy3D",
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
