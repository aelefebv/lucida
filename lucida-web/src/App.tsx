import { useCallback, useEffect, useRef, useState } from "react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { LayerPanel } from "./components/LayerPanel.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { PeerCursors, type CursorLabel } from "./components/PeerCursors.tsx";
import { FpsCounter } from "./components/FpsCounter.tsx";
import type { VolumeData } from "./zarr/volumeAssembler.ts";
import type { DatasetState, PendingChunkResolve } from "./types.ts";
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
  const pendingChunkRequests = useRef<Map<string, PendingChunkResolve>>(new Map());

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
    pendingChunkRequests,
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
    wasmSceneRef: scene.wasmSceneRef,
    ensureScene: scene.ensureScene,
    setWasmScene: scene.setWasmScene,
    loopRef: render.loopRef,
    datasetsRef,
    sendCommand: bridge.sendCommand,
    emitPresence: bridge.emitPresence,
    emitDatasetPresence: bridge.emitDatasetPresence,
    initLayerMaps: layers.initLayerMaps,
    sendOpenRemoteDataset: bridge.sendOpenRemoteDataset,
    setSelectedDatasetId,
    setVolumeMap,
    bumpDatasetsVersion,
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
      const ds = datasetsRef.current.get(id);
      if (ds) {
        ds.store.destroy();
        datasetsRef.current.delete(id);
      }
      layers.cleanupLayerMaps(id);
      setSelectedDatasetId(prev => {
        if (prev === id) {
          return datasetsRef.current.keys().next().value ?? null;
        }
        return prev;
      });
      setVolumeMap(prev => { const next = new Map(prev); next.delete(id); return next; });
      for (const [key, pending] of pendingChunkRequests.current) {
        if (key.startsWith(id + "/")) {
          pending.reject(new Error("Dataset removed"));
          pendingChunkRequests.current.delete(key);
        }
      }
      bumpDatasetsVersion();
    },
  };

  // --- Side-effect hooks ---

  useIntensityBatcher({
    clientReady: render.clientReady,
    clientRef: render.clientRef,
    autoContrastMapRef: layers.autoContrastMapRef,
    wasmSceneRef: scene.wasmSceneRef,
    loopRef: render.loopRef,
    bridgeRef: bridge.bridgeRef,
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

    const peersArr = Array.from(bridge.peers.values()).map(p => ({
      id: p.client_id,
      cursor: p.cursor,
      mode: (p.camera as { mode?: string })?.mode ?? "slice",
      camera: p.camera,
      view_z: p.view?.z_range?.start,
    }));
    const canvasEl = render.canvasRef.current;
    const screenW = canvasEl?.clientWidth ?? 800;
    const screenH = canvasEl?.clientHeight ?? 600;
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
    render.loopRef.current?.markDirty();
  }, [bridge.peers, bridge.myId, dims.viewMode, render.clientReady, scene.wasmReady, render.clientRef, scene.wasmSceneRef, render.loopRef]);

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
    render.loopRef.current?.markDirty();
    render.canvasRef.current?.focus();
  }, [scene.wasmSceneRef, bridge, render.loopRef, render.canvasRef]);

  const [urlInput, setUrlInput] = useState("");
  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      datasets.handleUrlSubmit(urlInput);
      setUrlInput("");
    }
  }, [datasets, urlInput]);

  const dirInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="app">
      <input
        ref={dirInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={datasets.handleDirChange}
        hidden
      />
      <LayerPanel
        layers={layers.layerInfos}
        selectedLayerId={selectedDatasetId}
        expandedLayerId={layers.expandedLayerId}
        onSelectLayer={layers.handleLayerSelect}
        onToggleExpand={layers.handleLayerToggleExpand}
        onSetVisible={layers.handleLayerSetVisible}
        onSetOpacity={layers.handleLayerSetOpacity}
        onSetContrast={layers.handleLayerSetContrast}
        onSetGamma={layers.handleLayerSetGamma}
        onSetBlendMode={layers.handleLayerSetBlendMode}
        onSetRenderMode={layers.handleLayerSetRenderMode}
        onAutoContrast={layers.handleLayerAutoContrast}
        onAutoContrastToggle={layers.handleLayerAutoContrastToggle}
        onFullRangeToggle={layers.handleLayerFullRangeToggle}
        onMoveLayer={layers.handleLayerMove}
        onRemoveLayer={layers.handleRemoveLayer}
        onAddLayer={() => dirInputRef.current?.click()}
        viewModeToggle={volumeMap.size > 0 ? { label: dims.viewMode === "2d" ? "3D" : "2D", onClick: dims.handleViewModeToggle } : null}
        cameraModeToggle={dims.viewMode === "3d" ? { label: cameraMode === "fly" ? "Arcball" : "Fly", onClick: handleCameraModeToggle } : null}
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
        <div style={{ position: "relative", display: volumeMap.size > 0 ? "block" : "none", width: layout.canvasWidth }}>
          <canvas
            ref={render.canvasRef}
            tabIndex={0}
            style={{
              width: layout.canvasWidth,
              height: layout.canvasHeight,
              imageRendering: dims.viewMode === "2d" ? "pixelated" : "auto",
              borderRadius: 8,
              backgroundColor: "black",
              display: "block",
            }}
          />
          {volumeMap.size > 0 && dims.viewMode === "2d" && scene.wasmScene && render.client && (
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
          {volumeMap.size > 0 && dims.viewMode === "3d" && scene.wasmScene && render.client && (
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
        {volumeMap.size > 0 && (
          <div className="dimension-controls" style={{ maxWidth: layout.canvasWidth }}>
            <DimensionControls label="Z" value={dims.z} max={dims.dimZ} onChange={dims.handleZChange} disabled={dims.viewMode === "3d"} />
            <DimensionControls label="C" value={dims.c} max={dims.dimC} onChange={dims.handleCChange} />
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
        </div>
        {(datasets.loading || bridge.remoteDatasetLoading) && <p className="secondary">Loading volume...</p>}
        {(render.renderError || datasets.loadError || bridge.remoteDatasetError) && (
          <p style={{ color: "#f44" }}>{render.renderError || datasets.loadError || bridge.remoteDatasetError}</p>
        )}
      </div>
    </div>
  );
}

export default App;
