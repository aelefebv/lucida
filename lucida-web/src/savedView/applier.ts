// Apply a `SavedView` to the live scene. Async, deep module.
//
// Apply flow at the recipient:
//
//   1. Parse + validate (the encoder did this; we accept a parsed SavedView)
//   2. Diff datasets. Source-url mode computes DatasetId for each URL
//      via blake3 and opens missing datasets. Workspace-dataset-id mode
//      treats ids as already-loaded workspace members and never opens
//      hidden source URLs.
//   3. In source-url mode, open missing via bridge.sendOpenRemoteDataset(url).
//   4. Wait for DatasetOpened to come back via CommandBroadcast.
//   5. For currently-loaded datasets NOT in the link, send
//      SetDatasetVisible(false) — a ViewportCommand (recipient-only).
//   6. Apply SetActiveLayout for any dataset where the link's layout
//      differs from the live scene when document layout mutation is
//      allowed. Workspace viewers skip this shared document mutation.
//   7. SetDatasetOrder, then per-dataset SetDatasetVisible/Opacity/contrast/
//      gamma/blend/render mode/per-channel colormap+contrast+gamma.
//   8. SetContrast / SetGamma / SetMultiChannel.
//   9. SetT / SetC / SetZRange — clamp out-of-range to fit the
//      recipient's datasets, with a non-blocking "adjusted to fit" notice.
//  10. Camera last (via import_presence so it goes through one mutator).
//
// Every apply owns a monotonically increasing epoch. Completion is observable
// through `subscribeApplySettled` / `waitForSettlement`; consumers sequence
// follow-up work from that event instead of inferring completion from timers.
// Per-step status is broadcast to subscribers (the loading banner) so users
// see "loading 2 of 4 datasets…".

import type { WasmScene } from "lucida-core";
import type { DocumentCommand, ViewportCommand } from "../commands.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import type {
  Camera,
  DatasetDisplaySettings,
  DatasetId,
  DatasetReferenceMode,
  LayoutId,
  SavedView,
  ChannelSettings,
  LabelSettings,
} from "./types.ts";
import { validateSavedView } from "./encoder.ts";

// Public types

export interface ApplierBridge {
  /** Send `OpenRemoteDataset { url }` over the WebSocket. */
  sendOpenRemoteDataset: (url: string) => string | null;
  /** Send a document command (broadcast to peers). */
  sendCommand: (json: string) => void;
}

/** Per-URL outcome of the open phase. */
export interface OpenStatus {
  url: string;
  /** "pending" while waiting for DatasetOpened; "ok" on success;
   *  "error" if OpenDatasetFailed came back. */
  state: "pending" | "ok" | "error";
  error?: string;
}

export interface ApplierState {
  /** True between `apply` start and resolution (success or fail). */
  inProgress: boolean;
  /** Per-URL status for the dataset-opening phase, or empty when idle. */
  openStatuses: ReadonlyArray<OpenStatus>;
  /** Total count and ok-count to drive "X of Y" progress. */
  totalToOpen: number;
  okOpened: number;
  /** True on at least one OpenDatasetFailed. Drives the partial-failure UI. */
  anyOpenFailed: boolean;
  /** Non-fatal apply warnings, such as missing workspace dataset ids or
   * skipped shared layout changes for viewer-role applies. */
  warnings: readonly string[];
  /** Epoch currently mutating the scene, or null while settled. */
  activeEpoch: number | null;
  /** Most recently settled epoch (success, unavailable, or failure). */
  settledEpoch: number;
}

export type StateListener = (s: ApplierState) => void;

export interface ApplierEventChannels {
  /** Called when the bridge's `onCommand` handler sees a DatasetOpened
   * for a URL we requested. Returns the dataset_id for matching purposes. */
  notifyDatasetOpened: (datasetId: string) => void;
  notifyOpenFailed: (url: string, error: string) => void;
}

/** After-apply summary used by callers (App.tsx) to resolve UI-focus
 *  state that lives outside the WASM scene. The selected-dataset
 *  wrinkle ([[wiki/queue]] 2026-05-07) is resolved option (c):
 *  auto-select the first visible dataset on apply so dimension/contrast
 *  side-panel controls operate on something the recipient can see. */
export interface ApplyResult {
  /** Datasets visible after apply (in `dataset_order` order; visibility
   *  derived from the post-apply scene state). Empty when nothing's loaded. */
  visibleDatasetIds: string[];
  /** First entry of `visibleDatasetIds`, or null. Convenience for the
   *  selectedDatasetId wrinkle (option c). */
  firstVisibleDatasetId: string | null;
}

export type ApplyResultListener = (r: ApplyResult) => void;

/** Fires once after every successfully applied `apply()`, after the
 *  inProgress flag flips back to false.
 *  Subscribers can read post-apply scene state via the live `getScene()`
 *  passed to the applier. Used in `useSavedViewSync` to mark the render
 *  loop dirty + bump the dataset-settings generation + push post-apply
 *  C/T/Z back to React state (since the applier writes to WASM only). */
export type ApplyCompleteListener = (view: SavedView) => void;

export type ApplySettlementStatus = "applied" | "unavailable" | "failed";

/** One immutable completion record per apply generation. */
export interface ApplySettlement {
  epoch: number;
  status: ApplySettlementStatus;
  /** The validated, default-restored view. Absent only when validation failed. */
  view?: SavedView;
  result?: ApplyResult;
  error?: unknown;
}

export type ApplySettledListener = (event: ApplySettlement) => void;

// Implementation

const IDLE_STATE: ApplierState = {
  inProgress: false,
  openStatuses: [],
  totalToOpen: 0,
  okOpened: 0,
  anyOpenFailed: false,
  warnings: [],
  activeEpoch: null,
  settledEpoch: 0,
};

interface PendingOpen {
  url: string;
  finish: (state: "ok" | "error", error?: string) => void;
}

interface DatasetWaiter {
  check: () => void;
  cancel: () => void;
}

interface ApplyContext {
  epoch: number;
  /** Dataset ids whose arrival is part of this apply generation. Session-side
   * auto-fit correlation consults this set instead of a global busy flag. */
  ownedDatasetIds: Set<string>;
  pendingByDatasetId: Map<string, PendingOpen>;
  pendingByUrl: Map<string, string>;
  datasetWaiters: Set<DatasetWaiter>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

interface ViewportCheckpoint {
  presence: string;
  datasetPresence: string;
}

function workspaceDatasetIdsForView(view: SavedView): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const id of view.dataset_order) add(id);
  for (const id of Object.keys(view.dataset_settings)) add(id);
  for (const id of Object.keys(view.active_layouts)) add(id);
  for (const id of Object.keys(view.auto_contrast ?? {})) add(id);

  return out;
}

function workspaceMissingDatasetWarnings(
  loadedIds: Set<string>,
  requestedIds: Set<string>,
): string[] {
  const missing = Array.from(requestedIds).filter((id) => !loadedIds.has(id));
  if (missing.length === 0) return [];
  const warning = `Workspace view references ${missing.length} missing dataset(s): ${missing.join(", ")}`;
  console.warn(`[SavedViewApplier] ${warning}`);
  return [warning];
}

export class SavedViewApplier {
  private state: ApplierState = IDLE_STATE;
  private listeners = new Set<StateListener>();
  private applyResultListeners = new Set<ApplyResultListener>();
  private applyCompleteListeners = new Set<ApplyCompleteListener>();
  private applySettledListeners = new Set<ApplySettledListener>();
  private activeContext: ApplyContext | null = null;
  private nextEpoch = 1;
  private settlements = new Map<number, ApplySettlement>();
  private settlementWaiters = new Map<number, Set<(event: ApplySettlement) => void>>();
  private readonly bridge: ApplierBridge;
  private readonly getScene: () => WasmScene | null;
  private readonly datasetIdForUrl: (url: string) => string;
  private readonly datasetReferenceMode: DatasetReferenceMode;
  private readonly allowDocumentLayoutMutation: boolean;
  private readonly openTimeoutMs: number;
  /** Resolves per-dataset T/C extents for clamping (Z comes from the
   *  scene's volume shape). Optional: when absent, t/c pass through
   *  unclamped — see `clampViewIndices`. */
  private readonly dimensionExtentsFor?: DimensionExtentsResolver;
  /** Resolves the recipient's CURRENT label names (manifest order) for a
   *  dataset, so per-label settings in an applied view are keyed by label
   *  name+occurrence rather than raw index. Optional: when absent, per-label
   *  settings apply positionally (legacy). */
  private readonly labelNamesFor?: LabelNamesResolver;

  constructor(
    bridge: ApplierBridge,
    /** A function returning the live `WasmScene`, or null if not yet loaded. */
    getScene: () => WasmScene | null,
    /** Derive a `DatasetId` from a URL — usually the wasm `dataset_id_for_url`,
     * but injectable for tests so they don't need WASM init. */
    datasetIdForUrl: (url: string) => string,
    /** ms after which a queued open is considered failed (default 30 s). */
    openTimeoutMs: number = 30_000,
    datasetReferenceMode: DatasetReferenceMode = "source-url",
    allowDocumentLayoutMutation: boolean = true,
    /** Resolves the recipient's per-dataset T/C extents so out-of-range
     *  timepoint/channel indices in an applied view clamp to fit. Z is
     *  always derived from `dataset_volume_shape`; this only adds T/C.
     *  Optional — omit (e.g. in tests) to leave t/c unclamped. */
    dimensionExtentsFor?: DimensionExtentsResolver,
    /** Resolves the recipient's current label names (manifest order) per
     *  dataset so per-label settings restore by name+occurrence. Optional —
     *  omit (e.g. in tests) to leave per-label settings positional. */
    labelNamesFor?: LabelNamesResolver,
  ) {
    this.bridge = bridge;
    this.getScene = getScene;
    this.datasetIdForUrl = datasetIdForUrl;
    this.datasetReferenceMode = datasetReferenceMode;
    this.allowDocumentLayoutMutation = allowDocumentLayoutMutation;
    this.openTimeoutMs = openTimeoutMs;
    this.dimensionExtentsFor = dimensionExtentsFor;
    this.labelNamesFor = labelNamesFor;
  }

  // State subscription (used by LoadingViewBanner)

  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Subscribe to a one-shot summary fired once at the end of every
   *  successful (or partial-failure) `apply()`. The selectedDatasetId
   *  wrinkle resolution (option c) consumes this in `useSavedViewSync`. */
  subscribeApplyResult(fn: ApplyResultListener): () => void {
    this.applyResultListeners.add(fn);
    return () => { this.applyResultListeners.delete(fn); };
  }

  /** Subscribe to a compatibility "apply done" event fired once after every
   *  successful apply, after WASM mutations and settlement. Subscribers
   *  read post-apply scene state via the same `getScene()` the applier
   *  uses; the render-loop and React-side dim mirrors get refreshed
   *  through this channel (see useSavedViewSync). Distinct from
   *  `subscribeApplyResult` (which is about UI focus / selectedDatasetId). */
  subscribeApplyComplete(fn: ApplyCompleteListener): () => void {
    this.applyCompleteListeners.add(fn);
    return () => { this.applyCompleteListeners.delete(fn); };
  }

  /** Subscribe to the authoritative end of an apply generation. The event is
   * emitted after `inProgress` becomes false, on success, unavailable scene,
   * and failure alike. */
  subscribeApplySettled(fn: ApplySettledListener): () => void {
    this.applySettledListeners.add(fn);
    return () => { this.applySettledListeners.delete(fn); };
  }

  getActiveEpoch(): number | null {
    return this.activeContext?.epoch ?? null;
  }

  /** Resolve from the epoch's settlement event. Safe to call before or after
   * the event; a small bounded cache makes late subscribers deterministic. */
  waitForSettlement(epoch: number): Promise<ApplySettlement> {
    const settled = this.settlements.get(epoch);
    if (settled) return Promise.resolve(settled);
    return new Promise((resolve) => {
      let waiters = this.settlementWaiters.get(epoch);
      if (!waiters) {
        waiters = new Set();
        this.settlementWaiters.set(epoch, waiters);
      }
      waiters.add(resolve);
    });
  }

  getState(): ApplierState {
    return this.state;
  }

  /** Whether a `dataset_opened` event for `datasetId` belongs to the active
   * apply generation. This is an ownership relationship, not a timing guess:
   * unrelated user opens during a restore remain eligible for their normal
   * auto-fit policy. */
  ownsDatasetOpen(datasetId: string): boolean {
    return this.activeContext?.ownedDatasetIds.has(datasetId) ?? false;
  }

  /** Bridge-side hook: call this from the bridge's `onCommand` handler when
   * a DatasetOpened broadcast arrives. */
  notifyDatasetOpened(datasetId: string): void {
    const context = this.activeContext;
    if (!context) return;
    const entry = context.pendingByDatasetId.get(datasetId);
    entry?.finish("ok");
    for (const waiter of [...context.datasetWaiters]) waiter.check();
  }

  /** Bridge-side hook: call this from the bridge's `onOpenDatasetFailed`
   * handler when a per-URL failure arrives. */
  notifyOpenFailed(url: string, error: string): void {
    const context = this.activeContext;
    if (!context) return;
    const datasetId = context.pendingByUrl.get(url);
    if (!datasetId) return;
    const entry = context.pendingByDatasetId.get(datasetId);
    if (!entry) return;
    entry.finish("error", error);
  }

  // Main entry point

  /**
   * Apply a SavedView to the live scene. Returns when all in-flight
   * commands are dispatched and the camera has been imported. Resolves
   * even on partial dataset-open failure (the loading banner shows the
   * indicator).
   */
  async apply(untrustedView: SavedView): Promise<ApplySettlement> {
    if (this.activeContext) {
      throw new Error("SavedViewApplier.apply: another apply already in progress");
    }
    const context: ApplyContext = {
      epoch: this.nextEpoch++,
      ownedDatasetIds: new Set(),
      pendingByDatasetId: new Map(),
      pendingByUrl: new Map(),
      datasetWaiters: new Set(),
      timers: new Set(),
    };
    this.activeContext = context;
    this.setState({
      ...IDLE_STATE,
      inProgress: true,
      activeEpoch: context.epoch,
      settledEpoch: this.state.settledEpoch,
    });
    let view: SavedView | undefined;
    let result: ApplyResult | undefined;
    let status: ApplySettlementStatus = "failed";
    let failure: unknown;
    try {
      // Runtime preflight is deliberately first. API responses and direct
      // callers can violate the static type; no dataset open or scene mutation
      // happens until every nested optional field and the major version pass.
      view = validateSavedView(untrustedView);
      // Compute requested dataset ids. Global saved views identify
      // datasets by source URL and may open missing datasets. Workspace
      // inline views identify already-loaded workspace datasets by their
      // document/runtime IDs and must not expose source URLs.
      const requestedIds = this.datasetReferenceMode === "source-url"
        ? view.datasets.map((url) => ({
          url,
          id: this.datasetIdForUrl(url),
        }))
        : workspaceDatasetIdsForView(view).map((id) => ({ url: "", id }));
      context.ownedDatasetIds = new Set(requestedIds.map((entry) => entry.id));

      // Snapshot of currently-loaded ids.
      const scene = this.getScene();
      if (!scene) {
        // No scene yet — skip everything that needs it. Caller should
        // re-invoke after the scene is available.
        status = "unavailable";
        return this.finishApply(context, { status, view });
      }
      const loadedIds = new Set<string>(
        JSON.parse(scene.dataset_ids()) as string[],
      );
      const requestedSet = new Set(requestedIds.map((r) => r.id));

      // Step 2-4: open missing.
      const toOpen = this.datasetReferenceMode === "source-url"
        ? requestedIds.filter((r) => !loadedIds.has(r.id))
        : [];
      this.setState({
        ...this.state,
        totalToOpen: toOpen.length,
        openStatuses: toOpen.map((r) => ({ url: r.url, state: "pending" })),
      });
      await this.openMissing(context, toOpen);

      if (this.datasetReferenceMode === "workspace-dataset-id" && requestedSet.size > 0) {
        await this.waitForWorkspaceDatasets(context, requestedSet);
      }

      // Re-read scene after opens (best-effort: if opens raced or some
      // failed, we proceed with whatever's loaded).
      const sceneAfter = this.getScene();
      if (!sceneAfter) {
        status = "unavailable";
        return this.finishApply(context, { status, view });
      }

      // Local viewport state is rollback-capable. Validation above prevents
      // malformed-input failures; this checkpoint also protects against an
      // unexpected scene rejection so a restore never leaves half of its local
      // camera/display/dataset-presence writes behind.
      const localCheckpoint = this.captureLocalCheckpoint(sceneAfter);
      try {
        const loadedAfter = new Set<string>(
        JSON.parse(sceneAfter.dataset_ids()) as string[],
      );
        if (this.datasetReferenceMode === "workspace-dataset-id") {
          for (const warning of workspaceMissingDatasetWarnings(loadedAfter, requestedSet)) {
            this.addWarning(warning);
          }
        }

      // Step 5: hide datasets that are loaded but not in the link
      // (recipient-only, ViewportCommand).
      const shouldHideUnrequested =
        this.datasetReferenceMode === "source-url" || requestedSet.size > 0;
      if (shouldHideUnrequested) {
        for (const id of loadedAfter) {
          if (!requestedSet.has(id)) {
            this.applyViewport(sceneAfter, {
              type: "set_dataset_visible",
              dataset_id: id,
              visible: false,
            });
          }
        }
      }

      // Step 6: SetActiveLayout where the link differs.
      for (const [id, layoutId] of Object.entries(view.active_layouts)) {
        if (!loadedAfter.has(id)) continue;
        const layouts = JSON.parse(sceneAfter.available_layouts(id)) as Array<{
          id: string; active?: boolean;
        }>;
        const currentActive = layouts.find((l) => l.active)?.id;
        const exists = layouts.some((l) => l.id === layoutId);
        if (!exists) {
          console.warn(
            `[SavedViewApplier] dataset ${id} has no layout ${JSON.stringify(layoutId)}; falling back to default`,
          );
          continue;
        }
        if (currentActive !== layoutId) {
          if (!this.allowDocumentLayoutMutation) {
            const warning = `Workspace view expects layout ${JSON.stringify(layoutId)} for dataset ${id}, but active layout is ${JSON.stringify(currentActive)}; leaving shared layout unchanged`;
            console.warn(`[SavedViewApplier] ${warning}`);
            this.addWarning(warning);
            continue;
          }
          this.applyDocument({
            type: "set_active_layout",
            dataset_id: id,
            layout_id: layoutId,
          });
        }
      }

      // Step 7a: SetDatasetOrder (only the loaded subset, in the saved order).
      const filteredOrder = view.dataset_order.filter((id) => loadedAfter.has(id));
      if (filteredOrder.length > 0) {
        this.applyViewport(sceneAfter, {
          type: "set_dataset_order",
          order: filteredOrder,
        });
      }

      // Step 7b: per-dataset display settings.
      for (const [id, s] of Object.entries(view.dataset_settings)) {
        if (!loadedAfter.has(id)) continue;
        this.applyDatasetSettings(sceneAfter, id, s);
      }

      // Step 8: global contrast + gamma + multi-channel.
      this.applyViewport(sceneAfter, {
        type: "set_contrast",
        min: view.display.contrast_min,
        max: view.display.contrast_max,
      });
      this.applyViewport(sceneAfter, {
        type: "set_gamma",
        gamma: view.display.gamma,
      });
      if (view.view.multi_channel !== undefined) {
        this.applyViewport(sceneAfter, {
          type: "set_multi_channel",
          enabled: view.view.multi_channel,
        });
      }

      // Step 9: SetT / SetC / SetZRange — clamp out-of-range indices to
      // fit the recipient's datasets, with a non-blocking notice.
      // `clampViewIndices` narrows this loaded set to the datasets the view
      // addresses + makes visible, so a co-loaded, unreferenced (or hidden)
      // shallow neighbor can't crush the authoritative Z/T/C of the
      // deep/multi-channel dataset the view is actually restoring.
      const clampedDatasets = Array.from(loadedAfter, (id) => ({ url: "", id }));
      const clamped = clampViewIndices(
        sceneAfter,
        clampedDatasets,
        view,
        this.dimensionExtentsFor,
      );
      if (clamped.clamped) {
        // Non-blocking notice via the existing warnings channel (rendered
        // by LoadingViewBanner). Name the axes so the user understands
        // exactly what moved, e.g. "Z adjusted to fit this dataset" or
        // "Z and C adjusted to fit this dataset".
        this.addWarning(clampNotice(clamped.adjustedAxes));
      }
      this.applyViewport(sceneAfter, { type: "set_t", t: clamped.t });
      this.applyViewport(sceneAfter, { type: "set_c", c: clamped.c });
      this.applyViewport(sceneAfter, {
        type: "set_z_range",
        start: clamped.zStart,
        end: clamped.zEnd,
      });

      // Step 10: camera last. Use import_presence so the WASM side
      // reapplies camera+view+display in one go (keeping local viewport).
      this.importCameraView(sceneAfter, view.camera);

      // Selected-dataset wrinkle resolution (option c, [[wiki/queue]]
      // 2026-05-07): emit the post-apply visibility set so consumers
      // can re-target UI focus at something the recipient can see.
      result = this.emitApplyResult(sceneAfter, view);

      // Fires inside the try (before the inProgress flag flips back) so
      // subscribers can read post-apply scene state and trigger render
      // refresh + React-state sync. The applied view is passed so
      // listeners can restore client-only state (e.g. autoContrastMap).
      // See `useSavedViewSync` for usage.
      } catch (error) {
        this.restoreLocalCheckpoint(sceneAfter, localCheckpoint);
        throw error;
      }
      status = "applied";
    } catch (error) {
      failure = error;
    }

    const settlement = this.finishApply(context, {
      status,
      ...(view ? { view } : {}),
      ...(result ? { result } : {}),
      ...(failure !== undefined ? { error: failure } : {}),
    });
    if (failure !== undefined) throw failure;
    return settlement;
  }

  private finishApply(
    context: ApplyContext,
    event: Omit<ApplySettlement, "epoch">,
  ): ApplySettlement {
    if (this.activeContext === context) this.activeContext = null;
    for (const timer of context.timers) clearTimeout(timer);
    context.timers.clear();
    for (const waiter of [...context.datasetWaiters]) waiter.cancel();
    context.datasetWaiters.clear();
    context.pendingByDatasetId.clear();
    context.pendingByUrl.clear();

    const settlement: ApplySettlement = { epoch: context.epoch, ...event };
    this.setState({
      ...this.state,
      inProgress: false,
      activeEpoch: null,
      settledEpoch: context.epoch,
    });
    if (settlement.status === "applied" && settlement.view) {
      for (const fn of this.applyCompleteListeners) fn(settlement.view);
    }
    this.settlements.set(context.epoch, settlement);
    while (this.settlements.size > 16) {
      const oldest = this.settlements.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.settlements.delete(oldest);
    }
    for (const resolve of this.settlementWaiters.get(context.epoch) ?? []) resolve(settlement);
    this.settlementWaiters.delete(context.epoch);
    for (const fn of this.applySettledListeners) fn(settlement);
    return settlement;
  }

  private captureLocalCheckpoint(scene: WasmScene): ViewportCheckpoint | null {
    try {
      return {
        presence: scene.export_presence(),
        datasetPresence: scene.export_dataset_presence(),
      };
    } catch {
      return null;
    }
  }

  private restoreLocalCheckpoint(scene: WasmScene, checkpoint: ViewportCheckpoint | null): void {
    if (!checkpoint) return;
    try {
      guardedSceneCall("import_presence", scene, () => scene.import_presence(checkpoint.presence));
      guardedSceneCall("import_dataset_presence", scene, () =>
        scene.import_dataset_presence(checkpoint.datasetPresence));
    } catch (rollbackError) {
      console.warn("[SavedViewApplier] local rollback failed:", rollbackError);
    }
  }

  /** Read post-apply visibility from the live scene + the just-applied
   *  view's `dataset_order`, then notify subscribers so they can pick a
   *  new selectedDatasetId. */
  private emitApplyResult(scene: WasmScene, view: SavedView): ApplyResult {
    const loaded = new Set<string>(JSON.parse(scene.dataset_ids()) as string[]);
    // Walk dataset_order first so the "first visible" is well-defined
    // (matches the order the recipient will see in the layer panel).
    const visible: string[] = [];
    const seen = new Set<string>();
    const considered = view.dataset_order.length > 0
      ? view.dataset_order
      : Array.from(loaded);
    for (const id of considered) {
      if (!loaded.has(id) || seen.has(id)) continue;
      seen.add(id);
      const settings = view.dataset_settings[id];
      // No per-dataset settings = fall back to "visible" (matches the
      // applier's earlier write of SetDatasetVisible(false) only for
      // datasets explicitly removed from the link).
      const isVisible = settings ? settings.visible !== false : true;
      if (isVisible) visible.push(id);
    }
    // Defensive: catch loaded ids the order didn't list (rare; e.g. a
    // dataset opened mid-apply).
    for (const id of loaded) {
      if (seen.has(id)) continue;
      const settings = view.dataset_settings[id];
      const isVisible = settings ? settings.visible !== false : true;
      if (isVisible) visible.push(id);
    }
    const result: ApplyResult = {
      visibleDatasetIds: visible,
      firstVisibleDatasetId: visible[0] ?? null,
    };
    for (const fn of this.applyResultListeners) fn(result);
    return result;
  }

  // Helpers

  private async openMissing(
    context: ApplyContext,
    toOpen: { url: string; id: string }[],
  ): Promise<void> {
    if (toOpen.length === 0) return;

    const promises = toOpen.map((r) => {
      const p = new Promise<void>((resolve) => {
        let settled = false;
        const finish: PendingOpen["finish"] = (state, error) => {
          if (settled || this.activeContext !== context) return;
          settled = true;
          clearTimeout(timer);
          context.timers.delete(timer);
          context.pendingByDatasetId.delete(r.id);
          context.pendingByUrl.delete(r.url);
          this.updateOpenStatus(r.url, state, error);
          if (state === "ok") {
            this.setState({ ...this.state, okOpened: this.state.okOpened + 1 });
          } else {
            this.setState({ ...this.state, anyOpenFailed: true });
            console.warn(`[SavedViewApplier] open failed: ${r.url}: ${error ?? "unknown"}`);
          }
          resolve();
        };
        const timer = setTimeout(() => finish("error", "timeout"), this.openTimeoutMs);
        context.timers.add(timer);
        context.pendingByDatasetId.set(r.id, { url: r.url, finish });
        context.pendingByUrl.set(r.url, r.id);
      });
      try {
        const requestId = this.bridge.sendOpenRemoteDataset(r.url);
        if (requestId === null) {
          context.pendingByDatasetId.get(r.id)?.finish(
            "error",
            "workspace connection is not ready",
          );
        }
      } catch (error) {
        context.pendingByDatasetId.get(r.id)?.finish("error", String(error));
      }
      return p;
    });
    await Promise.all(promises);
  }

  private async waitForWorkspaceDatasets(
    context: ApplyContext,
    requestedSet: Set<string>,
  ): Promise<void> {
    const allLoaded = () => {
      const scene = this.getScene();
      if (!scene) return true;
      const loaded = new Set<string>(JSON.parse(scene.dataset_ids()) as string[]);
      return [...requestedSet].every((id) => loaded.has(id));
    };
    if (allLoaded()) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.timers.delete(timer);
        context.datasetWaiters.delete(waiter);
        resolve();
      };
      const waiter: DatasetWaiter = {
        check: () => {
          if (this.activeContext !== context || allLoaded()) cleanup();
        },
        cancel: cleanup,
      };
      const timer = setTimeout(cleanup, Math.min(this.openTimeoutMs, 5_000));
      context.timers.add(timer);
      context.datasetWaiters.add(waiter);
      waiter.check();
    });
  }

  private applyDocument(cmd: DocumentCommand): void {
    const json = JSON.stringify(cmd);
    const scene = this.getScene();
    if (scene) guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
    this.bridge.sendCommand(json);
  }

  private applyViewport(scene: WasmScene, cmd: ViewportCommand): void {
    guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
  }

  private applyDatasetSettings(
    scene: WasmScene,
    id: string,
    s: DatasetDisplaySettings,
  ): void {
    // Visibility + opacity are the LAYER-PLACEMENT settings (which datasets show
    // and how strongly). They are part of the HEAVY apply only — the light
    // annotation-view restore deliberately leaves them untouched. Everything
    // AFTER these two is the per-dataset/per-channel DISPLAY (colormap, contrast,
    // gamma, blend), shared with the light path via `datasetDisplayCommands`.
    this.applyViewport(scene, { type: "set_dataset_visible", dataset_id: id, visible: s.visible });
    this.applyViewport(scene, { type: "set_dataset_opacity", dataset_id: id, opacity: s.opacity });
    for (const cmd of datasetDisplayCommands(id, s, this.labelNamesFor?.(id))) {
      this.applyViewport(scene, cmd);
    }
  }

  private importCameraView(scene: WasmScene, camera: Camera): void {
    // Camera goes through `import_presence` so the wasm side does all
    // three (camera/view/display) atomically and preserves local viewport.
    // We only want to update the camera shape here — view + display were
    // already applied step-by-step. Pass them through unchanged by reading
    // the live scene.
    const presence = JSON.parse(scene.export_presence()) as {
      camera: Camera;
      view: unknown;
      display: unknown;
    };
    presence.camera = camera;
    guardedSceneCall("import_presence", scene, () => scene.import_presence(JSON.stringify(presence)));
  }

  private updateOpenStatus(url: string, newState: OpenStatus["state"], error?: string): void {
    this.setState({
      ...this.state,
      openStatuses: this.state.openStatuses.map((s) =>
        s.url === url ? { ...s, state: newState, error } : s,
      ),
    });
  }

  private setState(next: ApplierState): void {
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }

  private addWarning(warning: string): void {
    this.setState({
      ...this.state,
      warnings: [...this.state.warnings, warning],
    });
  }
}

// Per-dataset / per-channel DISPLAY commands (colormap, contrast, gamma,
// blend, render mode, detail level). These are all recipient-LOCAL
// ViewportCommands — none of them is broadcast, opens a dataset, changes
// visibility/opacity/order, or mutates the shared layout. Extracted from the
// heavy applier's per-dataset settings step so the LIGHT annotation-view
// restore can reproduce the AUTHOR'S per-channel colors/contrast for
// already-loaded datasets WITHOUT forking the command shapes — and without
// touching layer placement (visibility/opacity), which stay heavy-only.
//
// DELIBERATELY EXCLUDES `set_dataset_visible` and `set_dataset_opacity`: those
// are layer-placement, not display, and reside in the heavy apply only (the
// light restore must never hide/reorder a recipient's datasets).

/** The per-channel display commands for one channel — colormap, contrast,
 * gamma, and channel visibility (a channel toggle is display state, scoped to a
 * single dataset's rendering; it never hides the DATASET). */
export function channelDisplayCommands(
  datasetId: string,
  channel: number,
  c: ChannelSettings,
): ViewportCommand[] {
  return [
    { type: "set_channel_visible", dataset_id: datasetId, channel, visible: c.visible },
    { type: "set_channel_colormap", dataset_id: datasetId, channel, colormap: c.colormap },
    {
      type: "set_channel_contrast",
      dataset_id: datasetId, channel,
      min: c.contrast_min, max: c.contrast_max,
    },
    { type: "set_channel_gamma", dataset_id: datasetId, channel, gamma: c.gamma },
  ];
}

/** The per-label overlay display commands for one label — visibility + opacity.
 * A label's visible/opacity is display state scoped to a single dataset's
 * rendering (it never hides the DATASET or reframes the camera), so — like
 * `channelDisplayCommands` — it rides both the heavy applier and the light
 * restore, letting a restored view reproduce the author's visible-label set. */
export function labelDisplayCommands(
  datasetId: string,
  label: number,
  ls: LabelSettings,
): ViewportCommand[] {
  return [
    { type: "set_label_visible", dataset_id: datasetId, label, visible: ls.visible },
    { type: "set_label_opacity", dataset_id: datasetId, label, opacity: ls.opacity },
  ];
}

/** The per-dataset DISPLAY commands (contrast, gamma, blend, render mode,
 * detail level, every channel's display, and every label's overlay) for one
 * dataset — i.e. everything `applyDatasetSettings` emits EXCEPT
 * `set_dataset_visible` / `set_dataset_opacity`. Shared by the heavy applier and
 * the light restore.
 *
 * `currentLabelNames` is the recipient dataset's CURRENT label names in manifest
 * order. When it AND the author's captured `s.label_names` are both present, the
 * per-label overlay commands are keyed by label NAME and occurrence rather than
 * by raw array index: each current label takes the author's per-label settings
 * for the same name (matched by occurrence for a repeated name), so a view whose
 * label list was reordered / had a label added or removed still lands each
 * setting on the right current label. Without both (a legacy view with no
 * captured names, or a caller that can't supply the current names) it falls back
 * to the positional index-for-index behaviour. */
export function datasetDisplayCommands(
  id: string,
  s: DatasetDisplaySettings,
  currentLabelNames?: string[],
): ViewportCommand[] {
  const cmds: ViewportCommand[] = [
    { type: "set_dataset_contrast", dataset_id: id, min: s.contrast_min, max: s.contrast_max },
    { type: "set_dataset_gamma", dataset_id: id, gamma: s.gamma },
    { type: "set_dataset_blend_mode", dataset_id: id, blend_mode: s.blend_mode },
  ];
  if (s.render_mode !== undefined) {
    cmds.push({ type: "set_dataset_render_mode", dataset_id: id, render_mode: s.render_mode });
  }
  if (s.channel_blend_mode !== undefined) {
    cmds.push({ type: "set_channel_blend_mode", dataset_id: id, blend_mode: s.channel_blend_mode });
  }
  cmds.push({
    type: "set_dataset_detail_level_override",
    dataset_id: id,
    level: s.detail_level_override ?? null,
  });
  if (s.channel_settings) {
    s.channel_settings.forEach((c, i) => {
      for (const cmd of channelDisplayCommands(id, i, c)) cmds.push(cmd);
    });
  }
  // Per-label overlay state — restored so a saved view reproduces the visible
  // label set + opacities (a hidden label stays hidden on restore).
  if (s.label_settings) {
    const authorNames = s.label_names;
    if (authorNames && authorNames.length > 0 && currentLabelNames) {
      // Name-keyed, occurrence-aware: emit for each CURRENT label the author's
      // settings for the same name (k-th current occurrence takes the k-th
      // author occurrence). A current label with no matching author entry emits
      // nothing — it keeps whatever the recipient already had.
      const occurrencesTaken = new Map<string, number>();
      currentLabelNames.forEach((name, currentIndex) => {
        const targetOccurrence = occurrencesTaken.get(name) ?? 0;
        occurrencesTaken.set(name, targetOccurrence + 1);
        let matched = 0;
        let authorIndex = -1;
        for (let ai = 0; ai < authorNames.length; ai++) {
          if (authorNames[ai] === name) {
            if (matched === targetOccurrence) {
              authorIndex = ai;
              break;
            }
            matched++;
          }
        }
        if (authorIndex === -1) return;
        const ls = s.label_settings?.[authorIndex];
        if (!ls) return;
        for (const cmd of labelDisplayCommands(id, currentIndex, ls)) cmds.push(cmd);
      });
    } else {
      // Legacy / no current names available: positional index-for-index.
      s.label_settings.forEach((ls, i) => {
        for (const cmd of labelDisplayCommands(id, i, ls)) cmds.push(cmd);
      });
    }
  }
  return cmds;
}

// Out-of-range clamping for view indices.
// Exported for tests so the clamp logic can be exercised in isolation
// without spinning up a WasmScene.

export interface ClampedView {
  t: number;
  c: number;
  zStart: number;
  zEnd: number;
  /** True iff the clamp adjusted ANY of z (start or end), t, or c to fit
   *  the recipient's datasets. Drives the non-blocking "adjusted to fit
   *  this dataset" notice. When the saved indices were already in range,
   *  this is false and z/t/c are returned unchanged. */
  clamped: boolean;
  /** Human-readable names of the axes that were adjusted (subset of
   *  `["Z", "T", "C"]`, in that order). Empty when `clamped` is false.
   *  Lets the caller surface a precise per-axis notice. */
  adjustedAxes: readonly string[];
}

/**
 * Resolves the valid per-dataset extents (counts) for clamping, by axis.
 * Any axis whose extent is not determinable for a dataset is reported as
 * `undefined`, and that axis is left unclamped (the "clamp ... when
 * determinable" contract). Extents are counts: a value of `N` means valid
 * indices are `0..N-1` and a valid z slab is `0..N`.
 */
export type DimensionExtentsResolver = (
  datasetId: string,
) => { z?: number; t?: number; c?: number };

/**
 * Resolves a dataset's CURRENT label names, in manifest (`labels[]`) order —
 * the same order the per-label settings index into. Returns `undefined` (or an
 * empty array) for an unknown/unloaded dataset or one with no labels, which
 * makes the per-label restore fall back to positional application. Backed by the
 * recipient's loaded manifests (see `useDimensions` / `App.tsx`).
 */
export type LabelNamesResolver = (datasetId: string) => string[] | undefined;

/**
 * The datasets a view actually addresses AND keeps visible — i.e. the
 * volumes whose extents the z/t/c indices must remain valid for. A dataset
 * is "addressed" if it appears in `dataset_order` or `dataset_settings`,
 * and "visible" unless its per-dataset settings say `visible: false`.
 *
 * Returns `undefined` when the view addresses no datasets at all (e.g. an
 * empty/global view) so callers can fall back to "all loaded".
 */
function visibleAddressedDatasetIds(view: SavedView): Set<string> | undefined {
  const addressed = new Set<string>();
  for (const id of view.dataset_order) addressed.add(id);
  for (const id of Object.keys(view.dataset_settings)) addressed.add(id);
  if (addressed.size === 0) return undefined;

  const visible = new Set<string>();
  for (const id of addressed) {
    // No per-dataset settings = visible by default (matches the applier's
    // step-5 logic, which only hides datasets dropped from the link).
    if (view.dataset_settings[id]?.visible === false) continue;
    visible.add(id);
  }
  return visible;
}

/**
 * Clamp a saved view's z slab / t / c so they fit the recipient's
 * currently-loaded datasets.
 *
 * Z extents come from the per-dataset `dataset_volume_shape` (authoritative
 * and precise). T/C extents are NOT carried by `dataset_volume_shape`, so
 * they are only clamped when an `extentsFor` resolver supplies them — see
 * `useSavedViewSync`, which wires the recipient's manifest-derived union
 * extents. When no extent is determinable for an axis, that axis passes
 * through unchanged (matching the legacy behavior for t/c).
 *
 * The clamp is conservative: it uses the SMALLEST extent across the
 * datasets the view ADDRESSES and makes VISIBLE (intersected with the
 * loaded set passed in `requestedIds`), so an index stays valid for every
 * volume it must address — without being crushed to an unrelated/hidden
 * co-loaded neighbor. When the view addresses no datasets at all, every
 * loaded id in `requestedIds` is considered (legacy behavior).
 */
export function clampViewIndices(
  scene: WasmScene,
  requestedIds: { url: string; id: string }[],
  view: SavedView,
  extentsFor?: DimensionExtentsResolver,
): ClampedView {
  // Restrict the extent scan to the datasets the view addresses + keeps
  // visible. A co-loaded dataset the view never referenced (or hides) must
  // not drag the conservative min down and crush a deep/multi-channel
  // volume's valid Z/T/C. Fall back to all-loaded only for a view that
  // addresses nothing (empty/global).
  const addressedVisible = visibleAddressedDatasetIds(view);
  const idsToClamp = addressedVisible === undefined
    ? requestedIds
    : requestedIds.filter((r) => addressedVisible.has(r.id));

  // LARGEST extent per axis across the relevant datasets — the bound the
  // global Z/T/C sliders actually navigate (the DEEPEST visible volume). A
  // co-visible SHALLOW dataset (e.g. a 2D image with Z=1) must NOT crush a
  // deep volume's valid plane: each dataset clamps its own rendering, so the
  // saved index only needs to fit the deepest relevant volume. (Using the
  // smallest extent here was the #814 restore regression: a 2D dataset
  // co-loaded with a 340-plane volume collapsed a valid Z to 0.) `undefined`
  // means "not determinable for any relevant dataset", leaving the axis alone.
  let maxZ: number | undefined;
  let maxT: number | undefined;
  let maxC: number | undefined;
  const considerMax = (cur: number | undefined, next: number | undefined) => {
    if (next === undefined || !Number.isFinite(next) || next <= 0) return cur;
    return cur === undefined ? next : Math.max(cur, next);
  };

  for (const r of idsToClamp) {
    // Z extent: from the volume shape ([Z, Y, X]). This is the only
    // dimension `dataset_volume_shape` carries.
    try {
      const shape = scene.dataset_volume_shape(r.id);
      if (shape.length >= 1) maxZ = considerMax(maxZ, shape[0]);
    } catch {
      // Dataset not yet loaded / no shape; skip — its extent is unknown.
    }
    // T/C extents: only available via the injected resolver (manifest
    // union on the recipient). Resolver failures are non-fatal.
    if (extentsFor) {
      try {
        const ext = extentsFor(r.id);
        maxT = considerMax(maxT, ext.t);
        maxC = considerMax(maxC, ext.c);
      } catch {
        // Resolver couldn't determine extents for this dataset; skip.
      }
    }
  }

  const requested = view.view;

  // --- Z slab: clamp start and end into [0, maxZ], keeping a slab of
  // thickness >= 1. Preserves the slab when it fits the deepest visible volume. ---
  let zStart = requested.z_range.start;
  let zEnd = requested.z_range.end;
  if (maxZ !== undefined) {
    zStart = Math.max(0, Math.min(zStart, maxZ - 1));
    zEnd = Math.max(zStart + 1, Math.min(zEnd, maxZ));
  }

  // --- T: clamp into [0, maxT - 1] when the extent is known. ---
  let t = requested.t;
  if (maxT !== undefined) {
    t = Math.max(0, Math.min(t, maxT - 1));
  }

  // --- C: clamp into [0, maxC - 1] when the extent is known. ---
  let c = requested.c;
  if (maxC !== undefined) {
    c = Math.max(0, Math.min(c, maxC - 1));
  }

  // Report per-axis adjustments precisely so the notice can name them.
  const adjustedAxes: string[] = [];
  if (zStart !== requested.z_range.start || zEnd !== requested.z_range.end) {
    adjustedAxes.push("Z");
  }
  if (t !== requested.t) adjustedAxes.push("T");
  if (c !== requested.c) adjustedAxes.push("C");

  return { t, c, zStart, zEnd, clamped: adjustedAxes.length > 0, adjustedAxes };
}

/**
 * Build the non-blocking notice shown when `clampViewIndices` adjusted one
 * or more axes, naming exactly which ones moved. Examples:
 *   ["Z"]           -> "Z adjusted to fit this dataset"
 *   ["Z", "C"]      -> "Z and C adjusted to fit this dataset"
 *   ["Z", "T", "C"] -> "Z, T and C adjusted to fit this dataset"
 * Exported for tests so the wording can be asserted without a WasmScene.
 */
export function clampNotice(adjustedAxes: readonly string[]): string {
  const axes = adjustedAxes.length > 1
    ? `${adjustedAxes.slice(0, -1).join(", ")} and ${adjustedAxes[adjustedAxes.length - 1]}`
    : (adjustedAxes[0] ?? "");
  return `${axes} adjusted to fit this dataset`;
}

/** Helper: re-export shape used by tests so they can construct an applier-like
 * object without depending on the full ApplierBridge surface. */
export type { Camera, DatasetId, LayoutId, DatasetDisplaySettings };
