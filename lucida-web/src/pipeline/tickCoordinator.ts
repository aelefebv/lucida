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
import type { DatasetManifest, ImageSpec } from "../manifestTypes.ts";
import {
  getActiveChannels,
  getSceneSettings,
} from "../tickCommon.ts";
import { buildDisplayStateByChannel } from "./upload/coldState/displayState.ts";
import type { ColdStateDisplayState } from "../renderer/workerProtocol.ts";
import { computeMemberIndexMap } from "../renderer/descriptorBuffer.ts";
import {
  plan,
  emitPlanRequests,
  emptyPlanStats,
  initialPlanningState,
  planProxyResidencyForInputs,
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

// Re-export: canonical declaration lives in `pipeline/planning/index.ts`.
export type { MinimapChunkCoord } from "./planning/index.ts";
import type { CpuCache } from "./fetch/index.ts";
import type { ProxyRequest } from "./planning/index.ts";
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
  /**
   * The active set the worker currently holds for this dataset — captured from
   * `PlanningState.previousActiveSet` BEFORE `plan()`'s `nextState` overwrote it.
   * The view-move delta diffs `result.activeSet` against this.
   */
  previousActiveSet: ActiveSetEntry[];
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
   * level pin, channel visibility, per-label state, or a field
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
 * level pin, channel visibility, and dataset visibility are all
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
 *
 * MAINTENANCE: this equality gates BOTH cheap paths — the display-only patch
 * AND the selection-scrub fast path (which fires only when display is proven
 * UNCHANGED). Any NEW field added to {@link ColdStateDisplayState} that a user
 * edit can move must be compared here (or folded into the non-display
 * fingerprint), or an edit to it could silently slip through a scrub as a stale
 * display. The three omitted fields above are safe only because they cannot
 * change on this path today.
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
   * Per-dataset cache of layout-derived per-entity tile model matrices, reused
   * across rebuilds while placement is unchanged. Tile matrices come from
   * `scene.member_model_matrix` (a pure function of layout, no camera input), so
   * a view move — which advances only the view epoch — leaves them byte-
   * identical; only tiles new to a rebuild's roster are recomputed. Keyed by an
   * epoch fingerprint so a content/layout/asset change (a reflow or add/remove
   * that moves placement) discards the stale matrices. `group-as-proxy` matrices
   * are never cached (they are synthesized from the visible child-tile set, which
   * a view move changes).
   */
  private readonly matrixCacheByDataset = new Map<string, {
    epochKey: string;
    matrices: Map<string, { model: Float32Array; inv: Float32Array }>;
  }>();
  /**
   * Per-dataset cache of the camera-independent inputs to
   * {@link buildPlanningSnapshot}: the parsed `member_positions` record
   * (the fixed 2D layout placement) and the two manifest-derived maps
   * (`imageSpecById`, `parentByEntityId`). All three are pure functions of
   * the scene's layout placement and the current dataset manifest, so a
   * view move — which advances only the view epoch — leaves them
   * byte-identical; recomputing them on every view-only replan is a wasted
   * `member_positions` serde + JSON.parse plus two manifest walks on the
   * interaction hot path.
   *
   * An entry is valid only when BOTH signals still match:
   *   - `epochKey` — the content|layout|asset fingerprint (as
   *     {@link matrixCacheByDataset}). `member_positions` is layout-derived,
   *     so a reflow or an add/remove that moves placement bumps the epoch
   *     and must recompute `positions`.
   *   - `manifestRef` — the `ds.manifest` object reference. The manifest
   *     maps derive from `ds.manifest`, which is swapped for a NEW object
   *     when progressively-generated coarse/downsampled levels merge in —
   *     a manifest change that carries no epoch bump. Reference identity is
   *     the reliable change signal for that path, so a stale entry can
   *     never serve outdated `imageSpecById` / `parentByEntityId` (and the
   *     wrong level-of-detail set) after a new level arrives.
   * On any mismatch all three inputs are recomputed and re-stored with the
   * current epoch key and manifest reference. A manifest swap under an
   * unchanged epoch also recomputes `positions`, which is harmless — it
   * comes from the scene and is consistent within the tick.
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
   * reconstructed `image_id → EntitySnapshot` map, plus the basis it was
   * built against. The next replan asks the scene for a `view_query_delta`
   * and folds it onto `map` (deleting `left`, upserting `entered` ∪
   * `changed`) instead of parsing the full visible set — the O(delta) win on
   * a camera move.
   *
   * # Why a per-record projection map
   *
   * A delta reports only the *quantized* projection
   * (`{ membership, visible, target_level, kind }`) of each record. The
   * fold is safe to feed the planner because every active-set input is
   * either in that quantized set (`visible`, and the target level with the
   * level pin folded in by the core, so a zoom or a pin edit that moves a
   * level arrives as a `changed` record) or in the cursor basis below (the
   * manifest join for `levels` and `coarseLevel`). The active set never
   * reads the continuous `projected_diagonal_px`, which the delta does NOT
   * track.
   *
   * # Cursor lifecycle (silent-wrong-data guard)
   *
   * The scene holds the matching Rust cursor; the two MUST advance together.
   *   - `scene`: a reconstructed `WasmScene` starts with an empty Rust cursor
   *     (it is `#[serde(skip)]`), so its first `view_query_delta` is a Full.
   *     Any cursor held here belongs to the prior scene, so a scene-identity
   *     change drops every entry — folding a delta against a foreign cursor
   *     would ship wrong tiles.
   *   - `basis`: the record shape a delta does NOT re-report depends on the
   *     manifest join, which can move WITHOUT a structural epoch bump (a
   *     progressively-merged level swaps the manifest object) and is no
   *     trigger for the Rust delta, so a record absent from the delta would
   *     keep a stale `levels`/`coarseLevel`. Invalidating the cursor when the
   *     basis changes forces a reseed from the full query with the new basis.
   * A dropped entry means the next fold has no prior; the fold then reseeds
   * from the full `view_query` at that same tick (matching the Rust cursor,
   * which the delta call just advanced), so a Delta is never folded against a
   * missing base.
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
   * Datasets whose worker-side cold state is known to hold exactly this
   * coordinator's `previousActiveSet` — the precondition for a view-move delta.
   * Set after a full cold state (or a delta) lands; a delta keeps it set because
   * the worker's reconstructed active set equals the new `result.activeSet`. The
   * scrub / display fast paths never change the active set, so they leave it set.
   * Cleared on dataset removal so a re-added dataset re-syncs with a full send.
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
    // Opens the `plan` phase: everything from here to the submit that hands
    // the wanted set to the scheduler, synchronous wasm calls included. Not a
    // separate timing source — one recorder, one clock, so plan time is
    // comparable with the phases downstream of it.
    traceRecorder.markPlanStart();

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
      this.serveCachedTelemetry(tickStart);
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
    // A pure view move (pan / zoom / orbit): only the camera moved, so T/Z/C,
    // the channel set, per-channel display state, and layout are all unchanged
    // and the active set is a pure function of the new view. This is the sole
    // gate for the view-move cold-state delta — anything bundled with the view
    // change (a selection edit, a structural change) fails it and takes the full
    // rebuild, so the delta's retained descriptors are always safe.
    const viewOnly = !structural && causes.length === 1 && causes[0] === "view";

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
      this.serveCachedTelemetry(tickStart);
      return this.cachedResult;
    }

    // Selection-scrub fast path — a pure T-scrub or Z-plane move in the 2D
    // slice view, with the visible set, per-entity geometry/LOD, matrices, and
    // display state all unchanged. Because only the selection epoch moved (the
    // caller's `selectionOnly` gate), the view/content/layout inputs the active
    // set derives from are byte-identical, so the roster and residency shape are
    // unchanged; only the top-level currentT/currentZ (and, on a Z move, the
    // visible region) differ. Re-plan + submit to fetch the new T/Z's chunks,
    // but push a compact selection patch to the worker instead of rebuilding and
    // re-transmitting the O(active-set) descriptor array — and reuse the cached
    // roster. Any change beyond a pure scrub fails the proof inside and falls
    // through to the full rebuild.
    if (
      selectionOnly &&
      this.tryScrubOnlyUpdate({
        ctx, currentEpochs, settings, multiChannel, tickStart,
        minimapPendingFetch, planningConfig,
      })
    ) {
      this.serveCachedTelemetry(tickStart);
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

    const memberRoster = new Map<string, MemberRosterEntry[]>();
    const entityIndexByDataset = new Map<string, Map<string, number>>();
    const plannedDatasets: PlannedDataset[] = [];

    for (const [dsId, ds] of ctx.datasets) {
      // Skip invisible datasets.
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) continue;

      // Compute-or-reuse the camera-independent snapshot inputs (parsed
      // `member_positions` + the two manifest maps). The entry is valid only
      // when BOTH the placement epoch fingerprint AND the `ds.manifest`
      // object reference are unchanged: `member_positions` is layout-derived
      // (a reflow bumps the epoch), while the two manifest maps track
      // `ds.manifest`, which is swapped for a new object — with no epoch bump
      // — when progressively-generated levels merge in. A pure view move
      // leaves both stable, so the whole entry is reused across the
      // interaction hot path; any mismatch recomputes all three and re-stores
      // the fresh key + manifest reference (recomputing `positions` on a
      // manifest-only swap is harmless — the scene reports it consistently
      // within the tick). Mirrors `matrixCacheByDataset` below.
      const snapshotInputEpochKey =
        `${currentEpochs.content}|${currentEpochs.layout}|${currentEpochs.asset}`;
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
      // plans first (ADR 0023).
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
      // Capture what the worker currently holds BEFORE `nextState` overwrites it
      // — the view-move delta diffs the fresh active set against this.
      const previousActiveSet = planningStateForDataset.previousActiveSet;
      const result = this.planFn(snapshot, planningStateForDataset, planningConfig);
      this.planningState.set(dsId, result.nextState);
      this.requestEpoch = result.epochs.request;
      this._lastVisibleRegion.set(dsId, visibleRegion);
      this._lastEntities.set(dsId, entities);
      emitViewerInterestHint(ctx, dsId, selection, visibleRegion, result.requests, this.requestEpoch);

      // The trace's per-tick aggregate, recorded from the same plan and
      // before the same side-effects — but unconditionally, because
      // recording does not wait for somebody to open a panel (ADR 0049).
      recordPlanningTick(dsId, result, ctx.cpuCache.levelResidency());


      plannedDatasets.push({
        dsId,
        dsSettings,
        snapshot,
        entities,
        visibleRegion,
        selection,
        result,
        previousActiveSet,
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

      // 3d. Build member roster + per-entity matrix map in one walk. Reuse
      // layout-derived tile matrices across a view move via a per-dataset cache
      // invalidated whenever placement changes (content/layout/asset epoch).
      const matrixEpochKey =
        `${currentEpochs.content}|${currentEpochs.layout}|${currentEpochs.asset}`;
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

      // View-move fast path: the active set genuinely changed (tiles scroll
      // in/out, LODs change) but only the camera moved, and the worker holds
      // exactly this coordinator's `previousActiveSet`. Diff and ship only the
      // delta instead of rebuilding + re-cloning the whole O(active-set)
      // descriptor array. Any other case (first sync, a bundled selection/
      // structural change) falls through to the full send below.
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
          entities,
          selection,
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
        // The worker rebuilds its descriptor buffer from the reordered active
        // set in the SAME canonical order this walks, so the indices agree.
        entityIndexByDataset.set(
          dsId,
          computeActiveSetIndexMap(result.activeSet, selection.visibleChannels, multiChannel),
        );
        this.uploader.sendViewHotStateFromMembersIfAdvanced({
          ctx,
          datasetId: dsId,
          memberIds: iterateActiveSetMembers(
            result.activeSet, selection.visibleChannels, multiChannel,
          ),
          epochs: result.epochs,
        });
      } else {
        // Full send. Drives atlas creation/remap + wanted-set + descriptor
        // buffer build; dsSettings bakes per-channel display state into
        // descriptors. Marks the dataset synced so a later pure view move can
        // take the delta path against this active set.
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
        this.coldStateSyncedDatasets.add(dsId);
      }

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

    // Stamp the coalescing anchor at rebuild COMPLETION. The window then
    // measures idle time since the rebuild finished, so coalescing engages
    // for the next interactive frame regardless of how long this rebuild
    // took — the property that makes the fast-path effective on a wide
    // collection, where a single rebuild can exceed the window on its own.
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
    // mode, render mode, level pin, channel visibility, …) unchanged;
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
   * The selection-scrub fast path. Fires only when it can PROVE the sole
   * change since the last rebuild is a pure T-scrub and/or Z-plane move in the
   * 2D slice view — the visible set, per-entity geometry/LOD, matrices, and
   * per-channel display state are all unchanged. `currentT`/`currentZ` are
   * top-level cold-state scalars (never part of a per-entity descriptor), so on
   * a pure scrub the whole descriptor array is byte-identical; only the top
   * scalars (and, on a Z move, the visible region) differ.
   *
   * Unlike {@link tryDisplayOnlyUpdate}, a scrub needs different chunks, so this
   * still runs the planner and `cpuCache.submit` to fetch the new T/Z's keys —
   * it only skips the O(active-set) descriptor rebuild + roster rebuild + full
   * cold-state resend, pushing a compact selection patch to the worker (which
   * re-ingests its retained cold state at the new selection) and reusing the
   * cached roster.
   *
   * Correctness rests on the caller's `selectionOnly` gate: only the selection
   * epoch moved, so the view/content/layout/asset inputs the active set is a
   * pure function of are byte-identical — the roster and residency shape are
   * provably unchanged, which is why the cached roster can be reused.
   *
   * Conservative by construction: it is scoped to slice mode, requires an
   * actual T or Z move, and any other difference (a display edit, a bundled
   * label/blend/visibility change, a channel change, a z-range WIDTH change such
   * as a slab extension, a new/dropped dataset, a layer reorder, or a field
   * added later) fails the proof and the caller falls through to a full rebuild.
   *
   * Returns `true` when it fully handled the tick (caller serves the cached
   * result); `false` when the change is not a provable pure scrub or nothing
   * scrubbed. On `false` no worker message is sent and no fetch is submitted.
   */
  private tryScrubOnlyUpdate(args: {
    ctx: TickContext;
    currentEpochs: SceneEpochs;
    settings: SceneSettings;
    multiChannel: boolean;
    tickStart: number;
    minimapPendingFetch: Map<string, MinimapChunkCoord[]>;
    planningConfig: PlanningConfig;
  }): boolean {
    const { ctx, currentEpochs, settings, multiChannel, minimapPendingFetch, planningConfig } = args;
    if (
      this.cachedResult === null ||
      this.lastRebuildScalars === null ||
      this.lastRebuildByDataset.size === 0
    ) {
      return false;
    }

    // Scoped to the 2D slice view: a Z-plane move is a slice-view concept, and
    // the volume path's proxy residency keys on T in ways this compact patch is
    // deliberately not trying to cover. Volume T changes fall through to the
    // full rebuild.
    const scalars = this.lastRebuildScalars;
    const mode = ctx.mode as "slice" | "volume";
    if (mode !== "slice" || scalars.mode !== "slice") return false;

    // C, multi-channel, layer order, and the visible-dataset set must be
    // unchanged — each changes the member shape or roster and needs a real
    // rebuild. (T is the scrub axis; Z is proven per-dataset via the z-range.)
    if (ctx.scene.c() !== scalars.c) return false;
    if (multiChannel !== scalars.multiChannel) return false;
    if (JSON.stringify(settings.layerOrder) !== this.lastLayerOrderKey) return false;
    const sceneC = scalars.c;

    let visibleCount = 0;
    for (const [dsId, dsSettings] of Object.entries(settings.allSettings)) {
      if (!dsSettings.visible) continue;
      visibleCount++;
      if (!this.lastVisibleDatasetIds.has(dsId)) return false;
    }
    if (visibleCount !== this.lastVisibleDatasetIds.size) return false;

    const newT = ctx.scene.t();
    const newZ = ctx.scene.z();
    let anyScrub = newT !== scalars.t;

    // Per-dataset precheck (no side effects). Prove for every planned dataset:
    // still visible; non-display settings fingerprint unchanged (label state,
    // blend mode, render mode, level pin, channel visibility, …);
    // display state unchanged (a bundled display edit falls through so both
    // edits settle via the full rebuild); visible-channel set unchanged; and
    // the z-range WIDTH unchanged (a same-width shift is a plane move; a widen
    // is a slab extension that changes which chunks/entities are wanted and
    // must rebuild). A within-width z shift is the Z-scrub signal. The cached
    // active set / entities / visible region needed to regenerate requests must
    // all still be present, or the fast path bails to the full rebuild.
    interface ScrubDataset {
      dsId: string;
      dsSettings: DatasetSettings | undefined;
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
      const visibleChannels = computeVisibleChannels(multiChannel, dsSettings, sceneC);
      if (!numberArraysEqual(visibleChannels, sig.visibleChannels)) return false;
      const displayState = buildDisplayStateByChannel(visibleChannels, dsSettings);
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
        dsId, dsSettings, visibleChannels, planningState, entities, cachedRegion,
        newZRange: zRange,
      });
    }
    // Nothing actually scrubbed — let the caller fall through (a genuine cache
    // hit / display path already handled the no-op display case).
    if (!anyScrub) return false;

    // Regenerate ONLY the changed-T/Z chunk requests. The pure-scrub premise
    // (only the selection epoch moved) makes the active set, entities, and
    // camera-derived visible region byte-identical to the last rebuild, so the
    // requests are re-emitted from the cached active set + a snapshot whose only
    // difference is the new selection (and, on a Z move, the new z-range read
    // via one cheap `visible_region` call). This skips the O(N)
    // `view_query`/`member_positions` serde AND `buildActiveSet` — the dominant
    // remaining boundary cost — while producing exactly the requests a full
    // `plan()` would for the new T/Z. `assetCatalog.snapshot()` is dataset-
    // agnostic, so one shared snapshot serves every dataset's proxy budgeting.
    const scrubRequestEpoch = currentEpochs.request + 1;
    const scrubEpochs: SceneEpochs = { ...currentEpochs, request: scrubRequestEpoch };
    const assetCatalog = ctx.assetCatalog.snapshot();
    interface ScrubPlanned {
      dsId: string;
      dsSettings: DatasetSettings | undefined;
      snapshot: PlanningSnapshot;
      visibleRegion: VisibleRegion;
      selection: SelectionState;
      planningState: PlanningState;
      requests: ChunkRequest[];
      proxyRequests: ProxyRequest[];
      stats: PlanStats;
    }
    const planned: ScrubPlanned[] = perDataset.map((pd) => {
      const visibleRegion: VisibleRegion = {
        ...pd.cachedRegion,
        zRangeVox: pd.newZRange,
      };
      const selection: SelectionState = {
        t: newT,
        c: sceneC,
        z: newZ,
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
        assetCatalog,
        minimapPending: minimapPendingFetch,
      };
      const stats = emptyPlanStats();
      const { requests, proxyRequests } = emitPlanRequests(
        pd.planningState.previousActiveSet,
        snapshot,
        stats,
        planningConfig,
        pd.planningState.zoomDirection,
      );
      return {
        dsId: pd.dsId,
        dsSettings: pd.dsSettings,
        snapshot,
        visibleRegion,
        selection,
        planningState: pd.planningState,
        requests,
        proxyRequests,
        stats,
      };
    });

    // Budget proxy residency once (fresh keys for the new selection).
    const proxyResidency = planProxyResidencyForInputs({
      inputs: planned.map((p) => ({
        snapshot: p.snapshot,
        activeSet: p.planningState.previousActiveSet,
        proxyRequests: p.proxyRequests,
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

    // Commit. Advance the fetch lifecycle exactly once (the delivery ledger is
    // cleared because the worker repacks its atlas indirection for the new T/Z,
    // so the new plane/timepoint's chunks must be re-delivered), then per
    // dataset: submit the new fetch, push the compact selection patch, and
    // refresh carry-forward state so a later full rebuild is coherent. The
    // active set is unchanged, so `planningState` is deliberately left as-is.
    ctx.cpuCache.onPlanRebuildStart();
    for (const p of planned) {
      this.requestEpoch = scrubRequestEpoch;
      this._lastVisibleRegion.set(p.dsId, p.visibleRegion);

      emitViewerInterestHint(
        ctx, p.dsId, p.selection, p.visibleRegion, p.requests, this.requestEpoch,
      );

      const budgetedProxyRequests = proxyRequestsByDataset.get(p.dsId) ?? [];
      this._lastPlanByDataset.set(p.dsId, {
        requests: p.requests,
        activeSet: p.planningState.previousActiveSet,
        epochs: scrubEpochs,
        proxyRequests: budgetedProxyRequests,
        stats: p.stats,
        nextState: p.planningState,
      });

      // Categorical label overlays follow the plane/timepoint too — merge their
      // synthesized requests exactly as the full rebuild does.
      const labelRequests = computeLabelChunkRequests({
        datasetId: p.dsId,
        manifest: ctx.datasets.get(p.dsId)!.manifest,
        t: p.selection.t,
        z: p.selection.z,
        labelSettings: p.dsSettings?.label_settings,
        mode,
      });
      const requestsWithLabels =
        labelRequests.length > 0
          ? [...p.requests, ...labelRequests]
          : p.requests;

      ctx.cpuCache.submit({
        requests: requestsWithLabels,
        activeSet: p.planningState.previousActiveSet,
        proxyRequests: budgetedProxyRequests,
        epochs: scrubEpochs,
        stats: p.stats,
        nextState: p.planningState,
      });

      this.uploader.sendColdStateSelection({
        ctx,
        datasetId: p.dsId,
        currentT: p.selection.t,
        currentZ: p.selection.z,
        visibleRegion: p.visibleRegion,
        desiredProxyKeys: desiredProxyKeysByDataset.get(p.dsId) ?? new Set(),
        epochs: scrubEpochs,
      });

      // Refresh the display-only fast-path signature's z-range so a subsequent
      // display edit compares against the scrubbed value; the display state,
      // channels, and non-display fingerprint were proven unchanged above.
      const scrubSig = this.lastRebuildByDataset.get(p.dsId);
      if (scrubSig) scrubSig.zRangeVox = p.visibleRegion.zRangeVox;
    }

    // Reuse the cached roster + entity index (identical on a pure scrub);
    // refresh only the epochs it carries. Advance the scrubbed T scalar and the
    // epoch/coalescing anchors so a later display edit / pan / zoom compares
    // against the scrubbed state.
    const outputEpochs: SceneEpochs = { ...currentEpochs, request: this.requestEpoch };
    this.lastEpochs = outputEpochs;
    this.cachedResult = { ...this.cachedResult, settings, epochs: outputEpochs };
    this.lastRebuildScalars = { ...scalars, t: newT };
    this.lastRebuildAt = performance.now();
    this.pendingDeferredRebuild = false;
    return true;
  }

  /**
   * Reconstruct a dataset's `entities` incrementally by folding the scene's
   * `view_query_delta` onto the per-dataset cursor, instead of parsing the
   * full visible set. Returns the entity array on success, `"skip"` when the
   * dataset is not registered (the scene reports `null`, exactly as the full
   * `view_query` path skips it).
   *
   * Called only from the full-rebuild path. `deps` is the same
   * manifest/placement join the full builder uses; `inputsRef` is the
   * identity of the cached snapshot-inputs entry `deps` came from (the
   * cursor's manifest/placement basis).
   *
   * Correctness: the returned array reconstructs the SAME snapshot a fresh
   * full build produces, on the render-affecting projection
   * ({@link EntitySnapshot} `visible` / `targetLevel` / `kind` /
   * `coarseLevel` / `parentId`, keyed by `image_id`). Records in `entered` /
   * `changed` are freshly assembled this tick, so a record whose target level
   * moved carries its new `targetLevel`; a carried-over record was assembled
   * on a prior tick with a basis proven identical (scene identity +
   * `basisInputs`), so its quantized and manifest-derived fields match a
   * fresh build. Continuous fields (`importance` /
   * `projectedDiagonalPx` / `projectedAreaPx2` / `centroidWorld`) may be
   * stale on a carried-over record. That is intended, and they are never an
   * active-set input.
   */
  private foldViewDeltaEntities(
    scene: TickContext["scene"],
    datasetId: string,
    deps: SnapshotEntityDeps,
    inputsRef: object,
  ): EntitySnapshot[] | "skip" {
    // Scene-identity guard. A reconstructed scene starts with an empty Rust
    // cursor, so any cursor held here belongs to a scene that no longer
    // exists; drop all of them before folding against the new scene.
    if (scene !== this.viewDeltaScene) {
      this.viewDeltaCursor.clear();
      this.viewDeltaScene = scene;
    }

    const deltaJson = scene.view_query_delta(datasetId);
    // Advancing the Rust cursor and skipping are mutually exclusive: a `null`
    // means the dataset is unknown and the Rust cursor was NOT advanced, so
    // dropping our cursor keeps the two consistent for a later re-add.
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

    // Drop-on-throw invariant: `view_query_delta` above already advanced the
    // Rust cursor to this tick's state, but the map build below is fallible —
    // `makeEntitySnapshot` throws on a producer-invariant violation (a Tile
    // with no parent edge). Advancing the Rust cursor and setting the TS cursor
    // must not straddle that fallible build without a drop on throw: if a throw
    // left the TS cursor holding the PRIOR tick's map, the next tick would fold
    // a Delta onto that stale base and silently drop this tick's
    // entered/left/changed forever (the offending record is now
    // quantized-stable in the Rust cursor, so it never re-throws). On a throw,
    // drop the entry so the next tick reseeds from the full query (matching the
    // already-advanced Rust cursor), then rethrow so the failure stays loud —
    // exactly as the non-folding full path throws every tick.
    try {
      let next: Map<string, EntitySnapshot>;
      if (prev === null && "Delta" in delta) {
        // The Rust cursor is ahead of this consumer (a new coordinator against
        // a persisting scene, or a basis change), so the delta reports changes
        // since a base we never held and cannot be folded. Reseed from the
        // authoritative full query at this same tick: the delta call above just
        // advanced the Rust cursor to this tick's quantized state, so a
        // snapshot built from the full query now matches it and the next delta
        // folds.
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
   * Build a fresh `image_id → EntitySnapshot` map from the full `view_query`,
   * via the same {@link makeEntitySnapshot} the fold uses. Returns `null`
   * when the dataset is unknown (scene reports `null` / no visible set) — the
   * caller treats that as skip. Used to seed the fold cursor when a delta
   * cannot be folded (no matching prior).
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
    // Drop the skip-decision signature so a fast path can never reuse a
    // removed dataset's roster. (It is also rebuilt from scratch on the
    // next full rebuild.)
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
      nextState: initialPlanningState(),
    });
  }
}
