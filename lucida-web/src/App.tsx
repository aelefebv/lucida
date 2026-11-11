import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BookmarkSimpleIcon,
  ChatCircleIcon,
  CompassIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import { LayerPanel, type LayerViewPlacement } from "./components/LayerPanel.tsx";
import { useSceneView } from "./hooks/useSceneView.ts";
import { Minimap } from "./components/Minimap.tsx";
import type { Annotation, AnnotationOverlayHandle } from "./components/annotationDocument.ts";
import { sceneClipDepth } from "./components/clipDepth.ts";
import type { AnnotationDraft } from "./components/annotationDraft.ts";
import type { Tool } from "./components/annotationTool.ts";
import { CommentsPanel } from "./components/CommentsPanel.tsx";
import { countUnread, findMentionsOfMe } from "./components/mentionsOfMe.ts";
import { currentDatasetAnnotations } from "./components/currentDatasetAnnotations.ts";
import { FpsCounter } from "./components/FpsCounter.tsx";
import { extractCollectionData } from "./components/CollectionSelector.tsx";
import type { VoxelRect } from "./pipeline/layoutBuilders.ts";
import { frameRegionOnCanvas } from "./applyAndSend.ts";
import { readPlaneMap, sceneToFrame } from "./placement.ts";
import { LoadingViewBanner } from "./components/LoadingViewBanner.tsx";
import { ImportWarningBanner } from "./components/ImportWarningBanner.tsx";
import { WorkspaceSavedViewsSidebar } from "./components/WorkspaceSavedViewsSidebar.tsx";
import { ExplorationPanel, type Dims } from "./components/ExplorationPanel.tsx";
import { DatasetInfoPanel } from "./components/DatasetInfoPanel.tsx";
import { makeThumbnailRequester } from "./exploreThumbnails.ts";
import { runCommand } from "./ui/commands.ts";
import { toast } from "./ui/toastQueue.ts";
import { invalidateDisplaySettings, requestRender } from "./invalidation.ts";
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
import { useEngine } from "./engine.ts";
import { CanvasLayers } from "./viewer/CanvasLayers.tsx";
import { EngineProvider } from "./viewer/EngineProvider.tsx";
import { useEngineParts } from "./viewer/engineParts.ts";
import { useAnnotationNavigation } from "./viewer/useAnnotationNavigation.ts";
import type { ChromeInputs } from "./shell/chrome.ts";
import { desktopChrome } from "./shell/desktopChrome.tsx";
import { phoneChrome } from "./shell/phone/phoneChrome.tsx";
import { useDatasetSettings, type BridgeCallbacks, type DatasetCallbacks } from "./hooks/useDatasetSettings.ts";
import { useDimensions } from "./hooks/useDimensions.ts";
import { useBridge } from "./hooks/useBridge.ts";
import { useDatasets } from "./hooks/useDatasets.ts";
import { useSeedDatasetOpens } from "./hooks/useSeedDatasetOpens.ts";
import { useAutoContrast } from "./hooks/useAutoContrast.ts";
import { useDatasetLevels } from "./hooks/useDatasetLevels.ts";
import { useSavedViewSync } from "./hooks/useSavedViewSync.ts";
import { useScriptControls } from "./hooks/useScriptControls.ts";
import { useComparison } from "./hooks/useComparison.ts";
import { useEditHistory } from "./hooks/useEditHistory.ts";
import { useUserTransforms } from "./hooks/useUserTransforms.ts";
import { viewLayoutActions } from "./viewLayout.ts";
import { useViewedMentions } from "./hooks/useViewedMentions.ts";
import type { SavedView } from "./savedView/types.ts";
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
import { noteDatasetOpened, noteDatasetOpenFailed } from "./trace/steps.ts";
import { AddDataDialog, AddDataPrompt, noteSourceOpenFailed } from "./addData/index.ts";
import { Banner } from "./shell/Banner.tsx";
import { CanvasStage, type CanvasSize } from "./shell/CanvasStage.tsx";
import { WebGpuUnavailable } from "./shell/WebGpuUnavailable.tsx";
import { DimensionBar } from "./shell/DimensionBar.tsx";
import { useOpenRightPanel } from "./shell/sidePanels.ts";
import { revealCanvas } from "./shell/phone/sheet.ts";
import type { RailPanel } from "./shell/RightRail.tsx";
import { ToolPalette } from "./shell/ToolPalette.tsx";
import { useViewportClass } from "./theme/viewport.ts";
import { useDeveloperSurfaces } from "./shell/useDeveloperSurfaces.ts";
import { useViewerCommands } from "./shell/useViewerCommands.ts";
import { KeyboardHelp } from "./ui/KeyboardHelp.tsx";
import { useWorkspacePreview } from "./workspacePreview/useWorkspacePreview.ts";
import "./App.css";

// The debug UI is code-split: the panel loads on first open, the overlay layer
// (in CanvasLayers) only when an overlay is on or a radius preview is being
// dragged. The main bundle keeps only the small gate module, debug/logging.ts.
const DevControls = lazy(() =>
  import("./debug/DevControls.tsx").then((m) => ({ default: m.DevControls })),
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
  /** The server removed this person's access while the viewer was open. */
  onAccessRevoked?: () => void;
  onRenameWorkspace: (name: string) => Promise<void>;
  onSetDefaultSavedView: (savedViewId: string | null) => Promise<void>;
  /** Create a new workspace from file-browser selections and navigate into
   *  it, as the dashboard does. */
  onCreateWorkspaceFromDatasets?: (paths: string[]) => void;
}

/** The viewer for one workspace, inside the engine it drives. */
function App(props: AppProps) {
  return (
    <EngineProvider>
      <Viewer {...props} />
    </EngineProvider>
  );
}

function Viewer({
  workspaceId,
  workspaceName,
  workspaceRole,
  defaultSavedViewId,
  canRenameWorkspace,
  initialDatasetUrls,
  onBackToDashboard,
  onAccessRevoked,
  onRenameWorkspace,
  onSetDefaultSavedView,
  onCreateWorkspaceFromDatasets,
}: AppProps) {
  // Provided by <AuthGate>; throws when unauthenticated. The email feeds the
  // saved-view "Mine only" filter.
  const authSession = useAuthSession();

  // Browser-persisted author identity, used only for annotation `author` and
  // ownership checks; the connection's `myId` stays the presence/cursor/follow identity.
  // Persisting it lets a returning user keep control of what they authored.
  const annotationAuthor = useMemo(() => annotationAuthorId(), []);

  const engine = useEngine();
  const sceneStore = engine.store;
  const { scene, render, setSession } = useEngineParts();
  // `?render=1` is the chrome-free capture surface for `dataset montage`,
  // `dataset explore`, and the trace driver: no UI chrome and no persisted
  // writes. Read `captureSurface.ts` before wiring anything new in here.
  const captureSurface = useMemo(() => isCaptureSurface(), []);
  const developer = useDeveloperSurfaces({ captureSurface });
  // A phone puts its own chrome around the same canvas (src/shell/phone).
  const phone = useViewportClass() === "phone" && !captureSurface;
  // The canvas's CSS size, settled: it follows a panel drag a beat behind, so
  // the drag doesn't re-render the whole viewer on every frame.
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });

  const datasetsRef = useRef<Map<string, DatasetState>>(new Map());
  // Lifted here because call ordering stops the hooks that use it from owning it.
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  // The canvas tool: pan navigates; point, line, and box draw an annotation.
  const [tool, setTool] = useState<Tool>("pan");
  // Personal show/hide of all annotations: local, unsynced, not persisted, and
  // passed as `visible` to both overlays.
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  // Lets the Comments panel jump to a pin, although each overlay owns its
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
  // Set when `#a=<id>` doesn't resolve in the loaded document. A recipient
  // without access fails at the workspace gate first, so this never reveals
  // whether an annotation exists.
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
  } | null>(null);

  // Domain hooks (order matters: earlier hooks use refs for later hooks' values).

  const dims = useDimensions({
    sceneStore,
    wasmSceneRef: scene.wasmSceneRef,
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
    onSessionChanged: setSession,
    bumpLayerSettingsVersion: layers.bumpLayerSettingsVersion,
    initLayerMaps: (id) => {
      layers.initLayerMaps(id);
    },
    setSelectedDatasetId,
    bumpDatasetsVersion,
    bumpRemoteDocumentVersion,
    onWorkspaceArchived: onBackToDashboard,
    onAccessRevoked,
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

  const notifySavedViewMissing = useCallback(() => {
    toast({
      title: "Saved view not found",
      description:
        "The view this link names isn't in this workspace. It may have been deleted, or the link may name a bookmark, which this server no longer keeps.",
      tone: "warning",
    });
  }, []);

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

  // Saved-view wiring. Must come after `useBridge`, whose functions the applier
  // needs, and before the savedViewHooksRef populate below.
  const savedViewSync = useSavedViewSync({
    getScene: engine.scene,
    sendOpenRemoteDataset: bridge.sendOpenRemoteDataset,
    sendCommand: bridge.sendCommand,
    emitPresence: bridge.emitPresence,
    emitDatasetPresence: bridge.emitDatasetPresence,
    breakFollow: bridge.breakFollow,
    // Any local or remote scene mutation bumps one of these. Viewport-only
    // changes bypass them and go through emitPresenceWithUrl.
    changeTick: datasetsVersion + remoteDocumentVersion,
    sceneStore,
    onApplyResult: handleApplyResult,
    loopRef: render.loopRef,
    dimensionExtentsFor: dims.dimensionExtentsFor,
    labelNamesFor: dims.labelNamesFor,
    autoContrastMapRef: layers.autoContrastMapRef,
    setAutoContrastMap: layers.setAutoContrastMap,
    datasetReferenceMode: "workspace-dataset-id",
    fetchSavedViewById: fetchWorkspaceSavedViewById,
    onSavedViewMissing: notifySavedViewMissing,
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
    onDatasetOpened: (id) => {
      savedViewSync.applier.notifyDatasetOpened(id);
      noteDatasetOpened(id);
    },
    onOpenDatasetFailed: (url, err) => {
      savedViewSync.applier.notifyOpenFailed(url, err);
      noteSourceOpenFailed(url);
      noteDatasetOpenFailed(url, err);
    },
  };

  const datasets = useDatasets({
    // Wrap so URL→DatasetId tracking is populated for every local open
    // (browse-pane-driven, URL-bar-driven, applier-driven).
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
  // Threaded to every caller of bridge.emitPresence. Both are keyed on stable
  // callbacks alone: the canvas viewers bind their listeners to them, and a
  // peer message must not rebind those.
  const { emitPresence, emitDatasetPresence, breakFollow } = bridge;
  const notifySavedViewChange = savedViewSync.notifyChange;
  const emitPresenceWithUrl = useCallback(() => {
    emitPresence();
    notifySavedViewChange();
    // The live view no longer matches the opened saved view. Guarded so it
    // doesn't re-render on every pan frame.
    setCurrentOpenSavedViewId((prev) => (prev === null ? prev : null));
  }, [emitPresence, notifySavedViewChange]);
  const emitDatasetPresenceWithUrl = useCallback(() => {
    emitDatasetPresence();
    notifySavedViewChange();
  }, [emitDatasetPresence, notifySavedViewChange]);

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
  // and shared by the mention-candidate builder and the Comments panel.
  const currentAnnotations = useMemo<Annotation[]>(() => {
    // With no selection, falls back to the first dataset with annotations, so a
    // peer's mention that lands before selection still counts.
    return currentDatasetAnnotations(scene.wasmSceneRef.current, selectedDatasetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on doc/dataset change; the scene is a stable ref.
  }, [scene.wasmSceneRef, selectedDatasetId, remoteDocumentVersion]);

  // Per-browser read state for mentions, persisted and scoped to the selected
  // dataset. Never synced.
  const { viewedCommentIds, markViewed } = useViewedMentions(selectedDatasetId);

  // Comments that mention this user; the unread ones badge the Comments rail icon.
  const mentionsOfMe = useMemo(
    () =>
      findMentionsOfMe({
        annotations: currentAnnotations,
        currentUserId: annotationAuthor,
        currentUserEmail: authSession.principal.email,
        members: workspaceMembers,
      }),
    [currentAnnotations, annotationAuthor, authSession.principal.email, workspaceMembers],
  );
  const unreadMentions = useMemo(
    () => countUnread(mentionsOfMe, new Set(viewedCommentIds)),
    [mentionsOfMe, viewedCommentIds],
  );

  const mentionCandidates = useMemo(() => {
    return deriveMentionCandidates({
      annotations: currentAnnotations,
      currentUserId: annotationAuthor,
      members: workspaceMembers,
      currentUserEmail: authSession.principal.email,
    });
  }, [currentAnnotations, annotationAuthor, workspaceMembers, authSession.principal.email]);

  const { navigateToMention, goToAuthorView } = useAnnotationNavigation({
    engine,
    viewMode: dims.viewMode,
    dimensionExtentsFor: dims.dimensionExtentsFor,
    labelNamesFor: dims.labelNamesFor,
    annotations: currentAnnotations,
    selectedDatasetId,
    setSelectedDatasetId,
    annotationsVisible,
    setAnnotationsVisible,
    overlay2dRef,
    overlay3dRef,
    breakFollow,
    emitPresence: emitPresenceWithUrl,
    emitDatasetPresence: emitDatasetPresenceWithUrl,
    collapseDeepLinkHash: savedViewSync.collapseDeepLinkHash,
    docVersion: remoteDocumentVersion,
    onDeepLinkNotFound: setDeepLinkNotFound,
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

  // The two sections of a bundle the trace does not record, the server's
  // dataset health and the frame on the canvas, come from the session socket
  // and the render worker, which both live here. The seam owns the rest, and
  // a page with neither registered still saves a bundle that says what is
  // missing.
  const liveBridge = bridge.bridge;
  useEffect(() => {
    setBundleServices({
      requestHealth: () =>
        liveBridge
          ? liveBridge.requestDatasetHealthReply()
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

  const comparison = useComparison(engine, layers.layerInfos);
  const editHistory = useEditHistory({
    engine,
    sendCommand: bridge.sendCommand,
    onDocumentChanged: bumpRemoteDocumentVersion,
  });
  const userTransforms = useUserTransforms({
    engine,
    canEdit: canEditWorkspace,
    sendCommand: bridge.sendCommand,
    history: editHistory,
    nameOf: comparison.nameOf,
    onDocumentChanged: bumpRemoteDocumentVersion,
  });
  const viewLayout = useMemo(() => viewLayoutActions(engine.scene, engine.loop), [engine]);
  const { views: shownViews, layout: viewLayoutName, links: viewLinks } = useSceneView(engine.store);
  // Several views offer each layer a place among them.
  const layerViewPlacement = useMemo((): LayerViewPlacement | undefined => {
    if (shownViews.length < 2) return undefined;
    return {
      count: shownViews.length,
      moveTo: (id, index) => viewLayout.move(shownViews[index].id, id),
      showEverywhere: viewLayout.showEverywhere,
    };
  }, [shownViews, viewLayout]);
  const toggleSplit = useCallback(() => {
    // A phone stacks its two views; a wider screen sets them side by side.
    viewLayout.setLayout(viewLayoutName !== "single" ? "single" : phone ? "rows" : "columns");
  }, [viewLayout, viewLayoutName, phone]);

  const requestDatasetHealth = useCallback(
    () => liveBridge
      ? liveBridge.requestDatasetHealth()
      : Promise.reject(new Error("the session socket is not connected")),
    [liveBridge],
  );
  useScriptControls({
    selectors: {
      z: dims.z, t: dims.t,
      dimZ: dims.dimZ, dimT: dims.dimT,
      viewMode: dims.viewMode,
      slicePlane: dims.slicePlane, cutIndex: dims.cutIndex, dimCut: dims.dimCut,
    },
    resolvedLayers: dims.layers,
    setCut: dims.handleCutChange,
    setSlicePlane: dims.handleSlicePlaneChange,
    setT: dims.handleTChange,
    setSolo: layers.handleChannelSetSolo,
    setChannelVisible: layers.handleChannelSetVisible,
    setLayerVisible: layers.handleLayerSetVisible,
    setLabelVisible: layers.handleLabelSetVisible,
    setChannelContrast: layers.handleChannelSetContrast,
    openDataset: datasets.handleUrlSubmit,
    removeDataset: layers.removeLayer,
    datasetHealth: requestDatasetHealth,
    captureView: savedViewSync.captureBuilder,
    comparison: comparison.actions,
    viewLayout,
    selectedDatasetId,
    datasetsRef,
  });

  useAutoContrast({
    activeLoop: render.activeLoop,
    autoContrastMapRef: layers.autoContrastMapRef,
    contrastFitMapRef: layers.contrastFitMapRef,
    setContrastFitMap: layers.setContrastFitMap,
    wasmSceneRef: scene.wasmSceneRef,
    loopRef: render.loopRef,
    sessionRef: bridge.sessionRef,
    peerStore: bridge.peerStore,
  });

  // The volume viewer owns the fly toggle: entering fly mode also sets the fly
  // speed from the volume's size and shows the fly hint, which a bare switch
  // of the scene's camera here would skip.
  const handleCameraModeToggle = useCallback(() => {
    runCommand("camera.toggleFly");
  }, []);

  const [addDataOpen, setAddDataOpen] = useState(false);
  // Whether any on-canvas debug overlay is toggled on (persisted in
  // the `debug.overlays` preference, independent of every panel). Drives the
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
    // A new size changes what the view wants, so the recorder hears it as an
    // input. Before a dataset opens the loop opens no run for it.
    render.loopRef.current?.markInput("resize");
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
  // header, and its `[T, C, Z, Y, X]` shape for the labels. Recomputed from
  // the live layer list + dataset map.
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

  // The Info panel describes the selected dataset, else the first one open.
  const infoDataset = useMemo(() => {
    const layer =
      layers.layerInfos.find((l) => l.id === selectedDatasetId) ?? layers.layerInfos[0] ?? null;
    // eslint-disable-next-line react-hooks/refs -- the live dataset map; datasetsVersion re-runs this.
    const ds = layer ? datasetsRef.current.get(layer.id) : undefined;
    return layer && ds ? { id: layer.id, name: layer.name, manifest: ds.manifest } : null;
    // datasetsVersion drives the re-render that surfaces datasetsRef mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.layerInfos, selectedDatasetId, datasetsVersion]);

  // The manifest has no source location or health; the server's dataset health has both.
  const getDatasetHealth = useCallback(
    async (datasetId: string) => {
      if (!liveBridge) return null;
      const health = await liveBridge.requestDatasetHealth(datasetId);
      return health.find((h) => h.workspace_dataset_id === datasetId) ?? null;
    },
    [liveBridge],
  );

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
  const handleOpenWorkspaceSavedView = useCallback(async (view: SavedView, savedViewId: string) => {
    revealCanvas();
    // Picked by hand, so it may put datasets where it recorded them.
    userTransforms.restored(await savedViewApplier.apply(view, { restorePlacement: true }));
    notifySavedViewChange();
    // Remember which saved view is now applied so the sidebar can flag the
    // active row. Set it only after a successful apply.
    setCurrentOpenSavedViewId(savedViewId);
  }, [savedViewApplier, notifySavedViewChange, userTransforms]);

  // The sidebar reports when the open saved view stops existing (deleted,
  // withdrawn, or rejected); drop the highlight. The id guard keeps a stale
  // invalidation from clearing a newer open view.
  const handleActiveSavedViewInvalidated = useCallback((savedViewId: string) => {
    setCurrentOpenSavedViewId((prev) => (prev === savedViewId ? null : prev));
  }, []);

  // Descend into a guided-exploration candidate (or Home/Back) from the Explore
  // panel: apply the view and co-tap the URL/last-view sync. Distinct from
  // handleOpenWorkspaceSavedView because there is no saved-view id to flag as
  // the active row (an explored view is ephemeral until bookmarked).
  const applyExploreView = useCallback(
    async (view: SavedView) => {
      await savedViewApplier.apply(view);
      notifySavedViewChange();
    },
    [savedViewApplier, notifySavedViewChange],
  );

  const hasData = layers.layerInfos.length > 0;

  const takeViewAsPreview = useWorkspacePreview({
    workspaceId,
    canUpload: workspaceRole !== "viewer" && !captureSurface,
    hasData,
    captureFrame: () => render.loopRef.current?.captureFrame() ?? render.clientRef.current?.captureFrame() ?? null,
  });

  useViewerCommands({
    viewMode: dims.viewMode,
    hasData: datasetsVersion > 0,
    onToggleViewMode: dims.handleViewModeToggle,
    onBackToDashboard,
    rightPanels: [
      { id: "savedViews", label: "Saved views" },
      { id: "comments", label: "Comments" },
      { id: "explore", label: "Explore" },
      { id: "info", label: "Info" },
    ],
    developer,
  });

  // The 2D collection navigator for the selected dataset, when it is a collection.
  const navigatorProps = (() => {
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
    return {
      collectionKind: collectionData.collectionKind,
      members: collectionData.members,
      collectionName: ds.name,
      onGroupClick: (bounds: VoxelRect) => {
        const ws = scene.wasmSceneRef.current;
        const canvas = render.canvasRef.current;
        if (!ws || !canvas) return;
        revealCanvas();
        bridge.breakFollow();
        frameRegionOnCanvas(ws, canvas, ds.id, bounds);
        emitPresenceWithUrl();
        requestRender(render.loopRef.current, "collection_group_click");
      },
      getViewCenter: () => {
        const ws = scene.wasmSceneRef.current;
        return ws ? sceneToFrame(readPlaneMap(ws, ds.id), [ws.center(ws.active_view())[0], ws.center(ws.active_view())[1]]) : null;
      },
    };
  })();

  // A browser that can't draw gets its own explanation in place of the canvas.
  const datasetStatus =
    scene.wasmError || (render.gpuUnavailable ? null : render.renderError) || bridge.remoteDatasetError;

  // The JSX block below reads `.current` from the engine's refs (the canvas,
  // the dataset map, the render client) to pass the latest values to the
  // Explore panel, the HUD, the minimap, and the canvas layers. The versioning
  // state (datasetsVersion, remoteDocumentVersion) drives the re-render that
  // surfaces a ref's update. eslint-plugin-react-hooks@7 treats every such
  // read as suspicious; these are intentional.
  /* eslint-disable react-hooks/refs */
  // The layer panel, the dimension bar, and the rail's panels sit beside and
  // over the canvas on wider screens, and in the bottom sheet on a phone.
  const layerPanel = (
    <LayerPanel
      layers={layers.layerInfos}
      selectedLayerId={selectedDatasetId}
      expandedLayerId={layers.expandedLayerId}
      resolvedLayers={dims.layers}
      slicePlane={dims.viewMode === "2d" ? dims.slicePlane : null}
      importWarnings={bridge.datasetImportWarnings}
      onSelectLayer={layers.handleLayerSelect}
      onToggleExpand={layers.handleLayerToggleExpand}
      onSetVisible={layers.handleLayerSetVisible}
      onSetOpacity={layers.handleLayerSetOpacity}
      onSetBlendMode={layers.handleLayerSetBlendMode}
      onSetRenderMode={layers.handleLayerSetRenderMode}
      onSetLevelPin={layers.handleLayerSetLevelPin}
      onAutoContrastChange={layers.handleAutoContrastChange}
      onMoveLayer={layers.handleLayerMove}
      onRemoveLayer={layers.handleRemoveLayer}
      onRenameLayer={layers.handleLayerRename}
      canEdit={canEditWorkspace}
      onChannelSetVisible={layers.handleChannelSetVisible}
      onChannelSetColormap={layers.handleChannelSetColormap}
      onChannelSetName={layers.handleChannelSetName}
      onChannelSetContrast={layers.handleChannelSetContrast}
      onChannelSetGamma={layers.handleChannelSetGamma}
      onChannelAutoFit={layers.handleChannelAutoFit}
      onChannelSetBlendMode={layers.handleChannelSetBlendMode}
      onSoloChannel={layers.handleSoloChannel}
      onShowAllChannels={layers.handleShowAllChannels}
      onLabelSetVisible={layers.handleLabelSetVisible}
      onLabelSetOpacity={layers.handleLabelSetOpacity}
      onAddData={() => setAddDataOpen(true)}
      comparisonBlocker={comparison.blocker}
      comparisonNote={comparison.byHand}
      onCompare={comparison.compareWith}
      onSetUserTransform={userTransforms.commit}
      onResetUserTransform={userTransforms.reset}
      viewPlacement={layerViewPlacement}
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
    />
  );
  const dimensionBar = hasData && (
    <DimensionBar
      viewMode={dims.viewMode}
      onViewModeToggle={dims.handleViewModeToggle}
      split={viewLayoutName !== "single"}
      stacked={phone}
      onSplitToggle={toggleSplit}
      links={viewLinks ? { links: viewLinks, onChange: viewLayout.link } : undefined}
      slicePlane={dims.slicePlane}
      onSlicePlaneChange={dims.handleSlicePlaneChange}
      dimZ={dims.dimZ}
      cut={dims.cutIndex}
      cutPlace={dims.cutPlace}
      dimCut={dims.dimCut}
      onCutChange={dims.handleCutChange}
      t={dims.t}
      dimT={dims.dimT}
      onTChange={dims.handleTChange}
      cameraMode={dims.cameraMode === "fly" ? "fly" : "arcball"}
      onCameraModeToggle={handleCameraModeToggle}
      // Moves the same scene state the `[` and `]` keys do, and
      // shares and repaints it the same way.
      clipDepth={
        scene.wasmScene && selectedDatasetId
          ? sceneClipDepth(scene.wasmScene, selectedDatasetId, () => {
              emitPresenceWithUrl();
              requestRender(render.loopRef.current, "clip_plane");
            })
          : undefined
      }
    />
  );
  const railPanels: RailPanel[] = [
    {
      id: "savedViews",
      label: "Saved views",
      shortLabel: "Views",
      icon: BookmarkSimpleIcon,
      render: (active) => (
        <WorkspaceSavedViewsSidebar
          workspaceId={workspaceId}
          currentUserEmail={authSession.principal.email}
          canEdit={canEditWorkspace}
          getCurrentSavedView={savedViewSync.captureBuilder}
          position={{ z: dims.z, t: dims.t }}
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
      id: "comments",
      label: "Comments",
      icon: ChatCircleIcon,
      badge: {
        count: unreadMentions,
        label: `${unreadMentions} unread mention${unreadMentions === 1 ? "" : "s"}`,
      },
      render: (active) => (
        <CommentsPanel
          visible={active}
          annotations={currentAnnotations}
          mentions={mentionsOfMe}
          viewedCommentIds={viewedCommentIds}
          currentUserId={annotationAuthor}
          extents={{ z: dims.dimZ, t: dims.dimT }}
          onNavigate={(pinId) => {
            revealCanvas();
            navigateToMention(pinId);
          }}
          onMarkViewed={markViewed}
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
          getScene={() => scene.wasmSceneRef.current}
          requestThumbnail={requestThumbnail}
        />
      ),
    },
    {
      id: "info",
      label: "Info",
      icon: InfoIcon,
      render: (active) => (
        <DatasetInfoPanel
          visible={active}
          workspaceId={workspaceId}
          dataset={infoDataset}
          getHealth={getDatasetHealth}
        />
      ),
    },
  ];
  const chromeInputs: ChromeInputs = {
    workspaceId,
    workspaceName,
    onRenameWorkspace: canRenameWorkspace ? onRenameWorkspace : undefined,
    onBackToDashboard,
    onUseViewAsPreview: takeViewAsPreview,
    presence: {
      peerStore: bridge.peerStore,
      onFollow: bridge.handleFollow,
    },
    share: {
      workspaceId,
      canManageAccess: workspaceRole === "owner",
      getCurrentSavedView: savedViewSync.captureBuilder,
    },
    developer,
    layerPanel,
    dimensionBar,
    channelChips: {
      layers: layers.layerInfos,
      selectedLayerId: selectedDatasetId,
      resolvedLayers: dims.layers,
      onChannelSetVisible: layers.handleChannelSetVisible,
      onSoloChannel: layers.handleSoloChannel,
      onShowAllChannels: layers.handleShowAllChannels,
    },
    navigator: navigatorProps,
    railPanels,
  };
  const chrome = phone ? phoneChrome(chromeInputs) : desktopChrome(chromeInputs, { captureSurface });

  // The canvas stage keeps its place in the tree whichever chrome is around
  // it (see `shell/chrome.ts`).
  return (
    <div className="lc-shell" data-capture={captureSurface || undefined} data-layout={phone ? "phone" : undefined}>
      {chrome.top}
      <div className="lc-shell-body">
        {chrome.left}
        <div className="lc-shell-center">
          <CanvasStage
            canvasRef={render.canvasRef}
            canvasKey={render.canvasKey}
            pixelated={dims.viewMode === "2d"}
            onResize={handleCanvasResize}
            bare={captureSurface}
            label={
              hasData
                ? `${dims.viewMode === "3d" ? "3D" : "2D"} view of ${loadedDatasetNames.join(", ")}`
                : "Empty view"
            }
            emptyState={
              render.gpuUnavailable ? (
                <WebGpuUnavailable reason={render.gpuUnavailable} />
              ) : !hasData && bridge.sessionReady && !bridge.remoteDatasetLoading && !captureSurface ? (
                <AddDataPrompt onAddData={() => setAddDataOpen(true)} />
              ) : null
            }
            // Without a renderer the controls over the canvas have nothing to drive.
            slots={render.gpuUnavailable ? undefined : {
              "top-left": hasData && (
                <ToolPalette
                  tool={tool}
                  onToolChange={setTool}
                  annotationsVisible={annotationsVisible}
                  onAnnotationsVisibleChange={setAnnotationsVisible}
                  compact={phone}
                  canMove={canEditWorkspace}
                />
              ),
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
                    <Banner tone="info">{bridge.remoteDatasetProgress ?? "Loading dataset…"}</Banner>
                  )}
                  {datasetStatus && (
                    <Banner tone="danger" role="alert">
                      {datasetStatus}
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
                        getGpuMemory={() => render.clientRef.current?.gpuMemory() ?? null}
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
                      />
                    </Suspense>
                  )}
                </>
              ),
              "bottom-left": chrome.canvasBottomLeft,
              "bottom-center": chrome.canvasBottomCenter,
              // Mounted before any dataset opens, and only hidden until one
              // does: its first 2D-canvas draw must land before an open's
              // first frame (see Minimap.tsx).
              "bottom-right": render.clientReady && render.clientRef.current && (
                <div hidden={!hasData}>
                  <Minimap
                    client={render.clientRef.current}
                    activeLoop={render.activeLoop}
                    engine={engine}
                    emitPresence={emitPresenceWithUrl}
                    breakFollow={breakFollow}
                  />
                </div>
              ),
            }}
          >
            <CanvasLayers
              datasets={datasetsRef.current}
              hasDatasets={datasetsVersion > 0}
              selectedDatasetId={selectedDatasetId}
              tool={tool}
              annotationsVisible={annotationsVisible}
              annotationAuthor={annotationAuthor}
              remoteDocumentVersion={remoteDocumentVersion}
              onDocumentChanged={bumpRemoteDocumentVersion}
              emitPresence={emitPresenceWithUrl}
              breakFollow={breakFollow}
              sendCursor={bridge.sendCursor}
              sendCommand={bridge.sendCommand}
              peerStore={bridge.peerStore}
              overlay2dRef={overlay2dRef}
              overlay3dRef={overlay3dRef}
              annotationDraftRef={annotationDraftRef}
              mentionCandidates={mentionCandidates}
              onGoToAuthorView={goToAuthorView}
              canvasSize={canvasSize}
              showDebugOverlays={showDebugOverlays}
              viewLayout={viewLayout}
              userTransforms={userTransforms}
            />
          </CanvasStage>
          {developer.monitor && (
            // The dock overlays the canvas rather than resizing it, so opening
            // it changes nothing the recorder sees. Its frame keeps it between
            // the side panels.
            <div className="lc-shell-dock">
              <Suspense fallback={null}>
                <MonitorDock onClose={developer.closeMonitor} />
              </Suspense>
            </div>
          )}
          {chrome.below}
        </div>
        {chrome.right}
      </div>
      {!captureSurface && (
        <AddDataDialog
          isOpen={addDataOpen}
          onOpenChange={setAddDataOpen}
          onOpen={datasets.handleUrlSubmit}
          onCreateWorkspace={onCreateWorkspaceFromDatasets}
        />
      )}
      {!captureSurface && <KeyboardHelp />}
    </div>
  );
  /* eslint-enable react-hooks/refs */
}

export default App;
