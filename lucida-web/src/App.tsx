import { useCallback, useRef, useState } from "react";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { LayerPanel } from "./components/LayerPanel.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { PeerCursors } from "./components/PeerCursors.tsx";
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
              t={dims.t}
              c={dims.c}
              loopRef={render.loopRef}
              onLoopChange={render.setActiveLoop}
            />
          )}
          {bridge.peers.size > 0 && dims.viewMode === "2d" && scene.wasmScene && render.canvasRef.current && (
            <PeerCursors
              peers={bridge.peers}
              myId={bridge.myId}
              wasmSceneRef={scene.wasmSceneRef}
              canvas={render.canvasRef.current}
              z={dims.z}
              t={dims.t}
              c={dims.c}
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
        {datasets.loading && <p className="secondary">Loading volume...</p>}
        {(render.renderError || datasets.loadError) && <p style={{ color: "#f44" }}>{render.renderError || datasets.loadError}</p>}
      </div>
    </div>
  );
}

export default App;
