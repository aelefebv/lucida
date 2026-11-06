import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BookmarkSimpleIcon, CompassIcon } from "@phosphor-icons/react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
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
import { CollectionSelector, extractCollectionData } from "./components/CollectionSelector.tsx";
import { frameRect } from "./components/groupFraming.ts";
import { LoadingViewBanner } from "./components/LoadingViewBanner.tsx";
import { ImportWarningBanner } from "./components/ImportWarningBanner.tsx";
import { WorkspaceSavedViewsSidebar } from "./components/WorkspaceSavedViewsSidebar.tsx";
import { ExplorationPanel, type Dims } from "./components/ExplorationPanel.tsx";
import { makeThumbnailRequester } from "./exploreThumbnails.ts";
import { ShareButton } from "./share/ShareButton.tsx";
import { applyViewportCommand } from "./applyAndSend.ts";
import {
  invalidateDisplaySettings,
  invalidateAfterViewRestore,
  requestRender,
} from "./invalidation.ts";
import { annotationAuthorId } from "./annotationIdentity.ts";
import { deriveMentionCandidates } from "./components/annotationParticipants.ts";
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
import { AddDataDialog, AddDataPrompt, noteSourceOpenFailed } from "./addData/index.ts";
import { Banner } from "./shell/Banner.tsx";
import { BottomToolbar } from "./shell/BottomToolbar.tsx";
import { CanvasStage, type CanvasSize } from "./shell/CanvasStage.tsx";
import { DimensionBar } from "./shell/DimensionBar.tsx";
import { useOpenRightPanel } from "./shell/layoutPreferences.ts";
import { LeftPanel } from "./shell/LeftPanel.tsx";
import { RightRail } from "./shell/RightRail.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { useDeveloperSurfaces } from "./shell/useDeveloperSurfaces.ts";
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
  const developer = useDeveloperSurfaces({ captureSurface });
  // The canvas's CSS size, settled: it follows a panel drag a beat behind, so
  // the drag doesn't re-render the whole viewer on every frame.
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });

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
  const bumpDatasetsVersion = useCallback(() => setDatasetsVersion(v => v + 1), []);
  const bumpRemoteDocumentVersion = useCallback(() => setRemoteDocumentVersion(v => v + 1), []);
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
    canvasRef: render.canvasRef,
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
    onOpenDatasetFailed: (url, err) => {
      savedViewSync.applier.notifyOpenFailed(url, err);
      noteSourceOpenFailed(url);
    },
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
    // canvasSize re-projects the labels after a panel moves the canvas edges.
  }, [bridge.peers, bridge.myId, bridge.followTarget, dims.viewMode, render.clientReady, scene.wasmReady, render.clientRef, scene.wasmSceneRef, render.loopRef, render.canvasRef, canvasSize]);

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

  const [addDataOpen, setAddDataOpen] = useState(false);
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
  // Debug overlays are a developer surface too, so the setting hides them.
  const showDebugOverlays =
    developer.enabled && (anyOverlayEnabled || radiusPreviewActive || selectionPublished);
  const showExplorePanel = useOpenRightPanel() === "explore";

  useEffect(() => {
    if (captureSurface) return;
    document.title = `${workspaceName} · lucida`;
    return () => {
      document.title = "lucida";
    };
  }, [workspaceName, captureSurface]);

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // CanvasStage keeps the latest handler in a ref, so this needs no memo.
  const handleCanvasResize = (size: CanvasSize) => {
    requestRender(render.loopRef.current, "canvas_resize");
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setCanvasSize(size);
    }, 100);
  };
  useEffect(() => () => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
  }, []);

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

  const hasData = layers.layerInfos.length > 0;

  // The 2D collection navigator for the selected dataset, when it is a collection.
  const collectionNavigator = (() => {
    if (datasetsVersion === 0 || dims.viewMode !== "2d") return null;
    // eslint-disable-next-line react-hooks/refs -- the live dataset map; datasetsVersion re-renders on change.
    const ds = selectedDatasetId ? datasetsRef.current.get(selectedDatasetId) : undefined;
    if (!ds) return null;
    // Resolve the active layout's placements: derived layouts come from the
    // registry, source layouts from the content graph.
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
        getViewCenter={() => scene.wasmSceneRef.current?.center() ?? null}
      />
    );
  })();

  const datasetStatus = scene.wasmError || render.renderError || bridge.remoteDatasetError;

  // The JSX block below reads `.current` from refs returned by useRenderClient,
  // useWasmScene, useBridge, etc. — passing them as props to
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
    <div className="lc-shell" data-capture={captureSurface || undefined}>
      {!captureSurface && (
        <TopBar
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          onRenameWorkspace={canRenameWorkspace ? onRenameWorkspace : undefined}
          onBackToDashboard={onBackToDashboard}
          inbox={
            <MentionsOfMe
              annotations={currentAnnotations}
              currentUserId={annotationAuthor}
              currentUserEmail={authSession.principal.email}
              members={workspaceMembers}
              onNavigate={handleNavigateToMention}
              viewedCommentIds={viewedCommentIds}
              onMarkViewed={markViewed}
            />
          }
          presence={{
            peers: bridge.peers,
            followTarget: bridge.followTarget,
            onFollow: bridge.handleFollow,
          }}
          share={
            <ShareButton
              workspaceId={workspaceId}
              canManageAccess={workspaceRole === "owner"}
              getCurrentSavedView={savedViewSync.captureBuilder}
            />
          }
          developer={developer}
        />
      )}
      <div className="lc-shell-body">
        {!captureSurface && (
          <LeftPanel label="Layers">
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
              onAddLayer={() => setAddDataOpen(true)}
              viewModeToggle={null}
              cameraModeToggle={null}
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
              // The left panel draws the edge.
              style={{ borderRight: "none" }}
            />
          </LeftPanel>
        )}
        <div className="lc-shell-center">
          <CanvasStage
            canvasRef={render.canvasRef}
            canvasKey={render.canvasKey}
            pixelated={dims.viewMode === "2d"}
            onResize={handleCanvasResize}
            bare={captureSurface}
            emptyState={
              !hasData && bridge.sessionReady && !bridge.remoteDatasetLoading && !captureSurface ? (
                <AddDataPrompt onAddData={() => setAddDataOpen(true)} />
              ) : null
            }
            slots={{
              "top-center": (
                <>
                  <LoadingViewBanner applier={savedViewSync.applier} />
                  {/* Durable, dismissible surface for non-fatal import warnings
                      from a dataset open (e.g. the sampled-label-discovery
                      notice). Stays visible after the open completes and clears
                      on dismiss or a fresh open. */}
                  <ImportWarningBanner
                    warnings={bridge.remoteDatasetWarnings}
                    overflow={bridge.remoteDatasetWarningsOverflow}
                    onDismiss={bridge.dismissRemoteDatasetWarnings}
                  />
                  {bridge.remoteDatasetLoading && (
                    <Banner tone="info">{bridge.remoteDatasetProgress ?? "Loading volume..."}</Banner>
                  )}
                  {datasetStatus && (
                    <Banner tone="danger" role="alert">
                      {datasetStatus}
                    </Banner>
                  )}
                  {/* Clamp notice from the light annotation-view restore. */}
                  {restoreNotice && (
                    <Banner tone="info" data-testid="annotation-restore-notice">
                      {restoreNotice}
                    </Banner>
                  )}
                  {/* `#a=<id>` didn't resolve. A recipient without access fails
                      at the gate first, so this never confirms the annotation
                      existed. */}
                  {deepLinkNotFound && (
                    <Banner data-testid="annotation-deeplink-notfound" onDismiss={() => setDeepLinkNotFound(false)}>
                      This annotation couldn&rsquo;t be found — it may have been deleted.
                    </Banner>
                  )}
                </>
              ),
              "top-right": (
                <>
                  {developer.fps && <FpsCounter />}
                  {developer.hud && (
                    <Suspense fallback={null}>
                      <Hud
                        canvasRef={render.canvasRef}
                        datasets={datasetsRef.current}
                        getCache={() => bridge.sessionRef.current?.cpuCache ?? null}
                      />
                    </Suspense>
                  )}
                  {developer.devControls && (
                    <Suspense fallback={null}>
                      <DevControls
                        // Deferred ref read (never during render): the session can
                        // attach or be replaced while the surface is open, and the
                        // surface re-reads on its own tick.
                        getCpuCache={() => bridge.sessionRef.current?.cpuCache ?? null}
                        // Lets it shrink to the room the slot has and scroll.
                        style={{ minHeight: 0, flexShrink: 1 }}
                      />
                    </Suspense>
                  )}
                </>
              ),
              "bottom-left": collectionNavigator,
              "bottom-center": hasData && (
                <DimensionBar
                  viewMode={dims.viewMode}
                  onViewModeToggle={dims.handleViewModeToggle}
                  z={dims.z}
                  dimZ={dims.dimZ}
                  onZChange={dims.handleZChange}
                  t={dims.t}
                  dimT={dims.dimT}
                  onTChange={dims.handleTChange}
                  cameraMode={cameraMode === "fly" ? "fly" : "arcball"}
                  onCameraModeToggle={handleCameraModeToggle}
                  channel={{
                    c: dims.c,
                    dimC: dims.dimC,
                    onCChange: dims.handleCChange,
                    multiChannel: dims.multiChannel,
                    onMultiChannelToggle: dims.handleMultiChannelToggle,
                  }}
                />
              ),
              // Mounted before any dataset opens, and only hidden until one
              // does: its first 2D-canvas draw must land before an open's
              // first frame (see Minimap.tsx).
              "bottom-right": render.clientReady && render.clientRef.current && (
                <div hidden={!hasData}>
                  <Minimap client={render.clientRef.current} activeLoop={render.activeLoop} />
                </div>
              ),
            }}
          >
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
            {showDebugOverlays && (
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
          </CanvasStage>
          {!captureSurface && (
            <BottomToolbar
              annotationKind={annotationKind}
              onAnnotationKindChange={setAnnotationKind}
              annotationsVisible={annotationsVisible}
              onToggleAnnotations={() => setAnnotationsVisible((v) => !v)}
            />
          )}
          {developer.monitor && (
            // The dock overlays the canvas rather than resizing it (ADR 0052),
            // so opening it changes nothing the recorder sees. Its frame keeps
            // it between the side panels.
            <div className="lc-shell-dock">
              <Suspense fallback={null}>
                <MonitorDock onClose={developer.closeMonitor} />
              </Suspense>
            </div>
          )}
        </div>
        {!captureSurface && (
          <RightRail
            panels={[
              {
                id: "savedViews",
                label: "Saved views",
                icon: BookmarkSimpleIcon,
                render: (active) => (
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
                    visible={active}
                  />
                ),
              },
              {
                id: "explore",
                label: "Explore",
                icon: CompassIcon,
                render: (active) => (
                  <ExplorationPanel
                    visible={active}
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
                  />
                ),
              },
            ]}
          />
        )}
      </div>
      {!captureSurface && (
        <AddDataDialog
          isOpen={addDataOpen}
          onOpenChange={setAddDataOpen}
          onOpen={datasets.handleUrlSubmit}
          onCreateWorkspace={onCreateWorkspaceFromDatasets}
        />
      )}
    </div>
  );
  /* eslint-enable react-hooks/refs */
}

export default App;
