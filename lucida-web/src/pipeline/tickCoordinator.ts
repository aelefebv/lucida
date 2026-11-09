/**
 * Planner role. Builds the `PlanningSnapshot` from live WASM scene state
 * each tick, calls `plan()` per dataset, caches on the epoch ladder, and
 * routes output through {@link Uploader} for cold-state emission and chunk
 * delivery.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { DatasetSettings, SceneSettings } from "../tickCommon.ts";
import type { DatasetManifest, ImageSpec } from "../manifestTypes.ts";
import { getSceneSettings } from "../tickCommon.ts";
import { readResolvedLayers, shownChannels, type ResolvedLayer } from "../resolvedLayers.ts";
import { buildDisplayStateByChannel } from "./upload/coldState/displayState.ts";
import type { ColdStateDisplayState, GpuCapacityReport } from "../renderer/workerProtocol.ts";
import { computeMemberIndexMap } from "../renderer/descriptorBuffer.ts";
import {
  plan,
  emitPlanRequests,
  isZStep,
  emptyPlanStats,
  initialPlanningState,
  type PlanningConfig,
} from "./planning/index.ts";
import { configStore } from "./planning/configStore.ts";
import { buildPlanningSnapshot } from "./planning/snapshot.ts";
import {
  applyViewQueryDelta,
  makeEntitySnapshot,
  type SnapshotEntityDeps,
  type ViewQueryDeltaJson,
  type ViewQueryEntityJson,
} from "./planning/snapshotDelta.ts";
import type { WasmScene } from "lucida-core";
import { recordPlanningTick } from "./planning/traceTick.ts";
import { computeLabelChunkRequests } from "./planning/labelRequests.ts";
import { admitPlans, chunkBytesFor, type Admission } from "./planning/admission.ts";
import { gpuChunkRoomBytes, gpuSlotsFor } from "./planning/gpuCapacity.ts";
import { pageDeviceBudgets } from "../deviceBudget.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningState,
  ChunkRequest,
  PlanStats,
  RequestPlan,
  PlanningSnapshot,
  SelectionState,
} from "./planning/index.ts";
import type { SceneEpochs } from "./epochs.ts";
import type { VisibleRegion } from "./viewport.ts";

export type { MinimapChunkCoord } from "./planning/index.ts";
import type { ColdStateCauseKey } from "./upload/telemetry/coldState.ts";
import { orchTelemetryActive } from "./upload/telemetry/active.ts";
import { buildRoster } from "./upload/coldState/roster.ts";
import {
  computeActiveSetIndexMap,
  iterateActiveSetMembers,
} from "./upload/coldState/build.ts";
import type { Uploader } from "./upload/uploader.ts";
import { traceRecorder } from "../trace/recorder.ts";

/** A visible member for render layer construction. */
export interface MemberRosterEntry {
  imageId: string;
  position: [number, number];
  /** Entity id from the planning active set entry that produced this roster member. */
  entityId?: string;
  /** The member's model matrix, as the cold state carries it. */
  modelMatrix?: Float32Array;
}

export interface TickCoordinatorResult {
  /** Per-dataset roster of members that need render layers, keyed by dsId. */
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  /** What each layer shows, as the scene resolved it for this plan. */
  layers: ReadonlyMap<string, ResolvedLayer>;
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
  layer: ResolvedLayer | undefined;
  snapshot: PlanningSnapshot;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  result: RequestPlan;
  /**
   * The active set the worker holds for this dataset, captured from
   * `PlanningState.previousActiveSet` before `plan()`'s `nextState` overwrote
   * it. The view-move delta diffs `result.activeSet` against this.
   */
  previousActiveSet: ActiveSetEntry[];
  /** Whether the selection stepped along Z since the previous plan ({@link isZStep}). */
  zStep: boolean;
}

const VIEWER_INTEREST_TTL_MS = 2_000;
const VIEWER_INTEREST_KEY_CAP = 512;

/**
 * Coalescing window for interactive view changes (pan/zoom). The render
 * pass reflects the fresh camera every frame from the cached roster, so the
 * O(visible-entities) rebuild only re-runs at this cadence, enough to fetch
 * tiles that scroll into view. The trailing rebuild applies the final
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
 * Per-dataset carry-forward captured at each full rebuild. Lets the next
 * rebuild prove cheaply that only the per-channel intensity display state
 * (contrast, gamma, colormap, opacity) changed, so a descriptor patch can
 * replace a replan. Every non-display signal the render depends on is
 * captured here, so a match guarantees the reused roster and residency are
 * still exact.
 */
interface DatasetRebuildSignature {
  visibleChannels: number[];
  /** Per-channel intensity display state emitted to the worker. */
  displayState: Record<number, ColdStateDisplayState>;
  /** Full [start, end) voxel z-range this rebuild planned for. */
  zRangeVox: [number, number];
  /**
   * Serialized dataset settings minus the pure intensity-display fields.
   * Every other field, including one added later, stays in, so it forces a
   * rebuild until proven display-only.
   */
  nonDisplayKey: string;
}

function numberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A dataset's settings without the fields the display patch carries:
 * dataset-level contrast, gamma, opacity and per-channel contrast, gamma,
 * colormap. The spread rest keeps every other field, including one added
 * later, so it stays in the fingerprint and forces a full rebuild.
 * Per-channel `visible` is kept because it drives the visible-channel set.
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
 * Fingerprint of a dataset's settings minus the intensity-display fields.
 * Equal fingerprints across two ticks prove no non-display setting changed.
 * `opacity` counts as display because it is per-fragment alpha and never
 * changes draw order, which the roster and layer order fix. Blend mode
 * changes compositing, so it stays in and forces a rebuild.
 */
function nonDisplayKeyForDataset(ds: DatasetSettings | undefined): string {
  return JSON.stringify(ds ? nonDisplayDatasetShape(ds) : null);
}

/**
 * The [start, end) voxel z-range WASM reports for a dataset, with the same
 * null handling as {@link buildPlanningSnapshot} so it compares exactly
 * against the captured range. Read directly rather than from `scene.z()`,
 * which is only the slab start, so the fast paths notice a slab extension
 * that moves the end.
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
 * (order-independent). Compares only the fields the display patch carries:
 * contrast, gamma, opacity, colormap. `channelMask` follows from the channel
 * index, and `colormapMode` / `labelOpacity` are constant on the intensity
 * path because a `label_settings` change fails the non-display fingerprint
 * first.
 *
 * This equality gates both the display-only patch and the selection-scrub
 * path, which fires only when display is unchanged. A new user-editable
 * field on {@link ColdStateDisplayState} must be compared here or folded
 * into the non-display fingerprint, or a scrub could ship a stale display.
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

/** One dataset's requests as the planner made them, before admission. */
interface DatasetRequests {
  dsId: string;
  requests: readonly ChunkRequest[];
}

/**
 * Admit each dataset's requests against what the CPU budgets and the GPU
 * pools hold between them, as `report` gives the pools, in either view mode,
 * so the wanted set the cache drives toward fits both.
 */
function admitDatasetPlans(
  ctx: TickContext,
  plans: readonly DatasetRequests[],
  report: GpuCapacityReport | null,
): Admission[] {
  const gpuTotalBytes = pageDeviceBudgets().gpuTotalBytes;
  return admitPlans(
    plans.map(({ dsId, requests }) => {
      const manifest = ctx.datasets.get(dsId)!.manifest;
      return {
        requests,
        bytesOf: chunkBytesFor(manifest),
        slotOf: gpuSlotsFor(manifest, ctx.mode, report, gpuTotalBytes),
      };
    }),
    ctx.cpuCache.tierCapacity(),
    gpuChunkRoomBytes(report, gpuTotalBytes),
  );
}

/** Requests of the view's own lanes that admission left out, across datasets and tiers. */
function shortfallOf(admissions: readonly Admission[]): number {
  return admissions.reduce((sum, { shortfall }) => sum + shortfall.detail + shortfall.coarse, 0);
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

/**
 * Whether a rebuild's causes change what is placed or what it is made of,
 * rather than where the camera is or which plane is selected. These rebuild
 * at once, with no coalescing and no fast path.
 */
function isStructural(causes: readonly ColdStateCauseKey[]): boolean {
  return (
    causes.includes("content") ||
    causes.includes("layout") ||
    causes.includes("manifest")
  );
}

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
   * Each dataset's manifest as of the last full rebuild. A generated level
   * arrives as a replaced manifest with no scene epoch behind it, so the
   * cached plan is keyed on these references as well as on the epochs.
   */
  private lastRebuildManifests = new Map<string, DatasetManifest>();
  /**
   * The minimap's pending chunk lists as the last plan saw them. The minimap
   * finds what it lacks after the tick has planned, so chunks it adds reach
   * the planner only through a replan this map triggers.
   */
  private plannedMinimap = new Map<string, MinimapChunkCoord[]>();
  /**
   * `performance.now()` at the completion of the last full rebuild.
   * Interactive changes within a coalescing window of this are served from
   * the cached result. Stamped at completion, not tick start, so the window
   * measures idle time. A rebuild longer than the window (routine on a wide
   * collection) would otherwise leave every following frame past the window,
   * and coalescing would never engage where it matters.
   */
  private lastRebuildAt = Number.NEGATIVE_INFINITY;
  /**
   * True when an interactive change was coalesced and its trailing rebuild
   * has not run. The render loop ticks again when the window elapses, so the
   * settled state renders even after the user stops. While set, `lastEpochs`
   * stays stale on purpose so the pending change is re-detected next tick.
   */
  private pendingDeferredRebuild = false;
  /** The coalescing window the owed rebuild waits out, from {@link lastRebuildAt}. */
  private deferredRebuildIntervalMs = 0;
  /**
   * Scene scalars captured at the last full rebuild, for the fast-path
   * proofs. The z-range lives per dataset in {@link DatasetRebuildSignature}
   * because it is in per-dataset voxel space and carries the slab end, which
   * `scene.z()` omits.
   */
  private lastRebuildScalars: {
    t: number;
    mode: "slice" | "volume";
  } | null = null;
  /** Layer participation + order (JSON) at the last full rebuild. */
  private lastLayerOrderKey = "";
  /** Settings-visible dataset ids at the last full rebuild. */
  private lastVisibleDatasetIds = new Set<string>();
  /** Per-planned-dataset carry-forward for the display-only fast path. */
  private readonly lastRebuildByDataset = new Map<string, DatasetRebuildSignature>();
  /**
   * Per-dataset cache of tile model matrices, reused while placement is
   * unchanged. They come from `scene.member_model_matrix`, which has no
   * camera input, so a view move leaves them identical. Keyed by an epoch
   * fingerprint so a content or layout change discards them.
   */
  private readonly matrixCacheByDataset = new Map<string, {
    epochKey: string;
    matrices: Map<string, { model: Float32Array; inv: Float32Array }>;
  }>();
  /**
   * Per-dataset cache of the camera-independent inputs to
   * {@link buildPlanningSnapshot}: parsed `member_positions` and the
   * `imageSpecById` / `parentByEntityId` manifest maps. A view move leaves
   * all three identical. An entry is valid only while both keys match:
   *   - `epochKey`, the content|layout fingerprint. A reflow or
   *     add/remove that moves placement bumps it.
   *   - `manifestRef`, the `ds.manifest` reference. Progressively generated
   *     levels swap in a new manifest object with no epoch bump, so
   *     reference identity is the only signal the manifest maps are stale.
   */
  private readonly snapshotInputCacheByDataset = new Map<string, {
    epochKey: string;
    manifestRef: DatasetManifest;
    positions: Record<string, [number, number]>;
    imageSpecById: Map<string, ImageSpec>;
    parentByEntityId: Map<string, string | null>;
  }>();
  /**
   * Per-dataset cursor for the incremental view-query fold: the last
   * reconstructed `image_id → EntitySnapshot` map and the basis it was built
   * against. A replan folds the scene's `view_query_delta` onto `map` instead
   * of parsing the full visible set.
   *
   * The fold is safe because every active-set input is either in the delta's
   * quantized projection (`visible`, and the target level with the pin folded
   * in) or in the basis (the manifest join for `levels` and `coarseLevel`).
   * The active set never reads `projected_diagonal_px`, which the delta does
   * not track.
   *
   * This cursor and the scene's Rust cursor must advance together, or the
   * fold ships wrong tiles. A reconstructed `WasmScene` starts with an empty
   * Rust cursor (`#[serde(skip)]`), so a scene change drops every entry. The
   * manifest join can change with no epoch bump and no Rust delta, so a basis
   * change drops the entry too. A dropped entry reseeds from the full
   * `view_query` at the same tick, so a Delta never folds onto a missing base.
   */
  private readonly viewDeltaCursor = new Map<string, {
    /** Identity of the snapshot-inputs entry (manifest maps + placement). */
    basisInputs: object;
    map: Map<string, EntitySnapshot>;
  }>();
  /**
   * The `WasmScene` the {@link viewDeltaCursor} entries were built against.
   * Compared by object identity every fold; a mismatch (a reconstructed
   * scene, or the first fold of a freshly-constructed coordinator) clears the
   * whole cursor so a stale entry can never be folded against a new scene's
   * Rust cursor.
   */
  private viewDeltaScene: WasmScene | null = null;

  /**
   * Datasets whose worker cold state holds exactly this coordinator's
   * `previousActiveSet`, the precondition for a view-move delta. Set after a
   * full cold state or a delta lands. The scrub and display fast paths never
   * change the active set, so they leave it set. Cleared on dataset removal
   * so a re-added dataset re-syncs with a full send.
   */
  private readonly coldStateSyncedDatasets = new Set<string>();
  private requestEpoch = 0;
  /** Per-dataset snapshot of the most recent visible region. Consumed by `orchDebug`. */
  private _lastVisibleRegion = new Map<string, VisibleRegion>();
  /** Per-dataset snapshot of the most recent entity list. */
  private _lastEntities = new Map<string, EntitySnapshot[]>();
  /** Per-dataset snapshot of the most recent full `plan()` output. */
  private _lastPlanByDataset = new Map<string, RequestPlan>();

  private configStoreUnsub: () => void;

  /**
   * The planner entry point. Injectable so tests can pass a stub instead of
   * `vi.resetModules()`-mocking the planning singleton, which races across
   * shuffled tests. Production never passes it.
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

  /**
   * The last admission: the requests it took, the capacity report it took
   * them against, and how many it left short. A report can raise what a pool
   * may hold while nothing in the view changes, as when a plan sized a pool
   * before the worker made it, so each report is weighed against this.
   */
  private lastAdmission: { plans: readonly DatasetRequests[]; report: GpuCapacityReport | null; short: number } | null = null;
  /** A capacity report would admit part of the last shortfall, and no plan has used it yet. */
  private capacityReplanOwed = false;

  /** Admit against the worker's latest report, and keep what {@link noteGpuCapacity} weighs. */
  private admit(ctx: TickContext, plans: readonly DatasetRequests[]): Admission[] {
    const report = ctx.client.gpuCapacity();
    const admissions = admitDatasetPlans(ctx, plans, report);
    this.lastAdmission = { plans, report, short: shortfallOf(admissions) };
    return admissions;
  }

  /**
   * Whether the worker's latest capacity report would admit part of what the
   * last plan left short. The caller wakes the loop when it would, and the
   * next tick plans again; nothing else would, since the view did not change.
   */
  noteGpuCapacity(ctx: TickContext): boolean {
    if (this.capacityReplanOwed) return true;
    const last = this.lastAdmission;
    const report = ctx.client.gpuCapacity();
    if (!last || last.short === 0 || report === last.report) return false;
    // A removed dataset plans again on its own.
    if (last.plans.some(({ dsId }) => !ctx.datasets.has(dsId))) return false;
    if (shortfallOf(admitDatasetPlans(ctx, last.plans, report)) >= last.short) return false;
    this.capacityReplanOwed = true;
    return true;
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
    // Opens the `plan` phase: everything from here to the submit that hands
    // the wanted set to the scheduler, synchronous wasm calls included. One
    // recorder and one clock, so plan time compares with the phases after it.
    traceRecorder.markPlanStart();

    const rawEpochs = JSON.parse(ctx.scene.epochs());
    const currentEpochs: SceneEpochs = {
      content: rawEpochs.content,
      layout: rawEpochs.layout,
      view: rawEpochs.view,
      selection: rawEpochs.selection,
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
      if (this.manifestReplacedSinceRebuild(ctx)) causes.push("manifest");
      if (this.minimapHasUnplannedChunks(minimapPendingFetch)) causes.push("minimap");
      if (this.capacityReplanOwed) causes.push("capacity");
      isHit = causes.length === 0;
    }

    // Coalescing gate. A full rebuild is O(visible entities), so paying it
    // every interactive frame collapses frame rate on a wide collection.
    // When only interactive epochs moved, serve the cached result and defer:
    //   - view only: the render pass reads the camera fresh each frame and
    //     transforms the cached roster at draw time, so replan only at a
    //     coarse cadence to fetch tiles that scroll into view.
    //   - selection: the leading change rebuilds promptly, and further
    //     changes within the window coalesce.
    // Structural changes must render immediately, and so does a capacity
    // report, which comes once rather than as a stream.
    let coalescedSkip = false;
    if (!isHit && hasPrior) {
      if (!isStructural(causes) && !causes.includes("capacity")) {
        const interval = causes.includes("selection")
          ? SELECTION_COALESCE_INTERVAL_MS
          : VIEW_REPLAN_INTERVAL_MS;
        if (tickStart - this.lastRebuildAt < interval) {
          coalescedSkip = true;
          // Leave `lastEpochs` stale so the change is re-detected next
          // tick, and flag the deferral so the render loop ticks again
          // once the window elapses and the trailing rebuild lands.
          this.pendingDeferredRebuild = true;
          this.deferredRebuildIntervalMs = interval;
        }
      }
    }

    if (isHit || coalescedSkip) {
      // A genuine cache hit clears any owed deferral so the loop can idle.
      // A coalesced skip keeps it set. The two are mutually exclusive, so
      // this never drops a live deferral. Without it, a hit while a deferral
      // is owed (an epoch counter regressing on a scene reset) would leave
      // the flag stuck and spin the loop at full frame rate.
      if (isHit) {
        this.pendingDeferredRebuild = false;
      }
      this.serveCachedTelemetry(tickStart);
      return this.cachedResult;
    }

    // Past the coalescing gate. Read the shared inputs once so all datasets
    // and the display-only fast path below see the same config.
    const settings = getSceneSettings(ctx.scene);
    const layers = readResolvedLayers(ctx.scene);
    const planningConfig = configStore.get();

    const structural = isStructural(causes);
    const selectionOnly =
      !structural && causes.length === 1 && causes[0] === "selection";
    // A selection scrub, minimap chunks no plan asked for, or both: the active
    // set's inputs are unchanged, so only the requests need emitting again.
    const requestsOnly =
      !structural && causes.every((c) => c === "selection" || c === "minimap");
    // A pure view move: only the camera moved, so the active set is a pure
    // function of the new view. This is the sole gate for the view-move
    // cold-state delta. Anything bundled with the view change, bar a display
    // edit patched below, fails it and takes the full rebuild, so the delta's
    // retained descriptors are safe.
    let viewOnly = !structural && causes.length === 1 && causes[0] === "view";

    // Display-only fast path: a per-channel intensity edit with nothing else
    // changed. The active set and residency are then identical, so push a
    // descriptor patch and reuse the cached roster instead of a full replan.
    if (
      selectionOnly &&
      this.tryDisplayOnlyUpdate({ ctx, currentEpochs, settings, layers, tickStart })
    ) {
      this.serveCachedTelemetry(tickStart);
      return this.cachedResult;
    }

    // Selection-scrub fast path: a pure T or Z-plane move in the slice view,
    // or new minimap demand. Fetch the new chunks, but push a compact
    // selection patch instead of the O(active-set) descriptor array, and reuse
    // the cached roster.
    if (
      requestsOnly &&
      this.tryScrubOnlyUpdate({
        ctx, currentEpochs, settings, layers, tickStart,
        minimapPendingFetch, planningConfig,
        minimapChanged: causes.includes("minimap"),
      })
    ) {
      this.serveCachedTelemetry(tickStart);
      return this.cachedResult;
    }

    // Auto-contrast follows the view, so a camera move often lands with a
    // display edit. Patching the display first leaves a pure view move, whose
    // delta costs the entities that changed rather than a cold state of all
    // of them.
    if (
      !structural &&
      causes.length === 2 &&
      causes.includes("view") &&
      causes.includes("selection") &&
      this.patchDisplayState(ctx, settings, layers)
    ) {
      viewOnly = true;
    }

    // Full rebuild. The settled state is applied now, so clear any deferral.
    // `lastRebuildAt` is stamped at completion below, not here.
    this.pendingDeferredRebuild = false;
    this.capacityReplanOwed = false;

    // CpuCache owns wanted-generation and delivery/rejection state, so the
    // rebuild lifecycle advances there exactly once before the per-dataset
    // loop.
    ctx.cpuCache.onPlanRebuildStart();

    const memberRoster = new Map<string, MemberRosterEntry[]>();
    const entityIndexByDataset = new Map<string, Map<string, number>>();
    const plannedDatasets: PlannedDataset[] = [];

    for (const [dsId, ds] of ctx.datasets) {
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) continue;
      const layer = layers.get(dsId);

      // See `snapshotInputCacheByDataset` for why both keys are checked.
      const snapshotInputEpochKey = `${currentEpochs.content}|${currentEpochs.layout}`;
      let snapshotInputs = this.snapshotInputCacheByDataset.get(dsId);
      if (
        !snapshotInputs ||
        snapshotInputs.epochKey !== snapshotInputEpochKey ||
        snapshotInputs.manifestRef !== ds.manifest
      ) {
        const positions = JSON.parse(
          ctx.scene.member_positions(dsId),
        ) as Record<string, [number, number]>;
        const imageSpecById = new Map<string, ImageSpec>();
        for (const img of ds.manifest.images) {
          imageSpecById.set(img.image_id, img);
        }
        const parentByEntityId = new Map<string, string | null>();
        for (const ent of ds.manifest.entities) {
          parentByEntityId.set(ent.id, ent.parent ?? null);
        }
        snapshotInputs = {
          epochKey: snapshotInputEpochKey,
          manifestRef: ds.manifest,
          positions,
          imageSpecById,
          parentByEntityId,
        };
        this.snapshotInputCacheByDataset.set(dsId, snapshotInputs);
      }

      // Fold the view delta instead of re-running `view_query`: O(delta)
      // rather than O(N members) on a camera move, a level change included.
      // `viewDeltaCursor` documents why the fold matches a full parse.
      const deps: SnapshotEntityDeps = {
        imageSpecById: snapshotInputs.imageSpecById,
        parentByEntityId: snapshotInputs.parentByEntityId,
        positions: snapshotInputs.positions,
      };
      const entitiesOverride = this.foldViewDeltaEntities(
        ctx.scene, dsId, deps, snapshotInputs,
      );
      if (entitiesOverride === "skip") continue;

      // The builder skips `view_query` when given `entitiesOverride` but
      // still computes `visible_region` and `selection` fresh.
      // `minimapPendingFetch` flows into the snapshot so the minimap lane
      // plans first.
      const built = buildPlanningSnapshot({
        scene: ctx.scene,
        datasetId: dsId,
        dataset: ds,
        layer,
        minimapPending: minimapPendingFetch,
        mode: ctx.mode as "slice" | "volume",
        currentEpochs,
        requestEpoch: this.requestEpoch,
        config: planningConfig,
        precomputed: {
          positions: snapshotInputs.positions,
          imageSpecById: snapshotInputs.imageSpecById,
          parentByEntityId: snapshotInputs.parentByEntityId,
        },
        entitiesOverride,
      });
      if (!built) continue;
      const { snapshot, entities, visibleRegion, selection } = built;

      // Plan. Opaque carry-forward state travels via {@link PlanningState};
      // `nextState` is stored for the next tick.
      const planningStateForDataset = this.planningState.get(dsId)
        ?? initialPlanningState();
      // Capture what the worker holds before `nextState` overwrites it. The
      // view-move delta diffs the fresh active set against this.
      const previousActiveSet = planningStateForDataset.previousActiveSet;
      const zStep = isZStep(planningStateForDataset.previousZ, selection, planningConfig.sliceBandPlanes);
      const result = this.planFn(snapshot, planningStateForDataset, planningConfig);
      this.planningState.set(dsId, result.nextState);
      this.requestEpoch = result.epochs.request;
      this._lastVisibleRegion.set(dsId, visibleRegion);
      this._lastEntities.set(dsId, entities);
      emitViewerInterestHint(ctx, dsId, selection, visibleRegion, result.requests, this.requestEpoch);

      // Recorded unconditionally, unlike the `orch` telemetry: recording
      // does not wait for somebody to open a panel.
      recordPlanningTick(
        dsId,
        result,
        ctx.cpuCache.levelResidency(),
        entities,
        ctx.client.datasetLevels(dsId)?.displayed ?? null,
      );

      plannedDatasets.push({
        dsId,
        dsSettings,
        layer,
        snapshot,
        entities,
        visibleRegion,
        selection,
        result,
        previousActiveSet,
        zStep,
      });
    }

    // Rebuild the display-only fast-path signatures from scratch: datasets
    // that no longer plan (turned invisible / scrolled fully out) drop out.
    this.lastRebuildByDataset.clear();

    const admissions = this.admit(
      ctx,
      plannedDatasets.map((planned) => ({ dsId: planned.dsId, requests: planned.result.requests })),
    );
    for (const [index, planned] of plannedDatasets.entries()) {
      const { dsId, dsSettings, layer, entities, visibleRegion, selection, zStep } = planned;
      const admission = admissions[index];
      const result: RequestPlan = {
        ...planned.result,
        requests: admission.admitted,
        shortfall: admission.shortfall,
        coarseLoanBytes: admission.borrowed,
      };
      this._lastPlanByDataset.set(dsId, result);

      // Build the member roster and per-entity matrix map in one walk.
      const matrixEpochKey = `${currentEpochs.content}|${currentEpochs.layout}`;
      let matrixCacheEntry = this.matrixCacheByDataset.get(dsId);
      if (!matrixCacheEntry || matrixCacheEntry.epochKey !== matrixEpochKey) {
        matrixCacheEntry = { epochKey: matrixEpochKey, matrices: new Map() };
        this.matrixCacheByDataset.set(dsId, matrixCacheEntry);
      }
      const { entries: rosterEntries, matricesByEntity } = buildRoster({
        activeSet: result.activeSet,
        entities,
        ctx,
        datasetId: dsId,
        tileMatrixCache: matrixCacheEntry.matrices,
      });
      memberRoster.set(dsId, rosterEntries);

      // View-move fast path: only the camera moved and the worker holds
      // exactly this coordinator's `previousActiveSet`, so ship only the
      // active-set delta instead of the whole descriptor array.
      const canDelta =
        viewOnly &&
        this.coldStateSyncedDatasets.has(dsId) &&
        planned.previousActiveSet.length > 0;

      if (canDelta) {
        this.uploader.sendColdStateDelta({
          ctx,
          datasetId: dsId,
          activeSet: result.activeSet,
          previousActiveSet: planned.previousActiveSet,
          requests: result.requests,
          entities,
          selection,
          visibleRegion,
          renderRadiusView: {
            detail: planningConfig.detailRenderRadiusView,
            coarse: planningConfig.coarseRenderRadiusView,
          },
          epochs: result.epochs,
          matricesByEntity,
          layer,
        });
        // The worker rebuilds its descriptor buffer from the reordered active
        // set in the same canonical order this walks, so the indices agree.
        entityIndexByDataset.set(
          dsId,
          computeActiveSetIndexMap(result.activeSet, selection.visibleChannels),
        );
        this.uploader.sendViewHotStateFromMembersIfAdvanced({
          ctx,
          datasetId: dsId,
          memberIds: iterateActiveSetMembers(result.activeSet, selection.visibleChannels),
          epochs: result.epochs,
        });
      } else {
        // Full send. Drives atlas creation/remap + wanted-set + descriptor
        // buffer build; the resolved layer bakes per-channel display state
        // into descriptors. Marks the dataset synced so a later pure view move
        // can take the delta path against this active set.
        const coldMsg = this.uploader.sendColdState({
          ctx,
          datasetId: dsId,
          activeSet: result.activeSet,
          requests: result.requests,
          entities,
          selection,
          visibleRegion,
          renderRadiusView: {
            detail: planningConfig.detailRenderRadiusView,
            coarse: planningConfig.coarseRenderRadiusView,
          },
          epochs: result.epochs,
          matricesByEntity,
          layer,
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
        this.coldStateSyncedDatasets.add(dsId);
      }

      // Categorical label overlays are invisible to the WASM planner
      // (labels live outside `manifest.images`/`entities`), so their chunk
      // requests are synthesized here from the label's own geometry and
      // merged into the fetch plan. In `slice` mode the planes around the
      // label's mapped Z-plane are fetched, as the image's are; in `volume`
      // mode the whole label volume (every z-chunk) is fetched for the 3D
      // first-hit surface. Scoped under each label's own image id, so they
      // never perturb intensity-chunk eviction.
      const labelRequests = computeLabelChunkRequests({
        datasetId: dsId,
        manifest: ctx.datasets.get(dsId)!.manifest,
        t: selection.t,
        z: selection.z,
        // Fetch only the labels the render path will draw (visible +
        // eligible), so a hidden label is neither fetched nor drawn.
        labelSettings: dsSettings?.label_settings,
        mode: ctx.mode as "slice" | "volume",
        config: planningConfig,
        zStep,
      });
      const requestsWithLabels =
        labelRequests.length > 0
          ? [...result.requests, ...labelRequests]
          : result.requests;

      // Submit image and label chunks in a single call so they don't cancel
      // each other. Cancellation contract: a request omitted by the
      // next plan has its in-flight fetch aborted.
      ctx.cpuCache.submit({
        requests: requestsWithLabels,
        activeSet: result.activeSet,
        epochs: result.epochs,
        stats: result.stats,
        // `nextState` is required on RequestPlan but unused by submit();
        // forward the planner's pointer so the shape stays honest.
        nextState: result.nextState,
        shortfall: result.shortfall,
        coarseLoanBytes: result.coarseLoanBytes,
      }, chunkBytesFor(ctx.datasets.get(dsId)!.manifest));

      // Capture this dataset's display-only fast-path signature: the
      // display state now on the worker, plus every non-display signal a
      // later intensity-display edit must prove unchanged (visible
      // channels, the full z-range, and the stripped settings fingerprint).
      this.lastRebuildByDataset.set(dsId, {
        visibleChannels: selection.visibleChannels,
        displayState: buildDisplayStateByChannel(layer),
        zRangeVox: visibleRegion.zRangeVox,
        nonDisplayKey: nonDisplayKeyForDataset(dsSettings),
      });
    }

    const outputEpochs: SceneEpochs = { ...currentEpochs, request: this.requestEpoch };
    this.lastEpochs = outputEpochs;
    this.cachedResult = { memberRoster, settings, layers, epochs: outputEpochs, entityIndexByDataset };
    this.lastRebuildManifests = new Map(
      [...ctx.datasets].map(([dsId, ds]) => [dsId, ds.manifest]),
    );
    this.plannedMinimap = new Map(minimapPendingFetch);

    // Capture the scene scalars, layer order, and visible-dataset set this
    // rebuild planned against, so the display-only fast path has a baseline
    // to prove against. `lastRebuildByDataset` was repopulated per dataset
    // above (each carries its own z-range).
    this.lastRebuildScalars = {
      t: ctx.scene.t(),
      mode: ctx.mode as "slice" | "volume",
    };
    this.lastLayerOrderKey = JSON.stringify(settings.layerOrder);
    this.lastVisibleDatasetIds = new Set<string>();
    for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
      if (dsSettings.visible) this.lastVisibleDatasetIds.add(dsId);
    }

    // Stamped at completion; see `lastRebuildAt`.
    const rebuildEnd = performance.now();
    this.lastRebuildAt = rebuildEnd;

    // Gated like recordHit above: the rebuild window, cause attribution,
    // and churn detector only run while the `orch` log category is on.
    if (orchTelemetryActive()) {
      this.uploader.coldStateTelemetry.recordRebuild(
        tickStart, causes, rebuildEnd - tickStart,
      );
    }

    return this.cachedResult;
  }

  /**
   * Whether the minimap waits on a chunk the last plan did not see. Its scan
   * replaces each member's list on every pass, so a list that only lost
   * chunks, which arrived, is adopted as planned and is not compared again.
   */
  private minimapHasUnplannedChunks(pending: Map<string, MinimapChunkCoord[]>): boolean {
    let unplanned = false;
    for (const [memberId, coords] of pending) {
      const planned = this.plannedMinimap.get(memberId);
      if (planned === coords) continue;
      if (planned) {
        const plannedKeys = new Set(planned.map((coord) => coord.key));
        if (coords.every((coord) => plannedKeys.has(coord.key))) {
          this.plannedMinimap.set(memberId, coords);
          continue;
        }
      }
      unplanned = true;
    }
    return unplanned;
  }

  /** Whether any dataset's manifest is not the one the last rebuild planned against. */
  private manifestReplacedSinceRebuild(ctx: TickContext): boolean {
    if (ctx.datasets.size !== this.lastRebuildManifests.size) return true;
    for (const [dsId, ds] of ctx.datasets) {
      if (this.lastRebuildManifests.get(dsId) !== ds.manifest) return true;
    }
    return false;
  }

  /**
   * Cold-state window telemetry for a tick that serves the cached result
   * instead of rebuilding (a genuine cache hit, a coalesced skip, or the
   * display-only fast path).
   */
  private serveCachedTelemetry(tickStart: number): void {
    // Aggregates only while the `orch` log category can carry the output.
    if (orchTelemetryActive()) {
      this.uploader.coldStateTelemetry.recordHit(tickStart);
    }
  }

  /**
   * Display-only fast path. Fires only when it can prove the sole change
   * since the last rebuild is per-channel intensity display state. When it
   * fires it pushes a descriptor patch and reuses the cached roster, with no
   * plan(), roster, or submit.
   *
   * Returns `true` when it handled the tick. On `false` no worker message is
   * sent.
   */
  private tryDisplayOnlyUpdate(args: {
    ctx: TickContext;
    currentEpochs: SceneEpochs;
    settings: SceneSettings;
    layers: ReadonlyMap<string, ResolvedLayer>;
    tickStart: number;
  }): boolean {
    const { ctx, currentEpochs, settings, layers, tickStart } = args;
    if (!this.patchDisplayState(ctx, settings, layers)) return false;

    // Refresh the cached settings and layers so display readers such as the
    // minimap see current values. The proof pinned everything else.
    this.cachedResult = { ...this.cachedResult!, settings, layers };

    // Applied: advance the epoch anchor so the loop can idle, re-anchor
    // coalescing, and clear any owed deferral.
    this.lastEpochs = currentEpochs;
    this.lastRebuildAt = tickStart;
    this.pendingDeferredRebuild = false;
    return true;
  }

  /**
   * Push a descriptor patch for each dataset whose per-channel intensity
   * display state changed, when that is the only selection change since the
   * last rebuild. Every non-display signal must match the captured baseline
   * and the settings fingerprint keeps unknown fields, so any other change
   * fails the proof. Returns `false`, having sent nothing, when the proof
   * fails or no display changed.
   */
  private patchDisplayState(
    ctx: TickContext,
    settings: SceneSettings,
    layers: ReadonlyMap<string, ResolvedLayer>,
  ): boolean {
    if (
      this.cachedResult === null ||
      this.lastRebuildScalars === null ||
      this.lastRebuildByDataset.size === 0
    ) {
      return false;
    }

    // A T or mode change needs different chunks. Z and the shown channels
    // are proven per dataset below; the full z-range also catches a slab
    // extension.
    const scalars = this.lastRebuildScalars;
    if (
      ctx.scene.t() !== scalars.t ||
      (ctx.mode as "slice" | "volume") !== scalars.mode
    ) {
      return false;
    }

    // A layer reorder changes the composite draw order, which comes from
    // the roster.
    if (JSON.stringify(settings.layerOrder) !== this.lastLayerOrderKey) return false;

    // A visibility toggle bumps the selection epoch but changes the roster.
    // This also catches a dataset turning visible, which the per-dataset
    // loop below would never see.
    let visibleCount = 0;
    for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
      if (!dsSettings.visible) continue;
      visibleCount++;
      if (!this.lastVisibleDatasetIds.has(dsId)) return false;
    }
    if (visibleCount !== this.lastVisibleDatasetIds.size) return false;

    // Precheck with no side effects. Each planned dataset must still be
    // visible with an unchanged non-display fingerprint, z-range, and
    // visible-channel set before any patch is pushed.
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
      const layer = layers.get(dsId);
      if (!numberArraysEqual(shownChannels(layer), sig.visibleChannels)) return false;
      const displayState = buildDisplayStateByChannel(layer);
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
    return true;
  }

  /**
   * Selection-scrub fast path. Fires only when it can prove the sole change
   * since the last rebuild is a T scrub and/or Z-plane move in the slice view,
   * or minimap demand no plan has asked for (`minimapChanged`).
   * `currentT`/`currentZ` are top-level cold-state scalars, never part of a
   * descriptor, so the descriptor array is unchanged. A scrub still needs new
   * chunks, so this emits requests and submits them, but pushes a selection
   * patch instead of a full cold state. The caller's `requestsOnly` gate
   * keeps the active set's inputs unchanged, which is why the cached roster
   * can be reused. Any other difference, a z-range width change included,
   * fails the proof.
   *
   * Returns `true` when it handled the tick. On `false` nothing is sent or
   * submitted.
   */
  private tryScrubOnlyUpdate(args: {
    ctx: TickContext;
    currentEpochs: SceneEpochs;
    settings: SceneSettings;
    layers: ReadonlyMap<string, ResolvedLayer>;
    tickStart: number;
    minimapPendingFetch: Map<string, MinimapChunkCoord[]>;
    planningConfig: PlanningConfig;
    minimapChanged: boolean;
  }): boolean {
    const { ctx, currentEpochs, settings, layers, minimapPendingFetch, planningConfig } = args;
    if (
      this.cachedResult === null ||
      this.lastRebuildScalars === null ||
      this.lastRebuildByDataset.size === 0
    ) {
      return false;
    }

    // Slice view only, the one mode this compact patch is proven against.
    const scalars = this.lastRebuildScalars;
    const mode = ctx.mode as "slice" | "volume";
    if (mode !== "slice" || scalars.mode !== "slice") return false;

    // Layer order and the visible-dataset set each change the roster, and the
    // shown channels the member shape, proven per dataset below. T is the
    // scrub axis; Z is proven per dataset via the z-range.
    if (JSON.stringify(settings.layerOrder) !== this.lastLayerOrderKey) return false;

    let visibleCount = 0;
    for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
      if (!dsSettings.visible) continue;
      visibleCount++;
      if (!this.lastVisibleDatasetIds.has(dsId)) return false;
    }
    if (visibleCount !== this.lastVisibleDatasetIds.size) return false;

    const newT = ctx.scene.t();
    let anyScrub = newT !== scalars.t;

    // Precheck with no side effects. Each planned dataset must still be
    // visible with unchanged non-display fingerprint, display state, and
    // visible channels. The z-range width must match: a same-width shift is a
    // plane move (the Z-scrub signal), while a widen is a slab extension that
    // changes the wanted set. The cached state needed to regenerate requests
    // must be present.
    interface ScrubDataset {
      dsId: string;
      dsSettings: DatasetSettings | undefined;
      layer: ResolvedLayer | undefined;
      visibleChannels: number[];
      planningState: PlanningState;
      entities: EntitySnapshot[];
      cachedRegion: VisibleRegion;
      newZRange: [number, number];
    }
    const perDataset: ScrubDataset[] = [];
    for (const [dsId, sig] of this.lastRebuildByDataset) {
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) return false;
      if (nonDisplayKeyForDataset(dsSettings) !== sig.nonDisplayKey) return false;
      const layer = layers.get(dsId);
      const visibleChannels = shownChannels(layer);
      if (!numberArraysEqual(visibleChannels, sig.visibleChannels)) return false;
      const displayState = buildDisplayStateByChannel(layer);
      if (!displayStatesEqual(displayState, sig.displayState)) return false;
      const zRange = readZRangeVox(ctx.scene, dsId);
      const oldWidth = sig.zRangeVox[1] - sig.zRangeVox[0];
      const newWidth = zRange[1] - zRange[0];
      if (newWidth !== oldWidth) return false;
      if (zRange[0] !== sig.zRangeVox[0] || zRange[1] !== sig.zRangeVox[1]) {
        anyScrub = true;
      }

      const planningState = this.planningState.get(dsId);
      const entities = this._lastEntities.get(dsId);
      const cachedRegion = this._lastVisibleRegion.get(dsId);
      if (!planningState || !entities || !cachedRegion) return false;

      perDataset.push({
        dsId, dsSettings, layer, visibleChannels, planningState, entities, cachedRegion,
        newZRange: zRange,
      });
    }
    if (!anyScrub && !args.minimapChanged) return false;

    // Re-emit requests from the cached active set with only the selection
    // (and z-range, on a Z move) changed. This skips the O(N) `view_query`
    // and `member_positions` serde and `buildActiveSet`, yet yields the same
    // requests a full `plan()` would.
    const scrubRequestEpoch = currentEpochs.request + 1;
    const scrubEpochs: SceneEpochs = { ...currentEpochs, request: scrubRequestEpoch };
    interface ScrubPlanned {
      dsId: string;
      dsSettings: DatasetSettings | undefined;
      snapshot: PlanningSnapshot;
      visibleRegion: VisibleRegion;
      selection: SelectionState;
      planningState: PlanningState;
      requests: ChunkRequest[];
      stats: PlanStats;
      zStep: boolean;
    }
    const planned: ScrubPlanned[] = perDataset.map((pd) => {
      const visibleRegion: VisibleRegion = {
        ...pd.cachedRegion,
        zRangeVox: pd.newZRange,
      };
      // Each layer scrubs to the scene's t and z clamped into it.
      const selection: SelectionState = {
        t: pd.layer?.t ?? newT,
        z: pd.layer?.z_range.start ?? ctx.scene.z(),
        visibleChannels: pd.visibleChannels,
        renderMode: "slice",
        interactionState: "idle",
      };
      const snapshot: PlanningSnapshot = {
        datasetId: pd.dsId,
        epochs: scrubEpochs,
        entities: pd.entities,
        visibleRegion,
        selection,
        minimapPending: minimapPendingFetch,
      };
      const stats = emptyPlanStats();
      const zStep = isZStep(pd.planningState.previousZ, selection, planningConfig.sliceBandPlanes);
      const requests = emitPlanRequests(
        pd.planningState.previousActiveSet,
        snapshot,
        stats,
        planningConfig,
        pd.planningState.zoomDirection,
        zStep,
      );
      return {
        dsId: pd.dsId,
        dsSettings: pd.dsSettings,
        snapshot,
        visibleRegion,
        selection,
        planningState: { ...pd.planningState, previousZ: selection.z },
        requests,
        stats,
        zStep,
      };
    });

    // Advance the fetch lifecycle once. The delivery ledger stays: the worker
    // reports any slot the new T/Z leaves stale. The active set is unchanged,
    // so `planningState` keeps it and takes only the new z.
    ctx.cpuCache.onPlanRebuildStart();
    const admissions = this.admit(ctx, planned);
    for (const [index, scrubbed] of planned.entries()) {
      const admission = admissions[index];
      const p = { ...scrubbed, requests: admission.admitted };
      this.planningState.set(p.dsId, p.planningState);
      this.requestEpoch = scrubRequestEpoch;
      this._lastVisibleRegion.set(p.dsId, p.visibleRegion);

      emitViewerInterestHint(
        ctx, p.dsId, p.selection, p.visibleRegion, p.requests, this.requestEpoch,
      );

      this._lastPlanByDataset.set(p.dsId, {
        requests: p.requests,
        activeSet: p.planningState.previousActiveSet,
        epochs: scrubEpochs,
        stats: p.stats,
        nextState: p.planningState,
      });

      // Label overlays follow the plane and timepoint too.
      const labelRequests = computeLabelChunkRequests({
        datasetId: p.dsId,
        manifest: ctx.datasets.get(p.dsId)!.manifest,
        t: p.selection.t,
        z: p.selection.z,
        labelSettings: p.dsSettings?.label_settings,
        mode,
        config: planningConfig,
        zStep: p.zStep,
      });
      const requestsWithLabels =
        labelRequests.length > 0
          ? [...p.requests, ...labelRequests]
          : p.requests;

      ctx.cpuCache.submit({
        requests: requestsWithLabels,
        activeSet: p.planningState.previousActiveSet,
        epochs: scrubEpochs,
        stats: p.stats,
        nextState: p.planningState,
        shortfall: admission.shortfall,
        coarseLoanBytes: admission.borrowed,
      }, chunkBytesFor(ctx.datasets.get(p.dsId)!.manifest));

      this.uploader.sendColdStateSelection({
        ctx,
        datasetId: p.dsId,
        currentT: p.selection.t,
        currentZ: p.selection.z,
        requests: p.requests,
        visibleRegion: p.visibleRegion,
        epochs: scrubEpochs,
      });

      // Refresh the display-only fast-path signature's z-range so a subsequent
      // display edit compares against the scrubbed value; the display state,
      // channels, and non-display fingerprint were proven unchanged above.
      const scrubSig = this.lastRebuildByDataset.get(p.dsId);
      if (scrubSig) scrubSig.zRangeVox = p.visibleRegion.zRangeVox;
    }

    // Reuse the cached roster and entity index, refreshing only the epochs.
    // Advance T and the anchors so later edits compare against the scrubbed
    // state.
    const outputEpochs: SceneEpochs = { ...currentEpochs, request: this.requestEpoch };
    this.lastEpochs = outputEpochs;
    this.cachedResult = { ...this.cachedResult, settings, layers, epochs: outputEpochs };
    this.plannedMinimap = new Map(minimapPendingFetch);
    this.lastRebuildScalars = { ...scalars, t: newT };
    this.lastRebuildAt = performance.now();
    this.pendingDeferredRebuild = false;
    return true;
  }

  /**
   * Reconstruct a dataset's `entities` by folding the scene's
   * `view_query_delta` onto the per-dataset cursor. Returns `"skip"` when the
   * dataset is not registered, as the full `view_query` path does.
   * `inputsRef` is the identity of the snapshot-inputs entry `deps` came
   * from, which is the cursor's basis.
   *
   * The result matches a fresh full build on the render-affecting fields
   * (`visible`, `targetLevel`, `kind`, `coarseLevel`, `parentId`). Continuous
   * fields (`importance`, `projectedDiagonalPx`, `projectedAreaPx2`,
   * `centroidWorld`) may be stale on a carried-over record; none of them
   * feeds the active set.
   */
  private foldViewDeltaEntities(
    scene: TickContext["scene"],
    datasetId: string,
    deps: SnapshotEntityDeps,
    inputsRef: object,
  ): EntitySnapshot[] | "skip" {
    // A reconstructed scene starts with an empty Rust cursor, so every
    // cursor held here belongs to a dead scene.
    if (scene !== this.viewDeltaScene) {
      this.viewDeltaCursor.clear();
      this.viewDeltaScene = scene;
    }

    const deltaJson = scene.view_query_delta(datasetId);
    // `null` means the dataset is unknown and the Rust cursor did not
    // advance, so dropping ours keeps the two consistent for a later re-add.
    if (!deltaJson || deltaJson === "null") {
      this.viewDeltaCursor.delete(datasetId);
      return "skip";
    }
    const delta = JSON.parse(deltaJson) as ViewQueryDeltaJson;

    const existing = this.viewDeltaCursor.get(datasetId);
    // Fold only onto a cursor with the same manifest/placement basis (see the
    // field doc). Otherwise reseed from the full query.
    const prev =
      existing && existing.basisInputs === inputsRef ? existing.map : null;

    // Drop on throw. `view_query_delta` already advanced the Rust cursor, and
    // `makeEntitySnapshot` throws on a Tile with no parent edge. If a throw
    // left the prior map in place, the next tick would fold onto a stale base
    // and lose this tick's changes for good. Dropping the entry makes the
    // next tick reseed from the full query; the rethrow keeps it loud.
    try {
      let next: Map<string, EntitySnapshot>;
      if (prev === null && "Delta" in delta) {
        // The Rust cursor is ahead of us (a new coordinator on a persisting
        // scene, or a basis change), so this delta is against a base we never
        // held. Reseed from the full query at this tick, which matches the
        // Rust cursor the delta call just advanced.
        const seeded = this.buildEntityMapFromViewQuery(scene, datasetId, deps);
        if (seeded === null) {
          this.viewDeltaCursor.delete(datasetId);
          return "skip";
        }
        next = seeded;
      } else {
        next = applyViewQueryDelta(prev, delta, deps);
      }

      this.viewDeltaCursor.set(datasetId, { basisInputs: inputsRef, map: next });
      return [...next.values()];
    } catch (e) {
      this.viewDeltaCursor.delete(datasetId);
      throw e;
    }
  }

  /**
   * Build a fresh `image_id → EntitySnapshot` map from the full `view_query`
   * to seed the fold cursor. Returns `null` when the dataset is unknown.
   */
  private buildEntityMapFromViewQuery(
    scene: TickContext["scene"],
    datasetId: string,
    deps: SnapshotEntityDeps,
  ): Map<string, EntitySnapshot> | null {
    const vqJson = scene.view_query(datasetId);
    const vq = JSON.parse(vqJson) as
      | { visible_entities?: ViewQueryEntityJson[] }
      | null;
    if (!vq || !vq.visible_entities) return null;
    const map = new Map<string, EntitySnapshot>();
    for (const row of vq.visible_entities) {
      map.set(row.image_id, makeEntitySnapshot(row, deps));
    }
    return map;
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
    this._lastPlanByDataset.delete(workerMemberId);
    this._lastEntities.delete(workerMemberId);
    this._lastVisibleRegion.delete(workerMemberId);
    // Without this delete, a dataset removed and re-added would keep
    // its prior `PlanningState` (`previousActiveSet` etc.) across the gap.
    this.planningState.delete(workerMemberId);
    // Drop the fast-path signature so a fast path can never reuse a removed
    // dataset's roster.
    this.lastRebuildByDataset.delete(workerMemberId);
    this.lastVisibleDatasetIds.delete(workerMemberId);
    // Drop the cached tile matrices, the cached snapshot inputs, and the
    // delta-sync flag so a re-added dataset re-derives placement and re-syncs
    // with a full cold state before any view-move delta can reference it.
    this.matrixCacheByDataset.delete(workerMemberId);
    this.snapshotInputCacheByDataset.delete(workerMemberId);
    this.coldStateSyncedDatasets.delete(workerMemberId);
    // Drop the view-query fold cursor so a re-added dataset reseeds from a
    // full query rather than folding a delta onto a removed dataset's records.
    this.viewDeltaCursor.delete(workerMemberId);
  }

  /** Per-dataset snapshot of the most recent `plan()` output. Live Map — do not mutate. */
  getLastPlans(): ReadonlyMap<string, RequestPlan> {
    return this._lastPlanByDataset;
  }

  /**
   * True while a coalesced change's trailing rebuild is owed. The view is
   * not settled until it lands.
   */
  hasPendingRebuild(): boolean {
    return this.pendingDeferredRebuild;
  }

  /**
   * How long until the owed rebuild may run, or null when none is owed. The
   * render loop ticks again then rather than every frame until then.
   */
  msUntilPendingRebuild(now: number): number | null {
    if (!this.pendingDeferredRebuild) return null;
    return Math.max(0, this.lastRebuildAt + this.deferredRebuildIntervalMs - now);
  }
}
