import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { FocalDepthControl } from "./components/FocalDepthControl.tsx";
import { LayerPanel } from "./components/LayerPanel.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { PeerCursors, type CursorLabel } from "./components/PeerCursors.tsx";
import { AnnotationOverlay } from "./components/AnnotationOverlay.tsx";
import type { Annotation, AnnotationOverlayHandle } from "./components/annotationDocument.ts";
import { AnnotationOverlay3D } from "./components/AnnotationOverlay3D.tsx";
import { AnnotationDraftOverlay } from "./components/AnnotationDraftOverlay.tsx";
import type { AnnotationDraft } from "./components/annotationDraft.ts";
import { MentionsOfMe } from "./components/MentionsOfMe.tsx";
import {
  currentDatasetAnnotations,
  resolveAnnotationDatasetId,
} from "./components/currentDatasetAnnotations.ts";
import { FpsCounter } from "./components/FpsCounter.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { CollectionSelector, extractCollectionData } from "./components/CollectionSelector.tsx";
import { frameRect } from "./components/groupFraming.ts";
import { ShareToolbarButton } from "./components/ShareToolbarButton.tsx";
import { LoadingViewBanner } from "./components/LoadingViewBanner.tsx";
import { ImportWarningBanner } from "./components/ImportWarningBanner.tsx";
import { WorkspaceSavedViewsSidebar } from "./components/WorkspaceSavedViewsSidebar.tsx";
import { ExplorationPanel, type Dims } from "./components/ExplorationPanel.tsx";
import { makeThumbnailRequester } from "./exploreThumbnails.ts";
import { WorkspaceSharingDialog } from "./WorkspaceSharingDialog.tsx";
import { applyViewportCommand } from "./applyAndSend.ts";
import {
  invalidateDisplaySettings,
  invalidateAfterViewRestore,
  requestRender,
} from "./invalidation.ts";
import { annotationAuthorId } from "./annotationIdentity.ts";
import { deriveMentionCandidates } from "./components/annotationParticipants.ts";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import { useAuthSession } from "./auth/AuthSession.ts";
import {
  DEBUG_OVERLAYS,
  getRenderRadiusPreviewTier,
  isOverlayEnabled,
  onOverlaysChanged,
  onRenderRadiusPreviewChanged,
} from "./debug/logging.ts";
import type { DatasetState } from "./types.ts";
import { useWasmScene } from "./hooks/useWasmScene.ts";
import { useRenderClient } from "./hooks/useRenderClient.ts";
import { useLayout } from "./hooks/useLayout.ts";
import { useDatasetSettings, type BridgeCallbacks, type DatasetCallbacks } from "./hooks/useDatasetSettings.ts";
import { useDimensions } from "./hooks/useDimensions.ts";
import { useBridge } from "./hooks/useBridge.ts";
import { useDatasets } from "./hooks/useDatasets.ts";
import { useSeedDatasetOpens } from "./hooks/useSeedDatasetOpens.ts";
import { useIntensityBatcher } from "./hooks/useIntensityBatcher.ts";
import { useDatasetLevels } from "./hooks/useDatasetLevels.ts";
import { useSavedViewSync } from "./hooks/useSavedViewSync.ts";
import { useScriptControls } from "./hooks/useScriptControls.ts";
import { useViewedMentions } from "./hooks/useViewedMentions.ts";
import type { SavedView } from "./savedView/types.ts";
import { restoreAnnotationView } from "./savedView/restoreAnnotationView.ts";
import { useAnnotationDeepLink } from "./hooks/useAnnotationDeepLink.ts";
import {
  getWorkspaceSavedView,
  getWorkspaceViewerProfile,
  getWorkspaceSharing,
  getWorkspaceUserState,
  updateWorkspaceLastView,
  createWorkspaceSavedView,
} from "./workspaceApi.ts";
import type { WorkspaceRole, WorkspaceMember } from "./workspaceApi.ts";
import { isCaptureSurface } from "./captureSurface.ts";
import { setBundleServices } from "./trace/bundle.ts";
import { visibleRectOf } from "./trace/flatFrame.ts";
import { currentChunkSelection, onChunkSelectionChanged } from "./trace/linkedSelection.ts";
import { setReportSender } from "./trace/reportInbox.ts";
import { useHudKeyBinding } from "./hud/useHudKey.ts";
import "./App.css";

// The debug UI is code-split: the panel loads on first open, the overlay layer
// only when an overlay is on or a radius preview is being dragged. The main
// bundle keeps only the small gate module, debug/logging.ts.
const DevControls = lazy(() =>
  import("./debug/DevControls.tsx").then((m) => ({ default: m.DevControls })),
);
const DebugOverlays = lazy(() =>
  import("./debug/DebugOverlays.tsx").then((m) => ({ default: m.DebugOverlays })),
);
// Ships in every build, code-split so a session that never opens it never
// downloads it.
const MonitorDock = lazy(() =>
  import("./monitor/MonitorDock.tsx").then((m) => ({ default: m.MonitorDock })),
);
// Code-split for the same reason: the HUD is in every build, and most sessions never show it.
const Hud = lazy(() => import("./hud/Hud.tsx").then((m) => ({ default: m.Hud })));

interface AppProps {
  workspaceId: string;
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  defaultSavedViewId: string | null;
  canRenameWorkspace: boolean;
  /** Canonical dataset URLs to open once the viewer connects, set by the
   *  create-workspace-from-datasets flow. A failed open shows the normal
   *  banner and leaves the workspace in place. */
  initialDatasetUrls?: readonly string[];
  onBackToDashboard: () => void;
  onRenameWorkspace: (name: string) => Promise<void>;
  onSetDefaultSavedView: (savedViewId: string | null) => Promise<void>;
  /** Create a new workspace from file-browser selections and navigate into
   *  it, as the dashboard does. */
  onCreateWorkspaceFromDatasets?: (paths: string[]) => void;
}

function App({
  workspaceId,
  workspaceName,
  workspaceRole,
  defaultSavedViewId,
  canRenameWorkspace,
  initialDatasetUrls,
  onBackToDashboard,
  onRenameWorkspace,
  onSetDefaultSavedView,
  onCreateWorkspaceFromDatasets,
}: AppProps) {
  // Provided by <AuthGate>; throws when unauthenticated. The email feeds the
  // saved-view "Mine only" filter.
  const authSession = useAuthSession();

  // Browser-persisted author identity, used only for annotation `author` and
  // ownership checks; `bridge.myId` stays the presence/cursor/follow identity.
  // Persisting it lets a returning user keep control of what they authored.
  const annotationAuthor = useMemo(() => annotationAuthorId(), []);

  const scene = useWasmScene();
  const render = useRenderClient();
  // `?render=1` is the chrome-free capture surface for `dataset montage`,
  // `dataset explore`, and the trace driver: no UI chrome and no persisted
  // writes. Read `captureSurface.ts` before wiring anything new in here.
  const captureSurface = useMemo(() => isCaptureSurface(), []);
  const layout = useLayout({ loopRef: render.loopRef, captureSurface });

  const datasetsRef = useRef<Map<string, DatasetState>>(new Map());
  // Lifted here because call ordering stops the hooks that use it from owning it.
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  // Which annotation shape a shift-drag draws: a point pin (drop), a line
  // (drag between two points), or a box (drag between opposite corners).
  const [annotationKind, setAnnotationKind] = useState<"point" | "line" | "box">("point");
  // Personal show/hide of all annotations: local, unsynced, not persisted, and
  // passed as `visible` to both overlays.
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  // Lets the mentions inbox jump to a pin, although each overlay owns its
  // `openPinId`.
  const overlay2dRef = useRef<AnnotationOverlayHandle | null>(null);
  const overlay3dRef = useRef<AnnotationOverlayHandle | null>(null);
  // The canvas gesture handlers write the in-progress box or line here, and
  // AnnotationDraftOverlay renders it live.
  const annotationDraftRef = useRef<AnnotationDraft | null>(null);
  const [datasetsVersion, setDatasetsVersion] = useState(0);
  const [remoteDocumentVersion, setRemoteDocumentVersion] = useState(0);
  // Roster for @-mention candidates, so a collaborator can be mentioned before
  // they touch the document. Best-effort: sharing is owner-only and unavailable
  // offline, so this may stay `[]` and the picker uses document participants.
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [cameraMode, setCameraMode] = useState<string>("arcball");
  // A brief notice when the light annotation-view restore had to clamp z/t/c to
  // fit the pin's dataset. Auto-cleared.
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  // Set when `#a=<id>` doesn't resolve in the loaded document. Separate from
  // `restoreNotice` so neither clobbers the other. A recipient without access
  // fails at the workspace gate first, so this never reveals whether an
  // annotation exists.
  const [deepLinkNotFound, setDeepLinkNotFound] = useState(false);
  const [workspaceNameEdit, setWorkspaceNameEdit] = useState({
    source: workspaceName,
    value: workspaceName,
  });
  const bumpDatasetsVersion = useCallback(() => setDatasetsVersion(v => v + 1), []);
  const bumpRemoteDocumentVersion = useCallback(() => setRemoteDocumentVersion(v => v + 1), []);
  const workspaceNameDraft = workspaceNameEdit.source === workspaceName
    ? workspaceNameEdit.value
    : workspaceName;
  const canEditWorkspace = workspaceRole !== "viewer";

  // Callback refs to break circular dependencies.
  // Populated after all hooks return but before effects run on first render.
  const bridgeCallbacksRef = useRef<BridgeCallbacks>({
    sendCommand: () => {},
    emitPresence: () => {},
    emitDatasetPresence: () => {},
    breakFollow: () => {},
  });
  const datasetCallbacksRef = useRef<DatasetCallbacks>({
    removeDataset: () => {},
  });
  // Populated after useSavedViewSync constructs the applier (below).
  // The bridge calls into this on `dataset_opened` / `open_dataset_failed`.
  const savedViewHooksRef = useRef<{
    onDatasetOpened: (id: string) => void;
    onOpenDatasetFailed: (url: string, err: string) => void;
    isInProgress: () => boolean;
  } | null>(null);

  // Domain hooks (order matters: earlier hooks use refs for later hooks' values).

  const dims = useDimensions({
    wasmSceneRef: scene.wasmSceneRef,
    wasmScene: scene.wasmScene,
    selectedDatasetId,
    datasetsRef,
    datasetsVersion,
    bridgeCallbacksRef,
    loopRef: render.loopRef,
  });

  const datasetLevels = useDatasetLevels({
    clientReady: render.clientReady,
    clientRef: render.clientRef,
  });

  const layers = useDatasetSettings({
    wasmSceneRef: scene.wasmSceneRef,
    datasetsRef,
    loopRef: render.loopRef,
    selectedDatasetId,
    setSelectedDatasetId,
    bridgeCallbacksRef,
    datasetCallbacksRef,
    datasetsVersion,
    remoteDocumentVersion,
    viewMode: dims.viewMode,
    datasetLevels: datasetLevels.levels,
  });

  const bridge = useBridge({
    workspaceId,
    wasmReady: scene.wasmReady,
    wasmSceneRef: scene.wasmSceneRef,
    setWasmScene: scene.setWasmScene,
    ensureScene: scene.ensureScene,
    loopRef: render.loopRef,
    datasetsRef,
    datasetCallbacksRef,
    savedViewHooksRef,
    bumpLayerSettingsVersion: layers.bumpLayerSettingsVersion,
    initLayerMaps: layers.initLayerMaps,
    setZ: dims.setZ,
    setC: dims.setC,
    setT: dims.setT,
    setViewMode: dims.setViewMode,
    setMultiChannel: dims.setMultiChannel,
    setSelectedDatasetId,
    bumpDatasetsVersion,
    bumpRemoteDocumentVersion,
    onWorkspaceArchived: onBackToDashboard,
  });

  // On apply, re-target `selectedDatasetId` at the first
  // visible dataset so dimension/contrast controls land on something
  // the recipient can see. Stable identity so the subscribe effect in
  // useSavedViewSync doesn't relift every render.
  const handleApplyResult = useCallback((firstVisibleId: string | null) => {
    if (firstVisibleId === null) return;
    setSelectedDatasetId(firstVisibleId);
  }, []);

  const fetchWorkspaceSavedViewById = useCallback(async (id: string) => {
    const savedView = await getWorkspaceSavedView(workspaceId, id);
    return { id: savedView.id, view: savedView.view };
  }, [workspaceId]);

  const fetchDefaultWorkspaceSavedView = useCallback(async () => {
    if (!defaultSavedViewId) return null;
    const savedView = await getWorkspaceSavedView(workspaceId, defaultSavedViewId);
    return { id: savedView.id, view: savedView.view };
  }, [workspaceId, defaultSavedViewId]);

  const fetchWorkspaceViewerProfile = useCallback(async (profile: string) => {
    const record = await getWorkspaceViewerProfile(workspaceId, profile);
    if (!record) return null;
    return { id: `viewer_profile:${record.profile}`, view: record.view };
  }, [workspaceId]);

  // "Remember my last view" for a bare /w/:id open: the caller's own view, or
  // null to fall back to the workspace default. UrlSync owns the toggle and the
  // URL-hash precedence.
  const fetchWorkspaceLastView = useCallback(async () => {
    const state = await getWorkspaceUserState(workspaceId);
    if (!state.last_view) return null;
    return { id: `last-view:${workspaceId}`, view: state.last_view };
  }, [workspaceId]);

  // Persist the caller's current view as their last view, scoped to the
  // principal; never the shared default. Errors degrade silently (offline,
  // non-member, auth off).
  const persistWorkspaceLastView = useCallback(
    (view: SavedView) => updateWorkspaceLastView(workspaceId, view),
    [workspaceId],
  );

  // Live Z/T/C for "Save view" comes from React, because the scene's presence
  // export can lag and report the default slab, which the encoder strips. Slab
  // thickness comes from the scene, since React tracks only z_range.start.
  const getLiveView = useCallback((): SavedView["view"] | null => {
    const ws = scene.wasmSceneRef.current;
    let slabThickness = 1;
    if (ws) {
      try {
        const presence = JSON.parse(ws.export_presence()) as {
          view?: { z_range?: { start: number; end: number } };
        };
        const r = presence.view?.z_range;
        if (r && r.end > r.start) slabThickness = r.end - r.start;
      } catch {
        // Fall back to a single-plane slab if presence is unreadable.
      }
    }
    return {
      z_range: { start: dims.z, end: dims.z + slabThickness },
      t: dims.t,
      c: dims.c,
      multi_channel: dims.multiChannel,
    };
    // wasmSceneRef is a stable ref; reading .current at call time is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims.z, dims.t, dims.c, dims.multiChannel]);

  // Saved-view wiring. Must come after `useBridge`, whose functions the applier
  // needs, and before the savedViewHooksRef populate below.
  const savedViewSync = useSavedViewSync({
    getScene: () => scene.wasmSceneRef.current,
    sendOpenRemoteDataset: bridge.sendOpenRemoteDataset,
    sendCommand: bridge.sendCommand,
    // Any local or remote scene mutation bumps one of these. Viewport-only
    // changes bypass them and go through emitPresenceWithUrl.
    changeTick: datasetsVersion + remoteDocumentVersion,
    onApplyResult: handleApplyResult,
    loopRef: render.loopRef,
    getLiveView,
    dimensionExtentsFor: dims.dimensionExtentsFor,
    labelNamesFor: dims.labelNamesFor,
    setC: dims.setC,
    setT: dims.setT,
    setZ: dims.setZ,
    setViewMode: dims.setViewMode,
    setMultiChannel: dims.setMultiChannel,
    autoContrastMapRef: layers.autoContrastMapRef,
    setAutoContrastMap: layers.setAutoContrastMap,
    datasetReferenceMode: "workspace-dataset-id",
    fetchSavedViewById: fetchWorkspaceSavedViewById,
    fetchDefaultSavedView: fetchDefaultWorkspaceSavedView,
    fetchViewerProfile: fetchWorkspaceViewerProfile,
    fetchLastView: fetchWorkspaceLastView,
    persistLastView: persistWorkspaceLastView,
    // The capture surface reads views but never writes one back.
    captureSurface,
    // Restoring a view can change the shared active layout. A capture applies
    // it to its own scene only, so the picture is right and nobody else's is
    // touched; without edit rights the restore refuses and says so.
    layoutMutation: captureSurface ? "local" : canEditWorkspace ? "broadcast" : "refuse",
  });

  // The three callback-ref populate sites (savedViewHooksRef,
  // bridgeCallbacksRef, datasetCallbacksRef) run during render, after all hooks
  // return. That is load-bearing: populating in useEffect would leave the refs
  // empty for the first effect pass.
  // eslint-disable-next-line react-hooks/refs
  savedViewHooksRef.current = {
    onDatasetOpened: (id) => savedViewSync.applier.notifyDatasetOpened(id),
    onOpenDatasetFailed: (url, err) => savedViewSync.applier.notifyOpenFailed(url, err),
    // So the bridge can suppress auto-fit-on-open while a saved or last view is
    // restoring its own camera.
    isInProgress: () => savedViewSync.applier.isInProgress(),
  };

  const datasets = useDatasets({
    // Wrap so URL→DatasetId tracking is populated for every local open
    // (FileBrowser-driven, URL-bar-driven, applier-driven).
    sendOpenRemoteDataset: savedViewSync.trackedSendOpen,
  });

  // Open the seed datasets for the create-workspace-from-datasets flow through
  // the same path as the in-viewer "Open". Gated on `bridge.sessionReady`
  // (socket open and first snapshot applied), not `Boolean(bridge.bridge)`,
  // which flips while the socket is still connecting: `Bridge.send` has no
  // queue and would drop the send. A failed open leaves the workspace in place.
  useSeedDatasetOpens({
    initialDatasetUrls,
    ready: bridge.sessionReady,
    openDataset: datasets.handleUrlSubmit,
  });

  // Layout registry — null until WasmScene is set up; subscribe so the
  // CollectionSelector and LayoutSwitcher re-derive on layout changes (local or
  // peer). The version counter is the stable snapshot for useSyncExternalStore.
  const layoutRegistry = bridge.sessionRef.current?.ensureLayoutRegistry() ?? null;
  useSyncExternalStore(
    (cb) => layoutRegistry?.subscribe(cb) ?? (() => {}),
    () => layoutRegistry?.getVersion() ?? 0,
    () => 0,
  );

  // The applied saved view, highlighted in the sidebar. Cleared as soon as the
  // live view diverges (see `emitPresenceWithUrl`), so the highlight means "the
  // view on screen", not "the last row clicked".
  const [currentOpenSavedViewId, setCurrentOpenSavedViewId] = useState<string | null>(null);

  // Every viewport mutation also calls urlSync.notifyChange(), because
  // changeTick doesn't bump on viewport-only changes like pan or contrast.
  // Threaded to every caller of bridge.emitPresence.
  const emitPresenceWithUrl = useCallback(() => {
    bridge.emitPresence();
    savedViewSync.notifyChange();
    // The live view no longer matches the opened saved view. Guarded so it
    // doesn't re-render on every pan frame.
    setCurrentOpenSavedViewId((prev) => (prev === null ? prev : null));
  }, [bridge, savedViewSync]);
  const emitDatasetPresenceWithUrl = useCallback(() => {
    bridge.emitDatasetPresence();
    savedViewSync.notifyChange();
  }, [bridge, savedViewSync]);

  // Fetch the roster once per workspace; see `workspaceMembers`.
  useEffect(() => {
    let cancelled = false;
    getWorkspaceSharing(workspaceId)
      .then((sharing) => {
        if (!cancelled) setWorkspaceMembers(sharing.members);
      })
      .catch(() => {
        // Forbidden (non-owner), offline, or any error: no roster, just
        // participants. Reset so a previous workspace's roster never leaks in.
        if (!cancelled) setWorkspaceMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // The current dataset's annotations, read once per document or dataset change
  // and shared by the mention-candidate builder and the mentions inbox.
  const currentAnnotations = useMemo<Annotation[]>(() => {
    // With no selection, falls back to the first dataset with annotations, so a
    // peer's mention that lands before selection still counts.
    return currentDatasetAnnotations(scene.wasmSceneRef.current, selectedDatasetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on doc/dataset change; the scene is a stable ref.
  }, [scene.wasmSceneRef, selectedDatasetId, remoteDocumentVersion]);

  // Per-browser read state for the mentions inbox, persisted and scoped to the
  // selected dataset. Never synced.
  const { viewedCommentIds, markViewed } = useViewedMentions(selectedDatasetId);

  const mentionCandidates = useMemo(() => {
    return deriveMentionCandidates({
      annotations: currentAnnotations,
      currentUserId: annotationAuthor,
      members: workspaceMembers,
      currentUserEmail: authSession.principal.email,
    });
  }, [currentAnnotations, annotationAuthor, workspaceMembers, authSession.principal.email]);

  // Annotation navigation has two tiers. Gentle (a pin clicked on the canvas)
  // opens the thread and recenters, never touching camera, contrast, or zoom.
  // Explicit (a mention or "Go to author's view") restores the author's
  // captured view and falls back to gentle when the pin has none.
  //
  // `gentleOnContext` brings the pin on-context by matching its Z/T/C, breaking
  // follow, and emitting presence.
  const gentleOnContext = useCallback((pin: Annotation) => {
    const ws = scene.wasmSceneRef.current;
    const targetZ = pin.z ?? 0;
    const targetT = pin.t ?? 0;
    const targetC = pin.c ?? 0;
    let contextChanged = false;
    if (targetZ !== dims.z) {
      dims.setZ(targetZ);
      if (ws) applyViewportCommand(ws, { type: "set_z", z: targetZ });
      contextChanged = true;
    }
    if (targetT !== dims.t) {
      dims.setT(targetT);
      if (ws) applyViewportCommand(ws, { type: "set_t", t: targetT });
      contextChanged = true;
    }
    if (targetC !== dims.c) {
      dims.setC(targetC);
      if (ws) applyViewportCommand(ws, { type: "set_c", c: targetC });
      contextChanged = true;
    }
    if (contextChanged) {
      bridge.breakFollow();
      emitPresenceWithUrl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters/bridge/emit/scene ref; see note above.
  }, [dims.z, dims.t, dims.c]);

  // Focus a pin in whichever overlay is mounted for a GIVEN view mode (2D vs
  // 3D). Pass the mode explicitly because a just-restored 3D camera may have
  // flipped the view mode out from under the live `dims.viewMode` this render.
  const focusPinForMode = useCallback((pinId: string, mode: "2d" | "3d") => {
    const handle = mode === "3d" ? overlay3dRef.current : overlay2dRef.current;
    handle?.focusPin(pinId);
  }, []);

  // The explicit tier: restore the author's camera (switching 2D/3D mode before
  // focusing), z-slab/t/c, and display through `restoreAnnotationView`, which
  // issues only local ViewportCommands, then recenter on the pin. A pin without
  // a captured view takes the gentle path.
  const restoreCapturedView = useCallback((pin: Annotation, datasetIdOverride?: string) => {
    const ws = scene.wasmSceneRef.current;
    if (!ws || !pin.view) {
      // No captured view or no scene: take the gentle path, then focus.
      gentleOnContext(pin);
      const focus = () => focusPinForMode(pin.id, dims.viewMode);
      if (!annotationsVisible) {
        setAnnotationsVisible(true);
        requestAnimationFrame(focus);
      } else {
        focus();
      }
      return;
    }

    // Clamp against the pin's own dataset. A deep link passes it explicitly;
    // otherwise resolve it the way the pin set was read. With no selection,
    // `selectedDatasetId ?? ""` would clamp against the `[1,1,1]` sentinel and
    // collapse a deep Z to plane 0, so an unresolvable dataset passes
    // `undefined` and the clamp is skipped.
    const pinDatasetId =
      datasetIdOverride ?? resolveAnnotationDatasetId(ws, selectedDatasetId) ?? undefined;
    const result = restoreAnnotationView({
      scene: ws,
      view: pin.view,
      datasetId: pinDatasetId,
      dimensionExtentsFor: dims.dimensionExtentsFor,
      labelNamesFor: dims.labelNamesFor,
    });

    // The restore wrote only to WASM; mirror it into React so the sliders and
    // mode toggles aren't stale.
    dims.setZ(result.applied.zStart);
    dims.setT(result.applied.t);
    dims.setC(result.applied.c);
    if (pin.view.view.multi_channel !== undefined) {
      dims.setMultiChannel(pin.view.view.multi_channel);
    }
    if (result.cameraModeChanged) {
      dims.setViewMode(result.viewMode);
      try {
        setCameraMode(ws.camera_mode());
      } catch {
        // best-effort mirror; the scene command already switched the mode.
      }
    }
    bridge.breakFollow();
    emitPresenceWithUrl();
    invalidateAfterViewRestore(render.loopRef.current, "annotation_view_restore");

    // The clamp notice auto-clears below.
    setRestoreNotice(result.notice);

    // If the mode flipped or annotations were hidden, wait a frame so the right
    // overlay's ref exists. Focus with the restored mode, not the possibly stale
    // `dims.viewMode`.
    const focus = () => focusPinForMode(pin.id, result.viewMode);
    const needsRemount = result.cameraModeChanged || !annotationsVisible;
    if (!annotationsVisible) setAnnotationsVisible(true);
    if (needsRemount) {
      requestAnimationFrame(focus);
    } else {
      focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters/bridge/emit/render refs/scene ref; reactive deps listed.
  }, [dims.viewMode, dims.dimensionExtentsFor, dims.labelNamesFor, annotationsVisible, selectedDatasetId, gentleOnContext, focusPinForMode]);

  // A mention jump restores the author's view, or recenters gently when the pin
  // has none.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- the compiler infers the stable `setAnnotationsVisible` setter as a dep; the manual deps are the reactive values actually read.
  const handleNavigateToMention = useCallback((pinId: string) => {
    const pin = currentAnnotations.find((p) => p.id === pinId);
    if (!pin) {
      // Unknown pin: still try a focus, a no-op if the overlay lacks the pin, so
      // a stale id never wedges navigation.
      const focus = () => focusPinForMode(pinId, dims.viewMode);
      if (!annotationsVisible) {
        setAnnotationsVisible(true);
        requestAnimationFrame(focus);
      } else {
        focus();
      }
      return;
    }
    restoreCapturedView(pin);
  }, [currentAnnotations, restoreCapturedView, focusPinForMode, dims.viewMode, annotationsVisible]);

  // "Go to author's view" in a pin's thread: the explicit restore for a pin
  // selected on the canvas.
  const handleGoToAuthorView = useCallback((pinId: string) => {
    const pin = currentAnnotations.find((p) => p.id === pinId);
    if (!pin) return;
    restoreCapturedView(pin);
  }, [currentAnnotations, restoreCapturedView]);

  // `#a=<annotationId>` deep link. The pin may live on an unselected dataset;
  // selecting it mounts that dataset's overlay, so the restore waits a frame
  // for the overlay's ref.
  const restoreAnnotationDeepLinkPin = useCallback(
    (pin: Annotation, datasetId: string, onRestored: () => void) => {
      // Collapse `#a=` to `#view=` only after the restore, in the same frame, so
      // the URL captures the restored camera rather than the stale one.
      const run = () => {
        restoreCapturedView(pin, datasetId);
        onRestored();
      };
      if (selectedDatasetId !== datasetId) {
        setSelectedDatasetId(datasetId);
        requestAnimationFrame(run);
      } else {
        run();
      }
    },
    [restoreCapturedView, selectedDatasetId],
  );

  // The hook re-checks on every `remoteDocumentVersion` bump, so the restore
  // runs on the first tick where the pin is readable, not at scene bootstrap
  // while the document is still empty.
  const collapseDeepLinkHash = savedViewSync.collapseDeepLinkHash;
  const handleDeepLinkCollapse = useCallback(() => {
    void collapseDeepLinkHash();
  }, [collapseDeepLinkHash]);
  useAnnotationDeepLink({
    getScene: () => scene.wasmSceneRef.current,
    docVersion: remoteDocumentVersion,
    onRestore: restoreAnnotationDeepLinkPin,
    onCollapseHash: handleDeepLinkCollapse,
    onNotFound: setDeepLinkNotFound,
  });

  // Populate callback refs — runs during render, before effects fire.
  // See the comment block above (savedViewHooksRef) for the rationale.
  // eslint-disable-next-line react-hooks/refs
  bridgeCallbacksRef.current = {
    sendCommand: bridge.sendCommand,
    emitPresence: emitPresenceWithUrl,
    emitDatasetPresence: emitDatasetPresenceWithUrl,
    breakFollow: bridge.breakFollow,
  };
  // eslint-disable-next-line react-hooks/refs
  datasetCallbacksRef.current = {
    removeDataset: (id: string) => {
      render.loopRef.current?.removeDataset(id);
      render.clientRef.current?.removeLayerResources(id);
      datasetsRef.current.delete(id);
      layers.cleanupLayerMaps(id);
      datasetLevels.forget(id);
      setSelectedDatasetId(prev => {
        if (prev === id) {
          return datasetsRef.current.keys().next().value ?? null;
        }
        return prev;
      });
      bridge.sessionRef.current?.contentSource.rejectDataset(id);
      bumpDatasetsVersion();
    },
  };

  // Expose the tickCoordinator and cpuCache as `window.__orch` (alias
  // `__lucidaOrch`) for `requestTestProxy` from the dev console. Dev builds
  // only, since it issues real fetches. The capture globals
  // (`__lucidaCaptureReady`, `__lucidaAutoContrast`) are a separate contract
  // that the CLI reads in every build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const loop = render.activeLoop;
    const cache = bridge.sessionRef.current?.cpuCache;
    if (!loop || !cache) return;
    const coord = loop.getTickCoordinator();
    const debug = {
      tickCoordinator: coord,
      cpuCache: cache,
      requestTestProxy: (
        datasetId: string,
        entityId: string,
        imageId: string,
        kind: "GroupProxy3D" | "TileProxy3D",
        t = 0,
        c = 0,
      ) => coord.requestTestProxy(cache, datasetId, entityId, imageId, kind, t, c),
    };
    const w = window as unknown as { __orch?: typeof debug; __lucidaOrch?: typeof debug };
    w.__orch = debug;
    w.__lucidaOrch = debug;
    return () => {
      delete w.__orch;
      delete w.__lucidaOrch;
    };
  }, [render.activeLoop, bridge.sessionRef]);

  // The two sections of a bundle the trace does not record, the server's
  // dataset health and the frame on the canvas, come from the session socket
  // and the render worker, which both live here. The seam owns the rest, and
  // a page with neither registered still saves a bundle that says what is
  // missing.
  const liveBridge = bridge.bridge;
  useEffect(() => {
    setBundleServices({
      requestDatasetHealth: () =>
        liveBridge
          ? liveBridge.requestDatasetHealth()
          : Promise.reject(new Error("the session socket is not connected")),
      // The loop asks the worker for a frame along with the capture. A
      // client with no loop still answers, from the canvas as presented.
      captureFrame: () =>
        render.loopRef.current?.captureFrame()
          ?? render.clientRef.current?.captureFrame()
          ?? Promise.resolve({
            frame: null,
            reason: "the render client has not started, so there was no canvas to read",
          }),
      canvasRect: () => visibleRectOf(render.canvasRef.current),
    });
    // **Send report** goes over the same socket. Registered only while one
    // exists, so a page with no session offers no send rather than one that
    // goes nowhere. Only the action calls it.
    setReportSender(
      liveBridge ? (bundleJson: string) => liveBridge.sendReport(bundleJson) : null,
    );
    return () => {
      setBundleServices(null);
      setReportSender(null);
    };
  }, [liveBridge, render.canvasRef, render.clientRef, render.loopRef]);

  useScriptControls({
    selectors: {
      z: dims.z, t: dims.t, c: dims.c,
      dimZ: dims.dimZ, dimT: dims.dimT, dimC: dims.dimC,
      viewMode: dims.viewMode,
    },
    setZ: dims.handleZChange,
    setT: dims.handleTChange,
    setC: dims.handleCChange,
    setChannelVisible: layers.handleChannelSetVisible,
    setLayerVisible: layers.handleLayerSetVisible,
    captureView: savedViewSync.captureBuilder,
    selectedDatasetId,
    datasetsRef,
  });

  useIntensityBatcher({
    clientReady: render.clientReady,
    clientRef: render.clientRef,
    autoContrastMapRef: layers.autoContrastMapRef,
    wasmSceneRef: scene.wasmSceneRef,
    loopRef: render.loopRef,
    sessionRef: bridge.sessionRef,
    datasetsRef,
    setDataRangeMap: layers.setDataRangeMap,
  });

  const [cursorLabels, setCursorLabels] = useState<CursorLabel[]>([]);

  // Sync peer cursor geometry to GPU worker
  useEffect(() => {
    const client = render.clientRef.current;
    const ws = scene.wasmSceneRef.current;
    if (!client || !ws) {
      return;
    }
    if (bridge.peers.size === 0) {
      client.updateCursorData(new Float32Array(0), 0);
      // Reset on no-peers — the peers Map IS the external state we sync to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCursorLabels([]);
      return;
    }

    const peersArr = Array.from(bridge.peers.values())
      .filter(p => {
        if (p.cursor !== null) return true;
        // Hide defaulted cursor for peers in a follow relationship with us
        return !(p.following === bridge.myId || bridge.followTarget === p.client_id);
      })
      .map(p => {
        const mode = (p.camera as { mode?: string })?.mode ?? "slice";
        if (p.cursor === null) {
          const center = mode === "slice"
            ? (p.camera as { center?: [number, number] })?.center ?? [0, 0]
            : [0.5, 0.5];
          return { id: p.client_id, cursor: center, mode, camera: p.camera, view_z: p.view?.z_range?.start, label_only: true };
        }
        return { id: p.client_id, cursor: p.cursor, mode, camera: p.camera, view_z: p.view?.z_range?.start, label_only: false };
      });
    const canvasEl = render.canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const screenW = Math.round((canvasEl?.clientWidth ?? 800) * dpr);
    const screenH = Math.round((canvasEl?.clientHeight ?? 600) * dpr);
    const resultJson = ws.compute_peer_cursors(JSON.stringify(peersArr), bridge.myId, screenW, screenH);
    const result = JSON.parse(resultJson) as {
      gpu: number[][];
      labels: { id: number; sx: number; sy: number }[];
    };

    if (result.gpu.length > 0) {
      const flat = new Float32Array(result.gpu.length * 16);
      for (let i = 0; i < result.gpu.length; i++) {
        flat.set(result.gpu[i], i * 16);
      }
      client.updateCursorData(flat, result.gpu.length);
    } else {
      client.updateCursorData(new Float32Array(0), 0);
    }

    setCursorLabels(result.labels);
    requestRender(render.loopRef.current, "peer_cursors");
  }, [bridge.peers, bridge.myId, bridge.followTarget, dims.viewMode, render.clientReady, scene.wasmReady, render.clientRef, scene.wasmSceneRef, render.loopRef, render.canvasRef]);

  // Auto-clear the clamp notice after a few seconds. Re-arms on each new notice.
  useEffect(() => {
    if (!restoreNotice) return;
    const timer = setTimeout(() => setRestoreNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [restoreNotice]);

  const handleCameraModeChange = useCallback((mode: string) => {
    setCameraMode(mode);
  }, []);

  // The three useCallbacks below trip react-hooks/preserve-manual-memoization
  // because the deps array references refs (e.g. scene.wasmSceneRef) while
  // the body reads .current — React Compiler infers the .current as the real
  // dep and the ref-shaped manual dep as suspicious. The handlers are
  // user-event-driven (button click, keypress, debug toggle), so the
  // memoization-stability win is small; the manual deps are intentional and
  // satisfy the older react-hooks/exhaustive-deps gating.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleCameraModeToggle = useCallback(() => {
    const ws = scene.wasmSceneRef.current;
    if (!ws) return;
    const currentMode = ws.camera_mode();
    if (currentMode === "fly") {
      ws.set_mode_arcball();
    } else if (currentMode === "arcball") {
      ws.set_mode_fly();
      const BASE_SPEED_FACTOR = 0.3;
      const diagonal = ws.volume_diagonal();
      ws.fly_set_base_speed(diagonal * BASE_SPEED_FACTOR);
    }
    const newMode = ws.camera_mode();
    setCameraMode(newMode);
    bridge.breakFollow();
    emitPresenceWithUrl();
    requestRender(render.loopRef.current, "camera_mode_toggle");
    render.canvasRef.current?.focus();
  }, [scene.wasmSceneRef, bridge, emitPresenceWithUrl, render.loopRef, render.canvasRef]);

  const [urlInput, setUrlInput] = useState("");
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      datasets.handleUrlSubmit(urlInput);
      setUrlInput("");
    }
  }, [datasets, urlInput]);

  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showDevControls, setShowDevControls] = useState(false);
  // The dock overlays the canvas rather than resizing it (ADR 0052), so
  // opening it changes nothing the recorder sees.
  const [showMonitor, setShowMonitor] = useState(false);
  // Whether any on-canvas debug overlay is toggled on (persisted in
  // localStorage `debug.overlays`, independent of every panel). Drives the
  // mount of the code-split DebugOverlays layer: with every overlay off
  // there is nothing it could draw, so the chunk isn't fetched.
  const anyOverlayEnabled = useSyncExternalStore(
    onOverlaysChanged,
    () => DEBUG_OVERLAYS.some((o) => isOverlayEnabled(o)),
    () => false,
  );
  // A held render-radius slider in Dev controls draws its preview through
  // the same layer, so it mounts the layer for the duration of the drag
  // even with every overlay off. This is the layer's only other input —
  // no panel-open flag reaches it.
  const radiusPreviewActive = useSyncExternalStore(
    onRenderRadiusPreviewChanged,
    () => getRenderRadiusPreviewTier() !== null,
    () => false,
  );
  // Mounts the overlay layer while the dock has a brushed chunk set
  // published, even with every overlay off, since nothing else shows the set.
  const selectionPublished = useSyncExternalStore(
    onChunkSelectionChanged,
    () => currentChunkSelection() !== null,
    () => false,
  );
  const [showHud, setShowHud] = useState(false);
  const toggleHud = useCallback(() => setShowHud((v) => !v), []);
  useHudKeyBinding(toggleHud);
  const [showBookmarkSidebar, setShowBookmarkSidebar] = useState(true);
  // The Explore panel starts closed; it is a user toggle.
  const [showExplorePanel, setShowExplorePanel] = useState(false);
  const [showWorkspaceSharing, setShowWorkspaceSharing] = useState(false);

  const loadedDatasetNames = layers.layerInfos.map((layerInfo) => layerInfo.name);

  // The first VISIBLE dataset (falling back to the first loaded layer) is what
  // the Explore panel points its guided-exploration at: its id + name for the
  // header, and its `[T, C, Z, Y, X]` shape so the generator can frame Home and
  // gate dimensional moves. Recomputed from the live layer list + dataset map.
  const exploreTarget = useMemo((): {
    id: string | null;
    name: string | null;
    dims: Dims | null;
  } => {
    const first =
      layers.layerInfos.find((l) => l.visible) ?? layers.layerInfos[0] ?? null;
    if (!first) return { id: null, name: null, dims: null };
    // datasetsRef holds the live Map; datasetsVersion (in the deps) is the
    // React-side bumper that re-runs this memo whenever it mutates, so reading
    // .current here sees the latest manifest. Same render-time ref read as
    // buildLayerInfos / useDimensions.
    // eslint-disable-next-line react-hooks/refs
    const ds = datasetsRef.current.get(first.id);
    const shape = ds?.manifest.images[0]?.multiscale.levels[0]?.shape;
    const dims: Dims | null =
      shape && shape.length >= 5
        ? [shape[0], shape[1], shape[2], shape[3], shape[4]]
        : null;
    return { id: first.id, name: first.name, dims };
    // datasetsVersion drives the re-render that surfaces datasetsRef mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.layerInfos, datasetsVersion]);

  // Contact-sheet thumbnails for the Explore panel: off-screen renders of the
  // resident coarse overview from each candidate's camera (see
  // exploreThumbnails.ts). Undefined with no dataset, so rows are label-only.
  const requestThumbnail = useMemo(() => {
    const id = exploreTarget.id;
    if (!id) return undefined;
    // The getters read `.current` lazily (at thumbnail-request time, never during
    // render), the same deferred-ref idiom `useSavedViewSync` uses above — so
    // these are not render-time ref reads despite the rule's heuristic.
    /* eslint-disable react-hooks/refs */
    return makeThumbnailRequester({
      getScene: () => scene.wasmSceneRef.current,
      getClient: () => render.clientRef.current,
      getDatasets: () => datasetsRef.current,
      datasetId: id,
    });
    /* eslint-enable react-hooks/refs */
  }, [exploreTarget.id, scene.wasmSceneRef, render.clientRef]);

  // While the Explore panel is open, ask the render loop to keep the per-dataset
  // coarse overview textures uploaded (even if the minimap is hidden) so the
  // thumbnails have something to draw. The loop tears nothing down on disable;
  // it just stops re-seeding, so this is cheap to toggle with the panel.
  useEffect(() => {
    if (!showExplorePanel) return;
    const loop = render.loopRef.current;
    if (!loop) return;
    loop.setThumbnailOverview(true);
    return () => {
      render.loopRef.current?.setThumbnailOverview(false);
    };
  }, [showExplorePanel, render.loopRef, render.activeLoop, datasetsVersion]);

  // Bookmark from the Explore panel as a personal workspace saved view, since
  // guided exploration never auto-shares. Calls the API directly so the panel
  // needn't mount the saved-views list hook.
  const handleExploreBookmark = useCallback(
    (name: string, view: SavedView, visibility: "personal") =>
      createWorkspaceSavedView(workspaceId, name, view, visibility),
    [workspaceId],
  );

  // Active layout name for the default saved-view name.
  // Falls back to null when no dataset/layout is selected.
  const activeLayoutName = useMemo(() => {
    if (!selectedDatasetId) return null;
    if (!layoutRegistry) return null;
    const activeId = layoutRegistry.activeId(selectedDatasetId);
    if (!activeId) return null;
    const spec = layoutRegistry.getSpec(selectedDatasetId, activeId);
    return spec?.name ?? activeId;
  }, [selectedDatasetId, layoutRegistry]);
  const handleFileBrowserSelect = useCallback((path: string) => {
    datasets.handleUrlSubmit(path);
  }, [datasets]);

  const savedViewApplier = savedViewSync.applier;
  const notifySavedViewChange = savedViewSync.notifyChange;
  const handleOpenWorkspaceSavedView = useCallback(async (view: SavedView, savedViewId: string) => {
    await savedViewApplier.apply(view);
    notifySavedViewChange();
    // Remember which saved view is now applied so the sidebar can flag the
    // active row. Set it only after a successful apply.
    setCurrentOpenSavedViewId(savedViewId);
  }, [savedViewApplier, notifySavedViewChange]);

  // The sidebar reports when the open saved view stops existing (deleted,
  // withdrawn, or rejected); drop the highlight. The id guard keeps a stale
  // invalidation from clearing a newer open view.
  const handleActiveSavedViewInvalidated = useCallback((savedViewId: string) => {
    setCurrentOpenSavedViewId((prev) => (prev === savedViewId ? null : prev));
  }, []);

  // Descend into a guided-exploration candidate (or Home/Back) from the Explore
  // panel: this is a deliberate navigation, so break peer-follow first, then
  // apply the view and co-tap the URL/last-view sync. Distinct from
  // handleOpenWorkspaceSavedView because there is no saved-view id to flag as
  // the active row (an explored view is ephemeral until bookmarked).
  const applyExploreView = useCallback(
    async (view: SavedView) => {
      bridge.breakFollow();
      await savedViewApplier.apply(view);
      notifySavedViewChange();
    },
    [bridge, savedViewApplier, notifySavedViewChange],
  );

  const commitWorkspaceName = useCallback(() => {
    const next = workspaceNameDraft.trim();
    if (!next || next === workspaceName) {
      setWorkspaceNameEdit({ source: workspaceName, value: workspaceName });
      return;
    }
    void onRenameWorkspace(next).catch(() => {
      setWorkspaceNameEdit({ source: workspaceName, value: workspaceName });
    });
  }, [workspaceNameDraft, workspaceName, onRenameWorkspace]);

  // The JSX block below reads `.current` from refs returned by useRenderClient,
  // useWasmScene, useBridge, useLayout, etc. — passing them as props to
  // SliceViewer / VolumeViewer / PeerCursors / Minimap / DebugOverlays
  // so those children can read the latest canvas, scene, loop, etc.
  // each render. This is the canonical "ref-as-current-value-prop" idiom that
  // partners with the App.tsx hook order above: callback refs are populated AFTER
  // all hooks return, then read in the same render via `.current`. The
  // versioning state (datasetsVersion, remoteDocumentVersion) drives the
  // re-render that surfaces ref updates downstream. The new
  // eslint-plugin-react-hooks@7 "rules of react" treat all such reads as
  // suspicious; they are intentional and load-bearing here.
  /* eslint-disable react-hooks/refs */
  return (
    <div className={captureSurface ? "app render-mode" : "app"}>
      {/* ProfileMenu floats over the bottom-left corner of the app
          chrome. Absolute-positioning keeps it out of the existing
          flex layout so the LayerPanel + canvas geometry is untouched.
          Gated out of the chrome-free render surface. */}
      {!captureSurface && <ProfileMenu />}
      <LayerPanel
        layers={layers.layerInfos}
        selectedLayerId={selectedDatasetId}
        expandedLayerId={layers.expandedLayerId}
        onSelectLayer={layers.handleLayerSelect}
        onToggleExpand={layers.handleLayerToggleExpand}
        onSetVisible={layers.handleLayerSetVisible}
        onSetOpacity={layers.handleLayerSetOpacity}
        multiChannel={dims.multiChannel}
        onSetContrast={layers.handleLayerSetContrast}
        onSetGamma={layers.handleLayerSetGamma}
        onSetColormap={layers.handleLayerSetColormap}
        onSetBlendMode={layers.handleLayerSetBlendMode}
        onSetRenderMode={layers.handleLayerSetRenderMode}
        onSetLevelPin={layers.handleLayerSetLevelPin}
        onAutoContrast={layers.handleLayerAutoContrast}
        onAutoContrastToggle={layers.handleLayerAutoContrastToggle}
        onFullRangeToggle={layers.handleLayerFullRangeToggle}
        onMoveLayer={layers.handleLayerMove}
        onRemoveLayer={layers.handleRemoveLayer}
        onRenameLayer={layers.handleLayerRename}
        canEdit={canEditWorkspace}
        onChannelSetVisible={layers.handleChannelSetVisible}
        onChannelSetColormap={layers.handleChannelSetColormap}
        onChannelSetName={layers.handleChannelSetName}
        onChannelSetContrast={layers.handleChannelSetContrast}
        onChannelSetGamma={layers.handleChannelSetGamma}
        onChannelSetBlendMode={layers.handleChannelSetBlendMode}
        onLabelSetVisible={layers.handleLabelSetVisible}
        onLabelSetOpacity={layers.handleLabelSetOpacity}
        onAddLayer={() => setShowFileBrowser(true)}
        viewModeToggle={datasetsVersion > 0 ? { label: dims.viewMode === "2d" ? "3D" : "2D", onClick: dims.handleViewModeToggle } : null}
        cameraModeToggle={dims.viewMode === "3d" ? { label: cameraMode === "fly" ? "Arcball" : "Fly", onClick: handleCameraModeToggle } : null}
        devControlsToggle={{
          label: "Dev",
          active: showDevControls,
          onClick: () => setShowDevControls((v) => !v),
        }}
        layoutRegistry={layoutRegistry}
        sendCommand={bridge.sendCommand}
        onLayoutChange={() => {
          // The switcher already applied `set_active_layout`. Match the
          // inbound-peer arm in sessionController.ts so the planner re-reads
          // now; a missed signal leaves collection members drawn at their
          // pre-switch positions until the next pan or zoom.
          invalidateDisplaySettings(render.loopRef.current, "layout_switch");
          // A local switch re-anchors collection annotations in core but, unlike
          // an inbound peer switch, doesn't bump the document version, so bump
          // it here for the overlay to re-read the pins.
          bumpRemoteDocumentVersion();
        }}
        style={{ width: layout.sidebarWidth, minWidth: layout.sidebarWidth }}
      />
      <div className="sidebar-resize-handle" onPointerDown={layout.handleSidebarResizeDown} />
      <div className="main-content">
        <div className="workspace-chrome">
          <button className="workspace-back-button" onClick={onBackToDashboard}>
            Workspaces
          </button>
          {canRenameWorkspace ? (
            <input
              className="workspace-name-input"
              value={workspaceNameDraft}
              onChange={(e) => setWorkspaceNameEdit({
                source: workspaceName,
                value: e.target.value,
              })}
              onBlur={commitWorkspaceName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  setWorkspaceNameEdit({ source: workspaceName, value: workspaceName });
                  e.currentTarget.blur();
                }
              }}
              aria-label="Workspace name"
            />
          ) : (
            <div className="workspace-name-label" title={workspaceName}>
              {workspaceName}
            </div>
          )}
          <div className="workspace-chrome-actions">
            <button
              type="button"
              onClick={() => setShowMonitor((v) => !v)}
              aria-pressed={showMonitor}
              title={showMonitor ? "Close the pipeline monitor" : "Open the pipeline monitor"}
              data-testid="open-monitor"
              style={{
                background: showMonitor ? "#646cff" : undefined,
                color: showMonitor ? "#fff" : undefined,
              }}
            >
              Monitor
            </button>
            {canRenameWorkspace && (
              <button type="button" onClick={() => setShowWorkspaceSharing(true)}>
                Share Workspace
              </button>
            )}
            <div className="workspace-id-label" title={workspaceId}>
              {workspaceId}
            </div>
          </div>
        </div>
        {bridge.peers.size > 0 && (
          <div className="peer-list" style={{ fontSize: "0.85em", margin: "8px 0" }}>
            <strong>Peers ({bridge.peers.size}):</strong>
            {bridge.followTarget !== null && (
              <button onClick={() => bridge.handleFollow(null)} style={{ marginLeft: 8 }}>
                Stop Following
              </button>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: "4px 0" }}>
              {bridge.followablePeers.map(([peerId]) => (
                <li key={peerId} style={{ display: "inline", marginRight: 8 }}>
                  Client {peerId}
                  {bridge.followTarget !== peerId && (
                    <button onClick={() => bridge.handleFollow(peerId)} style={{ marginLeft: 4 }}>
                      Follow
                    </button>
                  )}
                  {bridge.followTarget === peerId && " (following)"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "row", width: layout.canvasWidth }}>
          <div className="viewer-canvas-wrap" style={{
            position: "relative",
            display: datasetsVersion > 0 ? "block" : "none",
            flex: 1,
            minWidth: 0,
          }}>
            <canvas
              // Keyed per RenderClient generation: `transferControlToOffscreen`
              // is one-shot per element, so after a client teardown (dev
              // StrictMode remount) the next client needs a fresh element.
              key={render.canvasKey}
              ref={render.canvasRef}
              tabIndex={0}
              style={{
                // The docked dev-controls panel is 300px wide.
                width: layout.canvasWidth - 300 * (showDevControls ? 1 : 0),
                height: layout.canvasHeight,
                imageRendering: dims.viewMode === "2d" ? "pixelated" : "auto",
                borderRadius: 8,
                backgroundColor: "black",
                display: "block",
              }}
            />
            {datasetsVersion > 0 && dims.viewMode === "2d" && scene.wasmScene && render.client && bridge.sessionRef.current && (
              <SliceViewer
                z={dims.z}
                t={dims.t}
                c={dims.c}
                session={bridge.sessionRef.current}
                scene={scene.wasmScene}
                datasets={datasetsRef.current}
                client={render.client}
                canvas={render.canvasRef.current!}
                remoteDocumentVersion={remoteDocumentVersion}
                emitPresence={emitPresenceWithUrl}
                breakFollow={bridge.breakFollow}
                sendCursor={bridge.sendCursor}
                loopRef={render.loopRef}
                onLoopChange={render.setActiveLoop}
                annotationDatasetId={selectedDatasetId}
                annotationKind={annotationKind}
                myId={annotationAuthor}
                sendCommand={bridge.sendCommand}
                onDocumentChanged={bumpRemoteDocumentVersion}
                annotationDraftRef={annotationDraftRef}
              />
            )}
            {datasetsVersion > 0 && dims.viewMode === "2d" && selectedDatasetId && scene.wasmScene && render.canvasRef.current && (
              <AnnotationDraftOverlay draftRef={annotationDraftRef} visible={annotationsVisible} />
            )}
            {datasetsVersion > 0 && dims.viewMode === "2d" && selectedDatasetId && scene.wasmScene && render.canvasRef.current && (
              <AnnotationOverlay
                ref={overlay2dRef}
                datasetId={selectedDatasetId}
                wasmSceneRef={scene.wasmSceneRef}
                canvas={render.canvasRef.current}
                version={remoteDocumentVersion}
                viewContext={{ z: dims.z, t: dims.t, c: dims.c }}
                myId={annotationAuthor}
                sendCommand={bridge.sendCommand}
                onDocumentChanged={bumpRemoteDocumentVersion}
                onViewportChanged={() => requestRender(render.loopRef.current, "annotation_viewport")}
                visible={annotationsVisible}
                mentionCandidates={mentionCandidates}
                onGoToAuthorView={handleGoToAuthorView}
              />
            )}
            {datasetsVersion > 0 && dims.viewMode === "2d" && (() => {
              const ds = selectedDatasetId ? datasetsRef.current.get(selectedDatasetId) : undefined;
              if (!ds) return null;
              // Resolve the active layout's placements: derived layouts
              // come from the registry, source layouts from the content graph.
              const activeId = layoutRegistry?.activeId(ds.id) ?? ds.manifest.default_layout_id;
              const activePlacements =
                (activeId ? layoutRegistry?.getSpec(ds.id, activeId)?.placements : null)
                ?? (activeId ? ds.manifest.source_layouts.find((l) => l.id === activeId)?.placements : null)
                ?? null;
              const collectionData = extractCollectionData(ds.manifest, activePlacements);
              if (!collectionData) return null;
              return (
                <CollectionSelector
                  collectionKind={collectionData.collectionKind}
                  members={collectionData.members}
                  collectionName={ds.name}
                  onGroupClick={(bounds) => {
                    const ws = scene.wasmSceneRef.current;
                    const canvas = render.canvasRef.current;
                    if (!ws || !canvas) return;
                    bridge.breakFollow();
                    frameRect(ws, canvas, bounds);
                    emitPresenceWithUrl();
                    requestRender(render.loopRef.current, "collection_group_click");
                  }}
                />
              );
            })()}
            {datasetsVersion > 0 && dims.viewMode === "3d" && scene.wasmScene && render.client && bridge.sessionRef.current && (
              <VolumeViewer
                session={bridge.sessionRef.current}
                scene={scene.wasmScene}
                datasets={datasetsRef.current}
                client={render.client}
                canvas={render.canvasRef.current!}
                remoteDocumentVersion={remoteDocumentVersion}
                emitPresence={emitPresenceWithUrl}
                breakFollow={bridge.breakFollow}
                sendCursor={bridge.sendCursor}
                t={dims.t}
                c={dims.c}
                loopRef={render.loopRef}
                onLoopChange={render.setActiveLoop}
                onCameraModeChange={handleCameraModeChange}
                annotationDatasetId={selectedDatasetId}
                annotationKind={annotationKind}
                myId={annotationAuthor}
                sendCommand={bridge.sendCommand}
                onDocumentChanged={bumpRemoteDocumentVersion}
                annotationDraftRef={annotationDraftRef}
              />
            )}
            {datasetsVersion > 0 && dims.viewMode === "3d" && selectedDatasetId && scene.wasmScene && render.canvasRef.current && (
              <AnnotationDraftOverlay draftRef={annotationDraftRef} visible={annotationsVisible} />
            )}
            {datasetsVersion > 0 && dims.viewMode === "3d" && selectedDatasetId && scene.wasmScene && render.canvasRef.current && (
              <AnnotationOverlay3D
                ref={overlay3dRef}
                datasetId={selectedDatasetId}
                wasmSceneRef={scene.wasmSceneRef}
                canvas={render.canvasRef.current}
                version={remoteDocumentVersion}
                viewContext={{ z: dims.z, t: dims.t, c: dims.c }}
                myId={annotationAuthor}
                sendCommand={bridge.sendCommand}
                onDocumentChanged={bumpRemoteDocumentVersion}
                onViewportChanged={() => requestRender(render.loopRef.current, "annotation_viewport")}
                visible={annotationsVisible}
                mentionCandidates={mentionCandidates}
                onGoToAuthorView={handleGoToAuthorView}
              />
            )}
            {bridge.peers.size > 0 && scene.wasmScene && render.canvasRef.current && (
              <PeerCursors
                peers={bridge.peers}
                myId={bridge.myId}
                followTarget={bridge.followTarget}
                wasmSceneRef={scene.wasmSceneRef}
                canvas={render.canvasRef.current}
                viewMode={dims.viewMode}
                z={dims.z}
                t={dims.t}
                c={dims.c}
                cursorLabels={cursorLabels}
              />
            )}
            {render.clientReady && render.clientRef.current && (
              <Minimap client={render.clientRef.current} activeLoop={render.activeLoop} />
            )}
            {(anyOverlayEnabled || radiusPreviewActive || selectionPublished) && (
              <Suspense fallback={null}>
                <DebugOverlays
                  wasmSceneRef={scene.wasmSceneRef}
                  canvasRef={render.canvasRef}
                  datasets={datasetsRef.current}
                  renderLoopRef={render.loopRef}
                  cpuCache={bridge.sessionRef.current?.cpuCache ?? null}
                  viewMode={dims.viewMode}
                />
              </Suspense>
            )}
            {showHud && !captureSurface && (
              <Suspense fallback={null}>
                <Hud
                  canvasRef={render.canvasRef}
                  datasets={datasetsRef.current}
                  getCache={() => bridge.sessionRef.current?.cpuCache ?? null}
                />
              </Suspense>
            )}
            <FpsCounter />
            <LoadingViewBanner applier={savedViewSync.applier} />
            {/* Durable, dismissible surface for non-fatal import warnings from
                a dataset open (e.g. the sampled-label-discovery notice). Stays
                visible after the open completes and clears on dismiss or a
                fresh open. */}
            <ImportWarningBanner
              warnings={bridge.remoteDatasetWarnings}
              overflow={bridge.remoteDatasetWarningsOverflow}
              onDismiss={bridge.dismissRemoteDatasetWarnings}
            />
            {/* Clamp notice from the light annotation-view restore. */}
            {restoreNotice && (
              <div
                role="status"
                data-testid="annotation-restore-notice"
                style={{
                  position: "absolute",
                  top: 12,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "rgba(31,111,235,0.95)",
                  color: "#fff",
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: "0.8rem",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                  zIndex: 40,
                  pointerEvents: "none",
                }}
              >
                {restoreNotice}
              </div>
            )}
            {/* `#a=<id>` didn't resolve. A recipient without access fails at the
                gate first, so this never confirms the annotation existed. */}
            {deepLinkNotFound && (
              <div
                role="status"
                data-testid="annotation-deeplink-notfound"
                style={{
                  position: "absolute",
                  top: 12,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "rgba(48,54,61,0.97)",
                  color: "#e6edf3",
                  padding: "8px 12px",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
                  zIndex: 41,
                  maxWidth: 420,
                }}
              >
                <span>
                  This annotation couldn&rsquo;t be found — it may have been
                  deleted.
                </span>
                <button
                  data-testid="annotation-deeplink-notfound-dismiss"
                  onClick={() => setDeepLinkNotFound(false)}
                  aria-label="Dismiss"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#8b949e",
                    cursor: "pointer",
                    fontSize: 16,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </div>
            )}
            <div className="canvas-resize-handle" onPointerDown={layout.handleCanvasResizeDown} />
          </div>
          {showDevControls && (
            <Suspense fallback={null}>
              <DevControls
                // Deferred ref read (never during render): the session can
                // attach or be replaced while the surface is open, and the
                // surface re-reads on its own tick.
                getCpuCache={() => bridge.sessionRef.current?.cpuCache ?? null}
                style={{ height: layout.canvasHeight }}
              />
            </Suspense>
          )}
        </div>
        {showMonitor && (
          <Suspense fallback={null}>
            <MonitorDock onClose={() => setShowMonitor(false)} insetLeft={layout.sidebarWidth} />
          </Suspense>
        )}
        {datasetsVersion > 0 && (
          <div className="dimension-controls" style={{ maxWidth: layout.canvasWidth }}>
            <DimensionControls label="Z" value={dims.z} max={dims.dimZ} onChange={dims.handleZChange} disabled={dims.viewMode === "3d"} />
            {dims.multiChannel ? (
              dims.dimC > 1 && (
                <div className="dim-control">
                  <span className="dim-label">C</span>
                  <button className="dim-btn" style={{ background: "#4a9eff", color: "#fff" }} onClick={dims.handleMultiChannelToggle} title="Switch to single-channel mode">Multi</button>
                </div>
              )
            ) : (
              <DimensionControls label="C" value={dims.c} max={dims.dimC} onChange={dims.handleCChange} />
            )}
            {!dims.multiChannel && dims.dimC > 1 && (
              <div className="dim-control" style={{ marginLeft: "-0.25rem" }}>
                <button className="dim-btn" onClick={dims.handleMultiChannelToggle} title="Switch to multi-channel composite mode">Multi</button>
              </div>
            )}
            <DimensionControls label="T" value={dims.t} max={dims.dimT} onChange={dims.handleTChange} />
            {/* Near/far bias for the 3D chunk-spawn origin, shown only in 3D
                where it means something. Binds to configStore.depthBiasView. */}
            {dims.viewMode === "3d" && <FocalDepthControl />}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", width: "100%", maxWidth: layout.canvasWidth }}>
          <input
            type="text"
            placeholder="Enter dataset path or gs:// URL"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            disabled={bridge.remoteDatasetLoading}
            style={{ flex: 1, padding: "0.375rem 0.5rem", fontSize: "0.875rem" }}
          />
          <button
            onClick={() => { datasets.handleUrlSubmit(urlInput); setUrlInput(""); }}
            disabled={bridge.remoteDatasetLoading || !urlInput.trim()}
            style={{ padding: "0.375rem 0.75rem", fontSize: "0.875rem" }}
          >
            {bridge.remoteDatasetLoading ? "Loading..." : "Open"}
          </button>
          <button
            onClick={() => setShowFileBrowser(true)}
            disabled={bridge.remoteDatasetLoading}
            style={{ padding: "0.375rem 0.75rem", fontSize: "0.875rem", whiteSpace: "nowrap" }}
          >
            Browse Local
          </button>
          <ShareToolbarButton getCurrentSavedView={savedViewSync.captureBuilder} />
          <label
            title="Shape drawn by shift-drag on the canvas (point = click, line/box = drag)"
            style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.875rem", whiteSpace: "nowrap" }}
          >
            Annotate
            <select
              aria-label="Annotation shape"
              value={annotationKind}
              onChange={(e) => setAnnotationKind(e.target.value as "point" | "line" | "box")}
              style={{ padding: "0.25rem", fontSize: "0.875rem" }}
            >
              <option value="point">Point</option>
              <option value="line">Line</option>
              <option value="box">Box</option>
            </select>
          </label>
          <MentionsOfMe
            annotations={currentAnnotations}
            currentUserId={annotationAuthor}
            currentUserEmail={authSession.principal.email}
            members={workspaceMembers}
            onNavigate={handleNavigateToMention}
            viewedCommentIds={viewedCommentIds}
            onMarkViewed={markViewed}
          />
          {/* The aria-label and title name the next action, so the control
              reads correctly in either state. */}
          <button
            data-testid="annot-visibility-toggle"
            onClick={() => setAnnotationsVisible((v) => !v)}
            aria-pressed={!annotationsVisible}
            aria-label={annotationsVisible ? "Hide annotations" : "Show annotations"}
            title={annotationsVisible ? "Hide annotations" : "Show annotations"}
            style={{
              padding: "0.375rem 0.75rem",
              fontSize: "0.875rem",
              whiteSpace: "nowrap",
              // Same accent as the other toolbar toggles.
              background: !annotationsVisible ? "#646cff" : undefined,
              color: !annotationsVisible ? "#fff" : undefined,
            }}
          >
            {annotationsVisible ? "Hide Annotations" : "Show Annotations"}
          </button>
          <button
            onClick={() => setShowBookmarkSidebar((v) => !v)}
            title={showBookmarkSidebar ? "Hide saved views" : "Show saved views"}
            style={{
              padding: "0.375rem 0.75rem",
              fontSize: "0.875rem",
              whiteSpace: "nowrap",
              background: showBookmarkSidebar ? "#646cff" : undefined,
              color: showBookmarkSidebar ? "#fff" : undefined,
            }}
          >
            Saved Views
          </button>
          <button
            onClick={() => setShowExplorePanel((v) => !v)}
            title={showExplorePanel ? "Hide the Explore panel" : "Suggest next views to explore"}
            data-testid="explore-toggle"
            style={{
              padding: "0.375rem 0.75rem",
              fontSize: "0.875rem",
              whiteSpace: "nowrap",
              background: showExplorePanel ? "#646cff" : undefined,
              color: showExplorePanel ? "#fff" : undefined,
            }}
          >
            Explore
          </button>
          <button
            onClick={toggleHud}
            aria-pressed={showHud}
            title={showHud ? "Hide the pipeline HUD (H)" : "Show the pipeline HUD (H)"}
            data-testid="hud-toggle"
            style={{
              padding: "0.375rem 0.75rem",
              fontSize: "0.875rem",
              whiteSpace: "nowrap",
              background: showHud ? "#646cff" : undefined,
              color: showHud ? "#fff" : undefined,
            }}
          >
            HUD
          </button>
        </div>
        {showFileBrowser && (
          <FileBrowser
            onSelect={handleFileBrowserSelect}
            onCreateWorkspace={
              onCreateWorkspaceFromDatasets
                ? (paths) => {
                    setShowFileBrowser(false);
                    onCreateWorkspaceFromDatasets(paths);
                  }
                : undefined
            }
            onClose={() => setShowFileBrowser(false)}
          />
        )}
        {bridge.remoteDatasetLoading && (
          <p className="secondary">{bridge.remoteDatasetProgress ?? "Loading volume..."}</p>
        )}
        {(scene.wasmError || render.renderError || bridge.remoteDatasetError) && (
          <p style={{ color: "#f44" }}>
            {scene.wasmError || render.renderError || bridge.remoteDatasetError}
          </p>
        )}
      </div>
      <WorkspaceSavedViewsSidebar
        workspaceId={workspaceId}
        currentUserEmail={authSession.principal.email}
        canEdit={canEditWorkspace}
        getCurrentSavedView={savedViewSync.captureBuilder}
        onOpenSavedView={handleOpenWorkspaceSavedView}
        loadedDatasetNames={loadedDatasetNames}
        activeLayoutName={activeLayoutName}
        defaultSavedViewId={defaultSavedViewId}
        onSetDefaultSavedView={onSetDefaultSavedView}
        currentOpenSavedViewId={currentOpenSavedViewId}
        onActiveSavedViewInvalidated={handleActiveSavedViewInvalidated}
        visible={showBookmarkSidebar}
        style={{ width: 280, minWidth: 280, height: "100vh" }}
      />
      <ExplorationPanel
        visible={showExplorePanel}
        captureBuilder={savedViewSync.captureBuilder}
        applyView={applyExploreView}
        createSavedView={handleExploreBookmark}
        datasetId={exploreTarget.id}
        datasetName={exploreTarget.name}
        dims={exploreTarget.dims}
        viewport={[
          render.canvasRef.current?.clientWidth ?? 800,
          render.canvasRef.current?.clientHeight ?? 600,
        ]}
        requestThumbnail={requestThumbnail}
        style={{ width: 280, minWidth: 280, height: "100vh" }}
      />
      <WorkspaceSharingDialog
        workspaceId={workspaceId}
        open={showWorkspaceSharing}
        onClose={() => setShowWorkspaceSharing(false)}
      />
    </div>
  );
  /* eslint-enable react-hooks/refs */
}

export default App;
