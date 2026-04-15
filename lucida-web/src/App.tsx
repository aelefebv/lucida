import { useCallback, useEffect, useRef, useState } from "react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { LayerPanel } from "./components/LayerPanel.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { PeerCursors, type CursorLabel } from "./components/PeerCursors.tsx";
import { FpsCounter } from "./components/FpsCounter.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { PlateSelector, extractPlateData } from "./components/PlateSelector.tsx";
import { applyViewportCommand } from "./applyAndSend.ts";
import { DebugPanel } from "./debug/DebugPanel.tsx";
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
import "./App.css";

function App() {
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

  // --- Domain hooks (order matters: earlier hooks use refs for later hooks' values) ---

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

  const datasets = useDatasets({
    sendOpenRemoteDataset: bridge.sendOpenRemoteDataset,
  });

  // Populate callback refs — runs during render, before effects fire
  bridgeCallbacksRef.current = {
    sendCommand: bridge.sendCommand,
    emitPresence: bridge.emitPresence,
    emitDatasetPresence: bridge.emitDatasetPresence,
    breakFollow: bridge.breakFollow,
  };
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
      bridge.contentSourceRef.current?.rejectDataset(id);
      bumpDatasetsVersion();
    },
  };

  // --- Side-effect hooks ---

  // Wire up CpuCache whenever the RenderLoop is recreated (e.g. mode switch)
  useEffect(() => {
    if (render.activeLoop && bridge.cpuCacheRef.current) {
      render.activeLoop.setCpuCache(bridge.cpuCacheRef.current);
    }
  }, [render.activeLoop]);

  useIntensityBatcher({
    clientReady: render.clientReady,
    clientRef: render.clientRef,
    autoContrastMapRef: layers.autoContrastMapRef,
    wasmSceneRef: scene.wasmSceneRef,
    loopRef: render.loopRef,
    bridgeRef: bridge.bridgeRef,
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
    emitPresence: bridge.emitPresence,
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
    render.loopRef.current?.markViewDirty();
  }, [bridge.peers, bridge.myId, bridge.followTarget, dims.viewMode, render.clientReady, scene.wasmReady, render.clientRef, scene.wasmSceneRef, render.loopRef]);

  const handleCameraModeChange = useCallback((mode: string) => {
    setCameraMode(mode);
  }, []);

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
    bridge.emitPresence();
    render.loopRef.current?.markViewDirty();
    render.canvasRef.current?.focus();
  }, [scene.wasmSceneRef, bridge, render.loopRef, render.canvasRef]);

  const [urlInput, setUrlInput] = useState("");
  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      datasets.handleUrlSubmit(urlInput);
      setUrlInput("");
    }
  }, [datasets, urlInput]);

  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [lastClickScreen, setLastClickScreen] = useState<[number, number] | null>(null);
  const handleDebugToggle = useCallback(() => {
    setShowDebug(prev => {
      debugStats.enabled = !prev;
      return !prev;
    });
    render.loopRef.current?.markViewDirty();
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

  return (
    <div className="app">
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
            {datasetsVersion > 0 && dims.viewMode === "2d" && scene.wasmScene && render.client && (
              <SliceViewer
                z={dims.z}
                t={dims.t}
                c={dims.c}
                scene={scene.wasmScene}
                datasets={datasetsRef.current}
                client={render.client}
                canvas={render.canvasRef.current!}
                remoteDocumentVersion={remoteDocumentVersion}
                emitPresence={bridge.emitPresence}
                breakFollow={bridge.breakFollow}
                sendCursor={bridge.sendCursor}
                loopRef={render.loopRef}
                onLoopChange={render.setActiveLoop}
              />
            )}
            {datasetsVersion > 0 && dims.viewMode === "2d" && (() => {
              const ds = selectedDatasetId ? datasetsRef.current.get(selectedDatasetId) : undefined;
              if (!ds) return null;
              const plateData = extractPlateData(ds.content);
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
                    bridge.emitPresence();
                    render.loopRef.current?.markViewDirty();
                  }}
                />
              );
            })()}
            {datasetsVersion > 0 && dims.viewMode === "3d" && scene.wasmScene && render.client && (
              <VolumeViewer
                scene={scene.wasmScene}
                datasets={datasetsRef.current}
                client={render.client}
                canvas={render.canvasRef.current!}
                remoteDocumentVersion={remoteDocumentVersion}
                emitPresence={bridge.emitPresence}
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
            <FpsCounter />
            <div className="canvas-resize-handle" onPointerDown={layout.handleCanvasResizeDown} />
          </div>
          {showDebug && (
            <DebugPanel
              wasmSceneRef={scene.wasmSceneRef}
              datasetId={selectedDatasetId}
              lastClickScreen={lastClickScreen}
              datasets={datasetsRef.current}
              cpuCacheRef={bridge.cpuCacheRef}
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
    </div>
  );
}

export default App;
