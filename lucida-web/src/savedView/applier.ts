// Apply a `SavedView` to the live scene.
//
// Source-url views name datasets by URL and open the missing ones.
// Workspace-dataset-id views name loaded workspace members and never open
// source URLs. Everything but a layout change or a placement by hand is a
// recipient-local ViewportCommand. Placement is restored only when the caller
// asks, for a view someone chose to apply: a link, a member's last view, the
// default view or a viewer profile is restored automatically, and an
// automatic restore must never undo a move someone else made since. A
// comparison comes back with placement or not at all: whether its pair lines
// up depends on placement, and it sets aside every other layer its view
// shows, which only someone who picked the view expects. The views go next to
// last, through `import_views`, and the active view's camera last, through
// `import_presence`, so each lands through one mutator. The in-progress state
// lets urlSync suppress URL writes while an apply runs.

import type { WasmScene } from "lucida-core";
import type { DocumentCommand, ViewportCommand } from "../commands.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import {
  IDENTITY_USER_TRANSFORM,
  readUserTransform,
  sameUserTransform,
  setUserTransformCommand,
  type UserTransform,
} from "../userTransform.ts";
import type {
  Camera,
  CameraSpace,
  DatasetDisplaySettings,
  DatasetId,
  DatasetReferenceMode,
  LayoutId,
  LayoutMutationMode,
  SavedView,
  ChannelSettings,
  LabelSettings,
  ViewState,
} from "./types.ts";

export interface ApplierBridge {
  sendOpenRemoteDataset: (url: string) => void;
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
}

export type StateListener = (s: ApplierState) => void;

export interface ApplierEventChannels {
  /** Called when the bridge's `onCommand` handler sees a DatasetOpened
   * for a dataset we requested. */
  notifyDatasetOpened: (datasetId: string) => void;
  notifyOpenFailed: (url: string, error: string) => void;
}

/** After-apply summary. Callers auto-select the first visible dataset so the
 *  side-panel controls act on something the recipient can see. */
export interface ApplyResult {
  /** Datasets visible after apply, in `dataset_order` order. */
  visibleDatasetIds: string[];
  firstVisibleDatasetId: string | null;
}

export type ApplyResultListener = (r: ApplyResult) => void;

/** What an `apply()` restores beyond what every restore does. */
export interface ApplyOptions {
  /** Someone picked this view to apply, so it puts each dataset where the view
   *  recorded it and brings back its comparisons. Every automatic restore
   *  leaves the document's placement, and shows no comparison. */
  chosen?: boolean;
}

/** A dataset an `apply()` placed by hand, from where it was. */
export interface PlacementChange {
  datasetId: string;
  from: UserTransform;
  to: UserTransform;
}

/** Fires once at the end of every `apply()`, before `inProgress` drops, so
 *  subscribers can read post-apply scene state. The applier writes WASM only;
 *  `useSavedViewSync` uses this to refresh the render loop and React mirrors. */
export type ApplyCompleteListener = (view: SavedView) => void;

/** Fires once at the start of every `apply()`, before it writes anything. */
export type ApplyStartListener = () => void;

const IDLE_STATE: ApplierState = {
  inProgress: false,
  openStatuses: [],
  totalToOpen: 0,
  okOpened: 0,
  anyOpenFailed: false,
  warnings: [],
};

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
  for (const id of Object.keys(view.user_transforms ?? {})) add(id);

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
  private applyStartListeners = new Set<ApplyStartListener>();
  // Keyed by dataset id because the DatasetOpened broadcast carries the
  // manifest, not the URL.
  private pendingByDatasetId = new Map<string, {
    url: string;
    resolve: () => void;
    reject: (e: Error) => void;
  }>();
  private pendingByUrl = new Map<string, string>(); // url → datasetId
  private readonly bridge: ApplierBridge;
  private readonly getScene: () => WasmScene | null;
  private readonly datasetIdForUrl: (url: string) => string;
  private readonly datasetReferenceMode: DatasetReferenceMode;
  private readonly layoutMutation: LayoutMutationMode;
  private readonly openTimeoutMs: number;
  /** Per-dataset T/C extents for clamping; Z comes from the volume shape.
   *  When absent, t/c pass through unclamped. */
  private readonly dimensionExtentsFor?: DimensionExtentsResolver;
  /** The recipient's current label names, so per-label settings match by
   *  name and occurrence. When absent, they apply by position. */
  private readonly labelNamesFor?: LabelNamesResolver;

  constructor(
    bridge: ApplierBridge,
    /** The live `WasmScene`, or null if not yet loaded. */
    getScene: () => WasmScene | null,
    /** Usually the wasm `dataset_id_for_url`; injectable so tests skip WASM
     * init. */
    datasetIdForUrl: (url: string) => string,
    /** ms after which a queued open is considered failed (default 30 s). */
    openTimeoutMs: number = 30_000,
    datasetReferenceMode: DatasetReferenceMode = "source-url",
    /** What this restore may do to the shared active layout. */
    layoutMutation: LayoutMutationMode = "broadcast",
    /** Omit to leave t/c unclamped. */
    dimensionExtentsFor?: DimensionExtentsResolver,
    /** Omit to restore per-label settings by position. */
    labelNamesFor?: LabelNamesResolver,
  ) {
    this.bridge = bridge;
    this.getScene = getScene;
    this.datasetIdForUrl = datasetIdForUrl;
    this.datasetReferenceMode = datasetReferenceMode;
    this.layoutMutation = layoutMutation;
    this.openTimeoutMs = openTimeoutMs;
    this.dimensionExtentsFor = dimensionExtentsFor;
    this.labelNamesFor = labelNamesFor;
  }

  /** Used by LoadingViewBanner. */
  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Subscribe to the post-apply visibility summary, fired once per
   *  `apply()`. `useSavedViewSync` uses it to pick a new selected dataset. */
  subscribeApplyResult(fn: ApplyResultListener): () => void {
    this.applyResultListeners.add(fn);
    return () => { this.applyResultListeners.delete(fn); };
  }

  /** Subscribe to "apply done", fired once per `apply()` after the WASM
   *  writes and before `inProgress` drops. Separate from
   *  `subscribeApplyResult`, which is about UI focus. */
  subscribeApplyComplete(fn: ApplyCompleteListener): () => void {
    this.applyCompleteListeners.add(fn);
    return () => { this.applyCompleteListeners.delete(fn); };
  }

  /** Subscribe to the start of every `apply()`, which comes before any of
   *  its writes and before it waits on a dataset open. */
  subscribeApplyStart(fn: ApplyStartListener): () => void {
    this.applyStartListeners.add(fn);
    return () => { this.applyStartListeners.delete(fn); };
  }

  getState(): ApplierState {
    return this.state;
  }

  isInProgress(): boolean {
    return this.state.inProgress;
  }

  /** Bridge-side hook: call this from the bridge's `onCommand` handler when
   * a DatasetOpened broadcast arrives. */
  notifyDatasetOpened(datasetId: string): void {
    const entry = this.pendingByDatasetId.get(datasetId);
    if (!entry) return;
    this.pendingByDatasetId.delete(datasetId);
    this.pendingByUrl.delete(entry.url);
    this.updateOpenStatus(entry.url, "ok");
    entry.resolve();
  }

  /** Bridge-side hook: call this from the bridge's `onOpenDatasetFailed`
   * handler when a per-URL failure arrives. */
  notifyOpenFailed(url: string, error: string): void {
    const datasetId = this.pendingByUrl.get(url);
    if (!datasetId) return;
    const entry = this.pendingByDatasetId.get(datasetId);
    if (!entry) return;
    this.pendingByDatasetId.delete(datasetId);
    this.pendingByUrl.delete(url);
    this.updateOpenStatus(url, "error", error);
    // Reject so apply() can continue to "skip and keep going".
    entry.reject(new Error(error));
  }

  /**
   * Apply a SavedView to the live scene. Returns when all in-flight
   * commands are dispatched and the camera has been imported. Resolves
   * even on partial dataset-open failure (the loading banner shows the
   * indicator). Says which datasets it placed by hand, none unless the view
   * was `chosen`.
   */
  async apply(view: SavedView, options: ApplyOptions = {}): Promise<PlacementChange[]> {
    const placed: PlacementChange[] = [];
    if (this.state.inProgress) {
      throw new Error("SavedViewApplier.apply: another apply already in progress");
    }
    this.setState({ ...IDLE_STATE, inProgress: true });
    try {
      for (const fn of this.applyStartListeners) fn();
      // Global views name datasets by source URL and may open them.
      // Workspace views name loaded datasets by id and must not expose
      // source URLs.
      const requestedIds = this.datasetReferenceMode === "source-url"
        ? view.datasets.map((url) => ({
          url,
          id: this.datasetIdForUrl(url),
        }))
        : workspaceDatasetIdsForView(view).map((id) => ({ url: "", id }));

      const scene = this.getScene();
      if (!scene) {
        // The caller re-invokes once the scene exists.
        return placed;
      }
      const loadedIds = new Set<string>(
        JSON.parse(scene.dataset_ids()) as string[],
      );
      const requestedSet = new Set(requestedIds.map((r) => r.id));

      const toOpen = this.datasetReferenceMode === "source-url"
        ? requestedIds.filter((r) => !loadedIds.has(r.id))
        : [];
      this.setState({
        ...this.state,
        totalToOpen: toOpen.length,
        openStatuses: toOpen.map((r) => ({ url: r.url, state: "pending" })),
      });
      await this.openMissing(toOpen);

      if (this.datasetReferenceMode === "workspace-dataset-id" && requestedSet.size > 0) {
        await this.waitForWorkspaceDatasets(requestedSet);
      }

      // Best effort: if opens raced or failed, proceed with whatever loaded.
      const sceneAfter = this.getScene();
      if (!sceneAfter) return placed;
      const loadedAfter = new Set<string>(
        JSON.parse(sceneAfter.dataset_ids()) as string[],
      );
      if (this.datasetReferenceMode === "workspace-dataset-id") {
        for (const warning of workspaceMissingDatasetWarnings(loadedAfter, requestedSet)) {
          this.addWarning(warning);
        }
      }

      // Hide loaded datasets the link doesn't name. Recipient-local.
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
          if (this.layoutMutation === "refuse") {
            const warning = `Workspace view expects layout ${JSON.stringify(layoutId)} for dataset ${id}, but active layout is ${JSON.stringify(currentActive)}; leaving shared layout unchanged`;
            console.warn(`[SavedViewApplier] ${warning}`);
            this.addWarning(warning);
            continue;
          }
          this.applyDocument(
            { type: "set_active_layout", dataset_id: id, layout_id: layoutId },
            this.layoutMutation === "broadcast",
          );
        }
      }

      if (options.chosen) {
        placed.push(...this.applyPlacement(sceneAfter, view, requestedSet, loadedAfter));
      }

      const filteredOrder = view.dataset_order.filter((id) => loadedAfter.has(id));
      if (filteredOrder.length > 0) {
        this.applyViewport(sceneAfter, {
          type: "set_dataset_order",
          order: filteredOrder,
        });
      }

      for (const [id, s] of Object.entries(view.dataset_settings)) {
        if (!loadedAfter.has(id)) continue;
        this.applyDatasetSettings(sceneAfter, id, s);
      }

      this.applyViewport(sceneAfter, {
        type: "set_contrast",
        min: view.display.contrast_min,
        max: view.display.contrast_max,
      });
      this.applyViewport(sceneAfter, {
        type: "set_gamma",
        gamma: view.display.gamma,
      });

      // `clampViewTime` narrows to the datasets the view names and keeps
      // visible, so an unreferenced or hidden neighbor can't crush the
      // restored T.
      const clampedDatasets = Array.from(loadedAfter, (id) => ({ url: "", id }));
      const clamped = clampViewTime(clampedDatasets, view, this.dimensionExtentsFor);
      if (clamped.clamped) {
        // LoadingViewBanner renders warnings; name the axes that moved.
        this.addWarning(clampNotice(clamped.adjustedAxes));
      }

      // The views, then the active view's camera and axis positions, with an
      // older view's scene-wide channel mode, which the scene decodes into
      // each layer's solo over the settings set above.
      importViews(sceneAfter, view, options.chosen === true);
      importCameraView(sceneAfter, view, clamped.t, legacyChannelMode(view));

      this.emitApplyResult(sceneAfter, view);

      // Inside the try, before inProgress drops, so listeners read
      // post-apply state. The view is passed so listeners can restore
      // client-only state such as autoContrastMap.
      for (const fn of this.applyCompleteListeners) fn(view);
    } finally {
      this.setState({ ...this.state, inProgress: false });
    }
    return placed;
  }

  /**
   * Put each dataset the view names where it sat by hand, the identity where
   * its record leaves one out, and say which moved. A view that records no
   * placement leaves the document's.
   */
  private applyPlacement(
    scene: WasmScene,
    view: SavedView,
    requested: ReadonlySet<string>,
    loaded: ReadonlySet<string>,
  ): PlacementChange[] {
    const placed: PlacementChange[] = [];
    const recorded = view.user_transforms;
    if (!recorded) return placed;
    for (const id of requested) {
      if (!loaded.has(id)) continue;
      const want = recorded[id] ?? IDENTITY_USER_TRANSFORM;
      const have = readUserTransform(scene, id) ?? IDENTITY_USER_TRANSFORM;
      if (sameUserTransform(want, have)) continue;
      if (this.layoutMutation === "refuse") {
        const warning = `Workspace view places dataset ${id} by hand differently; leaving the shared placement unchanged`;
        console.warn(`[SavedViewApplier] ${warning}`);
        this.addWarning(warning);
        continue;
      }
      this.applyDocument(setUserTransformCommand(id, want), this.layoutMutation === "broadcast");
      placed.push({ datasetId: id, from: have, to: want });
    }
    return placed;
  }

  private emitApplyResult(scene: WasmScene, view: SavedView): void {
    const loaded = new Set<string>(JSON.parse(scene.dataset_ids()) as string[]);
    // Walk dataset_order first so "first visible" matches the layer panel.
    const visible: string[] = [];
    const seen = new Set<string>();
    const considered = view.dataset_order.length > 0
      ? view.dataset_order
      : Array.from(loaded);
    for (const id of considered) {
      if (!loaded.has(id) || seen.has(id)) continue;
      seen.add(id);
      const settings = view.dataset_settings[id];
      // No per-dataset settings means visible; apply hides only datasets
      // the link drops.
      const isVisible = settings ? settings.visible !== false : true;
      if (isVisible) visible.push(id);
    }
    // Loaded ids the order didn't list, e.g. a dataset opened mid-apply.
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
  }

  private async openMissing(toOpen: { url: string; id: string }[]): Promise<void> {
    if (toOpen.length === 0) return;

    const promises = toOpen.map((r) => {
      const p = new Promise<void>((resolve, reject) => {
        this.pendingByDatasetId.set(r.id, { url: r.url, resolve, reject });
        this.pendingByUrl.set(r.url, r.id);
      });
      this.bridge.sendOpenRemoteDataset(r.url);
      return p
        .then(() => {
          this.setState({ ...this.state, okOpened: this.state.okOpened + 1 });
        })
        .catch((e) => {
          this.setState({ ...this.state, anyOpenFailed: true });
          // Swallow: the per-URL state already records the error.
          console.warn(`[SavedViewApplier] open failed: ${r.url}: ${(e as Error).message}`);
        });
    });

    // One watchdog fails every entry still pending at the timeout.
    const watchdog = new Promise<void>((resolve) => {
      setTimeout(() => {
        for (const entry of this.pendingByDatasetId.values()) {
          this.updateOpenStatus(entry.url, "error", "timeout");
          entry.reject(new Error("timeout"));
        }
        this.pendingByDatasetId.clear();
        this.pendingByUrl.clear();
        resolve();
      }, this.openTimeoutMs);
    });

    await Promise.race([Promise.all(promises), watchdog]);
  }

  private async waitForWorkspaceDatasets(requestedSet: Set<string>): Promise<void> {
    const deadline = performance.now() + Math.min(this.openTimeoutMs, 5_000);
    while (performance.now() < deadline) {
      const scene = this.getScene();
      if (!scene) return;
      const loaded = new Set<string>(JSON.parse(scene.dataset_ids()) as string[]);
      let missing = false;
      for (const id of requestedSet) {
        if (!loaded.has(id)) {
          missing = true;
          break;
        }
      }
      if (!missing) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Apply a document command here and, unless `broadcast` is false, send it so
   * peers and the persisted document follow. The capture surface needs the
   * local-only apply.
   */
  private applyDocument(cmd: DocumentCommand, broadcast: boolean = true): void {
    const json = JSON.stringify(cmd);
    const scene = this.getScene();
    if (scene) guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
    if (broadcast) this.bridge.sendCommand(json);
  }

  private applyViewport(scene: WasmScene, cmd: ViewportCommand): void {
    guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
  }

  private applyDatasetSettings(
    scene: WasmScene,
    id: string,
    s: DatasetDisplaySettings,
  ): void {
    // Visibility and opacity are layer placement and belong to this heavy apply
    // only; the light annotation-view restore leaves them alone. The rest is
    // display, shared with the light path through `datasetDisplayCommands`.
    this.applyViewport(scene, { type: "set_dataset_visible", dataset_id: id, visible: s.visible });
    this.applyViewport(scene, { type: "set_dataset_opacity", dataset_id: id, opacity: s.opacity });
    for (const cmd of datasetDisplayCommands(id, s, this.labelNamesFor?.(id))) {
      this.applyViewport(scene, cmd);
    }
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

/** The scene-wide channel mode of a view recorded before solo was per layer. */
export type LegacyChannelMode = Pick<ViewState, "c" | "multi_channel">;

/** `view`'s scene-wide channel mode, or `null` for a current view. */
export function legacyChannelMode(view: SavedView): LegacyChannelMode | null {
  const { c, multi_channel } = view.view;
  return c === undefined && multi_channel === undefined ? null : { c, multi_channel };
}

/**
 * Lay the views out as the saved view recorded them, or as one view of every
 * dataset when it recorded none, through `import_views`, which carries their
 * cameras and axis positions from the spaces they were saved in. Comparisons
 * come back only with `comparisons`.
 */
export function importViews(
  scene: WasmScene,
  { views, camera_space }: Pick<SavedView, "views" | "camera_space">,
  comparisons: boolean,
): void {
  const json = JSON.stringify({ views: views ?? null, camera_space, comparisons });
  guardedSceneCall("import_views", scene, () => scene.import_views(json));
}

/**
 * Import the view's camera and axis positions through `import_presence`,
 * which sets camera, view, and display atomically and keeps the local
 * viewport. Both go with the spaces they were saved in, which the scene
 * carries them out of, and with the view's version, so the scene reads an
 * older view's positions as it meant them. The display was already applied,
 * so the live one goes back through unchanged, as does an older view's
 * channel mode: the scene owns decoding it into each layer's solo.
 */
export function importCameraView(
  scene: WasmScene,
  { v, camera, camera_space, view }: Pick<SavedView, "v" | "camera" | "camera_space" | "view">,
  t: number,
  legacy: LegacyChannelMode | null,
): void {
  const presence = JSON.parse(scene.export_presence()) as {
    camera: Camera;
    view: ViewState;
    display: unknown;
    camera_space?: CameraSpace;
    v?: number;
  };
  presence.camera = camera;
  presence.camera_space = camera_space;
  presence.v = v;
  presence.view = { ...view, t, ...(legacy ?? {}) };
  guardedSceneCall("import_presence", scene, () => scene.import_presence(JSON.stringify(presence)));
}

// Per-dataset and per-channel display commands. All are recipient-local
// ViewportCommands, shared by the heavy applier and the light annotation-view
// restore. They exclude `set_dataset_visible` and `set_dataset_opacity`: those
// are layer placement, and the light restore must never hide or reorder a
// recipient's datasets.

/** Display commands for one channel. Channel visibility is display state; it
 * never hides the dataset. */
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

/** Overlay display commands for one label: visibility and opacity. Like
 * channel display, it rides both the heavy apply and the light restore. */
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

/** Every display command `applyDatasetSettings` emits for one dataset, minus
 * visibility and opacity.
 *
 * When both `currentLabelNames` (recipient manifest order) and the author's
 * `s.label_names` exist, per-label settings match by name and occurrence, so a
 * reordered or edited label list still lands each setting on the right label.
 * Otherwise they apply by index. */
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
  cmds.push({ type: "set_channel_solo", dataset_id: id, channel: s.solo ?? null });
  if (s.channel_settings) {
    s.channel_settings.forEach((c, i) => {
      for (const cmd of channelDisplayCommands(id, i, c)) cmds.push(cmd);
    });
  }
  if (s.label_settings) {
    const authorNames = s.label_names;
    if (authorNames && authorNames.length > 0 && currentLabelNames) {
      // The k-th current occurrence of a name takes the k-th author
      // occurrence. A current label with no author match emits nothing and
      // keeps the recipient's state.
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
      // Names missing on either side: apply by index.
      s.label_settings.forEach((ls, i) => {
        for (const cmd of labelDisplayCommands(id, i, ls)) cmds.push(cmd);
      });
    }
  }
  return cmds;
}

// The clamp helpers are exported so tests can run them without a WasmScene.

export interface ClampedView {
  t: number;
  /** True iff the clamp moved t. Drives the "adjusted to fit" notice. */
  clamped: boolean;
  /** Axes that moved: `["T"]`, or none. Z, Y and X are places, which a layer
   *  past them says it is outside of rather than being clamped. */
  adjustedAxes: readonly string[];
}

/**
 * Per-dataset extents (counts) for clamping. An axis reported `undefined`
 * stays unclamped. `N` means valid indices `0..N-1`.
 */
export type DimensionExtentsResolver = (
  datasetId: string,
) => { z?: number; t?: number; c?: number };

/**
 * A dataset's current label names in manifest (`labels[]`) order, the order
 * per-label settings index into. `undefined` or empty falls back to
 * positional restore.
 */
export type LabelNamesResolver = (datasetId: string) => string[] | undefined;

/**
 * The datasets a view names (in `dataset_order` or `dataset_settings`) and
 * doesn't hide. `undefined` when the view names none, so callers fall back to
 * all loaded.
 */
function visibleAddressedDatasetIds(view: SavedView): Set<string> | undefined {
  const addressed = new Set<string>();
  for (const id of view.dataset_order) addressed.add(id);
  for (const id of Object.keys(view.dataset_settings)) addressed.add(id);
  if (addressed.size === 0) return undefined;

  const visible = new Set<string>();
  for (const id of addressed) {
    // No per-dataset settings means visible.
    if (view.dataset_settings[id]?.visible === false) continue;
    visible.add(id);
  }
  return visible;
}

/**
 * Clamp a saved view's timepoint to the recipient's loaded datasets.
 *
 * T extents come only from `extentsFor`. With none known, T passes through.
 * It clamps to the largest extent among the datasets the view names and
 * keeps visible, or among every id in `requestedIds` when the view names
 * none: each dataset clamps its own rendering, so the saved index only needs
 * to fit the longest relevant series.
 */
export function clampViewTime(
  requestedIds: { url: string; id: string }[],
  view: SavedView,
  extentsFor?: DimensionExtentsResolver,
): ClampedView {
  const addressedVisible = visibleAddressedDatasetIds(view);
  const idsToClamp = addressedVisible === undefined
    ? requestedIds
    : requestedIds.filter((r) => addressedVisible.has(r.id));

  let maxT: number | undefined;
  for (const r of idsToClamp) {
    if (!extentsFor) break;
    try {
      const next = extentsFor(r.id).t;
      if (next !== undefined && Number.isFinite(next) && next > 0) {
        maxT = maxT === undefined ? next : Math.max(maxT, next);
      }
    } catch {
      // Resolver couldn't determine extents for this dataset; skip.
    }
  }

  const requested = view.view.t;
  const t = maxT === undefined ? requested : Math.max(0, Math.min(requested, maxT - 1));
  const adjustedAxes = t === requested ? [] : ["T"];
  return { t, clamped: adjustedAxes.length > 0, adjustedAxes };
}

/**
 * Build the non-blocking notice shown when `clampViewTime` adjusted one
 * or more axes, naming exactly which ones moved. Examples:
 *   ["Z"]           -> "Z adjusted to fit this dataset"
 *   ["Z", "T"]      -> "Z and T adjusted to fit this dataset"
 * Exported for tests so the wording can be asserted without a WasmScene.
 */
export function clampNotice(adjustedAxes: readonly string[]): string {
  const axes = adjustedAxes.length > 1
    ? `${adjustedAxes.slice(0, -1).join(", ")} and ${adjustedAxes[adjustedAxes.length - 1]}`
    : (adjustedAxes[0] ?? "");
  return `${axes} adjusted to fit this dataset`;
}

/** Re-exported for tests. */
export type { Camera, DatasetId, LayoutId, DatasetDisplaySettings };
