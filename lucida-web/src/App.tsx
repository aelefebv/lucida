import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { LayerPanel } from "./components/LayerPanel.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { PeerCursors, type CursorLabel } from "./components/PeerCursors.tsx";
import { FpsCounter } from "./components/FpsCounter.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { PlateSelector, extractPlateData } from "./components/PlateSelector.tsx";
import { ShareToolbarButton } from "./components/ShareToolbarButton.tsx";
import { LoadingViewBanner } from "./components/LoadingViewBanner.tsx";
import { BookmarkSidebar } from "./components/BookmarkSidebar.tsx";
import { applyViewportCommand } from "./applyAndSend.ts";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import { useAuthSession } from "./auth/AuthSession.ts";
import { DebugPanel } from "./debug/DebugPanel.tsx";
import { DebugOverlays } from "./debug/DebugOverlays.tsx";
import { debugStats } from "./debug/debugStats.ts";
import type { VolumeData } from "./types.ts";
import type { DatasetState } from "./types.ts";
import { useWasmScene } from "./hooks/useWasmScene.ts";
import { useRenderClient } from "./hooks/useRenderClient.ts";
import { useLayout } from "./hooks/useLayout.ts";
import { useDatasetSettings, type BridgeCallbacks, type DatasetCallbacks } from "./hooks/useDatasetSettings.ts";
import { useDimensions } from "./hooks/useDimensions.ts";
import { useBridge } from "./hooks/useBridge.ts";
import { useDatasets } from "./hooks/useDatasets.ts";
import { useIntensityBatcher } from "./hooks/useIntensityBatcher.ts";
import { usePreUpload } from "./hooks/usePreUpload.ts";
import { useSavedViewSync } from "./hooks/useSavedViewSync.ts";
import "./App.css";

function App() {
  // Authenticated principal — provided by <AuthGate> above us; throws if
  // accessed unauthenticated. We forward the email to the BookmarkSidebar
  // for the "Mine only" filter (and to bookmark creation telemetry).
  const authSession = useAuthSession();

  // Foundation hooks
  const scene = useWasmScene();
  const render = useRenderClient();
  const layout = useLayout({ loopRef: render.loopRef });

  // Shared refs used by multiple hooks
  const datasetsRef = useRef<Map<string, DatasetState>>(new Map());
  // Lifted state — shared across hooks that can't own it due to call ordering
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [datasetsVersion, setDatasetsVersion] = useState(0);
  const [remoteDocumentVersion, setRemoteDocumentVersion] = useState(0);
  const [volumeMap, setVolumeMap] = useState<Map<string, VolumeData>>(new Map());
  const [cameraMode, setCameraMode] = useState<string>("arcball");
  const bumpDatasetsVersion = useCallback(() => setDatasetsVersion(v => v + 1), []);
  const bumpRemoteDocumentVersion = useCallback(() => setRemoteDocumentVersion(v => v + 1), []);

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
    setSelectedDatasetId,
    setVolumeMap,
    bumpDatasetsVersion,
    bumpRemoteDocumentVersion,
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
    setC: dims.setC,
    setT: dims.setT,
    setZ: dims.setZ,
    setViewMode: dims.setViewMode,
    autoContrastMapRef: layers.autoContrastMapRef,
    setAutoContrastMap: layers.setAutoContrastMap,
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
  // VolumeViewer / PlateSelector / handleCameraModeToggle / usePreUpload
  // — anywhere a viewport mutation already calls bridge.emitPresence.
  const emitPresenceWithUrl = useCallback(() => {
    bridge.emitPresence();
    savedViewSync.notifyChange();
  }, [bridge, savedViewSync]);
  const emitDatasetPresenceWithUrl = useCallback(() => {
    bridge.emitDatasetPresence();
    savedViewSync.notifyChange();
  }, [bridge, savedViewSync]);

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
      setVolumeMap(prev => { const next = new Map(prev); next.delete(id); return next; });
      bridge.sessionRef.current?.contentSource.rejectDataset(id);
      bumpDatasetsVersion();
    },
  };

  // Side-effect hooks.

  // Expose the orchestrator + cpuCache on `window.__orch` (also aliased
  // as `__lucidaOrch`) so the dev console can call
  // `requestTestProxy(datasetId, entityId, imageId, kind, t, c)` to
  // verify the proxy fetch wire flow.
  useEffect(() => {
    const loop = render.activeLoop;
    const cache = bridge.sessionRef.current?.cpuCache;
    if (!loop || !cache) return;
    const orch = loop.getOrchestrator();
    const debug = {
      orchestrator: orch,
      cpuCache: cache,
      requestTestProxy: (
        datasetId: string,
        entityId: string,
        imageId: string,
        kind: "WellProxy3D" | "FieldProxy3D",
        t = 0,
        c = 0,
      ) => orch.requestTestProxy(cache, datasetId, entityId, imageId, kind, t, c),
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

  usePreUpload({
    volumeMap,
    clientReady: render.clientReady,
    clientRef: render.clientRef,
    datasetsRef,
    loopRef: render.loopRef,
    wasmSceneRef: scene.wasmSceneRef,
    emitPresence: emitPresenceWithUrl,
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

  // Loaded dataset URLs derived from the live capture builder. The
  // BookmarkSidebar uses these to filter `GET /api/bookmarks?dataset=…`
  // — so the user only sees bookmarks that touch the datasets they
  // currently have open. Recomputed on every dataset/document change
  // (datasetsVersion + remoteDocumentVersion).
  const loadedDatasetUrls = useMemo(() => {
    const view = savedViewSync.captureBuilder();
    return view ? view.datasets : [];
    // Both versions force a recompute when datasets change. The
    // captureBuilder identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViewSync.captureBuilder, datasetsVersion, remoteDocumentVersion]);

  // Active layout name for the default bookmark name (e.g. "plate · Grid").
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
        onLayoutChange={() => render.loopRef.current?.markInteractiveDirty()}
        style={{ width: layout.sidebarWidth, minWidth: layout.sidebarWidth }}
      />
      <div className="sidebar-resize-handle" onPointerDown={layout.handleSidebarResizeDown} />
      <div className="main-content">
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
          <button
            onClick={() => setShowBookmarkSidebar((v) => !v)}
            title={showBookmarkSidebar ? "Hide bookmarks" : "Show bookmarks"}
            style={{
              padding: "0.375rem 0.75rem",
              fontSize: "0.875rem",
              whiteSpace: "nowrap",
              background: showBookmarkSidebar ? "#646cff" : undefined,
              color: showBookmarkSidebar ? "#fff" : undefined,
            }}
          >
            Bookmarks
          </button>
        </div>
        {showFileBrowser && (
          <FileBrowser
            onSelect={handleFileBrowserSelect}
            onClose={() => setShowFileBrowser(false)}
          />
        )}
        {bridge.remoteDatasetLoading && <p className="secondary">Loading volume...</p>}
        {(render.renderError || bridge.remoteDatasetError) && (
          <p style={{ color: "#f44" }}>{render.renderError || bridge.remoteDatasetError}</p>
        )}
      </div>
      <BookmarkSidebar
        loadedDatasets={loadedDatasetUrls}
        currentUserEmail={authSession.principal.email}
        getCurrentSavedView={savedViewSync.captureBuilder}
        activeLayoutName={activeLayoutName}
        visible={showBookmarkSidebar}
        style={{ width: 280, minWidth: 280, height: "100vh" }}
        bridge={bridge.bridge}
      />
    </div>
  );
  /* eslint-enable react-hooks/refs */
}

export default App;
