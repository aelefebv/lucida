import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { LayerPanel } from "./components/LayerPanel.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { PeerCursors, type CursorLabel } from "./components/PeerCursors.tsx";
import { AnnotationOverlay, type Annotation, type AnnotationOverlayHandle } from "./components/AnnotationOverlay.tsx";
import { AnnotationOverlay3D } from "./components/AnnotationOverlay3D.tsx";
import { MentionsOfMe } from "./components/MentionsOfMe.tsx";
import {
  currentDatasetAnnotations,
  resolveAnnotationDatasetId,
} from "./components/currentDatasetAnnotations.ts";
import { FpsCounter } from "./components/FpsCounter.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { PlateSelector, extractPlateData } from "./components/PlateSelector.tsx";
import { ShareToolbarButton } from "./components/ShareToolbarButton.tsx";
import { LoadingViewBanner } from "./components/LoadingViewBanner.tsx";
import { WorkspaceSavedViewsSidebar } from "./components/WorkspaceSavedViewsSidebar.tsx";
import { WorkspaceSharingDialog } from "./WorkspaceSharingDialog.tsx";
import { applyViewportCommand } from "./applyAndSend.ts";
import { bumpSettingsGeneration } from "./tickCommon.ts";
import { annotationAuthorId } from "./annotationIdentity.ts";
import { deriveMentionCandidates } from "./components/annotationParticipants.ts";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import { useAuthSession } from "./auth/AuthSession.ts";
import { DebugPanel } from "./debug/DebugPanel.tsx";
import { DebugOverlays } from "./debug/DebugOverlays.tsx";
import { debugStats } from "./debug/debugStats.ts";
import type { DatasetState } from "./types.ts";
import { useWasmScene } from "./hooks/useWasmScene.ts";
import { useRenderClient } from "./hooks/useRenderClient.ts";
import { useLayout } from "./hooks/useLayout.ts";
import { useDatasetSettings, type BridgeCallbacks, type DatasetCallbacks } from "./hooks/useDatasetSettings.ts";
import { useDimensions } from "./hooks/useDimensions.ts";
import { useBridge } from "./hooks/useBridge.ts";
import { useDatasets } from "./hooks/useDatasets.ts";
import { useIntensityBatcher } from "./hooks/useIntensityBatcher.ts";
import { useSavedViewSync } from "./hooks/useSavedViewSync.ts";
import { useViewedMentions } from "./hooks/useViewedMentions.ts";
import type { SavedView } from "./savedView/types.ts";
import { restoreAnnotationView } from "./savedView/restoreAnnotationView.ts";
import {
  getWorkspaceSavedView,
  getWorkspaceViewerProfile,
  getWorkspaceSharing,
  getWorkspaceUserState,
  updateWorkspaceLastView,
} from "./workspaceApi.ts";
import type { WorkspaceRole, WorkspaceMember } from "./workspaceApi.ts";
import "./App.css";

interface AppProps {
  workspaceId: string;
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  defaultSavedViewId: string | null;
  canRenameWorkspace: boolean;
  onBackToDashboard: () => void;
  onRenameWorkspace: (name: string) => Promise<void>;
  onSetDefaultSavedView: (savedViewId: string | null) => Promise<void>;
}

function App({
  workspaceId,
  workspaceName,
  workspaceRole,
  defaultSavedViewId,
  canRenameWorkspace,
  onBackToDashboard,
  onRenameWorkspace,
  onSetDefaultSavedView,
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
  const layout = useLayout({ loopRef: render.loopRef });

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
  };

  const datasets = useDatasets({
    // Wrap so URL→DatasetId tracking is populated for every local open
    // (FileBrowser-driven, URL-bar-driven, applier-driven).
    sendOpenRemoteDataset: savedViewSync.trackedSendOpen,
  });

  // Layout registry — null until WasmScene is set up; subscribe so the
  // PlateSelector and LayoutSwitcher re-derive on layout changes (local or
  // peer). The version counter is the stable snapshot for useSyncExternalStore.
  const layoutRegistry = bridge.sessionRef.current?.ensureLayoutRegistry() ?? null;
  useSyncExternalStore(
    (cb) => layoutRegistry?.subscribe(cb) ?? (() => {}),
    () => layoutRegistry?.getVersion() ?? 0,
    () => 0,
  );

  // Wrapped emitPresence/emitDatasetPresence — every viewport mutation
  // co-taps urlSync.notifyChange() so the URL stays in sync (Bug #1 fix:
  // changeTick alone doesn't bump on viewport-only mutations like
  // pan/zoom/T/C/Z/contrast). Used here AND threaded into SliceViewer /
  // VolumeViewer / PlateSelector / handleCameraModeToggle
  // — anywhere a viewport mutation already calls bridge.emitPresence.
  const emitPresenceWithUrl = useCallback(() => {
    bridge.emitPresence();
    savedViewSync.notifyChange();
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
  const restoreCapturedView = useCallback((pin: Annotation) => {
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
    const pinDatasetId =
      resolveAnnotationDatasetId(ws, selectedDatasetId) ?? undefined;
    const result = restoreAnnotationView({
      scene: ws,
      view: pin.view,
      datasetId: pinDatasetId,
      dimensionExtentsFor: dims.dimensionExtentsFor,
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
    bumpSettingsGeneration();
    render.loopRef.current?.markInteractiveDirty("annotation_view_restore");
    render.loopRef.current?.markResidencyDirty("annotation_view_restore");

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
  }, [dims.viewMode, dims.dimensionExtentsFor, annotationsVisible, selectedDatasetId, gentleOnContext, focusPinForMode]);

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
  // verify the proxy fetch wire flow.
  useEffect(() => {
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
        kind: "WellProxy3D" | "FieldProxy3D",
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
    render.loopRef.current?.markInteractiveDirty();
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
    render.loopRef.current?.markInteractiveDirty();
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
  const [showBookmarkSidebar, setShowBookmarkSidebar] = useState(true);
  const [showWorkspaceSharing, setShowWorkspaceSharing] = useState(false);
  const [currentOpenSavedViewId, setCurrentOpenSavedViewId] = useState<string | null>(null);

  const loadedDatasetNames = layers.layerInfos.map((layerInfo) => layerInfo.name);

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
    render.loopRef.current?.markInteractiveDirty();
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
    <div className="app">
      {/* ProfileMenu floats over the bottom-left corner of the app
          chrome. Absolute-positioning keeps it out of the existing
          flex layout so the LayerPanel + canvas geometry is untouched. */}
      <ProfileMenu />
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
        onChannelSetVisible={layers.handleChannelSetVisible}
        onChannelSetColormap={layers.handleChannelSetColormap}
        onChannelSetContrast={layers.handleChannelSetContrast}
        onChannelSetGamma={layers.handleChannelSetGamma}
        onChannelSetBlendMode={layers.handleChannelSetBlendMode}
        onAddLayer={() => setShowFileBrowser(true)}
        viewModeToggle={datasetsVersion > 0 ? { label: dims.viewMode === "2d" ? "3D" : "2D", onClick: dims.handleViewModeToggle } : null}
        cameraModeToggle={dims.viewMode === "3d" ? { label: cameraMode === "fly" ? "Arcball" : "Fly", onClick: handleCameraModeToggle } : null}
        debugToggle={{ label: "Debug", active: showDebug, onClick: handleDebugToggle }}
        layoutRegistry={layoutRegistry}
        sendCommand={bridge.sendCommand}
        onLayoutChange={() => {
          render.loopRef.current?.markInteractiveDirty();
          // A local layout switch re-anchors plate annotations in core (issue
          // #780), but — unlike an inbound peer switch (see useBridge) — it
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
          <div style={{
            position: "relative",
            display: datasetsVersion > 0 ? "block" : "none",
            flex: 1,
            minWidth: 0,
          }} onClick={handleDebugClick}>
            <canvas
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
              />
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
                onViewportChanged={() => render.loopRef.current?.markInteractiveDirty()}
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
              const plateData = extractPlateData(ds.manifest, activePlacements);
              if (!plateData) return null;
              return (
                <PlateSelector
                  plateKind={plateData.plateKind}
                  members={plateData.members}
                  plateName={ds.name}
                  onWellClick={(cx, cy) => {
                    const ws = scene.wasmSceneRef.current;
                    if (!ws) return;
                    applyViewportCommand(ws, { type: "set_center", x: cx, y: cy });
                    emitPresenceWithUrl();
                    render.loopRef.current?.markInteractiveDirty();
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
              />
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
                onViewportChanged={() => render.loopRef.current?.markInteractiveDirty()}
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
            <DebugOverlays
              wasmSceneRef={scene.wasmSceneRef}
              canvasRef={render.canvasRef}
              datasets={datasetsRef.current}
              renderLoopRef={render.loopRef}
              cpuCache={bridge.sessionRef.current?.cpuCache ?? null}
              viewMode={dims.viewMode}
            />
            <FpsCounter />
            <LoadingViewBanner applier={savedViewSync.applier} />
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
            <div className="canvas-resize-handle" onPointerDown={layout.handleCanvasResizeDown} />
          </div>
          {showDebug && (
            <DebugPanel
              wasmSceneRef={scene.wasmSceneRef}
              datasetId={selectedDatasetId}
              lastClickScreen={lastClickScreen}
              datasets={datasetsRef.current}
              sessionRef={bridge.sessionRef}
              renderLoopRef={render.loopRef}
              style={{ height: layout.canvasHeight }}
            />
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
        </div>
        {showFileBrowser && (
          <FileBrowser
            onSelect={handleFileBrowserSelect}
            onClose={() => setShowFileBrowser(false)}
          />
        )}
        {bridge.remoteDatasetLoading && (
          <p className="secondary">{bridge.remoteDatasetProgress ?? "Loading volume..."}</p>
        )}
        {(render.renderError || bridge.remoteDatasetError) && (
          <p style={{ color: "#f44" }}>{render.renderError || bridge.remoteDatasetError}</p>
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
        visible={showBookmarkSidebar}
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
