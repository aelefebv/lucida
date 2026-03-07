import { useCallback, useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";
import { buildFileIndex } from "./zarr/fileIndex.ts";
import { parseDatasetInfo } from "./zarr/metadata.ts";
import type { DatasetInfo } from "./zarr/metadata.ts";
import { assembleVolume } from "./zarr/volumeAssembler.ts";
import type { VolumeData } from "./zarr/volumeAssembler.ts";
import { ChunkStore } from "./zarr/chunkStore.ts";
import { RenderClient } from "./renderer/renderClient.ts";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { applyAndSend } from "./applyAndSend.ts";
import "./App.css";

interface OpenedItem {
  name: string;
  size: number;
  kind: "file" | "directory";
  fileCount?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ViewMode = "2d" | "3d";

function App() {
  const [item, setItem] = useState<OpenedItem | null>(null);
  const [, setWasmReady] = useState(false);
  const [volume, setVolume] = useState<VolumeData | null>(null);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");

  // Dimension state
  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [t, setT] = useState(0);

  // Remote (Python bridge) camera version — bumped when a command arrives via WebSocket
  const [remoteCameraVersion, setRemoteCameraVersion] = useState(0);

  // Keep dataset info and file index for re-assembling on C/T change
  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null);
  const fileIndexRef = useRef<Map<string, File> | null>(null);
  const storeRef = useRef<ChunkStore | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // Single canvas + RenderClient persisting across mode switches
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<RenderClient | null>(null);
  const [clientReady, setClientReady] = useState(false);

  useEffect(() => {
    init().then(() => setWasmReady(true));
  }, []);

  // Bridge: receive commands from relay server over WebSocket.
  // Use a ref so the Bridge (and its WebSocket) persists across wasmScene changes.
  const bridgeRef = useRef<Bridge | null>(null);
  const wasmSceneRef = useRef<WasmScene | null>(null);
  wasmSceneRef.current = wasmScene;

  useEffect(() => {
    if (bridgeRef.current) return;
    const handlers: BridgeHandlers = {
      onSnapshot: (_seq, sceneJson) => {
        const scene = wasmSceneRef.current;
        if (!scene) return;
        try {
          scene.load_snapshot(sceneJson);
          setZ(scene.z());
          setT(scene.t());
          setC(scene.c());
          setRemoteCameraVersion((v) => v + 1);
        } catch (e) {
          console.warn("[Bridge] bad snapshot:", e);
        }
      },
      onCommand: (_seq, commandJson) => {
        const scene = wasmSceneRef.current;
        if (!scene) return;
        try {
          scene.apply_command(commandJson);
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "set_z") setZ(cmd.z);
          if (cmd.type === "set_t") setT(cmd.t);
          if (cmd.type === "set_c") setC(cmd.c);
          if (cmd.type === "set_mode_2d" || cmd.type === "set_mode_3d") {
            const mode = cmd.type === "set_mode_3d" ? "3d" : "2d";
            setViewMode(mode);
            const client = clientRef.current;
            if (client) {
              if (mode === "2d") client.setModeSlice();
              else client.setModeVolume();
            }
          }
          setRemoteCameraVersion((v) => v + 1);
        } catch (e) {
          console.warn("[Bridge] bad command:", e);
        }
      },
      onAck: (_seq) => {
        // Client already applied optimistically — no-op.
      },
    };
    bridgeRef.current = new Bridge(handlers);
  }, []);

  const sendCommand = useCallback((json: string) => {
    bridgeRef.current?.send(json);
  }, []);

  // Create RenderClient once when canvas mounts.
  // transferControlToOffscreen() can only be called once per canvas, so we
  // must not destroy and recreate the client on StrictMode's double-mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || clientRef.current) return;

    const client = new RenderClient(canvas);
    clientRef.current = client;
    client.ready().then(() => {
      setClientReady(true);
    }).catch(err => {
      console.error("Render worker init failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  // Sync Z/T/C to WASM scene and request chunks
  useEffect(() => {
    if (!wasmScene || !storeRef.current) return;
    wasmScene.set_z(z);
    wasmScene.set_t(t);
    wasmScene.set_c(c);
    try {
      const plan = JSON.parse(wasmScene.chunk_plan());
      if (plan.needed.length > 0) {
        storeRef.current.ensureFetched(plan.needed);
      }
    } catch { /* ignore */ }
  }, [z, t, c, wasmScene]);

  function handleOpenFile() {
    fileInputRef.current?.click();
  }

  function handleOpenFolder() {
    dirInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setItem({
      name: selected.name,
      size: selected.size,
      kind: "file",
    });
    cleanupState();
  }

  function cleanupState() {
    storeRef.current?.destroy();
    storeRef.current = null;
    setVolume(null);
    setWasmScene(null);
    setDatasetInfo(null);
    setError(null);
    setZ(0);
    setC(0);
    setT(0);
  }

  async function handleDirChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const dirName = files[0].webkitRelativePath.split("/")[0];
    let totalSize = 0;
    for (let i = 0; i < files.length; i++) {
      totalSize += files[i].size;
    }

    setItem({
      name: dirName,
      size: totalSize,
      kind: "directory",
      fileCount: files.length,
    });
    cleanupState();

    // Try to load as OME-Zarr
    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    fileIndexRef.current = fileIndex;
    setLoading(true);
    try {
      const info = await parseDatasetInfo(fileIndex);
      console.log("OME-Zarr metadata:", info);
      setDatasetInfo(info);

      // Use coarsest level for fast first paint
      const coarsest = info.levels[info.levels.length - 1];
      const vol = await assembleVolume(fileIndex, coarsest.path, 0, 0, coarsest);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);

      // Create WasmScene with full-res level metadata
      const fullRes = info.levels[0];
      const scene = new WasmScene(800, 600);

      // Set volume scale from full-res level
      const shapeZ = fullRes.shape[2],
        shapeY = fullRes.shape[3],
        shapeX = fullRes.shape[4];
      const scaleZ = fullRes.scale[2],
        scaleY = fullRes.scale[3],
        scaleX = fullRes.scale[4];
      scene.set_volume_scale(shapeZ, shapeY, shapeX, scaleZ, scaleY, scaleX);

      // Add layer with real metadata so chunk_plan() can select levels
      const chunkX = fullRes.chunkShape[4];
      const chunkY = fullRes.chunkShape[3];
      const chunkZ = fullRes.chunkShape[2];
      scene.add_layer("main", true, info.levels.length, chunkX, chunkY, chunkZ, shapeX, shapeY, shapeZ);

      // Center the Rust 2D camera on the image so world_bounds matches the TS viewer
      scene.set_center(shapeX / 2, shapeY / 2);

      scene.set_mode_2d();
      scene.set_z(0);
      scene.set_c(0);
      scene.set_t(0);

      // Create ChunkStore
      const store = new ChunkStore(fileIndex, info);
      storeRef.current = store;

      setVolume(vol);
      setWasmScene(scene);
    } catch (err) {
      console.error("Failed to load OME-Zarr:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const handleViewModeToggle = useCallback(() => {
    const next = viewMode === "2d" ? "3d" : "2d";
    setViewMode(next);
    if (wasmScene) {
      applyAndSend(wasmScene, { type: next === "3d" ? "set_mode_3d" : "set_mode_2d" }, sendCommand);
      if (next === "2d" && datasetInfo) {
        const shapeX = datasetInfo.levels[0].shape[4];
        const shapeY = datasetInfo.levels[0].shape[3];
        applyAndSend(wasmScene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 }, sendCommand);
      }
    }
    const client = clientRef.current;
    if (client) {
      if (next === "2d") {
        client.setModeSlice();
      } else {
        client.setModeVolume();
      }
    }
  }, [viewMode, wasmScene, datasetInfo, sendCommand]);

  // Dimension extents from full-res level (level 0) for accurate slider ranges
  const dimZ = datasetInfo ? datasetInfo.levels[0].shape[2] : 1;
  const dimC = datasetInfo ? datasetInfo.levels[0].shape[1] : 1;
  const dimT = datasetInfo ? datasetInfo.levels[0].shape[0] : 1;

  const client = clientReady ? clientRef.current : null;

  return (
    <div className="app">
      <h1>Lucida</h1>
      <input
        ref={fileInputRef}
        type="file"
        accept=".tif,.tiff,.ome.tif,.ome.tiff,.nd2,.czi,.lif"
        onChange={handleFileChange}
        hidden
      />
      <input
        ref={dirInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleDirChange}
        hidden
      />
      <div className="button-group">
        <button onClick={handleOpenFile}>Open File</button>
        <button onClick={handleOpenFolder}>Open Folder</button>
        {volume && (
          <button onClick={handleViewModeToggle}>
            {viewMode === "2d" ? "3D View" : "2D View"}
          </button>
        )}
      </div>
      {item && (
        <div className="file-info">
          <p>{item.name}</p>
          <p className="secondary">
            {formatBytes(item.size)}
            {item.kind === "directory" && ` · ${item.fileCount} files`}
          </p>
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: 600,
          maxWidth: 800,
          imageRendering: viewMode === "2d" ? "pixelated" : "auto",
          borderRadius: 8,
          backgroundColor: "black",
          display: volume ? "block" : "none",
        }}
      />
      {volume && viewMode === "2d" && wasmScene && datasetInfo && storeRef.current && client && (
        <SliceViewer
          volume={volume}
          z={z}
          t={t}
          c={c}
          scene={wasmScene}
          store={storeRef.current}
          datasetInfo={datasetInfo}
          client={client}
          canvas={canvasRef.current!}
          remoteCameraVersion={remoteCameraVersion}
          sendCommand={sendCommand}
        />
      )}
      {volume && viewMode === "3d" && wasmScene && datasetInfo && storeRef.current && client && (
        <VolumeViewer
          volume={volume}
          scene={wasmScene}
          store={storeRef.current}
          datasetInfo={datasetInfo}
          client={client}
          canvas={canvasRef.current!}
          remoteCameraVersion={remoteCameraVersion}
          sendCommand={sendCommand}
          t={t}
          c={c}
        />
      )}
      {volume && (
        <div className="dimension-controls">
          <DimensionControls label="Z" value={z} max={dimZ} onChange={(v) => { setZ(v); sendCommand(JSON.stringify({ type: "set_z", z: v })); }} disabled={viewMode === "3d"} />
          <DimensionControls label="C" value={c} max={dimC} onChange={(v) => { setC(v); sendCommand(JSON.stringify({ type: "set_c", c: v })); }} />
          <DimensionControls label="T" value={t} max={dimT} onChange={(v) => { setT(v); sendCommand(JSON.stringify({ type: "set_t", t: v })); }} />
        </div>
      )}
      {loading && <p className="secondary">Loading volume...</p>}
      {error && <p style={{ color: "#f44" }}>{error}</p>}
    </div>
  );
}

export default App;
