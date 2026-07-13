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
import { debugStats } from "./debug/debugStats.ts";
import { DEBUG_OVERLAYS, isOverlayEnabled, onOverlaysChanged } from "./debug/logging.ts";
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
import { useSavedViewSync } from "./hooks/useSavedViewSync.ts";
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
import "./App.css";

// The debug UI (side panel + on-canvas overlay layer) is code-split into
// its own on-demand chunk: the panel loads on the first Debug-button
// click, the overlay layer only when an overlay toggle is persisted on
// (or the panel is open). A session that never opens either never
// downloads the code — the main bundle keeps only the tiny gate/stat
// modules (debug/logging.ts, debug/debugStats.ts) that production code
// paths already share.
const DebugPanel = lazy(() =>
  import("./debug/DebugPanel.tsx").then((m) => ({ default: m.DebugPanel })),
);
const DebugOverlays = lazy(() =>
  import("./debug/DebugOverlays.tsx").then((m) => ({ default: m.DebugOverlays })),
);

interface AppProps {
  workspaceId: string;
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  defaultSavedViewId: string | null;
  canRenameWorkspace: boolean;
  /** Dataset URLs/paths to auto-open once the viewer connects (#697). Set by
   *  the "create workspace from dataset(s)" flow (dashboard / file browser):
   *  the workspace is created and navigated into first, then these are opened
   *  here via the same path as the in-viewer "Open" flow. A failed open
   *  surfaces through the normal open-failed banner and LEAVES the workspace in
   *  place (it already exists and we're already in it). Already canonicalized
   *  by the caller. Empty/undefined in the normal open-existing-workspace
   *  case, so this is a no-op there. */
  initialDatasetUrls?: readonly string[];
  onBackToDashboard: () => void;
  onRenameWorkspace: (name: string) => Promise<void>;
  onSetDefaultSavedView: (savedViewId: string | null) => Promise<void>;
  /** Create a NEW workspace from dataset(s) chosen in the in-viewer file
   *  browser and navigate into it (#697). Mirrors the dashboard entry point so
   *  the "create workspace from selection" action is reachable from both. */
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
  // Authenticated principal — provided by <AuthGate> above us; throws if
  // accessed unauthenticated. We forward the email to saved-view UI for
  // the "Mine only" filter.
  const authSession = useAuthSession();

  // Stable, browser-persisted annotation author identity (issue #777). This is
  // the identity used ONLY for the annotation `author:` field and the
  // mine/ownership checks in the overlays/viewers — NOT the per-connection
  // `bridge.myId`, which stays the presence/cursor/follow identity. Because it's
  // persisted in localStorage it survives leaving + rejoining a workspace (and
  // tab close/reopen), so a returning user keeps edit/move/delete on the pins
  // and comments they authored. Resolved once per mount (the value is stable for
  // the session) so the same string flows to every annotation consumer.
  const annotationAuthor = useMemo(() => annotationAuthorId(), []);

  // Foundation hooks
  const scene = useWasmScene();
  const render = useRenderClient();
  // Chrome-free capture surface for `dataset montage` / `viewer render`:
  // `?render=1` hides all UI chrome and lets the canvas fill the viewport so a
  // headless screenshot is pure data. Parsed once — the URL is stable per capture.
  const renderMode = useMemo(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("render") === "1",
    [],
  );
  const layout = useLayout({ loopRef: render.loopRef, renderMode });

  // Shared refs used by multiple hooks
  const datasetsRef = useRef<Map<string, DatasetState>>(new Map());
  // Lifted state — shared across hooks that can't own it due to call ordering
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  // Which annotation shape a shift-drag draws: a point pin (drop), a line
  // (drag between two points), or a box (drag between opposite corners).
  const [annotationKind, setAnnotationKind] = useState<"point" | "line" | "box">("point");
  // Personal show/hide of ALL annotations (issue #792). A local view toggle —
  // not a command, not synced to peers, not persisted across reloads — passed as
  // `visible` to BOTH overlays so one toolbar button declutters every pin/line/
  // box (and their threads) at once; flipping it back re-renders the untouched
  // annotation set. Peer cursors are a separate overlay and stay visible.
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  // Imperative handles on the two annotation overlays (issue #526), so the
  // "mentions of me" inbox can JUMP to a pin even though each overlay owns its
  // own `openPinId` state. The host holds a ref to whichever overlay is mounted
  // (2D vs 3D follow the view mode) and calls `focusPin(pinId)`, which opens that
  // pin's thread and recenters on it. One ref per overlay keeps the seam explicit
  // and view-specific without leaking overlay internals into App.
  const overlay2dRef = useRef<AnnotationOverlayHandle | null>(null);
  const overlay3dRef = useRef<AnnotationOverlayHandle | null>(null);
  // Shared channel for the live box/line draw preview (issue: shapes only
  // appeared on release). The canvas gesture handlers (SliceViewer/VolumeViewer)
  // write the in-progress shape here; AnnotationDraftOverlay renders it.
  const annotationDraftRef = useRef<AnnotationDraft | null>(null);
  const [datasetsVersion, setDatasetsVersion] = useState(0);
  const [remoteDocumentVersion, setRemoteDocumentVersion] = useState(0);
  // Workspace member roster for @-mention candidates (issue #526). Best-effort:
  // `getWorkspaceSharing` is owner-only server-side (403 for editors/viewers) and
  // unavailable offline, so a failure leaves this `[]` and the picker falls back
  // to the document's participants. Fetched once per workspace (the roster is
  // small and changes rarely); members supply REAL display-name handles so you
  // can @-mention a collaborator before they've touched the document.
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [cameraMode, setCameraMode] = useState<string>("arcball");
  // A transient, non-blocking notice from the LIGHT annotation-view restore
  // (slice 2): when an author's captured z/t/c had to be clamped to fit the
  // pin's own dataset (different extents), we show a brief "Z adjusted to fit
  // this dataset" line rather than blocking. Auto-cleared after a few seconds.
  // Distinct from the heavy applier's LoadingViewBanner (the light path never
  // goes through the applier — no dataset opening/hiding, no layout broadcast).
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  // A non-blocking notice for the annotation DEEP-LINK path (slice 3) when the
  // `#a=<id>` couldn't be resolved against the loaded workspace document — the
  // annotation was deleted, or the id is wrong/forged. Distinct from
  // `restoreNotice` (a successful-but-clamped restore) so the two never clobber
  // each other; rendered as a dismissible message rather than a silent no-op.
  // NEVER-LEAK: this is the SAME outcome a recipient-without-access would see
  // (they never get this far — the workspace load fails at the gate first), so
  // "deleted/forged id" and "not allowed" are indistinguishable by design.
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

  // Resolves the selected-dataset wrinkle (option c, [[wiki/queue]]
  // 2026-05-07): on apply, re-target `selectedDatasetId` at the first
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

  // "Remember my last view" (#700) restore source for a bare /w/:id open.
  // Returns the caller's own remembered view (server-scoped to the principal),
  // or null when none / unavailable — the bootstrap then falls back to the
  // workspace default. The toggle gate + URL-hash precedence live in UrlSync.
  const fetchWorkspaceLastView = useCallback(async () => {
    const state = await getWorkspaceUserState(workspaceId);
    if (!state.last_view) return null;
    return { id: `last-view:${workspaceId}`, view: state.last_view };
  }, [workspaceId]);

  // Persist the caller's current view as their last view (#700). Scoped to the
  // principal server-side; never touches the shared default. Errors degrade
  // silently in the capture effect (offline / non-member / auth-off).
  const persistWorkspaceLastView = useCallback(
    (view: SavedView) => updateWorkspaceLastView(workspaceId, view),
    [workspaceId],
  );

  // Authoritative live Z/T/C for "Save view". The React dimension state
  // (dims.z/t/c/multiChannel) is the source of truth for what the user is
  // looking at; the scene's presence export can lag (peer-follow, restore,
  // dim-clamp) and report the default `z_range {0,1}`, which the encoder
  // then strips. We take z/t/c/multi_channel from React and preserve the
  // current slab THICKNESS from the scene (React only tracks z_range.start
  // via dims.z), so a multi-plane slab survives the capture.
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

  // SavedView wiring. Mounts the URL→scene sync, exposes the
  // share-button capture, gives the loading banner a handle on apply
  // progress, and forwards apply summaries for the selectedDatasetId
  // wrinkle. Hook order matters: must come *after* `useBridge` so we
  // can hand the applier the bridge functions, and *before* the
  // savedViewHooksRef populate below.
  const savedViewSync = useSavedViewSync({
    getScene: () => scene.wasmSceneRef.current,
    sendOpenRemoteDataset: bridge.sendOpenRemoteDataset,
    sendCommand: bridge.sendCommand,
    // The change tick combines doc and dataset versions: any local or
    // remote scene mutation bumps one or the other, which is exactly
    // what we want the URL to track. (Viewport-only mutations bypass
    // these counters and are handled via the emitPresence wrapper below.)
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
    allowDocumentLayoutMutation: canEditWorkspace,
  });

  // The three callback-ref population sites below (savedViewHooksRef,
  // bridgeCallbacksRef, datasetCallbacksRef) implement the "callback refs
  // populated after all hooks return" pattern documented in
  // wiki/gotchas/app-tsx-hook-order.md. Hooks defined earlier in the file
  // depend on these refs to break circular dependencies; populating during
  // render (before effects fire) is load-bearing — switching to useEffect
  // would leave the refs unpopulated for the very first effect pass.
  // Populate the bridge ↔ applier hook ref after the applier exists.
  // eslint-disable-next-line react-hooks/refs
  savedViewHooksRef.current = {
    onDatasetOpened: (id) => savedViewSync.applier.notifyDatasetOpened(id),
    onOpenDatasetFailed: (url, err) => savedViewSync.applier.notifyOpenFailed(url, err),
    // So the bridge can suppress auto-fit-on-open while a saved/last view is
    // restoring its own camera (#700).
    isInProgress: () => savedViewSync.applier.isInProgress(),
  };

  const datasets = useDatasets({
    // Wrap so URL→DatasetId tracking is populated for every local open
    // (FileBrowser-driven, URL-bar-driven, applier-driven).
    sendOpenRemoteDataset: savedViewSync.trackedSendOpen,
  });

  // Auto-open the seed dataset(s) for a "create workspace from dataset(s)" flow
  // (#697). The workspace was created and navigated into by the dashboard /
  // file browser; here we open the dataset(s) over the websocket exactly as the
  // in-viewer "Open" affordance does (`datasets.handleUrlSubmit` →
  // `trackedSendOpen` → `sendOpenRemoteDataset`), so dedup, URL→DatasetId
  // tracking, the loading banner, and the open-failed error path all apply
  // unchanged. Gated on `bridge.sessionReady` — the REAL transport-readiness
  // signal (WS open AND first snapshot applied), NOT `Boolean(bridge.bridge)`,
  // which flips synchronously while the socket is still CONNECTING. With the
  // weaker gate the seed send could fire against a CONNECTING socket and be
  // SILENTLY DROPPED by `Bridge.send` (no queue), leaving the new workspace
  // stuck on "dataset open request sent" forever (the one-shot guard had
  // already latched). `useSeedDatasetOpens` only latches AFTER it actually
  // sends, so until `sessionReady` it simply waits, then fires exactly once. A
  // FAILED import leaves the workspace in place and surfaces through the
  // existing `remoteDatasetError` banner below; we don't unwind.
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

  // Id of the saved view currently applied to the viewer, if any. The sidebar
  // highlights the matching row so the user sees which view they're looking at.
  // Set on a successful open (below); CLEARED the moment the live view diverges
  // from it — see `emitPresenceWithUrl`, the single signal every viewport
  // mutation funnels through — so the highlight means "the view on screen",
  // not "the last row I clicked" (#818).
  const [currentOpenSavedViewId, setCurrentOpenSavedViewId] = useState<string | null>(null);

  // Wrapped emitPresence/emitDatasetPresence — every viewport mutation
  // co-taps urlSync.notifyChange() so the URL stays in sync (Bug #1 fix:
  // changeTick alone doesn't bump on viewport-only mutations like
  // pan/zoom/T/C/Z/contrast). Used here AND threaded into SliceViewer /
  // VolumeViewer / CollectionSelector / handleCameraModeToggle
  // — anywhere a viewport mutation already calls bridge.emitPresence.
  const emitPresenceWithUrl = useCallback(() => {
    bridge.emitPresence();
    savedViewSync.notifyChange();
    // A viewport mutation (pan / zoom / Z / T / C / mode / multi-channel) means
    // the live view no longer equals the opened saved view, so drop the active
    // -row highlight (#818). Functional + guarded so it's a no-op (no re-render)
    // when nothing is highlighted — this fires on every pan frame.
    setCurrentOpenSavedViewId((prev) => (prev === null ? prev : null));
  }, [bridge, savedViewSync]);
  const emitDatasetPresenceWithUrl = useCallback(() => {
    bridge.emitDatasetPresence();
    savedViewSync.notifyChange();
  }, [bridge, savedViewSync]);

  // Fetch the workspace member roster for @-mention handles (issue #526) once per
  // workspace. Best-effort: `getWorkspaceSharing` is owner-only and unavailable
  // offline, so any failure just leaves `workspaceMembers` empty and the picker
  // falls back to document participants — the feature degrades, never throws.
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

  // @-mention candidates for annotation comments (issue #526), threaded to both
  // overlays' shared ThreadPopover. SOURCE = a graceful UNION of the workspace
  // members (real display-name handles, when the roster fetch succeeded) and the
  // document's PARTICIPANTS — the distinct authors already in
  // `scene.annotations(selectedDataset)` (pin AND comment authors) plus the
  // current user. Re-derived whenever the document changes (remoteDocumentVersion)
  // or the scoped dataset switches, so the picker tracks who's in the conversation
  // as pins/comments arrive. Reading the scene in a memo is the same JSON read the
  // overlays do; a parse failure degrades to participants + you rather than
  // throwing. Each candidate carries a STABLE, viewer-independent @handle, so a
  // mention means the same person to everyone (see annotationParticipants.ts).
  // The current dataset's annotations (pins + nested comments), read ONCE from
  // the scene per doc/dataset change and shared by the mention-candidate builder
  // AND the "mentions of me" inbox (issue #526). A single typed read is the same
  // JSON the overlays parse; a malformed/empty snapshot degrades to `[]` rather
  // than throwing. Scoped to `selectedDatasetId` so everything downstream is
  // CURRENT-dataset only (cross-dataset aggregation is out of scope).
  const currentAnnotations = useMemo<Annotation[]>(() => {
    // Read the CURRENT dataset's pins+comments for the mention machinery (the
    // "mentions of me" badge + the candidate builder). The resolver scopes to
    // `selectedDatasetId` when one is selected, and otherwise falls back to the
    // first dataset that actually has annotations — so a peer's mention that
    // lands before any dataset is selected is still counted live (bug #802).
    // See currentDatasetAnnotations.ts.
    return currentDatasetAnnotations(scene.wasmSceneRef.current, selectedDatasetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on doc/dataset change; the scene is a stable ref.
  }, [scene.wasmSceneRef, selectedDatasetId, remoteDocumentVersion]);

  // Per-browser read-state for the "mentions of me" inbox (issue #803): which
  // mention comment ids THIS browser has already viewed, persisted in
  // localStorage and scoped to the selected dataset so reads never bleed across
  // datasets. Personal state only — never synced, no command, no Rust. The
  // <MentionsOfMe> badge counts only ids NOT in this set, and a click on an item
  // marks it viewed (composed with the navigate below).
  const { viewedCommentIds, markViewed } = useViewedMentions(selectedDatasetId);

  const mentionCandidates = useMemo(() => {
    return deriveMentionCandidates({
      annotations: currentAnnotations,
      currentUserId: annotationAuthor,
      members: workspaceMembers,
      currentUserEmail: authSession.principal.email,
    });
  }, [currentAnnotations, annotationAuthor, workspaceMembers, authSession.principal.email]);

  // ANNOTATION NAVIGATION — the TWO TIERS (annotation-views slice 2).
  //
  //  - GENTLE (passive canvas pin-select): clicking a pin's dot on the canvas
  //    keeps today's behavior — the overlay opens the thread and, when the host
  //    drives it, recenters via `focusPin` (2D `set_center` / 3D
  //    `arcball_center_on_voxel`). It NEVER yanks the camera/contrast/zoom. The
  //    `gentleOnContext` helper below is the on-context part of that path.
  //  - EXPLICIT (mention navigation / "Go to author's view"): performs the FULL
  //    restore of the author's captured view via `restoreCapturedView` →
  //    `restoreAnnotationView` (camera incl. 2D<->3D mode switch, z/t/c, display).
  //    This is the LIGHT restore tier: local ViewportCommands only — no dataset
  //    opening/hiding, no SetActiveLayout broadcast (the heavy `applier.apply` is
  //    reserved for the cold share-link open in the next slice). A pin without a
  //    captured view falls back to the gentle path (no regression).
  //
  // GENTLE recenter to a pin (today's behavior, issue #779): bring the pin
  // on-context by matching its Z/T/C, break follow, emit presence. Does NOT
  // touch the camera/contrast/zoom — that's the explicit-restore tier's job.
  // Returns whether anything changed (for the caller's emit bookkeeping is
  // handled internally). Reused by both the no-view fallback AND the passive
  // canvas pin-select (which stays gentle by design).
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

  // The FULL (light) restore of an annotation's captured view — the
  // explicit-navigation tier. Restores the author's camera (incl. switching the
  // 2D<->3D camera MODE before focusing), z-slab/t/c, and display
  // (contrast/gamma), then recenters on the pin so it's actually on-screen.
  //
  // LIGHT, not heavy: routed through `restoreAnnotationView`, which issues ONLY
  // recipient-local ViewportCommands (no dataset opening, no hiding, no
  // SetActiveLayout broadcast). The pin's own dataset is the clamp target +
  // ends up on-context; an out-of-extent capture clamps gracefully with a
  // non-blocking notice. An annotation with NO captured view falls back to the
  // gentle recenter (today's behavior — no regression).
  const restoreCapturedView = useCallback((pin: Annotation, datasetIdOverride?: string) => {
    const ws = scene.wasmSceneRef.current;
    if (!ws || !pin.view) {
      // No view (older pin) or no scene: degrade to exactly today's gentle path,
      // then focus in the current mode.
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

    // The pin's OWN dataset is the clamp target — resolved the SAME way the pin
    // set was read (`selectedDatasetId` if selected, else the first annotated
    // dataset; see resolveAnnotationDatasetId). This matters in the
    // null-selection window — the Mentions inbox reaches restore with
    // `selectedDatasetId === null` (0 datasets, or >=2 with none clicked), and
    // `selectedDatasetId ?? ""` would clamp against `""`, whose WASM
    // `dataset_volume_shape` is the `[1,1,1]` sentinel — collapsing a deep
    // captured Z to plane 0 (the #814 class). When no dataset is resolvable we
    // pass `undefined`, so `restoreAnnotationView` SKIPS the clamp (the captured
    // z/t/c pass through) rather than collapsing.
    // A deep-link (`#a=`) passes the pin's OWN dataset explicitly (the pin may
    // live on a dataset that isn't the selected one), so the clamp targets the
    // right extents even before selection settles. Otherwise resolve the SAME
    // way the pin set was read.
    const pinDatasetId =
      datasetIdOverride ?? resolveAnnotationDatasetId(ws, selectedDatasetId) ?? undefined;
    const result = restoreAnnotationView({
      scene: ws,
      view: pin.view,
      datasetId: pinDatasetId,
      dimensionExtentsFor: dims.dimensionExtentsFor,
      labelNamesFor: dims.labelNamesFor,
    });

    // Mirror the restored scene state into React (the restore wrote to WASM
    // only — without this the Z/T/C sliders + mode toggles stay stale). Push the
    // clamped indices and the resolved view mode / camera mode.
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

    // Surface the graceful-degrade notice (auto-clears below).
    setRestoreNotice(result.notice);

    // Focus the pin AFTER the restore. If the camera MODE flipped (a different
    // overlay must mount) OR annotations were hidden, defer one frame so the
    // correct overlay's imperative ref exists before we call into it. Focus uses
    // the RESTORED mode, not the (possibly stale) live `dims.viewMode`.
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

  // Explicit navigation to a mentioning comment (issue #526) now performs the
  // FULL restore when the pin carries the author's captured view, and falls back
  // to today's gentle recenter when it doesn't (older pins). This is the user's
  // core intent for an explicit jump: "go to the view the author had."
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- the compiler infers the stable `setAnnotationsVisible` setter as a dep; the manual deps are the reactive values actually read.
  const handleNavigateToMention = useCallback((pinId: string) => {
    const pin = currentAnnotations.find((p) => p.id === pinId);
    if (!pin) {
      // Unknown pin: keep the old safe focus attempt (no-op if the overlay lacks
      // it) so a stale id never wedges navigation.
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

  // The pin thread/popover's "Go to author's view" affordance (slice 2): the
  // EXPLICIT, on-demand full restore for a pin selected passively on the canvas.
  // Passive canvas pin-select stays gentle; THIS button is how a user opts into
  // the author's framing from a pin's own thread. Same full-restore path as an
  // explicit mention navigation. Looks the pin up in the current set so the
  // overlays only need to pass an id.
  const handleGoToAuthorView = useCallback((pinId: string) => {
    const pin = currentAnnotations.find((p) => p.id === pinId);
    if (!pin) return;
    restoreCapturedView(pin);
  }, [currentAnnotations, restoreCapturedView]);

  // ANNOTATION DEEP-LINK (`#a=<annotationId>`) — slice 3. Resolve+restore+focus
  // the linked pin against the LOADED workspace document. Runs from the
  // post-document-load effect below (keyed on `remoteDocumentVersion`), NOT at
  // scene bootstrap: the pin exists only after the doc snapshot lands, so
  // resolving earlier would focus an unloaded pin (the #802 class).
  //
  // The pin may live on a dataset that isn't currently selected; selecting it
  // first mounts that dataset's overlay so `focusPin` (inside restoreCapturedView)
  // can actually open the thread. When selection changes we defer the restore one
  // frame so the overlay's imperative ref exists before we focus.
  const restoreAnnotationDeepLinkPin = useCallback(
    (pin: Annotation, datasetId: string, onRestored: () => void) => {
      // Collapse `#a=`→`#view=` only AFTER the restore has applied, so the URL
      // captures the restored camera, not the pre-restore one. When the pin is
      // on a not-yet-selected dataset the restore is deferred a frame (the
      // overlay must mount first); the collapse must ride the SAME frame, else a
      // copy/refresh in that window grabs the stale view.
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

  // Resolve the `#a=<id>` deep-link AFTER the workspace document's annotations
  // have loaded (annotation-views slice 3). The TIMING lives in the hook: it
  // re-checks on every `remoteDocumentVersion` bump (the bridge bumps it once a
  // snapshot/command lands), so the FIRST tick where the pin is actually
  // readable triggers the restore — NOT at scene bootstrap, where the doc is
  // still empty and `focusPin` would no-op on an unloaded pin (the #802 class).
  // On success it reuses the slice-2 LIGHT restore + focus and collapses `#a=`
  // to the live `#view=` (like `#b=`); a missing id surfaces the graceful
  // not-found notice rather than a silent no-op.
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

  // Side-effect hooks.

  // Expose the tickCoordinator + cpuCache on `window.__orch` (also
  // aliased as `__lucidaOrch`) so the dev console can call
  // `requestTestProxy(datasetId, entityId, imageId, kind, t, c)` to
  // verify the proxy fetch wire flow. Dev builds only: requestTestProxy
  // issues real fetches, so production gets no such hook. (The
  // load-bearing capture globals — `__lucidaCaptureReady` published by
  // renderLoop.ts, `__lucidaAutoContrast` by useIntensityBatcher.ts —
  // are a separate contract and stay present in every build; the CLI
  // capture path and the tryout harness read them.)
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

  // Auto-clear the light-restore graceful-degrade notice a few seconds after it
  // appears, so it reads as a transient "FYI we adjusted to fit" rather than a
  // persistent banner. Re-arms on each new notice (the timer keys off the notice
  // identity); clearing to null is inert.
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
  const [showDebug, setShowDebug] = useState(false);
  // Whether any on-canvas debug overlay is toggled on (persisted in
  // localStorage `debug.overlays`, independent of the panel). Drives the
  // mount of the code-split DebugOverlays layer: with every overlay off
  // and the panel closed there is nothing it could draw, so the chunk
  // isn't fetched. The panel being open also mounts it — the Config
  // tab's radius-slider drag previews render through the overlay layer.
  const anyOverlayEnabled = useSyncExternalStore(
    onOverlaysChanged,
    () => DEBUG_OVERLAYS.some((o) => isOverlayEnabled(o)),
    () => false,
  );
  const [showBookmarkSidebar, setShowBookmarkSidebar] = useState(true);
  // Default the Explore panel CLOSED; it remains a user toggle. (It previously
  // opened on a fresh dataset open to surface the guided-exploration affordance.)
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

  // Preview-thumbnail renderer for the Explore panel's contact sheet. Builds a
  // closure that turns a candidate child view into an off-screen render of the
  // dataset's resident coarse overview from that view's camera (reusing the
  // minimap render path; see exploreThumbnails.ts). Rebuilt when the target
  // dataset changes; reads scene/client/datasets via refs at call time so it
  // always sees the live state. Undefined when there's no dataset to preview, in
  // which case the panel just shows label-only rows.
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

  // Bookmark from the Explore panel: an ephemeral PERSONAL workspace saved view
  // (guided exploration never auto-shares). Thin wrapper over the workspace API
  // so the panel doesn't need to mount the full saved-views list hook.
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
  const [lastClickScreen, setLastClickScreen] = useState<[number, number] | null>(null);
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleDebugToggle = useCallback(() => {
    setShowDebug(prev => {
      debugStats.enabled = !prev;
      return !prev;
    });
    requestRender(render.loopRef.current, "debug_toggle");
  }, [render.loopRef]);
  const handleDebugClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!showDebug) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    setLastClickScreen([(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr]);
  }, [showDebug]);

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

  // The sidebar tells us when the open saved view stops existing as the user
  // acts on it (deleted / withdrawn / its deferred reject committed); drop the
  // active-row highlight so it doesn't dangle on a view that's gone (#818).
  // Guard on the id so a stale invalidation can't clear a newer open view.
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
  // SliceViewer / VolumeViewer / PeerCursors / Minimap / DebugOverlays /
  // DebugPanel so those children can read the latest canvas, scene, loop, etc.
  // each render. This is the canonical "ref-as-current-value-prop" idiom that
  // partners with the wiki-documented App.tsx hook order
  // (wiki/gotchas/app-tsx-hook-order.md): callback refs are populated AFTER
  // all hooks return, then read in the same render via `.current`. The
  // versioning state (datasetsVersion, remoteDocumentVersion) drives the
  // re-render that surfaces ref updates downstream. The new
  // eslint-plugin-react-hooks@7 "rules of react" treat all such reads as
  // suspicious; they are intentional and load-bearing here.
  /* eslint-disable react-hooks/refs */
  return (
    <div className={renderMode ? "app render-mode" : "app"}>
      {/* ProfileMenu floats over the bottom-left corner of the app
          chrome. Absolute-positioning keeps it out of the existing
          flex layout so the LayerPanel + canvas geometry is untouched.
          Gated out of the chrome-free render surface. */}
      {!renderMode && <ProfileMenu />}
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
        onSetDetailLevelOverride={layers.handleLayerSetDetailLevelOverride}
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
        debugToggle={{ label: "Debug", active: showDebug, onClick: handleDebugToggle }}
        layoutRegistry={layoutRegistry}
        sendCommand={bridge.sendCommand}
        onLayoutChange={() => {
          // The switcher already applied `set_active_layout` to the scene
          // (LayoutRegistry.setActive). Match the inbound-peer arm in
          // sessionController.ts, which bumps the settings generation after
          // every applied command and marks interactive — so the planner
          // re-reads and the canvas replans/renders without waiting for a
          // pan/zoom (the #780 class: a missed signal here leaves collection
          // members drawn at their pre-switch positions).
          invalidateDisplaySettings(render.loopRef.current, "layout_switch");
          // A local layout switch re-anchors collection annotations in core (issue
          // #780), but — unlike an inbound peer switch (see sessionController.ts) — it
          // doesn't bump the remote document version on its own, so the overlay
          // would keep showing pins at their pre-switch positions for the
          // switcher. Bump it here so the overlay re-reads the re-anchored pins,
          // exactly as it does after any other document change.
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
          }} onClick={handleDebugClick}>
            <canvas
              // Keyed per RenderClient generation: `transferControlToOffscreen`
              // is one-shot per element, so after a client teardown (dev
              // StrictMode remount) the next client needs a fresh element.
              key={render.canvasKey}
              ref={render.canvasRef}
              tabIndex={0}
              style={{
                width: showDebug ? layout.canvasWidth - 300 : layout.canvasWidth,
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
                  onGroupClick={(cx, cy) => {
                    const ws = scene.wasmSceneRef.current;
                    if (!ws) return;
                    applyViewportCommand(ws, { type: "set_center", x: cx, y: cy });
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
            {(showDebug || anyOverlayEnabled) && (
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
            {/* Non-blocking graceful-degrade notice from the LIGHT annotation
                -view restore (slice 2): shown when an author's captured z/t/c had
                to be clamped to fit the pin's own dataset. Auto-clears (effect
                below). Separate from LoadingViewBanner — the light restore never
                runs the heavy applier. */}
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
            {/* Annotation DEEP-LINK not-found notice (slice 3): the `#a=<id>`
                couldn't be resolved against the loaded workspace document
                (deleted, or a wrong/forged id). Non-blocking + dismissible — a
                clear message rather than a silent no-op. NEVER-LEAK: a recipient
                without workspace access never reaches here (the load fails at the
                gate first), so this is the SAME UX as a genuinely missing pin —
                it never confirms the annotation existed. */}
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
          {showDebug && (
            <Suspense fallback={null}>
              <DebugPanel
                wasmSceneRef={scene.wasmSceneRef}
                datasetId={selectedDatasetId}
                lastClickScreen={lastClickScreen}
                datasets={datasetsRef.current}
                sessionRef={bridge.sessionRef}
                renderLoopRef={render.loopRef}
                style={{ height: layout.canvasHeight }}
              />
            </Suspense>
          )}
        </div>
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
            {/* Focal-depth control (issue #532): a USER-facing near↔far
                bias for the 3-D center-out chunk-spawn origin. 3-D-only —
                the bias is meaningless on a 2-D slice — so it appears here
                (alongside the Z slider, which is itself disabled in 3-D)
                only when the viewer is in 3-D mode. Binds straight to
                configStore.depthBiasView (one source of truth); this is the
                discoverable home, replacing the old Debug→Config entry. */}
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
          {/* "Mentions of me" inbox (issue #526): an always-present badge with the
              count of CURRENT-dataset comments that @-mention the current user,
              toggling a panel of those comments; clicking one opens its pin thread
              and recenters via the overlay's imperative `focusPin` seam. Fed by
              the same current-dataset annotations the mention-candidate builder
              reads, the principal email, and the workspace roster. Sits next to
              the annotation-visibility toggle in the toolbar row. */}
          <MentionsOfMe
            annotations={currentAnnotations}
            currentUserId={annotationAuthor}
            currentUserEmail={authSession.principal.email}
            members={workspaceMembers}
            onNavigate={handleNavigateToMention}
            // Read/unread inbox (issue #803): the persisted per-browser viewed
            // set drives the unread count + per-item read marks; clicking an
            // item marks it viewed (the component composes this with onNavigate).
            viewedCommentIds={viewedCommentIds}
            onMarkViewed={markViewed}
          />
          {/* One personal view toggle (issue #792): show/hide ALL annotations
              (pins, lines, boxes — and their threads) at once. Flips local state
              passed as `visible` to both overlays; it is not a command, not
              synced to peers, and doesn't touch the document. The aria-label +
              title reflect the NEXT action (what clicking will do), so the
              control reads correctly to a screen reader in either state. */}
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
              // Reflect the hidden state with the same accent the other toolbar
              // toggles use, so "annotations are currently hidden" reads at a
              // glance.
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
