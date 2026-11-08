// Wires the savedView applier and UrlSync into the React tree. In source-url
// mode it also tracks URL to DatasetId for every local open, so a capture can
// name each dataset by its URL. Mounted after the bridge hook so the applier
// gets `sendCommand` and `sendOpenRemoteDataset` directly.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { dataset_id_for_url } from "lucida-core";
import {
  SavedViewApplier,
  type DimensionExtentsResolver,
  type LabelNamesResolver,
} from "../savedView/applier.ts";
import { UrlSync } from "../savedView/urlSync.ts";
import { buildCapture } from "../savedView/captureBuilder.ts";
import { getRestoreLastViewEnabled } from "../lastViewPreference.ts";
import {
  isPersistable,
  type DatasetReferenceMode,
  type LayoutMutationMode,
  type SavedView,
} from "../savedView/types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { invalidateAfterViewRestore } from "../invalidation.ts";
import type { SceneStore, ViewEpochs } from "../sceneStore.ts";

interface Params {
  getScene: () => WasmScene | null;
  sendOpenRemoteDataset: (url: string) => void;
  sendCommand: (json: string) => void;
  /** Increments whenever the scene mutates locally; drives URL re-encoding. */
  changeTick: number;
  /** The scene's view state. A move of the camera or the selectors arms the
   *  last-view capture as `changeTick` does, without a render. */
  sceneStore?: SceneStore;
  /** Debounce override for tests. Default 350. */
  debounceMs?: number;
  /** Fired after every successful apply, so App.tsx can re-target
   *  `selectedDatasetId` at the first visible dataset. */
  onApplyResult?: (firstVisibleDatasetId: string | null) => void;
  /** The applier writes to WASM only. Without marking the loop dirty, the
   *  pull-based RAF loop sits idle until the next user input. */
  loopRef: React.RefObject<RenderLoop | null>;
  /** The recipient's per-dataset T/C counts, so an applied view's out-of-range
   *  timepoint or channel clamps to fit. Z is clamped by the applier from the
   *  volume shape. Omit to leave t/c unclamped. */
  dimensionExtentsFor?: DimensionExtentsResolver;
  /** The recipient's current label names per dataset, in manifest order. Read at
   *  capture to stamp `label_names` and at apply to restore per-label settings by
   *  name and occurrence. Omit to leave per-label handling positional. */
  labelNamesFor?: LabelNamesResolver;
  /** Per-dataset auto-contrast preference, captured and restored. Without this
   *  round-trip the recipient's intensity batcher overwrites the captured
   *  contrast values. */
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  setAutoContrastMap: React.Dispatch<React.SetStateAction<Map<string, boolean>>>;
  datasetReferenceMode?: DatasetReferenceMode;
  fetchSavedViewById?: (id: string) => Promise<{ id: string; view: SavedView } | null>;
  /** A `#b=` link named a saved view that couldn't be fetched. */
  onSavedViewMissing?: (id: string) => void;
  fetchDefaultSavedView?: () => Promise<{ id: string; view: SavedView } | null>;
  fetchViewerProfile?: (profile: string) => Promise<{ id: string; view: SavedView } | null>;
  /** Resolve the caller's remembered last view for a bare workspace open. When
   *  omitted, the bootstrap falls back to the workspace default. */
  fetchLastView?: () => Promise<{ id: string; view: SavedView } | null>;
  /** Persist the current view as the caller's last view, debounced. Omitted in
   *  auth-off mode, so no server call is made. Errors never reach the UI. */
  persistLastView?: (view: SavedView) => Promise<unknown>;
  /** The per-user "restore my last view" toggle. Gates both restore and
   *  capture. Defaults to the localStorage preference. */
  restoreLastViewEnabled?: () => boolean;
  /** Last-view capture debounce, long enough that a burst of pans coalesces
   *  into one write. Default 3000ms. */
  lastViewDebounceMs?: number;
  /** True on the capture surface (`?render=1`), which writes no persisted state
   *  (see `captureSurface.ts`). The last-view capture is never armed, so a
   *  headless run neither overwrites the remembered view nor waits out the
   *  debounce. Restore still runs. */
  captureSurface?: boolean;
  /** What a restore may do to the shared active layout. Defaults to
   *  broadcasting, as an editor does. */
  layoutMutation?: LayoutMutationMode;
}

interface SyncBundle {
  applier: SavedViewApplier;
  urlSync: UrlSync;
  urlByDatasetId: Map<string, string>;
  capture: () => SavedView | null;
}

export function useSavedViewSync({
  getScene,
  sendOpenRemoteDataset,
  sendCommand,
  changeTick,
  sceneStore,
  debounceMs,
  onApplyResult,
  loopRef,
  dimensionExtentsFor,
  labelNamesFor,
  autoContrastMapRef,
  setAutoContrastMap,
  datasetReferenceMode = "source-url",
  fetchSavedViewById,
  onSavedViewMissing,
  fetchDefaultSavedView,
  fetchViewerProfile,
  fetchLastView,
  persistLastView,
  restoreLastViewEnabled,
  lastViewDebounceMs = 3000,
  captureSurface = false,
  layoutMutation = "broadcast",
}: Params): {
  applier: SavedViewApplier;
  captureBuilder: () => SavedView | null;
  trackedSendOpen: (url: string) => void;
  /** Schedule a debounced URL write. App.tsx calls it from the presence
   *  emitters so every viewport mutation updates the URL. Stable identity. */
  notifyChange: () => void;
  /** Collapse a resolved `#a=`/`#b=` hash to the live `#view=…` form after an
   *  annotation deep-link restore, as the `#b=` bootstrap does. Stable identity. */
  collapseDeepLinkHash: () => Promise<void>;
} {
  const fetchSavedViewByIdRef = useRef(fetchSavedViewById);
  const onSavedViewMissingRef = useRef(onSavedViewMissing);
  const fetchDefaultSavedViewRef = useRef(fetchDefaultSavedView);
  const fetchViewerProfileRef = useRef(fetchViewerProfile);
  const fetchLastViewRef = useRef(fetchLastView);
  const persistLastViewRef = useRef(persistLastView);
  const restoreEnabledRef = useRef(restoreLastViewEnabled);
  // Resolvers are read at call time from event handlers and from inside apply,
  // so refs track the latest props without rebuilding the bundle.
  const dimensionExtentsForRef = useRef(dimensionExtentsFor);
  const labelNamesForRef = useRef(labelNamesFor);
  // eslint-disable-next-line react-hooks/refs
  dimensionExtentsForRef.current = dimensionExtentsFor;
  // eslint-disable-next-line react-hooks/refs
  labelNamesForRef.current = labelNamesFor;
  // eslint-disable-next-line react-hooks/refs
  fetchSavedViewByIdRef.current = fetchSavedViewById;
  // eslint-disable-next-line react-hooks/refs
  onSavedViewMissingRef.current = onSavedViewMissing;
  // eslint-disable-next-line react-hooks/refs
  fetchDefaultSavedViewRef.current = fetchDefaultSavedView;
  // eslint-disable-next-line react-hooks/refs
  fetchViewerProfileRef.current = fetchViewerProfile;
  // eslint-disable-next-line react-hooks/refs
  fetchLastViewRef.current = fetchLastView;
  // eslint-disable-next-line react-hooks/refs
  persistLastViewRef.current = persistLastView;
  // eslint-disable-next-line react-hooks/refs
  restoreEnabledRef.current = restoreLastViewEnabled;

  // Built once via useState's initializer, so the capture keeps one identity
  // and nothing keyed on it re-runs on a render. `autoContrastMapRef` is read
  // inside the capture, which fires from event handlers, never during render,
  // so the react-hooks/refs warning is a false positive here.
  // eslint-disable-next-line react-hooks/refs
  const [bundle] = useState<SyncBundle>(() => {
    const urlByDatasetId = new Map<string, string>();
    const capture = (): SavedView | null => {
      const scene = getScene();
      if (!scene) return null;
      try {
        return buildCapture({
          scene,
          urlByDatasetId,
          datasetReferenceMode,
          autoContrastByDatasetId: autoContrastMapRef.current ?? undefined,
          labelNamesFor: (id) => labelNamesForRef.current?.(id),
        });
      } catch (e) {
        console.warn("[SavedView] capture failed:", e);
        return null;
      }
    };
    const applier = new SavedViewApplier(
      {
        sendOpenRemoteDataset: (url: string) => {
          if (datasetReferenceMode === "source-url") {
            urlByDatasetId.set(dataset_id_for_url(url), url);
          }
          sendOpenRemoteDataset(url);
        },
      sendCommand,
      },
      getScene,
      dataset_id_for_url,
      30_000,
      datasetReferenceMode,
      layoutMutation,
      (datasetId) => dimensionExtentsForRef.current?.(datasetId) ?? {},
      (datasetId) => labelNamesForRef.current?.(datasetId),
    );
    const urlSync = new UrlSync(capture, applier, {
      debounceMs,
      fetchSavedViewById: async (id) => fetchSavedViewByIdRef.current?.(id) ?? null,
      onSavedViewMissing: (id) => onSavedViewMissingRef.current?.(id),
      fetchDefaultSavedView: async () => fetchDefaultSavedViewRef.current?.() ?? null,
      fetchViewerProfile: async (profile) => fetchViewerProfileRef.current?.(profile) ?? null,
      // Read at call time so a resolver wired later (once auth resolves) takes
      // effect. With none wired it returns null and the bootstrap falls back to
      // the default. The toggle gate lives inside UrlSync.
      fetchLastView: async () => fetchLastViewRef.current?.() ?? null,
      restoreLastViewEnabled: () =>
        (restoreEnabledRef.current ?? getRestoreLastViewEnabled)(),
    });
    return { applier, urlSync, urlByDatasetId, capture };
  });
  const captureBuilder = bundle.capture;

  // Every local open goes through here (browse pane, URL bar, applier) so the
  // URL to DatasetId map stays complete.
  const trackedSendOpen = useCallback((url: string) => {
    if (datasetReferenceMode === "source-url") {
      bundle.urlByDatasetId.set(dataset_id_for_url(url), url);
    }
    sendOpenRemoteDataset(url);
  }, [bundle.urlByDatasetId, datasetReferenceMode, sendOpenRemoteDataset]);

  useEffect(() => {
    bundle.urlSync.start();
    return () => bundle.urlSync.destroy();
  }, [bundle.urlSync]);

  // When the scene first becomes available, apply any `#view=…` payload.
  // Safe to repeat: bootstrap is a no-op without a hash, and the applier
  // rejects re-entry.
  useEffect(() => {
    const scene = getScene();
    if (!scene) return;
    bundle.urlSync.bootstrap().catch((e) => {
      console.warn("[SavedView] bootstrap failed:", e);
    });
    // The trigger is `getScene()` turning non-null, once per scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle.urlSync, !!getScene()]);

  useEffect(() => {
    bundle.urlSync.notifyChange();
  }, [bundle.urlSync, changeTick]);

  // Debounced "remember my last view" capture, armed by the same change signal
  // as the URL sync and by any move of the camera or the selectors, which
  // reach the scene without a render. Neither persists an unframed view. Runs
  // only when `persistLastView` is wired (absent in auth-off mode) and the
  // toggle is on. Failures (offline, non-member 403/404, encode error) are
  // logged, never thrown into the UI.
  const lastViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armLastView = useCallback(() => {
    if (lastViewTimerRef.current !== null) clearTimeout(lastViewTimerRef.current);
    lastViewTimerRef.current = null;
    // Return before `setTimeout`: an armed-then-cancelled timer would still
    // make a headless run wait out the debounce before it could quit.
    if (captureSurface) return;
    // Setup gate only. Both checks run again at fire time, since either can
    // change during the debounce.
    if (!persistLastViewRef.current) return;
    if (!(restoreEnabledRef.current ?? getRestoreLastViewEnabled)()) return;
    lastViewTimerRef.current = setTimeout(() => {
      lastViewTimerRef.current = null;
      // Skip mid-apply so we don't persist the view being applied rather than
      // one the user navigated to.
      if (!(restoreEnabledRef.current ?? getRestoreLastViewEnabled)()) return;
      const persistNow = persistLastViewRef.current;
      if (!persistNow) return;
      if (bundle.applier.isInProgress()) return;
      const view = captureBuilder();
      if (!view || !isPersistable(view)) return;
      void Promise.resolve(persistNow(view)).catch((e) => {
        console.warn("[SavedView] last-view capture failed:", e);
      });
    }, lastViewDebounceMs);
  }, [bundle.applier, captureBuilder, lastViewDebounceMs, captureSurface]);
  useEffect(() => () => {
    if (lastViewTimerRef.current !== null) clearTimeout(lastViewTimerRef.current);
  }, []);

  useEffect(() => {
    armLastView();
  }, [armLastView, changeTick]);

  useEffect(() => {
    if (!sceneStore) return;
    let seen: ViewEpochs | null = sceneStore.getEpochs();
    return sceneStore.subscribe(() => {
      const epochs = sceneStore.getEpochs();
      if (epochs === seen) return;
      const moved =
        seen !== null &&
        epochs !== null &&
        (epochs.view !== seen.view || epochs.selection !== seen.selection);
      seen = epochs;
      if (!moved) return;
      // A resize or a new pixel ratio moves the view with no control touched.
      bundle.urlSync.notifyChange();
      armLastView();
    });
  }, [sceneStore, armLastView, bundle.urlSync]);

  useEffect(() => {
    if (!onApplyResult) return;
    return bundle.applier.subscribeApplyResult((r) => {
      onApplyResult(r.firstVisibleDatasetId);
    });
  }, [bundle.applier, onApplyResult]);

  // The applier writes the scene, which the readers of view state follow on
  // their own. What it leaves to this hook is the auto-contrast preference
  // and the render loop.
  useEffect(() => {
    return bundle.applier.subscribeApplyComplete((view) => {
      // Capture strips defaults, so an absent entry means `true` and only
      // explicit `false` entries need restoring.
      if (view.auto_contrast) {
        setAutoContrastMap((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [id, flag] of Object.entries(view.auto_contrast!)) {
            if (next.get(id) !== flag) {
              next.set(id, flag);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      invalidateAfterViewRestore(loopRef.current, "savedview_apply");
    });
  }, [bundle.applier, loopRef, setAutoContrastMap]);

  const notifyChange = useCallback(() => {
    bundle.urlSync.notifyChange();
  }, [bundle.urlSync]);

  const collapseDeepLinkHash = useCallback(
    () => bundle.urlSync.collapseToLiveView(),
    [bundle.urlSync],
  );

  return useMemo(() => ({
    applier: bundle.applier,
    captureBuilder,
    trackedSendOpen,
    notifyChange,
    collapseDeepLinkHash,
  }), [bundle.applier, captureBuilder, trackedSendOpen, notifyChange, collapseDeepLinkHash]);
}
