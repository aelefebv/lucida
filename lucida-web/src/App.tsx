import { useCallback, useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";
import { buildFileIndex } from "./zarr/fileIndex.ts";
import { parseDatasetInfo } from "./zarr/metadata.ts";
import type { DatasetInfo } from "./zarr/metadata.ts";
import { assembleVolume } from "./zarr/volumeAssembler.ts";
import type { VolumeData } from "./zarr/volumeAssembler.ts";
import { ChunkStore, type ChunkFetcher } from "./zarr/chunkStore.ts";
import { loadChunk } from "./zarr/chunkLoader.ts";
import { decompressLz4Async } from "./zarr/lz4Client.ts";
import { RenderClient } from "./renderer/renderClient.ts";
import { RenderLoop } from "./renderLoop.ts";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import { ContrastControls } from "./components/ContrastControls.tsx";
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

function dtypeMax(dtype: string): number {
  switch (dtype) {
    case "uint8": return 255;
    case "uint16": return 65535;
    case "uint32": return 4294967295;
    case "float32": return 1;
    default: return 65535;
  }
}

/** State for a single dataset, either local or remote. */
interface DatasetState {
  id: string;
  info: DatasetInfo;
  store: ChunkStore;
  fileIndex: Map<string, File> | null; // null for remote datasets
}

/** Pending chunk request from a remote viewer. */
interface PendingChunkResolve {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

function App() {
  const [item, setItem] = useState<OpenedItem | null>(null);
  const [wasmReady, setWasmReady] = useState(false);
  const [volume, setVolume] = useState<VolumeData | null>(null);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");

  // Dimension state
  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [t, setT] = useState(0);

  // Contrast controls
  const [dataRange, setDataRange] = useState<{ min: number; max: number } | null>(null);
  const [contrastMin, setContrastMin] = useState(0);
  const [contrastMax, setContrastMax] = useState(65535);
  const [gamma, setGamma] = useState(1.0);
  const [autoContrast, setAutoContrast] = useState(true);
  const [fullRange, setFullRange] = useState(false);

  // Remote (Python bridge) camera version — bumped when a command arrives via WebSocket
  const [remoteCameraVersion, setRemoteCameraVersion] = useState(0);

  // Keep dataset info and file index for re-assembling on C/T change
  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null);
  const fileIndexRef = useRef<Map<string, File> | null>(null);
  const storeRef = useRef<ChunkStore | null>(null);

  // Track all datasets (local and remote) by id
  const datasetsRef = useRef<Map<string, DatasetState>>(new Map());
  // Pending chunk requests from remote viewers (keyed by chunk key)
  const pendingChunkRequests = useRef<Map<string, PendingChunkResolve>>(new Map());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // Single canvas + RenderClient persisting across mode switches
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<RenderClient | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const loopRef = useRef<RenderLoop | null>(null);

  useEffect(() => {
    init().then(() => setWasmReady(true));
  }, []);

  // Bridge: receive commands from relay server over WebSocket.
  const bridgeRef = useRef<Bridge | null>(null);
  const wasmSceneRef = useRef<WasmScene | null>(null);
  wasmSceneRef.current = wasmScene;

  useEffect(() => {
    if (!wasmReady || bridgeRef.current) return;
    const handlers: BridgeHandlers = {
      onSnapshot: (_seq, sceneJson) => {
        try {
          let scene = wasmSceneRef.current;
          // Create WasmScene if we don't have one yet
          if (!scene) {
            scene = new WasmScene(800, 600);
            wasmSceneRef.current = scene;
          }
          scene.load_snapshot(sceneJson);
          setZ(scene.z());
          setT(scene.t());
          setC(scene.c());

          // Sync view mode from camera type
          const is3d = scene.is_3d();
          setViewMode(is3d ? "3d" : "2d");

          setRemoteCameraVersion((v) => v + 1);

          // Check for datasets in snapshot that we don't have locally
          const snapshotScene = JSON.parse(sceneJson);
          if (snapshotScene.datasets) {
            for (const ds of snapshotScene.datasets) {
              if (ds.client_metadata && !datasetsRef.current.has(ds.id)) {
                setupRemoteDataset(ds.id, ds.client_metadata);
              }
            }
          }

          // Publish the scene so render gate passes
          setWasmScene(scene);
        } catch (e) {
          console.warn("[Bridge] bad snapshot:", e);
        }
      },
      onCommand: (_seq, commandJson) => {
        try {
          let scene = wasmSceneRef.current;
          if (!scene) {
            const cmd = JSON.parse(commandJson);
            if (cmd.type === "add_dataset" && cmd.client_metadata) {
              scene = new WasmScene(800, 600);
              wasmSceneRef.current = scene;
            } else {
              return; // Can't apply commands without a scene
            }
          }
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
          if (cmd.type === "add_dataset" && cmd.client_metadata) {
            if (!datasetsRef.current.has(cmd.id)) {
              setupRemoteDataset(cmd.id, cmd.client_metadata);
            }
            setWasmScene(scene);
          }
          if (cmd.type === "remove_dataset") {
            const ds = datasetsRef.current.get(cmd.id);
            if (ds) {
              ds.store.destroy();
              datasetsRef.current.delete(cmd.id);
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
      onChunkFetch: (clientId, datasetId, key) => {
        // We are the data source — serve chunk data from local files.
        serveChunkFetch(clientId, datasetId, key);
      },
      onChunkData: (key, data) => {
        // Chunk data arrived from a remote data source.
        const pending = pendingChunkRequests.current.get(key);
        if (pending) {
          pendingChunkRequests.current.delete(key);
          pending.resolve(data);
        }
      },
    };
    bridgeRef.current = new Bridge(handlers);
  }, [wasmReady]);

  /** Set up a remote dataset from client_metadata received via command/snapshot. */
  function setupRemoteDataset(datasetId: string, clientMetadata: DatasetInfo) {
    const info = clientMetadata;

    // Create a remote fetcher that requests chunks via the bridge.
    const remoteFetcher: ChunkFetcher = async (coord, signal) => {
      const rawBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        pendingChunkRequests.current.set(coord.key, { resolve, reject });
        bridgeRef.current?.send(JSON.stringify({
          type: "chunk_request",
          dataset_id: datasetId,
          key: coord.key,
        }));
        signal?.addEventListener("abort", () => {
          pendingChunkRequests.current.delete(coord.key);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });

      // Apply codec pipeline (same as loadChunk does for local files).
      const levelMeta = info.levels[coord.level];
      if (levelMeta) {
        const hasLz4 = levelMeta.codecs.some(c => c.name === "numcodecs/lz4");
        if (hasLz4) {
          return decompressLz4Async(rawBytes);
        }
      }
      return rawBytes;
    };

    const store = new ChunkStore(remoteFetcher);
    datasetsRef.current.set(datasetId, {
      id: datasetId,
      info,
      store,
      fileIndex: null,
    });

    // If this is the first dataset and we don't have a local one, use it for rendering.
    if (!storeRef.current) {
      storeRef.current = store;
      setDatasetInfo(info);

      // Create placeholder volume from coarsest level dimensions.
      // The RenderLoop will fetch real chunks and overwrite the fallback.
      const coarsest = info.levels[info.levels.length - 1];
      const [, , depth, height, width] = coarsest.shape;
      setVolume({
        data: new Uint16Array(width * height * depth),
        width,
        height,
        depth,
      });
    }
  }

  /** Serve a chunk_fetch request — read raw file bytes and send via binary. */
  async function serveChunkFetch(clientId: number, datasetId: string, key: string) {
    const ds = datasetsRef.current.get(datasetId);
    if (!ds || !ds.fileIndex) return;

    // Parse key: "level/t/c/z/y/x"
    const parts = key.split("/").map(Number);
    if (parts.length !== 6) return;
    const [level, t, c, z, y, x] = parts;

    const levelMeta = ds.info.levels[level];
    if (!levelMeta) return;

    // Read raw bytes (no decompression — let the receiver decompress).
    const path = `${levelMeta.path}/c/${t}/${c}/${z}/${y}/${x}`;
    const file = ds.fileIndex.get(path);
    if (!file) return;

    try {
      const rawBytes = await file.arrayBuffer();

      // Build binary message: [client_id: u32 LE][key_len: u16 LE][key: UTF-8][data]
      const keyBytes = new TextEncoder().encode(key);
      const headerSize = 4 + 2 + keyBytes.length;
      const message = new Uint8Array(headerSize + rawBytes.byteLength);
      const view = new DataView(message.buffer);
      view.setUint32(0, clientId, true);
      view.setUint16(4, keyBytes.length, true);
      message.set(keyBytes, 6);
      message.set(new Uint8Array(rawBytes), headerSize);

      bridgeRef.current?.sendBinary(message);
    } catch (err) {
      console.error(`Failed to serve chunk ${key}:`, err);
    }
  }

  const sendCommand = useCallback((json: string) => {
    bridgeRef.current?.send(json);
  }, []);

  // Create RenderClient once when canvas mounts.
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

  // Hook intensity range callback
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.onIntensityRange = (min, max) => {
      setDataRange({ min, max });
      setAutoContrast(prev => {
        if (prev) {
          setContrastMin(min);
          setContrastMax(max);
        }
        return prev;
      });
    };
  }, [clientReady]);

  // Push display params to worker
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !clientReady) return;
    client.setDisplayParams(contrastMin, contrastMax, gamma);
    loopRef.current?.markDirty();
  }, [contrastMin, contrastMax, gamma, clientReady]);

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
    setDataRange(null);
    setContrastMin(0);
    setContrastMax(65535);
    setGamma(1.0);
    setAutoContrast(true);
    setFullRange(false);
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

      // Generate dataset ID
      const datasetId = crypto.randomUUID();

      // Build AddDataset command with layer metadata + client_metadata
      const shapeZ = fullRes.shape[2],
        shapeY = fullRes.shape[3],
        shapeX = fullRes.shape[4];
      const scaleZ = fullRes.scale[2],
        scaleY = fullRes.scale[3],
        scaleX = fullRes.scale[4];

      const chunkX = fullRes.chunkShape[4];
      const chunkY = fullRes.chunkShape[3];
      const chunkZ = fullRes.chunkShape[2];

      // Build per-level info for the layer
      const levelInfoArray: { shape: [number, number, number]; chunk_size: [number, number, number] }[] = [];
      for (const lvl of info.levels) {
        levelInfoArray.push({
          shape: [lvl.shape[4], lvl.shape[3], lvl.shape[2]],
          chunk_size: [lvl.chunkShape[4], lvl.chunkShape[3], lvl.chunkShape[2]],
        });
      }

      const addDatasetCmd = {
        type: "add_dataset",
        id: datasetId,
        name: dirName,
        layers: [{
          name: "main",
          visible: true,
          num_levels: info.levels.length,
          chunk_size: [chunkX, chunkY, chunkZ],
          data_shape: [shapeX, shapeY, shapeZ],
          level_info: levelInfoArray,
        }],
        volume_shape: [shapeZ, shapeY, shapeX] as [number, number, number],
        volume_scale: [scaleZ, scaleY, scaleX] as [number, number, number],
        client_metadata: info, // Full DatasetInfo for remote clients
      };

      // Apply locally and send to server
      applyAndSend(scene, addDatasetCmd, sendCommand);

      // Center the Rust 2D camera on the image (synced via server)
      applyAndSend(scene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 }, sendCommand);
      applyAndSend(scene, { type: "set_mode_2d" }, sendCommand);
      applyAndSend(scene, { type: "set_z", z: 0 }, sendCommand);
      applyAndSend(scene, { type: "set_c", c: 0 }, sendCommand);
      applyAndSend(scene, { type: "set_t", t: 0 }, sendCommand);

      // Create local ChunkStore with local fetcher
      const localFetcher: ChunkFetcher = (coord, signal) => {
        const levelMeta = info.levels[coord.level];
        if (!levelMeta) return Promise.reject(new Error(`No level ${coord.level}`));
        return loadChunk(
          fileIndex,
          levelMeta.path,
          coord.t,
          coord.c,
          coord.z,
          coord.y,
          coord.x,
          levelMeta.codecs,
          signal,
        );
      };
      const store = new ChunkStore(localFetcher);
      storeRef.current = store;

      // Track this dataset locally (so we can serve chunk requests)
      datasetsRef.current.set(datasetId, {
        id: datasetId,
        info,
        store,
        fileIndex,
      });

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

  const handleContrastChange = useCallback((min: number, max: number) => {
    setContrastMin(min);
    setContrastMax(max);
    setAutoContrast(false);
  }, []);

  const handleGammaChange = useCallback((g: number) => {
    setGamma(g);
  }, []);

  const handleAutoContrast = useCallback(() => {
    if (dataRange) {
      setContrastMin(dataRange.min);
      setContrastMax(dataRange.max);
    }
  }, [dataRange]);

  const handleAutoContrastToggle = useCallback(() => {
    setAutoContrast(prev => {
      const next = !prev;
      if (next && dataRange) {
        setContrastMin(dataRange.min);
        setContrastMax(dataRange.max);
      }
      return next;
    });
  }, [dataRange]);

  const fullRangeMax = datasetInfo ? dtypeMax(datasetInfo.levels[0].dataType) : 65535;

  const handleFullRangeToggle = useCallback(() => {
    setFullRange(prev => {
      const next = !prev;
      if (next) {
        setContrastMin(0);
        setContrastMax(fullRangeMax);
        setAutoContrast(false);
      } else if (dataRange) {
        setContrastMin(dataRange.min);
        setContrastMax(dataRange.max);
        setAutoContrast(true);
      }
      return next;
    });
  }, [fullRangeMax, dataRange]);

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
          loopRef={loopRef}
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
          loopRef={loopRef}
        />
      )}
      {volume && dataRange && (
        <ContrastControls
          dataMin={dataRange.min}
          dataMax={dataRange.max}
          contrastMin={contrastMin}
          contrastMax={contrastMax}
          gamma={gamma}
          autoContrast={autoContrast}
          onContrastChange={handleContrastChange}
          onGammaChange={handleGammaChange}
          onAutoContrast={handleAutoContrast}
          onAutoContrastToggle={handleAutoContrastToggle}
          fullRange={fullRange}
          onFullRangeToggle={handleFullRangeToggle}
          fullRangeMax={fullRangeMax}
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
