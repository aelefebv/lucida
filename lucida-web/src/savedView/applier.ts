// Apply a `SavedView` to the live scene. Async, deep module.
//
// Apply flow at the recipient:
//
//   1. Parse + validate (the encoder did this; we accept a parsed SavedView)
//   2. Diff datasets — compute DatasetId for each URL via blake3 (delegated
//      to the WASM `dataset_id_for_url`); open any that aren't loaded.
//   3. Open missing via bridge.sendOpenRemoteDataset(url).
//   4. Wait for DatasetOpened to come back via CommandBroadcast.
//   5. For currently-loaded datasets NOT in the link, send
//      SetDatasetVisible(false) — a ViewportCommand (recipient-only).
//   6. Apply SetActiveLayout for any dataset where the link's layout
//      differs from the live scene (DocumentCommand).
//   7. SetDatasetOrder, then per-dataset SetDatasetVisible/Opacity/contrast/
//      gamma/blend/render mode/per-channel colormap+contrast+gamma.
//   8. SetContrast / SetGamma / SetMultiChannel.
//   9. SetT / SetC / SetZRange — clamp out-of-range silently.
//  10. Camera last (via import_presence so it goes through one mutator).
//
// `applyInProgress` is exposed so urlSync can suppress writes; the
// per-step status is broadcast to subscribers (the loading banner) so
// users see "loading 2 of 4 datasets…".

import type { WasmScene } from "lucida-core";
import type {
  Camera,
  DatasetDisplaySettings,
  DatasetId,
  LayoutId,
  SavedView,
  ChannelSettings,
} from "./types.ts";

// --- Public types -------------------------------------------------------

export interface ApplierBridge {
  /** Send `OpenRemoteDataset { url }` over the WebSocket. */
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

/** Fires once at the end of every `apply()` (success or partial-failure),
 *  inside the `try` block before the inProgress flag flips back to false.
 *  Subscribers can read post-apply scene state via the live `getScene()`
 *  passed to the applier. Used in `useSavedViewSync` to mark the render
 *  loop dirty + bump the dataset-settings generation + push post-apply
 *  C/T/Z back to React state (since the applier writes to WASM only). */
export type ApplyCompleteListener = (view: SavedView) => void;

// --- Implementation ----------------------------------------------------

const IDLE_STATE: ApplierState = {
  inProgress: false,
  openStatuses: [],
  totalToOpen: 0,
  okOpened: 0,
  anyOpenFailed: false,
};

export class SavedViewApplier {
  private state: ApplierState = IDLE_STATE;
  private listeners = new Set<StateListener>();
  private applyResultListeners = new Set<ApplyResultListener>();
  private applyCompleteListeners = new Set<ApplyCompleteListener>();
  // Pending opens keyed by computed dataset id (we don't get the URL back
  // in the DatasetOpened broadcast — only the manifest, which carries the
  // server-assigned id derived from the URL). The applier resolves each
  // entry via `notifyDatasetOpened(datasetId)`.
  private pendingByDatasetId = new Map<string, {
    url: string;
    resolve: () => void;
    reject: (e: Error) => void;
  }>();
  private pendingByUrl = new Map<string, string>(); // url → datasetId
  private readonly bridge: ApplierBridge;
  private readonly getScene: () => WasmScene | null;
  private readonly datasetIdForUrl: (url: string) => string;
  private readonly openTimeoutMs: number;

  constructor(
    bridge: ApplierBridge,
    /** A function returning the live `WasmScene`, or null if not yet loaded. */
    getScene: () => WasmScene | null,
    /** Derive a `DatasetId` from a URL — usually the wasm `dataset_id_for_url`,
     * but injectable for tests so they don't need WASM init. */
    datasetIdForUrl: (url: string) => string,
    /** ms after which a queued open is considered failed (default 30 s). */
    openTimeoutMs: number = 30_000,
  ) {
    this.bridge = bridge;
    this.getScene = getScene;
    this.datasetIdForUrl = datasetIdForUrl;
    this.openTimeoutMs = openTimeoutMs;
  }

  // --- State subscription (used by LoadingViewBanner) -------------------

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

  /** Subscribe to a one-shot "apply done" event fired once at the end of
   *  every `apply()` (success or partial-failure), AFTER WASM mutations
   *  but BEFORE the `inProgress` flag flips back to false. Subscribers
   *  read post-apply scene state via the same `getScene()` the applier
   *  uses; the render-loop and React-side dim mirrors get refreshed
   *  through this channel (see useSavedViewSync). Distinct from
   *  `subscribeApplyResult` (which is about UI focus / selectedDatasetId). */
  subscribeApplyComplete(fn: ApplyCompleteListener): () => void {
    this.applyCompleteListeners.add(fn);
    return () => { this.applyCompleteListeners.delete(fn); };
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

  // --- Main entry point -------------------------------------------------

  /**
   * Apply a SavedView to the live scene. Returns when all in-flight
   * commands are dispatched and the camera has been imported. Resolves
   * even on partial dataset-open failure (the loading banner shows the
   * indicator).
   */
  async apply(view: SavedView): Promise<void> {
    if (this.state.inProgress) {
      throw new Error("SavedViewApplier.apply: another apply already in progress");
    }
    this.setState({ ...IDLE_STATE, inProgress: true });
    try {
      // Compute requested dataset ids from URLs.
      const requestedIds = view.datasets.map((url) => ({
        url,
        id: this.datasetIdForUrl(url),
      }));

      // Snapshot of currently-loaded ids.
      const scene = this.getScene();
      if (!scene) {
        // No scene yet — skip everything that needs it. Caller should
        // re-invoke after the scene is available.
        return;
      }
      const loadedIds = new Set<string>(
        JSON.parse(scene.dataset_ids()) as string[],
      );

      // Step 2-4: open missing.
      const toOpen = requestedIds.filter((r) => !loadedIds.has(r.id));
      this.setState({
        ...this.state,
        totalToOpen: toOpen.length,
        openStatuses: toOpen.map((r) => ({ url: r.url, state: "pending" })),
      });
      await this.openMissing(toOpen);

      // Re-read scene after opens (best-effort: if opens raced or some
      // failed, we proceed with whatever's loaded).
      const sceneAfter = this.getScene();
      if (!sceneAfter) return;
      const loadedAfter = new Set<string>(
        JSON.parse(sceneAfter.dataset_ids()) as string[],
      );
      const requestedSet = new Set(requestedIds.map((r) => r.id));

      // Step 5: hide datasets that are loaded but not in the link
      // (recipient-only, ViewportCommand).
      for (const id of loadedAfter) {
        if (!requestedSet.has(id)) {
          this.applyViewport(sceneAfter, {
            type: "set_dataset_visible",
            dataset_id: id,
            visible: false,
          });
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

      // Step 9: SetT / SetC / SetZRange — clamp silently.
      // Clamp against every currently-loaded dataset, not just the
      // requested URLs — handles "view already has datasets loaded; the
      // saved view's z is bigger than any loaded volume" silently.
      const clampedDatasets = Array.from(loadedAfter, (id) => ({ url: "", id }));
      const clamped = clampViewIndices(sceneAfter, clampedDatasets, view);
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
      this.emitApplyResult(sceneAfter, view);

      // Fires inside the try (before the inProgress flag flips back) so
      // subscribers can read post-apply scene state and trigger render
      // refresh + React-state sync. The applied view is passed so
      // listeners can restore client-only state (e.g. autoContrastMap).
      // See `useSavedViewSync` for usage.
      for (const fn of this.applyCompleteListeners) fn(view);
    } finally {
      // Ratchet the inProgress flag down regardless of any throw.
      this.setState({ ...this.state, inProgress: false });
    }
  }

  /** Read post-apply visibility from the live scene + the just-applied
   *  view's `dataset_order`, then notify subscribers so they can pick a
   *  new selectedDatasetId. */
  private emitApplyResult(scene: WasmScene, view: SavedView): void {
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
  }

  // --- Helpers ----------------------------------------------------------

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
          // Swallow — the per-URL state already records the error.
          console.warn(`[SavedViewApplier] open failed: ${r.url}: ${(e as Error).message}`);
        });
    });

    // Watchdog timeout per pending entry.
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

  private applyDocument(cmd: Record<string, unknown>): void {
    const json = JSON.stringify(cmd);
    const scene = this.getScene();
    scene?.apply_command(json);
    this.bridge.sendCommand(json);
  }

  private applyViewport(scene: WasmScene, cmd: Record<string, unknown>): void {
    scene.apply_command(JSON.stringify(cmd));
  }

  private applyDatasetSettings(
    scene: WasmScene,
    id: string,
    s: DatasetDisplaySettings,
  ): void {
    this.applyViewport(scene, { type: "set_dataset_visible", dataset_id: id, visible: s.visible });
    this.applyViewport(scene, { type: "set_dataset_opacity", dataset_id: id, opacity: s.opacity });
    this.applyViewport(scene, {
      type: "set_dataset_contrast",
      dataset_id: id,
      min: s.contrast_min,
      max: s.contrast_max,
    });
    this.applyViewport(scene, { type: "set_dataset_gamma", dataset_id: id, gamma: s.gamma });
    this.applyViewport(scene, {
      type: "set_dataset_blend_mode",
      dataset_id: id,
      blend_mode: s.blend_mode,
    });
    if (s.render_mode !== undefined) {
      this.applyViewport(scene, {
        type: "set_dataset_render_mode",
        dataset_id: id,
        render_mode: s.render_mode,
      });
    }
    if (s.channel_blend_mode !== undefined) {
      this.applyViewport(scene, {
        type: "set_channel_blend_mode",
        dataset_id: id,
        blend_mode: s.channel_blend_mode,
      });
    }
    if (s.channel_settings) {
      s.channel_settings.forEach((c, i) => this.applyChannelSettings(scene, id, i, c));
    }
  }

  private applyChannelSettings(
    scene: WasmScene,
    datasetId: string,
    channel: number,
    c: ChannelSettings,
  ): void {
    this.applyViewport(scene, {
      type: "set_channel_visible", dataset_id: datasetId, channel, visible: c.visible,
    });
    this.applyViewport(scene, {
      type: "set_channel_colormap", dataset_id: datasetId, channel, colormap: c.colormap,
    });
    this.applyViewport(scene, {
      type: "set_channel_contrast",
      dataset_id: datasetId, channel,
      min: c.contrast_min, max: c.contrast_max,
    });
    this.applyViewport(scene, {
      type: "set_channel_gamma", dataset_id: datasetId, channel, gamma: c.gamma,
    });
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
    scene.import_presence(JSON.stringify(presence));
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
}

// --- Out-of-range clamping for view indices ---------------------------
//
// Exported for tests so the clamp logic can be exercised in isolation
// without spinning up a WasmScene.

export interface ClampedView {
  t: number;
  c: number;
  zStart: number;
  zEnd: number;
}

export function clampViewIndices(
  scene: WasmScene,
  requestedIds: { url: string; id: string }[],
  view: SavedView,
): ClampedView {
  // Find the smallest dimension across loaded datasets (the conservative
  // choice — out-of-range silently clamps to the lower bound that's safe).
  let minZ = Number.POSITIVE_INFINITY;
  for (const r of requestedIds) {
    try {
      const shape = scene.dataset_volume_shape(r.id);
      if (shape.length >= 3) {
        // shape returns [Z, Y, X]; t/c are not in volume_shape — but
        // dataset_volume_shape is the only call we have for "max valid
        // index". The clamp contract is "clamp out-of-range silently"
        // specifically about z/t/c — we conservatively clamp z to
        // volume_shape[0] and pass t/c through (downstream WASM
        // `set_t`/`set_c` accept any u32; out-of-range there is
        // harmless because rendering will skip frames we don't have).
        minZ = Math.min(minZ, shape[0]);
      }
    } catch {
      // Dataset not yet loaded; skip.
    }
  }
  if (minZ === Number.POSITIVE_INFINITY) minZ = view.view.z_range.end;

  const t = view.view.t;
  const c = view.view.c;
  const zStart = Math.max(0, Math.min(view.view.z_range.start, minZ - 1));
  const zEnd = Math.max(zStart + 1, Math.min(view.view.z_range.end, minZ));

  return { t, c, zStart, zEnd };
}

/** Helper: re-export shape used by tests so they can construct an applier-like
 * object without depending on the full ApplierBridge surface. */
export type { Camera, DatasetId, LayoutId, DatasetDisplaySettings };
