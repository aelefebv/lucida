// Wires the savedView module suite into the React tree:
//   - URL→DatasetId tracking in source-url mode (populated on local
//     opens; resolved on incoming DatasetOpened broadcasts via
//     blake3-prefix derivation).
//   - SavedViewApplier (recipient apply orchestrator).
//   - UrlSync (debounced URL writes + bootstrap + popstate).
//
// Mounted in App.tsx after the bridge hook so it can hand the applier
// `sendCommand` + `sendOpenRemoteDataset` directly. Subscribes to scene
// epochs to drive the debounced URL writes — see
// `wiki/systems/subsystems/scene-state-and-epochs.md`.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { dataset_id_for_url } from "lucida-core";
import { SavedViewApplier, type DimensionExtentsResolver } from "../savedView/applier.ts";
import { UrlSync } from "../savedView/urlSync.ts";
import { buildCapture } from "../savedView/captureBuilder.ts";
import { getRestoreLastViewEnabled } from "../lastViewPreference.ts";
import type { DatasetReferenceMode, SavedView, ViewState } from "../savedView/types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";
import { syncSceneViewState } from "./sceneViewState.ts";

interface Params {
  /** Returns the live `WasmScene`, or null if not yet loaded. */
  getScene: () => WasmScene | null;
  /** Bridge functions sourced from `useBridge`. */
  sendOpenRemoteDataset: (url: string) => void;
  sendCommand: (json: string) => void;
  /** Tick that increments whenever the scene mutates locally — used to
   * drive URL re-encoding. We piggyback on the existing
   * `remoteDocumentVersion` + `datasetsVersion` counters. */
  changeTick: number;
  /** Debounce override for tests. Default 350. */
  debounceMs?: number;
  /** Callback fired after every successful apply; resolves the
   *  selected-dataset wrinkle ([[wiki/queue]] 2026-05-07, option c) by
   *  letting App.tsx re-target `selectedDatasetId` at the first visible
   *  dataset on apply (so dimension/contrast controls operate on
   *  something the user can see). */
  onApplyResult?: (firstVisibleDatasetId: string | null) => void;
  /** Render loop ref. The applier writes to WASM only; without marking
   *  interactive+residency dirty, the RAF-pull-based loop sits idle
   *  until the next user input (Bug #2 root cause). */
  loopRef: React.RefObject<RenderLoop | null>;
  /** Reads the authoritative live Z/T/C as a `ViewState` from the React
   *  dimension state. Captured verbatim by `buildCapture` so "Save view"
   *  records what the user is actually looking at — independent of whether
   *  the live slab/timepoint/channel has been flushed into the WASM scene
   *  yet (the capture root cause: scene presence can still report the
   *  default `z_range {0,1}`). Returns null when no scene/dims exist.
   *  Optional: when omitted, capture falls back to the scene's presence
   *  view (legacy behavior). */
  getLiveView?: () => ViewState | null;
  /** Resolves the recipient's per-dataset T/C extents (counts) so an
   *  applied view's out-of-range timepoint/channel clamps to fit. Sourced
   *  from the live manifest-derived dimension union; Z is handled by the
   *  applier via the scene's volume shape. Optional — omit to leave t/c
   *  unclamped. */
  dimensionExtentsFor?: DimensionExtentsResolver;
  /** React-side dim mirrors. The applier writes set_c/set_t/set_z_range
   *  to WASM; without these the C/T/Z sliders stay stale (e.g. bookmark
   *  saved on ch2 opens with the C slider showing 0; Bug #3 root cause). */
  setC: React.Dispatch<React.SetStateAction<number>>;
  setT: React.Dispatch<React.SetStateAction<number>>;
  setZ: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<React.SetStateAction<"2d" | "3d">>;
  setMultiChannel: React.Dispatch<React.SetStateAction<boolean>>;
  /** Per-dataset auto-contrast preference (read for capture, restored on
   *  apply). Lives in `useDatasetSettings.autoContrastMap`. Without this
   *  round-trip, recipient's auto-contrast immediately overwrites the
   *  captured contrast values via the intensity batcher. */
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  setAutoContrastMap: React.Dispatch<React.SetStateAction<Map<string, boolean>>>;
  datasetReferenceMode?: DatasetReferenceMode;
  fetchSavedViewById?: (id: string) => Promise<{ id: string; view: SavedView } | null>;
  fetchDefaultSavedView?: () => Promise<{ id: string; view: SavedView } | null>;
  fetchViewerProfile?: (profile: string) => Promise<{ id: string; view: SavedView } | null>;
  /** Resolve the caller's own remembered last view for a bare workspace open
   *  (#700). When omitted, last-view restore is disabled (the bootstrap falls
   *  back to the workspace default). */
  fetchLastView?: () => Promise<{ id: string; view: SavedView } | null>;
  /** Persist the current view as the caller's last view (#700), debounced on
   *  view-change. When omitted (auth-off mode), capture is disabled and no
   *  server call is ever made. Errors degrade silently — never thrown to UI. */
  persistLastView?: (view: SavedView) => Promise<unknown>;
  /** Whether the per-user "restore my last view" toggle is on. Defaults to the
   *  localStorage-backed preference; injectable for tests. Gates BOTH restore
   *  (bootstrap) and capture. */
  restoreLastViewEnabled?: () => boolean;
  /** Debounce for the last-view capture (#700). A few seconds so a burst of
   *  pans coalesces into one write. Default 3000ms; overridable for tests. */
  lastViewDebounceMs?: number;
  allowDocumentLayoutMutation?: boolean;
}

interface SyncBundle {
  applier: SavedViewApplier;
  urlSync: UrlSync;
  urlByDatasetId: Map<string, string>;
}

export function useSavedViewSync({
  getScene,
  sendOpenRemoteDataset,
  sendCommand,
  changeTick,
  debounceMs,
  onApplyResult,
  loopRef,
  getLiveView,
  dimensionExtentsFor,
  setC,
  setT,
  setZ,
  setViewMode,
  setMultiChannel,
  autoContrastMapRef,
  setAutoContrastMap,
  datasetReferenceMode = "source-url",
  fetchSavedViewById,
  fetchDefaultSavedView,
  fetchViewerProfile,
  fetchLastView,
  persistLastView,
  restoreLastViewEnabled,
  lastViewDebounceMs = 3000,
  allowDocumentLayoutMutation = true,
}: Params): {
  applier: SavedViewApplier;
  captureBuilder: () => SavedView | null;
  trackedSendOpen: (url: string) => void;
  /** Schedule a debounced URL write. App.tsx wraps this into the
   *  `emitPresence`/`emitDatasetPresence` callbacks so every viewport
   *  mutation co-taps the URL (Bug #1 fix). Stable identity. */
  notifyChange: () => void;
  /** Collapse a resolved `#a=`/`#b=` hash to the live `#view=…` form — used by
   *  App.tsx after restoring an annotation deep-link (slice 3), exactly as the
   *  `#b=` bootstrap collapses after its apply. Stable identity. */
  collapseDeepLinkHash: () => Promise<void>;
} {
  const fetchSavedViewByIdRef = useRef(fetchSavedViewById);
  const fetchDefaultSavedViewRef = useRef(fetchDefaultSavedView);
  const fetchViewerProfileRef = useRef(fetchViewerProfile);
  const fetchLastViewRef = useRef(fetchLastView);
  const persistLastViewRef = useRef(persistLastView);
  const restoreEnabledRef = useRef(restoreLastViewEnabled);
  // Live-view + extents resolvers are read at call time (capture fires
  // from event handlers; extents from inside apply), so keep them in refs
  // that track the latest props without relifting the bundle initializer.
  const getLiveViewRef = useRef(getLiveView);
  const dimensionExtentsForRef = useRef(dimensionExtentsFor);
  // eslint-disable-next-line react-hooks/refs
  getLiveViewRef.current = getLiveView;
  // eslint-disable-next-line react-hooks/refs
  dimensionExtentsForRef.current = dimensionExtentsFor;
  // eslint-disable-next-line react-hooks/refs
  fetchSavedViewByIdRef.current = fetchSavedViewById;
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

  // Construct everything lazily on first render via useState's initializer
  // (runs exactly once). The captured `autoContrastMapRef` is read at
  // call-time inside captureFn (which fires from event handlers), not
  // during the initializer pass — so the new "passing a ref to a function
  // may read its value during render" rule is a false positive here.
  // eslint-disable-next-line react-hooks/refs
  const [bundle] = useState<SyncBundle>(() => {
    const urlByDatasetId = new Map<string, string>();
    const captureFn = (): SavedView | null => {
      const scene = getScene();
      if (!scene) return null;
      try {
        return buildCapture({
          scene,
          urlByDatasetId,
          datasetReferenceMode,
          autoContrastByDatasetId: autoContrastMapRef.current ?? undefined,
          // Authoritative live Z/T/C from React; falls back to the scene's
          // presence view inside buildCapture when null.
          liveView: getLiveViewRef.current?.() ?? undefined,
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
      allowDocumentLayoutMutation,
      // Read the resolver from the ref at call time so updates to the
      // recipient's manifest-derived extents take effect across applies.
      (datasetId) => dimensionExtentsForRef.current?.(datasetId) ?? {},
    );
    const urlSync = new UrlSync(captureFn, applier, {
      debounceMs,
      fetchSavedViewById: async (id) => fetchSavedViewByIdRef.current?.(id) ?? null,
      fetchDefaultSavedView: async () => fetchDefaultSavedViewRef.current?.() ?? null,
      fetchViewerProfile: async (profile) => fetchViewerProfileRef.current?.(profile) ?? null,
      // Read the resolver from the ref at call time so enabling it later
      // (e.g. once auth resolves) takes effect; when no resolver is wired it
      // returns null, so the bootstrap's priority sees `hasLastView: false`
      // and falls back to the default. The toggle gate lives inside UrlSync.
      fetchLastView: async () => fetchLastViewRef.current?.() ?? null,
      restoreLastViewEnabled: () =>
        (restoreEnabledRef.current ?? getRestoreLastViewEnabled)(),
    });
    return { applier, urlSync, urlByDatasetId };
  });

  // Public capture builder that closes over the same map.
  const captureBuilder = useCallback((): SavedView | null => {
    const scene = getScene();
    if (!scene) return null;
    try {
      return buildCapture({
        scene,
        urlByDatasetId: bundle.urlByDatasetId,
        datasetReferenceMode,
        autoContrastByDatasetId: autoContrastMapRef.current ?? undefined,
        // Authoritative live Z/T/C from React (read via ref so the share
        // button captures the user's actual slab/timepoint/channel even if
        // it hasn't been flushed to the scene yet).
        liveView: getLiveViewRef.current?.() ?? undefined,
      });
    } catch (e) {
      console.warn("[SavedView] capture failed:", e);
      return null;
    }
  }, [getScene, bundle.urlByDatasetId, datasetReferenceMode, autoContrastMapRef]);

  // Wrap user-facing sendOpenRemoteDataset so URL→DatasetId tracking
  // catches every local open (FileBrowser, URL bar, applier).
  const trackedSendOpen = useCallback((url: string) => {
    if (datasetReferenceMode === "source-url") {
      bundle.urlByDatasetId.set(dataset_id_for_url(url), url);
    }
    sendOpenRemoteDataset(url);
  }, [bundle.urlByDatasetId, datasetReferenceMode, sendOpenRemoteDataset]);

  // Mount popstate listener; tear it down on unmount.
  useEffect(() => {
    bundle.urlSync.start();
    return () => bundle.urlSync.destroy();
  }, [bundle.urlSync]);

  // Bootstrap: when the scene first becomes available, decode and apply
  // any `#view=…` payload. Idempotent — UrlSync.bootstrap is a no-op if
  // there's no hash, and the applier rejects re-entry.
  useEffect(() => {
    const scene = getScene();
    if (!scene) return;
    bundle.urlSync.bootstrap().catch((e) => {
      console.warn("[SavedView] bootstrap failed:", e);
    });
    // Only run once per scene becoming available — `getScene` returning
    // a non-null result is the trigger, and the applier guards re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle.urlSync, !!getScene()]);

  // Schedule a debounced URL write whenever the scene changes.
  useEffect(() => {
    bundle.urlSync.notifyChange();
  }, [bundle.urlSync, changeTick]);

  // Debounced "remember my last view" capture (#700). Piggybacks on the same
  // change signal that drives the URL/presence sync, but with a longer
  // debounce (a few seconds) so a burst of pans coalesces into one write.
  //
  // Fires only when (a) a `persistLastView` callback is wired — absent in
  // auth-off mode, so NO server call is ever made there — and (b) the
  // per-user toggle is on. The capture is wrapped so a build/persist failure
  // (offline, non-member 403/404, encode error) degrades silently and never
  // throws into the UI. We skip while an apply is in progress so we don't
  // persist a view the recipient is mid-applying rather than one the user
  // navigated to.
  useEffect(() => {
    // Cheap setup gate: skip scheduling entirely when capture can't apply
    // (no callback = auth-off, or toggle off). The authoritative checks run
    // again at fire time below, since both can change during the debounce.
    if (!persistLastViewRef.current) return;
    if (!(restoreEnabledRef.current ?? getRestoreLastViewEnabled)()) return;
    const timer = setTimeout(() => {
      // Re-read at fire time: the toggle may have flipped, or an apply may be
      // mid-flight (don't persist a view the recipient is applying rather than
      // one the user navigated to).
      if (!(restoreEnabledRef.current ?? getRestoreLastViewEnabled)()) return;
      const persistNow = persistLastViewRef.current;
      if (!persistNow) return;
      if (bundle.applier.isInProgress()) return;
      const view = captureBuilder();
      if (!view) return;
      void Promise.resolve(persistNow(view)).catch((e) => {
        // Non-member / offline / auth-off race: never surface to the UI.
        console.warn("[SavedView] last-view capture failed:", e);
      });
    }, lastViewDebounceMs);
    return () => clearTimeout(timer);
  }, [bundle.applier, captureBuilder, changeTick, lastViewDebounceMs]);

  // Selected-dataset wrinkle (option c): subscribe to the applier's
  // post-apply summary and forward to the parent so it can re-target
  // `selectedDatasetId` at the first visible dataset. Subscription
  // installs once per applier and lifts/relifts when the consumer
  // changes its callback identity.
  useEffect(() => {
    if (!onApplyResult) return;
    return bundle.applier.subscribeApplyResult((r) => {
      onApplyResult(r.firstVisibleDatasetId);
    });
  }, [bundle.applier, onApplyResult]);

  // Apply-complete: refresh the render loop (Bug #2) and push post-apply
  // C/T/Z/viewMode/multiChannel back to React state (Bug #3). The applier writes to
  // WASM only; without this the RAF loop sits idle until the next user
  // input and the slider mirrors stay stale. Mirrors the bridge's
  // follow/presence-update flow (sessionController.ts onPresenceUpdate / onFollowChanged).
  useEffect(() => {
    return bundle.applier.subscribeApplyComplete((view) => {
      const scene = getScene();
      if (!scene) return;
      try {
        syncSceneViewState(scene, { setZ, setT, setC, setViewMode, setMultiChannel });
      } catch (e) {
        console.warn("[SavedView] post-apply state read failed:", e);
      }
      // Restore client-only auto-contrast preference. Without this, the
      // recipient's intensity batcher (default `true` per dataset)
      // immediately overwrites the captured contrast values. Per the
      // capture rule (defaults stripped), absent entries mean `true`;
      // explicit `false` entries are the meaningful ones to restore.
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
      bumpSettingsGeneration();
      loopRef.current?.markInteractiveDirty("savedview_apply");
      loopRef.current?.markResidencyDirty("savedview_apply");
    });
  }, [bundle.applier, getScene, loopRef, setC, setT, setZ, setViewMode, setMultiChannel, setAutoContrastMap]);

  // Stable notifyChange: App.tsx wraps emitPresence/emitDatasetPresence
  // so every viewport mutation co-taps the URL (Bug #1 fix). Forwards
  // to the underlying UrlSync; identity is stable across renders.
  const notifyChange = useCallback(() => {
    bundle.urlSync.notifyChange();
  }, [bundle.urlSync]);

  // Collapse a resolved `#a=`/`#b=` hash to the live `#view=…` form. Forwards to
  // the underlying UrlSync; stable identity across renders.
  const collapseDeepLinkHash = useCallback(
    () => bundle.urlSync.collapseToLiveView(),
    [bundle.urlSync],
  );

  return {
    applier: bundle.applier,
    captureBuilder,
    trackedSendOpen,
    notifyChange,
    collapseDeepLinkHash,
  };
}
