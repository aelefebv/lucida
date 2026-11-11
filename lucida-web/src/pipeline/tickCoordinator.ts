/**
 * Planner role. Builds the `PlanningSnapshot` from live WASM scene state
 * each tick, one view at a time, calls `plan()` per dataset, caches on the
 * epoch ladder, and routes output through {@link Uploader} for cold-state
 * emission and chunk delivery.
 */

import { keepsCut, readPlacement } from "../placement.ts";
import { drawnView, type TickContext, type TickView } from "../renderLoopTypes.ts";
import type { DatasetSettings, SceneSettings } from "../tickCommon.ts";
import type { DatasetManifest, ImageSpec } from "../manifestTypes.ts";
import { getSceneSettings } from "../tickCommon.ts";
import {
  outsideCut,
  readResolvedLayers,
  shownChannels,
  type ResolvedLayer,
  type ResolvedLayers,
} from "../resolvedLayers.ts";
import { buildDisplayStateByChannel } from "./upload/coldState/displayState.ts";
import type { ColdStateDisplayState, GpuCapacityReport, PoolMode } from "../renderer/workerProtocol.ts";
import { datasetViewKey } from "../renderer/poolKeys.ts";
import { computeMemberIndexMap } from "../renderer/descriptorBuffer.ts";
import {
  plan,
  emitPlanRequests,
  isCutStep,
  emptyPlanStats,
  initialPlanningState,
  scrubbedPlanningState,
  type PlanningConfig,
} from "./planning/index.ts";
import { configStore } from "./planning/configStore.ts";
import { buildViewSnapshot, sliceCut } from "./planning/snapshot.ts";
import { cutAxis, type SlicePlane, type SpatialAxis } from "../renderer/slicePlane.ts";
import {
  applyViewQueryDelta,
  makeEntitySnapshot,
  type SnapshotEntityDeps,
  type ViewQueryDeltaJson,
  type ViewQueryEntityJson,
} from "./planning/snapshotDelta.ts";
import type { WasmScene } from "lucida-core";
import { recordPlanningTick } from "./planning/traceTick.ts";
import { computeLabelChunkRequests, labelFormsFor } from "./planning/labelRequests.ts";
import { admitPlans, chunkBytesFor, type Admission } from "./planning/admission.ts";
import { tallyViewCoverage, type ViewCoverage } from "./planning/viewCoverage.ts";
import { requestIdentity } from "./planning/plan.ts";
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
  ViewSnapshot,
} from "./planning/index.ts";
import type { SceneEpochs } from "./epochs.ts";
import type { VisibleRegion } from "./viewport.ts";

export type { MinimapChunkCoord } from "./planning/index.ts";
import type { ColdStateCauseKey } from "./upload/telemetry/coldState.ts";
import { orchTelemetryActive } from "./upload/telemetry/active.ts";
import { buildRoster } from "./upload/coldState/roster.ts";
import { regionInWorkerFrame, workerCutAxis, workerCutIndex } from "./upload/coldState/build.ts";
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
  /**
   * Per dataset and view, keyed by `datasetViewKey`, the roster of members
   * that need render layers in that view.
   */
  memberRosterByDatasetView: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  /**
   * What each layer shows, as the scene resolved it for this plan in the
   * first view that draws it, the drawn view whenever that one does.
   */
  layers: ReadonlyMap<string, ResolvedLayer>;
  epochs: SceneEpochs;
  /**
   * Per dataset and view, keyed by `datasetViewKey`, the memberId → entity
   * index map of the view's descriptors. Both the worker (when building the
   * descriptor buffer) and the render paths (when assembling layers) read
   * from this map. Computed deterministically from the same
   * `cold.activeSet × cold.visibleChannels` iteration the worker uses, so
   * indices agree by construction.
   */
  entityIndexByDatasetView: Map<string, Map<string, number>>;
}

/** The views a tick plans for: each view the loop draws, the drawn one first. */
function plannedViews(ctx: TickContext): readonly TickView[] {
  return ctx.views;
}

/** Each dataset's layer as the first view that draws it resolves it, the drawn view first. */
function leadLayers(ctx: TickContext, layersByView: ReadonlyMap<number, ResolvedLayers>): ResolvedLayers {
  const lead = new Map<string, ResolvedLayer>();
  for (const dsId of ctx.datasets.keys()) {
    for (const view of ctx.views) {
      const layer = layersByView.get(view.id)?.get(dsId);
      if (layer) {
        lead.set(dsId, layer);
        break;
      }
    }
  }
  return lead;
}

/** One view of a planned dataset. */
interface PlannedView {
  view: TickView;
  /**
   * The pools the view draws the dataset from: those of its own mode, or
   * the volume pools for a slice view whose cut the dataset's placement
   * tilts, which it reads from the dataset's bricks ({@link drawMode}).
   */
  mode: PoolMode;
  snapshot: ViewSnapshot;
  /** The dataset's layer as the view resolves it. */
  layer: ResolvedLayer | undefined;
  /** Whether the selection stepped along its cut since the view's previous plan ({@link isCutStep}). */
  cutStep: boolean;
}

interface PlannedDataset {
  dsId: string;
  dsSettings: SceneSettings["allSettings"][string] | undefined;
  views: PlannedView[];
  result: RequestPlan;
}

/**
 * What the worker lays out for one planned view of a dataset: its own active
 * set, and the admitted requests it asked for, which become its wanted
 * chunks. A plan of one view is that view's.
 */
function viewShare(
  planned: PlannedDataset,
  view: PlannedView,
  admitted: readonly ChunkRequest[],
): { activeSet: ActiveSetEntry[]; requests: readonly ChunkRequest[] } {
  const { result } = planned;
  if (planned.views.length === 1) return { activeSet: result.activeSet, requests: admitted };
  const own = new Set((result.byView?.get(view.view.id) ?? []).map(requestIdentity));
  return {
    activeSet: result.nextState.views.get(view.view.id)?.activeSet ?? [],
    requests: admitted.filter((req) => own.has(requestIdentity(req))),
  };
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
 * How long a view holds still before it counts as stopped: a few display
 * frames past the last input of a drag, the gap at which a pause is no
 * longer the interval between two inputs.
 */
export const VIEW_STILL_MS = 100;

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
  /**
   * The [start, end) planes along its cut axis this rebuild planned for: the
   * z-range of an XY view, the Y or X plane of a side view.
   */
  cut: RegionCut;
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

/** The axis a region cuts and the [start, end) planes it spans along it. */
interface RegionCut {
  axis: SpatialAxis;
  range: [number, number];
}

/** The planes `region` spans along its cut axis. */
function regionCut(region: VisibleRegion): RegionCut {
  const axis = region.cutAxis ?? "z";
  const [minX, minY, maxX, maxY] = region.xyBoundsVox;
  const range: [number, number] =
    axis === "x" ? [minX, maxX] : axis === "y" ? [minY, maxY] : region.zRangeVox;
  return { axis, range };
}

/** `region` with its planes along its cut axis replaced by `range`. */
function withCutRange(region: VisibleRegion, range: [number, number]): VisibleRegion {
  const axis = region.cutAxis ?? "z";
  if (axis === "z") return { ...region, zRangeVox: range };
  const [minX, minY, maxX, maxY] = region.xyBoundsVox;
  const xyBoundsVox: [number, number, number, number] =
    axis === "x" ? [range[0], minY, range[1], maxY] : [minX, range[0], maxX, range[1]];
  return { ...region, xyBoundsVox };
}

/**
 * The pools `view` draws `datasetId` from: those of its own mode, unless it
 * is a slice view whose cut the dataset's placement tilts. Its planes then
 * don't lie across the cut, so the view samples the cut from the dataset's
 * bricks, as a volume view holds them.
 */
function drawMode(ctx: TickContext, view: TickView, datasetId: string): PoolMode {
  if (view.mode === "volume") return "volume";
  const plane = ctx.scene.slice_plane(view.id) as SlicePlane;
  return keepsCut(readPlacement(ctx.scene, datasetId), cutAxis(plane)) ? "slice" : "volume";
}

/**
 * Whether a view draws a dataset's label overlays: one that draws from its
 * own mode's pools. A tilted cut samples the bricks, and no label overlay
 * draws from them.
 */
function drawsLabels(planned: PlannedView): boolean {
  return planned.mode === planned.view.mode;
}

/** The plane `view` cuts: its slice plane, or null in the volume view, which cuts none. */
function viewCutPlane(ctx: TickContext, view: TickView): SlicePlane | null {
  return view.mode === "slice" ? (ctx.scene.slice_plane(view.id) as SlicePlane) : null;
}

/**
 * Whether a view of `plane` plans `layer`: one it draws, neither hidden, nor
 * set aside by the view's comparison, nor missed by its cut. Without a layer
 * the view's `view_query` decides, and answers nothing for a dataset it does
 * not draw.
 */
function plansLayer(layer: ResolvedLayer | undefined, plane: SlicePlane | null): boolean {
  return layer === undefined || (layer.visible && !outsideCut(layer, plane));
}

/**
 * The datasets the view draws and plans: each one shown whose layer it
 * plans. A change to this set changes the roster.
 */
function drawnDatasetIds(
  settings: SceneSettings,
  layers: ResolvedLayers,
  plane: SlicePlane | null,
): Set<string> {
  const drawn = new Set<string>();
  for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
    if (dsSettings.visible && plansLayer(layers.get(dsId), plane)) drawn.add(dsId);
  }
  return drawn;
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function sameCut(a: RegionCut, b: RegionCut): boolean {
  return a.axis === b.axis && a.range[0] === b.range[0] && a.range[1] === b.range[1];
}

/**
 * The planes WASM reports a dataset's region in `view` spans along its cut
 * axis, with the same null handling as {@link buildViewSnapshot} so it compares
 * exactly against the captured cut. Read directly rather than from
 * `scene.z()`, which is only the slab start, so the fast paths notice a slab
 * extension that moves the end.
 */
function readCut(
  scene: TickContext["scene"],
  view: number,
  datasetId: string,
): RegionCut {
  const raw = scene.visible_region(view, datasetId);
  const parsed = raw && raw !== "null"
    ? (JSON.parse(raw) as {
      xy_bounds?: [number, number, number, number];
      z_range?: [number, number];
      cut_axis?: SpatialAxis;
    } | null)
    : null;
  return regionCut({
    xyBoundsVox: parsed?.xy_bounds ?? [0, 0, 0, 0],
    zRangeVox: parsed?.z_range ?? [0, 1],
    effectiveZoom: 1,
    sortCenterVox: null,
    frustumPlanes: null,
    ...(parsed?.cut_axis !== undefined ? { cutAxis: parsed.cut_axis } : {}),
  });
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
 * pools hold between them, as `report` gives the pools, each request in the
 * pools of the mode of the view that asked, so the wanted set the cache
 * drives toward fits the one page-wide budget.
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
        slotOf: gpuSlotsFor(manifest, report, gpuTotalBytes),
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
  private lastViewCoverage: ReadonlyMap<number, ViewCoverage> | null = null;

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
  /** Only the view moved since the rebuild the owed one follows. */
  private deferredViewOnly = false;
  /** The view epoch the last tick read, and when it last changed. */
  private lastSeenViewEpoch: number | null = null;
  private lastViewMoveAt = Number.NEGATIVE_INFINITY;
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
  /** {@link drawnDatasetIds} at the last full rebuild. */
  private lastDrawnDatasetIds = new Set<string>();
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
   * {@link buildViewSnapshot}: the `imageSpecById` / `parentByEntityId`
   * manifest maps, and parsed `plane_positions` for each plane a view
   * places members on, since a side view places a collection's tiles in
   * cells of their own. A view move leaves all of them identical. An entry
   * is valid only while both keys match:
   *   - `epochKey`, the content|layout fingerprint. A reflow or
   *     add/remove that moves placement bumps it.
   *   - `manifestRef`, the `ds.manifest` reference. Progressively generated
   *     levels swap in a new manifest object with no epoch bump, so
   *     reference identity is the only signal the manifest maps are stale.
   */
  private readonly snapshotInputCacheByDataset = new Map<string, {
    epochKey: string;
    manifestRef: DatasetManifest;
    imageSpecById: Map<string, ImageSpec>;
    parentByEntityId: Map<string, string | null>;
    byPlane: Map<SlicePlane, SnapshotEntityDeps>;
  }>();
  /**
   * Per dataset and view, the cursor for the incremental view-query fold: the
   * last reconstructed `image_id → EntitySnapshot` map and the basis it was
   * built against. A replan folds the scene's `view_query_delta` onto `map` instead
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
  private readonly viewDeltaCursor = new Map<string, Map<number, {
    /** Identity of the snapshot inputs (manifest maps + placement). */
    basisInputs: SnapshotEntityDeps;
    map: Map<string, EntitySnapshot>;
  }>>();
  /**
   * The `WasmScene` the {@link viewDeltaCursor} entries were built against.
   * Compared by object identity every fold; a mismatch (a reconstructed
   * scene, or the first fold of a freshly-constructed coordinator) clears the
   * whole cursor so a stale entry can never be folded against a new scene's
   * Rust cursor.
   */
  private viewDeltaScene: WasmScene | null = null;

  /**
   * Per dataset and view, the active set the worker's cold state for that
   * view holds, and the mode it was laid out in: the base a view-move delta
   * diffs against. Set when a full cold state or a delta goes out. The scrub
   * and display fast paths never change the active set, so they leave it. A
   * view that no longer draws the dataset is dropped, and a removed dataset
   * or one no view plans drops every view, so a view drawing it again
   * re-syncs with a full send, as does a view now drawing it in the other
   * mode. Its keys are the datasets the worker holds a plan for.
   */
  private readonly heldActiveSets = new Map<string, Map<number, { mode: PoolMode; activeSet: ActiveSetEntry[] }>>();
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

  /**
   * Tell the worker of each dataset it holds a plan for that no view plans
   * now, so it wants none of its chunks: they keep their slots for a quick
   * return, and are the first to go when a planned dataset needs room.
   */
  private releaseUnplanned(ctx: TickContext, planned: readonly PlannedDataset[]): void {
    const plannedIds = new Set(planned.map((dataset) => dataset.dsId));
    for (const dsId of [...this.heldActiveSets.keys()]) {
      if (plannedIds.has(dsId) || !ctx.datasets.has(dsId)) continue;
      this.heldActiveSets.delete(dsId);
      this.uploader.sendDatasetUnplanned(ctx, dsId);
    }
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
    if (currentEpochs.view !== this.lastSeenViewEpoch) {
      this.lastSeenViewEpoch = currentEpochs.view;
      this.lastViewMoveAt = tickStart;
    }

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
        const viewOnly = causes.every((c) => c === "view");
        if (tickStart < this.deferredRebuildDue(interval, viewOnly)) {
          coalescedSkip = true;
          // Leave `lastEpochs` stale so the change is re-detected next
          // tick, and flag the deferral so the render loop ticks again
          // once the window elapses and the trailing rebuild lands.
          this.pendingDeferredRebuild = true;
          this.deferredRebuildIntervalMs = interval;
          this.deferredViewOnly = viewOnly;
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
    const views = plannedViews(ctx);
    const drawn = views[0];
    const layersByView = new Map(views.map((view) => [view.id, readResolvedLayers(ctx.scene, view.id)]));
    // With one view, the fast paths and the result describe what it draws.
    const layers = views.length === 1 ? layersByView.get(drawn.id)! : leadLayers(ctx, layersByView);
    const planningConfig = configStore.get();

    const structural = isStructural(causes);
    // The fast paths prove their case against the drawn view alone, and
    // against slice cuts alone: a tilted cut's slab moves with the view's
    // place, which only a full plan follows.
    const fastPathsHold = views.length === 1
      && [...ctx.datasets.keys()].every((dsId) => drawMode(ctx, views[0], dsId) === views[0].mode);
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
      fastPathsHold &&
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
      fastPathsHold &&
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
      fastPathsHold &&
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

    const memberRosterByDatasetView = new Map<string, MemberRosterEntry[]>();
    const entityIndexByDatasetView = new Map<string, Map<string, number>>();
    const plannedDatasets: PlannedDataset[] = [];

    for (const [dsId, ds] of ctx.datasets) {
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) continue;
      // Each view that draws the dataset plans it. A view that leaves the
      // dataset out gets no view query for it. A layer a view's cut misses,
      // or its comparison sets aside, draws nothing there, so nothing of it
      // is planned for that view.
      const viewsOfDataset = views
        .filter((view) => plansLayer(layersByView.get(view.id)!.get(dsId), viewCutPlane(ctx, view)));
      if (viewsOfDataset.length === 0) continue;

      const planningStateForDataset = this.planningState.get(dsId)
        ?? initialPlanningState();
      const plannedViewsOfDataset: PlannedView[] = [];
      for (const view of viewsOfDataset) {
        // Fold the view delta instead of re-running `view_query`: O(delta)
        // rather than O(N members) on a camera move, a level change included.
        // `viewDeltaCursor` documents why the fold matches a full parse.
        const deps = this.snapshotInputs(ctx, dsId, ds.manifest, currentEpochs, view);
        const entitiesOverride = this.foldViewDeltaEntities(ctx.scene, view.id, dsId, deps);
        if (entitiesOverride === "skip") continue;

        // The builder skips `view_query` when given `entitiesOverride` but
        // still computes `visible_region` and `selection` fresh.
        const layer = layersByView.get(view.id)!.get(dsId);
        const mode = drawMode(ctx, view, dsId);
        const snapshot = buildViewSnapshot({
          scene: ctx.scene,
          view: view.id,
          datasetId: dsId,
          dataset: ds,
          layer,
          mode,
          precomputed: deps,
          entitiesOverride,
        });
        if (!snapshot) continue;
        const previousCut = planningStateForDataset.views.get(view.id)?.previousCut ?? null;
        const cutStep = isCutStep(previousCut, snapshot.selection, planningConfig.sliceBandPlanes);
        plannedViewsOfDataset.push({ view, mode, snapshot, layer, cutStep });
      }
      const drawnOfDataset = plannedViewsOfDataset[0];
      if (drawnOfDataset === undefined) continue;
      const { entities, visibleRegion, selection } = drawnOfDataset.snapshot;

      // Plan. Opaque carry-forward state travels via {@link PlanningState};
      // `nextState` is stored for the next tick. `minimapPendingFetch` flows
      // into the snapshot so the minimap lane plans first.
      const snapshot: PlanningSnapshot = {
        datasetId: dsId,
        epochs: currentEpochs,
        views: plannedViewsOfDataset.map((planned) => planned.snapshot),
        minimapPending: minimapPendingFetch,
      };
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
        ctx.client.datasetLevels(dsId, drawnOfDataset.view.id)?.displayed ?? null,
      );

      plannedDatasets.push({
        dsId,
        dsSettings,
        views: plannedViewsOfDataset,
        result,
      });
    }

    // Rebuild the display-only fast-path signatures from scratch: datasets
    // that no longer plan (turned invisible / scrolled fully out) drop out.
    this.lastRebuildByDataset.clear();
    this.releaseUnplanned(ctx, plannedDatasets);

    const admissions = this.admit(
      ctx,
      plannedDatasets.map((planned) => ({ dsId: planned.dsId, requests: planned.result.requests })),
    );
    // With several views, how much of what each asks for admission let in.
    const viewCoverage = views.length > 1 ? new Map<number, ViewCoverage>() : null;
    for (const [index, planned] of plannedDatasets.entries()) {
      const { dsId, dsSettings } = planned;
      const { layer, snapshot: { visibleRegion, selection } } = planned.views[0];
      const admission = admissions[index];
      if (viewCoverage) {
        // A dataset one view plans asks for what its plan asks for.
        const byView = planned.result.byView ?? new Map([[
          planned.views[0].view.id,
          planned.result.requests.filter((req) => req.lane === "detail" || req.lane === "coarse"),
        ]]);
        tallyViewCoverage(viewCoverage, byView, admission.admitted);
      }
      const result: RequestPlan = {
        ...planned.result,
        requests: admission.admitted,
        shortfall: admission.shortfall,
        coarseLoanBytes: admission.borrowed,
      };
      this._lastPlanByDataset.set(dsId, result);

      const matrixEpochKey = `${currentEpochs.content}|${currentEpochs.layout}`;
      let matrixCacheEntry = this.matrixCacheByDataset.get(dsId);
      if (!matrixCacheEntry || matrixCacheEntry.epochKey !== matrixEpochKey) {
        matrixCacheEntry = { epochKey: matrixEpochKey, matrices: new Map() };
        this.matrixCacheByDataset.set(dsId, matrixCacheEntry);
      }
      // Each cold state names the views that draw the dataset, and the worker
      // drops what it kept for any other.
      const drawnViews = planned.views.map((view) => view.view.id);
      let held = this.heldActiveSets.get(dsId);
      if (!held) {
        held = new Map();
        this.heldActiveSets.set(dsId, held);
      }
      for (const view of [...held.keys()]) {
        if (!drawnViews.includes(view)) held.delete(view);
      }

      // Each view gets a cold state of its own: its active set, the requests
      // it asked for, and its own cut, timepoint and region. The worker lays
      // out the view's indirection over the pools the dataset's views share.
      for (const plannedView of planned.views) {
        const { view, mode, snapshot, layer: viewLayer } = plannedView;
        const { entities } = snapshot;
        const key = datasetViewKey(dsId, view.id);
        const share = viewShare(planned, plannedView, result.requests);

        // Build the member roster and per-entity matrix map in one walk.
        const { entries: rosterEntries, matricesByEntity } = buildRoster({
          activeSet: share.activeSet,
          entities,
          ctx,
          datasetId: dsId,
          tileMatrixCache: matrixCacheEntry.matrices,
        });
        memberRosterByDatasetView.set(key, rosterEntries);
        const coldArgs = {
          ctx,
          datasetId: dsId,
          activeSet: share.activeSet,
          requests: share.requests,
          labels: drawsLabels(plannedView) ? labelFormsFor({
            datasetId: dsId,
            manifest: ctx.datasets.get(dsId)!.manifest,
            t: snapshot.selection.t,
            cut: snapshot.selection.cut,
            labelSettings: dsSettings?.label_settings,
            mode,
          }) : [],
          entities,
          selection: snapshot.selection,
          visibleRegion: snapshot.visibleRegion,
          renderRadiusView: {
            detail: planningConfig.detailRenderRadiusView,
            coarse: planningConfig.coarseRenderRadiusView,
          },
          epochs: result.epochs,
          matricesByEntity,
          layer: viewLayer,
          view: view.id,
          drawnViews,
        };

        // View-move fast path: only the camera moved and the worker holds
        // exactly the active set last sent for this view, so ship only the
        // active-set delta instead of the whole descriptor array.
        const heldForView = held.get(view.id);
        const previousActiveSet = heldForView?.mode === mode ? heldForView.activeSet : undefined;
        if (viewOnly && previousActiveSet !== undefined && previousActiveSet.length > 0) {
          this.uploader.sendColdStateDelta({ ...coldArgs, previousActiveSet });
          // The worker rebuilds its descriptor buffer from the reordered active
          // set in the same canonical order this walks, so the indices agree.
          const visibleChannels = snapshot.selection.visibleChannels;
          entityIndexByDatasetView.set(key, computeActiveSetIndexMap(share.activeSet, visibleChannels));
          this.uploader.sendViewHotStateFromMembersIfAdvanced({
            ctx,
            datasetId: dsId,
            view: view.id,
            memberIds: iterateActiveSetMembers(share.activeSet, visibleChannels),
            epochs: result.epochs,
          });
        } else {
          // Full send. Drives atlas creation/remap + wanted-set + descriptor
          // buffer build; the resolved layer bakes per-channel display state
          // into descriptors.
          const coldMsg = this.uploader.sendColdState(coldArgs);
          // Same memberId → entityIndex map the worker builds from cold
          // state — both sides converge because they walk the same iteration order.
          entityIndexByDatasetView.set(key, computeMemberIndexMap(coldMsg));

          // Emit before render messages so the view's ray hits are current
          // when chunk-data eviction fires. Short-circuits on unchanged viewEpoch.
          this.uploader.sendViewHotStateIfAdvanced({
            ctx,
            datasetId: dsId,
            view: view.id,
            coldMsg,
            epochs: result.epochs,
          });
        }
        // A later pure view move can take the delta path against this.
        held.set(view.id, { mode, activeSet: share.activeSet });
      }

      // Categorical label overlays are invisible to the WASM planner
      // (labels live outside `manifest.images`/`entities`), so their chunk
      // requests are synthesized here from the label's own geometry and
      // merged into the fetch plan. In `slice` mode the planes around the
      // label's plane the view cuts are fetched, as the image's are; in `volume`
      // mode the whole label volume (every z-chunk) is fetched for the 3D
      // first-hit surface. Scoped under each label's own image id, so they
      // never perturb intensity-chunk eviction. Each view asks for its own.
      const labelRequests = planned.views.filter(drawsLabels).flatMap((view) => computeLabelChunkRequests({
        datasetId: dsId,
        manifest: ctx.datasets.get(dsId)!.manifest,
        t: view.snapshot.selection.t,
        cut: view.snapshot.selection.cut,
        // Fetch only the labels the render path will draw (visible +
        // eligible), so a hidden label is neither fetched nor drawn.
        labelSettings: dsSettings?.label_settings,
        mode: view.view.mode,
        config: planningConfig,
        cutStep: view.cutStep,
      }));
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
        cut: regionCut(visibleRegion),
        nonDisplayKey: nonDisplayKeyForDataset(dsSettings),
      });
    }

    this.lastViewCoverage = viewCoverage;
    const outputEpochs: SceneEpochs = { ...currentEpochs, request: this.requestEpoch };
    this.lastEpochs = outputEpochs;
    this.cachedResult = {
      memberRosterByDatasetView, settings, layers, epochs: outputEpochs, entityIndexByDatasetView,
    };
    this.lastRebuildManifests = new Map(
      [...ctx.datasets].map(([dsId, ds]) => [dsId, ds.manifest]),
    );
    this.plannedMinimap = new Map(minimapPendingFetch);

    // Capture the scene scalars, layer order, and drawn-dataset set this
    // rebuild planned against, so the display-only fast path has a baseline
    // to prove against. `lastRebuildByDataset` was repopulated per dataset
    // above (each carries its own z-range).
    this.lastRebuildScalars = {
      t: ctx.scene.t(),
      mode: drawn.mode,
    };
    this.lastLayerOrderKey = JSON.stringify(settings.layerOrder);
    this.lastDrawnDatasetIds = drawnDatasetIds(settings, layers, viewCutPlane(ctx, drawn));

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
      drawnView(ctx).mode !== scalars.mode
    ) {
      return false;
    }

    // A layer reorder changes the composite draw order, which comes from
    // the roster.
    if (JSON.stringify(settings.layerOrder) !== this.lastLayerOrderKey) return false;

    // A visibility toggle bumps the selection epoch but changes the roster.
    // This also catches a dataset turning visible, which the per-dataset
    // loop below would never see.
    if (!sameIds(drawnDatasetIds(settings, layers, viewCutPlane(ctx, drawnView(ctx))), this.lastDrawnDatasetIds)) {
      return false;
    }

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
      if (!sameCut(readCut(ctx.scene, drawnView(ctx).id, dsId), sig.cut)) return false;
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
        view: drawnView(ctx).id,
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
    const drawn = drawnView(ctx);
    const mode = drawn.mode;
    if (mode !== "slice" || scalars.mode !== "slice") return false;

    // Layer order and the drawn-dataset set each change the roster, and the
    // shown channels the member shape, proven per dataset below. T is the
    // scrub axis; Z is proven per dataset via the z-range. A scrub that takes
    // the cut past a layer, or back into one, changes the drawn set.
    if (JSON.stringify(settings.layerOrder) !== this.lastLayerOrderKey) return false;
    if (!sameIds(drawnDatasetIds(settings, layers, viewCutPlane(ctx, drawnView(ctx))), this.lastDrawnDatasetIds)) {
      return false;
    }

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
      newCut: RegionCut;
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
      const cut = readCut(ctx.scene, drawn.id, dsId);
      if (cut.axis !== sig.cut.axis) return false;
      const oldWidth = sig.cut.range[1] - sig.cut.range[0];
      const newWidth = cut.range[1] - cut.range[0];
      if (newWidth !== oldWidth) return false;
      if (!sameCut(cut, sig.cut)) anyScrub = true;

      const planningState = this.planningState.get(dsId);
      const entities = this._lastEntities.get(dsId);
      const cachedRegion = this._lastVisibleRegion.get(dsId);
      if (!planningState || !entities || !cachedRegion) return false;

      perDataset.push({
        dsId, dsSettings, layer, visibleChannels, planningState, entities, cachedRegion,
        newCut: cut,
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
      cutStep: boolean;
    }
    const planned: ScrubPlanned[] = perDataset.map((pd) => {
      const visibleRegion = withCutRange(pd.cachedRegion, pd.newCut.range);
      // Each layer scrubs to the scene's t and z clamped into it.
      const selection: SelectionState = {
        t: pd.layer?.t ?? newT,
        z: pd.layer?.z_range.start ?? ctx.scene.z(),
        cut: sliceCut(ctx.scene, drawn.id, pd.layer),
        visibleChannels: pd.visibleChannels,
        renderMode: "slice",
        interactionState: "idle",
      };
      const snapshot: PlanningSnapshot = {
        datasetId: pd.dsId,
        epochs: scrubEpochs,
        views: [{ view: drawn.id, entities: pd.entities, visibleRegion, selection }],
        minimapPending: minimapPendingFetch,
      };
      const stats = emptyPlanStats();
      const previousCut = pd.planningState.views.get(drawn.id)?.previousCut ?? null;
      const cutStep = isCutStep(previousCut, selection, planningConfig.sliceBandPlanes);
      const requests = emitPlanRequests(snapshot, pd.planningState, stats, planningConfig);
      return {
        dsId: pd.dsId,
        dsSettings: pd.dsSettings,
        snapshot,
        visibleRegion,
        selection,
        planningState: scrubbedPlanningState(snapshot, pd.planningState),
        requests,
        stats,
        cutStep,
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
        cut: p.selection.cut,
        labelSettings: p.dsSettings?.label_settings,
        mode,
        config: planningConfig,
        cutStep: p.cutStep,
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
        view: drawn.id,
        labels: labelFormsFor({
          datasetId: p.dsId,
          manifest: ctx.datasets.get(p.dsId)!.manifest,
          t: p.selection.t,
          cut: p.selection.cut,
          labelSettings: p.dsSettings?.label_settings,
          mode,
        }),
        currentT: p.selection.t,
        currentZ: workerCutIndex(p.selection),
        requests: p.requests,
        visibleRegion: regionInWorkerFrame(p.visibleRegion, workerCutAxis(p.selection)),
        epochs: scrubEpochs,
      });

      // Refresh the display-only fast-path signature's z-range so a subsequent
      // display edit compares against the scrubbed value; the display state,
      // channels, and non-display fingerprint were proven unchanged above.
      const scrubSig = this.lastRebuildByDataset.get(p.dsId);
      if (scrubSig) scrubSig.cut = regionCut(p.visibleRegion);
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
   * The camera-independent inputs to `view`'s snapshot of a dataset, the same
   * object while they hold, so a view-query fold keeps its basis. Members are
   * placed on the plane the view draws, a volume view placing them as an XY
   * view does. See `snapshotInputCacheByDataset` for why both keys are checked.
   */
  private snapshotInputs(
    ctx: TickContext,
    dsId: string,
    manifest: DatasetManifest,
    epochs: SceneEpochs,
    view: TickView,
  ): SnapshotEntityDeps {
    const epochKey = `${epochs.content}|${epochs.layout}`;
    let entry = this.snapshotInputCacheByDataset.get(dsId);
    if (!entry || entry.epochKey !== epochKey || entry.manifestRef !== manifest) {
      const imageSpecById = new Map<string, ImageSpec>();
      for (const img of manifest.images) imageSpecById.set(img.image_id, img);
      const parentByEntityId = new Map<string, string | null>();
      for (const ent of manifest.entities) parentByEntityId.set(ent.id, ent.parent ?? null);
      entry = { epochKey, manifestRef: manifest, imageSpecById, parentByEntityId, byPlane: new Map() };
      this.snapshotInputCacheByDataset.set(dsId, entry);
    }
    const plane = viewCutPlane(ctx, view) ?? "xy";
    let inputs = entry.byPlane.get(plane);
    if (!inputs) {
      inputs = {
        imageSpecById: entry.imageSpecById,
        parentByEntityId: entry.parentByEntityId,
        positions: JSON.parse(ctx.scene.plane_positions(view.id, dsId)) as Record<string, [number, number]>,
      };
      entry.byPlane.set(plane, inputs);
    }
    return inputs;
  }

  /**
   * Reconstruct what `view` sees of a dataset's `entities` by folding the
   * scene's `view_query_delta` onto the cursor for the two. Returns `"skip"`
   * when the view does not show the dataset or the dataset is not
   * registered, as the full `view_query` path does.
   * The identity of `deps` is the cursor's basis.
   *
   * The result matches a fresh full build on the render-affecting fields
   * (`visible`, `targetLevel`, `kind`, `coarseLevel`, `parentId`). Continuous
   * fields (`importance`, `projectedDiagonalPx`, `projectedAreaPx2`,
   * `centroidWorld`) may be stale on a carried-over record; none of them
   * feeds the active set.
   */
  private foldViewDeltaEntities(
    scene: TickContext["scene"],
    view: number,
    datasetId: string,
    deps: SnapshotEntityDeps,
  ): EntitySnapshot[] | "skip" {
    // A reconstructed scene starts with an empty Rust cursor, so every
    // cursor held here belongs to a dead scene.
    if (scene !== this.viewDeltaScene) {
      this.viewDeltaCursor.clear();
      this.viewDeltaScene = scene;
    }

    let cursors = this.viewDeltaCursor.get(datasetId);
    if (cursors === undefined) {
      cursors = new Map();
      this.viewDeltaCursor.set(datasetId, cursors);
    }
    const deltaJson = scene.view_query_delta(view, datasetId);
    // `null` means the dataset is unknown to the view and the Rust cursor did
    // not advance, so dropping ours keeps the two consistent for a later
    // re-add.
    if (!deltaJson || deltaJson === "null") {
      cursors.delete(view);
      return "skip";
    }
    const delta = JSON.parse(deltaJson) as ViewQueryDeltaJson;

    const existing = cursors.get(view);
    // Fold only onto a cursor with the same manifest/placement basis (see the
    // field doc). Otherwise reseed from the full query.
    const prev =
      existing && existing.basisInputs === deps ? existing.map : null;

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
        const seeded = this.buildEntityMapFromViewQuery(scene, view, datasetId, deps);
        if (seeded === null) {
          cursors.delete(view);
          return "skip";
        }
        next = seeded;
      } else {
        next = applyViewQueryDelta(prev, delta, deps);
      }

      cursors.set(view, { basisInputs: deps, map: next });
      return [...next.values()];
    } catch (e) {
      cursors.delete(view);
      throw e;
    }
  }

  /**
   * Build a fresh `image_id → EntitySnapshot` map from the full `view_query`
   * to seed the fold cursor. Returns `null` when the dataset is unknown.
   */
  private buildEntityMapFromViewQuery(
    scene: TickContext["scene"],
    view: number,
    datasetId: string,
    deps: SnapshotEntityDeps,
  ): Map<string, EntitySnapshot> | null {
    const vqJson = scene.view_query(view, datasetId);
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
    this.lastDrawnDatasetIds.delete(workerMemberId);
    // Drop the cached tile matrices, the cached snapshot inputs, and the
    // active sets the worker held so a re-added dataset re-derives placement
    // and re-syncs with a full cold state before any view-move delta can
    // reference it.
    this.matrixCacheByDataset.delete(workerMemberId);
    this.snapshotInputCacheByDataset.delete(workerMemberId);
    this.heldActiveSets.delete(workerMemberId);
    // Drop the view-query fold cursor so a re-added dataset reseeds from a
    // full query rather than folding a delta onto a removed dataset's records.
    this.viewDeltaCursor.delete(workerMemberId);
  }

  /** Per-dataset snapshot of the most recent `plan()` output. Live Map — do not mutate. */
  getLastPlans(): ReadonlyMap<string, RequestPlan> {
    return this._lastPlanByDataset;
  }

  /**
   * With several views, each one's coverage as of the last full plan; null
   * with one view, whose coverage is the page's.
   */
  viewCoverage(): ReadonlyMap<number, ViewCoverage> | null {
    return this.lastViewCoverage;
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
    return Math.max(0, this.deferredRebuildDue(this.deferredRebuildIntervalMs, this.deferredViewOnly) - now);
  }

  /**
   * When an owed rebuild may run: once its window from the last rebuild has
   * passed, or, for a view the budgets cut short that only moved, once it
   * has stopped. Uploads for that view wait for it to stop, so the plan they
   * follow should be its last.
   */
  private deferredRebuildDue(intervalMs: number, viewOnly: boolean): number {
    const due = this.lastRebuildAt + intervalMs;
    if (!viewOnly || (this.lastAdmission?.short ?? 0) === 0) return due;
    return Math.min(due, this.lastViewMoveAt + VIEW_STILL_MS);
  }

  /**
   * How long chunk uploads wait, or null when they may go. They wait while
   * a view the budgets cut short moves, until it has held still for
   * {@link VIEW_STILL_MS}. Each replan of such a view admits a different
   * part of it, so an upload during the move takes a full pool's slot from
   * a chunk the frame draws, for one the view has often moved past by the
   * time it lands, and the worker searches the pool for that slot first.
   * Planning and fetching go on, so the chunks are in the cache when the
   * view stops.
   */
  msUntilUploadsResume(now: number): number | null {
    if ((this.lastAdmission?.short ?? 0) === 0) return null;
    const wait = this.lastViewMoveAt + VIEW_STILL_MS - now;
    return wait > 0 ? wait : null;
  }
}
