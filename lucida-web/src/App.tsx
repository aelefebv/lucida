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
import { LayerPanel, type LayerInfo } from "./components/LayerPanel.tsx";
import { Bridge, type BridgeHandlers, type ClientId, type PresenceState } from "./bridge.ts";
import { applyDocumentCommand, applyViewportCommand } from "./applyAndSend.ts";
import { Minimap } from "./components/Minimap.tsx";
import "./App.css";

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
  name: string;
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
  const [wasmReady, setWasmReady] = useState(false);
  const [volumeMap, setVolumeMap] = useState<Map<string, VolumeData>>(new Map());
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");

  // Dimension state
  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [t, setT] = useState(0);

  // Per-dataset intensity ranges from GPU worker
  const [dataRangeMap, setDataRangeMap] = useState<Map<string, { min: number; max: number }>>(new Map());

  // Per-layer auto-contrast and full-range flags
  const [autoContrastMap, setAutoContrastMap] = useState<Map<string, boolean>>(new Map());
  const [fullRangeMap, setFullRangeMap] = useState<Map<string, boolean>>(new Map());
  const autoContrastMapRef = useRef<Map<string, boolean>>(new Map());
  autoContrastMapRef.current = autoContrastMap;

  // Layer panel expand state
  const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null);

  // Bumped when WASM layer settings change to trigger re-render
  const [layerSettingsVersion, setLayerSettingsVersion] = useState(0);

  // Remote document version — bumped when a document command arrives via WebSocket
  const [remoteDocumentVersion, setRemoteDocumentVersion] = useState(0);

  // Bumped when datasetsRef changes to trigger re-renders
  const [datasetsVersion, setDatasetsVersion] = useState(0);

  // Peer presence state
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);

  // Selected dataset for rendering
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);

  // Track all datasets (local and remote) by id
  const datasetsRef = useRef<Map<string, DatasetState>>(new Map());
  // Pending chunk requests from remote viewers (keyed by chunk key)
  const pendingChunkRequests = useRef<Map<string, PendingChunkResolve>>(new Map());

  const dirInputRef = useRef<HTMLInputElement>(null);

  // Single canvas + RenderClient persisting across mode switches
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<RenderClient | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const loopRef = useRef<RenderLoop | null>(null);
  const [activeLoop, setActiveLoop] = useState<RenderLoop | null>(null);

  // Track which datasets have been pre-uploaded to the GPU worker
  const preUploadedRef = useRef(new Set<string>());

  useEffect(() => {
    init().then(() => setWasmReady(true));
  }, []);

  // Bridge: receive commands from relay server over WebSocket.
  const bridgeRef = useRef<Bridge | null>(null);
  const wasmSceneRef = useRef<WasmScene | null>(null);
  wasmSceneRef.current = wasmScene;

  // Ref to follow target so event handlers see latest value
  const followTargetRef = useRef<ClientId | null>(null);
  followTargetRef.current = followTarget;

  useEffect(() => {
    if (!wasmReady || bridgeRef.current) return;
    const handlers: BridgeHandlers = {
      onSnapshot: (_seq, documentJson, snapshotPeers, yourId) => {
        try {
          let scene = wasmSceneRef.current;
          // Create WasmScene if we don't have one yet
          if (!scene) {
            scene = new WasmScene(800, 600);
            wasmSceneRef.current = scene;
          }
          // Load only document state — preserve local camera/view/display
          scene.load_document(documentJson);

          setMyId(yourId);

          // Build peers map from snapshot
          const peerMap = new Map<ClientId, PresenceState>();
          for (const peer of snapshotPeers) {
            if (peer.client_id !== yourId) {
              peerMap.set(peer.client_id, peer);
            }
          }
          setPeers(peerMap);

          // Check for datasets in snapshot that we don't have locally
          const doc = JSON.parse(documentJson);
          if (doc.datasets) {
            for (const ds of doc.datasets) {
              if (ds.client_metadata && !datasetsRef.current.has(ds.id)) {
                setupRemoteDataset(ds.id, ds.name ?? ds.id, ds.client_metadata);
              }
            }
          }

          setRemoteDocumentVersion((v) => v + 1);
          setDatasetsVersion((v) => v + 1);

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
          // Only document commands arrive here now
          scene.apply_command(commandJson);
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "add_dataset" && cmd.client_metadata) {
            if (!datasetsRef.current.has(cmd.id)) {
              setupRemoteDataset(cmd.id, cmd.name ?? cmd.id, cmd.client_metadata);
            }
            setWasmScene(scene);
          }
          if (cmd.type === "remove_dataset") {
            loopRef.current?.removeDataset(cmd.id);
            clientRef.current?.removeLayerResources(cmd.id);
            const ds = datasetsRef.current.get(cmd.id);
            if (ds) {
              ds.store.destroy();
              datasetsRef.current.delete(cmd.id);
            }
            // Clean up per-layer maps
            setAutoContrastMap(prev => { const next = new Map(prev); next.delete(cmd.id); return next; });
            setFullRangeMap(prev => { const next = new Map(prev); next.delete(cmd.id); return next; });
            setDataRangeMap(prev => { const next = new Map(prev); next.delete(cmd.id); return next; });
            // If removed dataset was selected, select next available or null
            setSelectedDatasetId(prev => {
              if (prev === cmd.id) {
                return datasetsRef.current.keys().next().value ?? null;
              }
              return prev;
            });
            setVolumeMap(prev => { const next = new Map(prev); next.delete(cmd.id); return next; });
            // Reject pending chunk requests for the removed dataset
            for (const [key, pending] of pendingChunkRequests.current) {
              if (key.startsWith(cmd.id + "/")) {
                pending.reject(new Error("Dataset removed"));
                pendingChunkRequests.current.delete(key);
              }
            }
            setDatasetsVersion((v) => v + 1);
          }
          setRemoteDocumentVersion((v) => v + 1);
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
      onPeerJoined: (clientId, presence) => {
        setPeers(prev => {
          const next = new Map(prev);
          next.set(clientId, presence);
          return next;
        });
      },
      onPeerLeft: (clientId) => {
        setPeers(prev => {
          const next = new Map(prev);
          next.delete(clientId);
          return next;
        });
        // If we were following this peer, stop
        if (followTargetRef.current === clientId) {
          setFollowTarget(null);
        }
      },
      onPresenceUpdate: (clientId, camera, view, display) => {
        // Update peer state
        setPeers(prev => {
          const next = new Map(prev);
          const existing = next.get(clientId);
          if (existing) {
            next.set(clientId, { ...existing, camera, view, display });
          }
          return next;
        });
        // If following this client, import their presence
        if (followTargetRef.current === clientId) {
          const scene = wasmSceneRef.current;
          if (scene) {
            try {
              const presenceJson = JSON.stringify({ camera, view, display });
              scene.import_presence(presenceJson);
              // Sync local state from imported presence
              setZ(scene.z());
              setT(scene.t());
              setC(scene.c());
              const is3d = scene.is_3d();
              setViewMode(is3d ? "3d" : "2d");
              loopRef.current?.markDirty();
              // Re-emit so the server has our updated state
              bridgeRef.current?.sendPresence(scene.export_presence());
            } catch (e) {
              console.warn("[Bridge] failed to import presence:", e);
            }
          }
        }
      },
      onCursorUpdate: (clientId, position) => {
        setPeers(prev => {
          const next = new Map(prev);
          const existing = next.get(clientId);
          if (existing) {
            next.set(clientId, { ...existing, cursor: position });
          }
          return next;
        });
      },
      onFollowChanged: (clientId, target) => {
        setPeers(prev => {
          const next = new Map(prev);
          const existing = next.get(clientId);
          if (existing) {
            next.set(clientId, { ...existing, following: target });
          }
          // If this is us being steered to follow someone, immediately import their presence
          if (clientId === myId && target !== null) {
            const peer = next.get(target);
            if (peer) {
              const scene = wasmSceneRef.current;
              if (scene && peer.camera && peer.view && peer.display) {
                try {
                  const presenceJson = JSON.stringify({
                    camera: peer.camera,
                    view: peer.view,
                    display: peer.display,
                  });
                  scene.import_presence(presenceJson);
                  setZ(scene.z());
                  setT(scene.t());
                  setC(scene.c());
                  setViewMode(scene.is_3d() ? "3d" : "2d");
                  loopRef.current?.markDirty();
                  bridgeRef.current?.sendPresence(scene.export_presence());
                } catch (e) {
                  console.warn("[Bridge] failed to import presence on steer:", e);
                }
              }
            }
          }
          return next;
        });
        // If this is us, update our follow target
        // (server may have redirected us due to transitive chain)
        if (clientId === myId) {
          setFollowTarget(target);
        }
      },
      onLayerPresenceUpdate: (clientId, layerOrder, layerSettings) => {
        // Update peer state
        setPeers(prev => {
          const next = new Map(prev);
          const existing = next.get(clientId);
          if (existing) {
            next.set(clientId, { ...existing, layer_order: layerOrder, layer_settings: layerSettings });
          }
          return next;
        });
        // If following this peer, import their layer presence
        if (followTargetRef.current === clientId) {
          const scene = wasmSceneRef.current;
          if (scene) {
            try {
              const json = JSON.stringify({ layer_order: layerOrder, layer_settings: layerSettings });
              scene.import_layer_presence(json);
              setLayerSettingsVersion((v) => v + 1);
              loopRef.current?.markDirty();
            } catch (e) {
              console.warn("[Bridge] failed to import layer presence:", e);
            }
          }
        }
      },
      onDisconnect: () => {
        // Reject all pending chunk requests so they don't hang forever
        for (const [, pending] of pendingChunkRequests.current) {
          pending.reject(new Error("Bridge disconnected"));
        }
        pendingChunkRequests.current.clear();
      },
    };
    bridgeRef.current = new Bridge(handlers);
  }, [wasmReady]);

  /** Set up a remote dataset from client_metadata received via command/snapshot. */
  function setupRemoteDataset(datasetId: string, name: string, clientMetadata: DatasetInfo) {
    const info = clientMetadata;

    const CHUNK_TIMEOUT_MS = 10_000;

    // Create a remote fetcher that requests chunks via the bridge.
    const remoteFetcher: ChunkFetcher = async (coord, signal) => {
      const compositeKey = `${datasetId}/${coord.key}`;
      const rawBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingChunkRequests.current.delete(compositeKey);
          reject(new Error(`Chunk ${coord.key} timed out`));
        }, CHUNK_TIMEOUT_MS);

        pendingChunkRequests.current.set(compositeKey, {
          resolve: (data) => { clearTimeout(timeoutId); resolve(data); },
          reject: (err) => { clearTimeout(timeoutId); reject(err); },
        });

        bridgeRef.current?.send(JSON.stringify({
          type: "chunk_request",
          dataset_id: datasetId,
          key: coord.key,
        }));

        signal?.addEventListener("abort", () => {
          clearTimeout(timeoutId);
          pendingChunkRequests.current.delete(compositeKey);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });

      // Empty response means chunk doesn't exist — return as-is so ChunkStore
      // caches the result and doesn't retry.
      if (rawBytes.byteLength === 0) {
        return rawBytes;
      }

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
      name,
      info,
      store,
      fileIndex: null,
    });

    // Init per-layer maps
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(datasetId, true); return next; });
    setFullRangeMap(prev => { const next = new Map(prev); next.set(datasetId, false); return next; });

    // Add to render loop if it exists
    loopRef.current?.addDataset(datasetId, store, info);

    // Always create placeholder volume for remote datasets
    const coarsest = info.levels[info.levels.length - 1];
    const [, , depth, height, width] = coarsest.shape;
    setVolumeMap(prev => {
      const next = new Map(prev);
      next.set(datasetId, { data: new Uint16Array(width * height * depth), width, height, depth });
      return next;
    });

    // If this is the first dataset, select it.
    if (datasetsRef.current.size === 1) {
      setSelectedDatasetId(datasetId);
    }

    setDatasetsVersion((v) => v + 1);
  }

  /** Send an empty-data binary response so the requester's promise resolves immediately. */
  function sendEmptyChunkResponse(clientId: number, datasetId: string, key: string) {
    const compositeKey = `${datasetId}/${key}`;
    const keyBytes = new TextEncoder().encode(compositeKey);
    const headerSize = 4 + 2 + keyBytes.length;
    const message = new Uint8Array(headerSize); // zero-length data
    const view = new DataView(message.buffer);
    view.setUint32(0, clientId, true);
    view.setUint16(4, keyBytes.length, true);
    message.set(keyBytes, 6);
    bridgeRef.current?.sendBinary(message);
  }

  /** Serve a chunk_fetch request — read raw file bytes and send via binary. */
  async function serveChunkFetch(clientId: number, datasetId: string, key: string) {
    const ds = datasetsRef.current.get(datasetId);
    if (!ds || !ds.fileIndex) {
      sendEmptyChunkResponse(clientId, datasetId, key);
      return;
    }

    // Parse key: "level/t/c/z/y/x"
    const parts = key.split("/").map(Number);
    if (parts.length !== 6) {
      sendEmptyChunkResponse(clientId, datasetId, key);
      return;
    }
    const [level, t, c, z, y, x] = parts;

    const levelMeta = ds.info.levels[level];
    if (!levelMeta) {
      sendEmptyChunkResponse(clientId, datasetId, key);
      return;
    }

    // Read raw bytes (no decompression — let the receiver decompress).
    const path = `${levelMeta.path}/c/${t}/${c}/${z}/${y}/${x}`;
    const file = ds.fileIndex.get(path);
    if (!file) {
      sendEmptyChunkResponse(clientId, datasetId, key);
      return;
    }

    try {
      const rawBytes = await file.arrayBuffer();

      // Build binary message: [client_id: u32 LE][key_len: u16 LE][key: UTF-8][data]
      const compositeKey = `${datasetId}/${key}`;
      const keyBytes = new TextEncoder().encode(compositeKey);
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
      sendEmptyChunkResponse(clientId, datasetId, key);
    }
  }

  /** Send a document command to server. */
  const sendCommand = useCallback((json: string) => {
    bridgeRef.current?.sendCommand(json);
  }, []);

  /** Emit current presence to server (throttled by bridge). */
  const emitPresence = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const presenceJson = scene.export_presence();
    bridgeRef.current?.sendPresence(presenceJson);
  }, []);

  /** Emit current layer presence to server (throttled by bridge). */
  const emitLayerPresence = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    bridgeRef.current?.sendLayerPresence(scene.export_layer_presence());
  }, []);

  /** Break follow on local viewport interaction. */
  const breakFollow = useCallback(() => {
    if (followTargetRef.current !== null) {
      setFollowTarget(null);
      bridgeRef.current?.sendFollow(null);
    }
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

  // Hook intensity range callback — per-dataset.
  // Worker messages arrive as separate browser tasks. During progressive chunk loading,
  // many intensityRange messages can queue up. Each setDataRangeMap call triggers a
  // React re-render, so unbatched updates cause cascading re-renders that block the
  // main thread. We batch them into a single RAF update.
  const pendingIntensityRef = useRef(new Map<string, { min: number; max: number }>());
  const intensityRafRef = useRef(0);
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.onIntensityRange = (datasetId, min, max) => {
      // Apply auto-contrast immediately via WASM (no React state) so the
      // render loop picks up correct contrast on the next tick.
      const isAuto = autoContrastMapRef.current.get(datasetId) ?? true;
      if (isAuto) {
        const scene = wasmSceneRef.current;
        if (scene) {
          scene.apply_command(JSON.stringify({
            type: "set_layer_contrast",
            dataset_id: datasetId,
            min,
            max,
          }));
          loopRef.current?.markDirty();
          bridgeRef.current?.sendLayerPresence(scene.export_layer_presence());
        }
      }

      // Batch the React state update to one per animation frame.
      pendingIntensityRef.current.set(datasetId, { min, max });
      if (!intensityRafRef.current) {
        intensityRafRef.current = requestAnimationFrame(() => {
          intensityRafRef.current = 0;
          const pending = pendingIntensityRef.current;
          if (pending.size === 0) return;
          const batch = new Map(pending);
          pending.clear();
          setDataRangeMap(prev => {
            const next = new Map(prev);
            for (const [id, range] of batch) {
              next.set(id, range);
            }
            return next;
          });
        });
      }
    };
    return () => {
      if (intensityRafRef.current) {
        cancelAnimationFrame(intensityRafRef.current);
        intensityRafRef.current = 0;
      }
    };
  }, [clientReady]);

  // Eagerly pre-upload initial volumes/fallbacks for all datasets at load time,
  // so switching layers doesn't trigger expensive synchronous uploads.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !clientReady) return;

    // Clean up removed datasets
    for (const id of preUploadedRef.current) {
      if (!volumeMap.has(id)) {
        preUploadedRef.current.delete(id);
      }
    }

    // Upload new datasets
    for (const [id, vol] of volumeMap) {
      if (preUploadedRef.current.has(id)) continue;
      preUploadedRef.current.add(id);

      // Upload 3D volume for volume rendering
      client.volumeSetInitialForLayer(id, vol.data, vol.width, vol.height, vol.depth);

      // Upload 2D fallback slice for slice rendering (z=0)
      const sliceSize = vol.width * vol.height;
      const slice = vol.data.subarray(0, sliceSize);
      client.sliceSetFallbackForLayer(id, slice, vol.width, vol.height);
    }
  }, [volumeMap, clientReady]);

  // Reset pan/zoom when dataset dimensions change (LOD upgrades),
  // but NOT when merely switching the selected layer.
  const prevDimsMapRef = useRef(new Map<string, { w: number; h: number; d: number }>());
  useEffect(() => {
    for (const [id, vol] of volumeMap) {
      const prev = prevDimsMapRef.current.get(id);
      if (prev && (vol.width !== prev.w || vol.height !== prev.h || vol.depth !== prev.d)) {
        const ds = datasetsRef.current.get(id);
        const scene = wasmSceneRef.current;
        if (ds && scene) {
          const fullResWidth = ds.info.levels[0].shape[4];
          const fullResHeight = ds.info.levels[0].shape[3];
          applyViewportCommand(scene, { type: "set_center", x: fullResWidth / 2, y: fullResHeight / 2 });
          applyViewportCommand(scene, { type: "set_zoom", value: 1.0 });
          emitPresence();
          loopRef.current?.markDirty();
        }
      }
      prevDimsMapRef.current.set(id, { w: vol.width, h: vol.height, d: vol.depth });
    }
    for (const id of prevDimsMapRef.current.keys()) {
      if (!volumeMap.has(id)) prevDimsMapRef.current.delete(id);
    }
  }, [volumeMap, emitPresence]);

  async function handleDirChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const dirName = files[0].webkitRelativePath.split("/")[0];

    // Try to load as OME-Zarr
    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    setLoading(true);
    setError(null);
    try {
      const info = await parseDatasetInfo(fileIndex);
      console.log("OME-Zarr metadata:", info);

      // Use coarsest level for fast first paint
      const coarsest = info.levels[info.levels.length - 1];
      const vol = await assembleVolume(fileIndex, coarsest.path, 0, 0, coarsest);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);

      // Create or reuse WasmScene
      let scene = wasmSceneRef.current;
      const isFirstDataset = !scene;
      if (!scene) {
        scene = new WasmScene(800, 600);
        wasmSceneRef.current = scene;
      }

      // Generate dataset ID
      const datasetId = crypto.randomUUID();

      // Build AddDataset command with layer metadata + client_metadata
      const fullRes = info.levels[0];
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
        client_metadata: info,
      };

      // Apply document command locally and send to server
      applyDocumentCommand(scene, addDatasetCmd, sendCommand);

      // If first dataset, set up viewport
      if (isFirstDataset) {
        applyViewportCommand(scene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 });
        applyViewportCommand(scene, { type: "set_mode_2d" });
        applyViewportCommand(scene, { type: "set_z", z: 0 });
        applyViewportCommand(scene, { type: "set_c", c: 0 });
        applyViewportCommand(scene, { type: "set_t", t: 0 });
      }

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

      // Track this dataset locally (so we can serve chunk requests)
      datasetsRef.current.set(datasetId, {
        id: datasetId,
        name: dirName,
        info,
        store,
        fileIndex,
      });

      // Init per-layer maps
      setAutoContrastMap(prev => { const next = new Map(prev); next.set(datasetId, true); return next; });
      setFullRangeMap(prev => { const next = new Map(prev); next.set(datasetId, false); return next; });

      // Add to render loop if it exists
      loopRef.current?.addDataset(datasetId, store, info);

      // Select this dataset
      setSelectedDatasetId(datasetId);
      setDatasetsVersion((v) => v + 1);

      setVolumeMap(prev => { const next = new Map(prev); next.set(datasetId, vol); return next; });
      setWasmScene(scene);

      // Emit initial presence after setup
      setTimeout(() => emitPresence(), 0);
      setTimeout(() => emitLayerPresence(), 0);
    } catch (err) {
      console.error("Failed to load OME-Zarr:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      // Reset input so same folder can be re-selected
      e.target.value = "";
    }
  }

  const handleViewModeToggle = useCallback(() => {
    const next = viewMode === "2d" ? "3d" : "2d";
    setViewMode(next);
    breakFollow();
    if (wasmScene) {
      applyViewportCommand(wasmScene, { type: next === "3d" ? "set_mode_3d" : "set_mode_2d" });
      if (next === "2d" && selectedDatasetId) {
        const dsInfo = datasetsRef.current.get(selectedDatasetId)?.info;
        if (dsInfo) {
          const shapeX = dsInfo.levels[0].shape[4];
          const shapeY = dsInfo.levels[0].shape[3];
          applyViewportCommand(wasmScene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 });
        }
      }
      emitPresence();
    }
  }, [viewMode, wasmScene, selectedDatasetId, emitPresence, breakFollow]);

  // Union dimension extents across ALL datasets for slider ranges.
  // Reference datasetsVersion so this recomputes when datasets are added/removed.
  let dimZ = 1, dimC = 1, dimT = 1;
  void datasetsVersion;
  for (const ds of datasetsRef.current.values()) {
    const shape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    dimZ = Math.max(dimZ, shape[2]);
    dimC = Math.max(dimC, shape[1]);
    dimT = Math.max(dimT, shape[0]);
  }

  // Clamp slider values when union dimensions shrink (e.g. removing a large dataset)
  useEffect(() => {
    if (z >= dimZ) setZ(dimZ - 1);
    if (c >= dimC) setC(dimC - 1);
    if (t >= dimT) setT(dimT - 1);
  }, [dimZ, dimC, dimT]);

  // --- Layer panel handlers ---

  const handleLayerSelect = useCallback((id: string) => {
    setSelectedDatasetId(id);
  }, []);

  const handleLayerToggleExpand = useCallback((id: string) => {
    setExpandedLayerId(prev => prev === id ? null : id);
    // Also select the layer so expanded controls always match the selected layer
    handleLayerSelect(id);
  }, [handleLayerSelect]);

  const handleLayerSetVisible = useCallback((id: string, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_layer_visible", dataset_id: id, visible }));
      loopRef.current?.markDirty();
      emitLayerPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [emitLayerPresence, breakFollow]);

  const handleLayerSetOpacity = useCallback((id: string, opacity: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_layer_opacity", dataset_id: id, opacity }));
      loopRef.current?.markDirty();
      emitLayerPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [emitLayerPresence, breakFollow]);

  const handleLayerSetContrast = useCallback((id: string, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_layer_contrast", dataset_id: id, min, max }));
      loopRef.current?.markDirty();
      emitLayerPresence();
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, false); return next; });
  }, [emitLayerPresence, breakFollow]);

  const handleLayerSetGamma = useCallback((id: string, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_layer_gamma", dataset_id: id, gamma }));
      loopRef.current?.markDirty();
      emitLayerPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [emitLayerPresence, breakFollow]);

  const handleLayerSetBlendMode = useCallback((id: string, mode: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_layer_blend_mode", dataset_id: id, blend_mode: mode }));
      loopRef.current?.markDirty();
      emitLayerPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [emitLayerPresence, breakFollow]);

  const handleLayerAutoContrast = useCallback((id: string) => {
    const dr = dataRangeMap.get(id);
    if (dr) {
      const scene = wasmSceneRef.current;
      if (scene) {
        breakFollow();
        scene.apply_command(JSON.stringify({ type: "set_layer_contrast", dataset_id: id, min: dr.min, max: dr.max }));
        loopRef.current?.markDirty();
        emitLayerPresence();
      }
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, true); return next; });
  }, [dataRangeMap, emitLayerPresence, breakFollow]);

  const handleLayerAutoContrastToggle = useCallback((id: string) => {
    setAutoContrastMap(prev => {
      const next = new Map(prev);
      const wasAuto = prev.get(id) ?? true;
      next.set(id, !wasAuto);
      if (!wasAuto) {
        // Re-enabling auto: apply current data range
        const dr = dataRangeMap.get(id);
        if (dr) {
          const scene = wasmSceneRef.current;
          if (scene) {
            breakFollow();
            scene.apply_command(JSON.stringify({ type: "set_layer_contrast", dataset_id: id, min: dr.min, max: dr.max }));
            loopRef.current?.markDirty();
            emitLayerPresence();
          }
        }
      }
      return next;
    });
  }, [dataRangeMap, emitLayerPresence, breakFollow]);

  const handleLayerFullRangeToggle = useCallback((id: string) => {
    setFullRangeMap(prev => {
      const next = new Map(prev);
      const wasFull = prev.get(id) ?? false;
      next.set(id, !wasFull);
      const scene = wasmSceneRef.current;
      if (scene) {
        breakFollow();
        if (!wasFull) {
          // Enabling full range
          const ds = datasetsRef.current.get(id);
          const frMax = ds ? dtypeMax(ds.info.levels[0].dataType) : 65535;
          scene.apply_command(JSON.stringify({ type: "set_layer_contrast", dataset_id: id, min: 0, max: frMax }));
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, false); return n; });
        } else {
          // Disabling full range — apply data range
          const dr = dataRangeMap.get(id);
          if (dr) {
            scene.apply_command(JSON.stringify({ type: "set_layer_contrast", dataset_id: id, min: dr.min, max: dr.max }));
          }
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, true); return n; });
        }
        loopRef.current?.markDirty();
        emitLayerPresence();
      }
      return next;
    });
  }, [dataRangeMap, emitLayerPresence, breakFollow]);

  const handleLayerMove = useCallback((id: string, direction: "up" | "down") => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    breakFollow();
    const order: string[] = JSON.parse(scene.layer_order());
    const idx = order.indexOf(id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= order.length) return;
    [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
    scene.apply_command(JSON.stringify({ type: "set_layer_order", order }));
    loopRef.current?.markDirty();
    emitLayerPresence();
    setLayerSettingsVersion((v) => v + 1);
  }, [emitLayerPresence, breakFollow]);

  const handleRemoveLayer = useCallback((id: string) => {
    if (!confirm(`Remove layer "${datasetsRef.current.get(id)?.name ?? id}"?`)) return;
    const scene = wasmSceneRef.current;
    if (!scene) return;

    applyDocumentCommand(scene, { type: "remove_dataset", id }, sendCommand);

    loopRef.current?.removeDataset(id);
    clientRef.current?.removeLayerResources(id);
    const ds = datasetsRef.current.get(id);
    if (ds) {
      ds.store.destroy();
      datasetsRef.current.delete(id);
    }

    // Clean up per-layer maps
    setAutoContrastMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    setFullRangeMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    setDataRangeMap(prev => { const next = new Map(prev); next.delete(id); return next; });

    // Select next layer
    setSelectedDatasetId(prev => {
      if (prev === id) {
        return datasetsRef.current.keys().next().value ?? null;
      }
      return prev;
    });
    setVolumeMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    // Reject pending chunk requests for the removed dataset
    for (const [key, pending] of pendingChunkRequests.current) {
      if (key.startsWith(id + "/")) {
        pending.reject(new Error("Dataset removed"));
        pendingChunkRequests.current.delete(key);
      }
    }
    setDatasetsVersion((v) => v + 1);
  }, [sendCommand]);

  /** Handle follow button click for a peer. */
  const handleFollow = useCallback((targetId: ClientId | null) => {
    if (targetId === myId) return;
    setFollowTarget(targetId);
    bridgeRef.current?.sendFollow(targetId);
    // If starting to follow, immediately import their latest presence
    if (targetId !== null) {
      const peer = peers.get(targetId);
      if (peer) {
        const scene = wasmSceneRef.current;
        if (scene) {
          try {
            const presenceJson = JSON.stringify({
              camera: peer.camera,
              view: peer.view,
              display: peer.display,
            });
            scene.import_presence(presenceJson);
            // Also import layer presence if available
            if (peer.layer_order && peer.layer_settings) {
              try {
                const layerJson = JSON.stringify({
                  layer_order: peer.layer_order,
                  layer_settings: peer.layer_settings,
                });
                scene.import_layer_presence(layerJson);
                setLayerSettingsVersion((v) => v + 1);
              } catch (e) {
                console.warn("Failed to import peer layer presence:", e);
              }
            }
            setZ(scene.z());
            setT(scene.t());
            setC(scene.c());
            const is3d = scene.is_3d();
            setViewMode(is3d ? "3d" : "2d");
            loopRef.current?.markDirty();
          } catch (e) {
            console.warn("Failed to import peer presence:", e);
          }
        }
      }
    }
  }, [peers, myId]);

  const client = clientReady ? clientRef.current : null;

  // Build list of followable peers (not following anyone else)
  const followablePeers = Array.from(peers.entries())
    .filter(([, p]) => p.following === null || p.following === undefined);

  // --- Build layer infos from WASM state ---
  const buildLayerInfos = (): LayerInfo[] => {
    const scene = wasmSceneRef.current;
    if (!scene) return [];

    let layerOrder: string[];
    let allSettings: Record<string, {
      visible: boolean;
      opacity: number;
      contrast_min: number;
      contrast_max: number;
      gamma: number;
      blend_mode: string;
    }>;
    try {
      layerOrder = JSON.parse(scene.layer_order());
      allSettings = JSON.parse(scene.all_layer_settings());
    } catch {
      return [];
    }

    // Reverse so frontmost layer (rendered last) appears at top of panel
    const result = layerOrder.slice().reverse().map(id => {
      const settings = allSettings[id];
      const ds = datasetsRef.current.get(id);
      const dr = dataRangeMap.get(id) ?? null;
      const frMax = ds ? dtypeMax(ds.info.levels[0].dataType) : 65535;

      return {
        id,
        name: scene.dataset_name(id),
        visible: settings?.visible ?? true,
        opacity: settings?.opacity ?? 1,
        contrastMin: settings?.contrast_min ?? 0,
        contrastMax: settings?.contrast_max ?? 65535,
        gamma: settings?.gamma ?? 1,
        blendMode: settings?.blend_mode ?? "alpha",
        autoContrast: autoContrastMap.get(id) ?? true,
        fullRange: fullRangeMap.get(id) ?? false,
        dataRange: dr,
        fullRangeMax: frMax,
      };
    });
    return result;
  };

  // Re-derive on relevant state changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layerInfos = buildLayerInfos();
  // Depend on datasetsVersion, autoContrastMap, fullRangeMap, dataRangeMap, wasmScene, remoteDocumentVersion
  void datasetsVersion;
  void remoteDocumentVersion;
  void layerSettingsVersion;

  return (
    <div className="app">
      <input
        ref={dirInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleDirChange}
        hidden
      />
      <LayerPanel
        layers={layerInfos}
        selectedLayerId={selectedDatasetId}
        expandedLayerId={expandedLayerId}
        onSelectLayer={handleLayerSelect}
        onToggleExpand={handleLayerToggleExpand}
        onSetVisible={handleLayerSetVisible}
        onSetOpacity={handleLayerSetOpacity}
        onSetContrast={handleLayerSetContrast}
        onSetGamma={handleLayerSetGamma}
        onSetBlendMode={handleLayerSetBlendMode}
        onAutoContrast={handleLayerAutoContrast}
        onAutoContrastToggle={handleLayerAutoContrastToggle}
        onFullRangeToggle={handleLayerFullRangeToggle}
        onMoveLayer={handleLayerMove}
        onRemoveLayer={handleRemoveLayer}
        onAddLayer={() => dirInputRef.current?.click()}
        viewModeToggle={volumeMap.size > 0 ? { label: viewMode === "2d" ? "3D" : "2D", onClick: handleViewModeToggle } : null}
      />
      <div className="main-content">
        {/* Peer list / follow controls */}
        {peers.size > 0 && (
          <div className="peer-list" style={{ fontSize: "0.85em", margin: "8px 0" }}>
            <strong>Peers ({peers.size}):</strong>
            {followTarget !== null && (
              <button onClick={() => handleFollow(null)} style={{ marginLeft: 8 }}>
                Stop Following
              </button>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: "4px 0" }}>
              {followablePeers.map(([peerId]) => (
                <li key={peerId} style={{ display: "inline", marginRight: 8 }}>
                  Client {peerId}
                  {followTarget !== peerId && (
                    <button onClick={() => handleFollow(peerId)} style={{ marginLeft: 4 }}>
                      Follow
                    </button>
                  )}
                  {followTarget === peerId && " (following)"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div style={{ position: "relative", display: volumeMap.size > 0 ? "block" : "none", maxWidth: 800 }}>
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height: 600,
              imageRendering: viewMode === "2d" ? "pixelated" : "auto",
              borderRadius: 8,
              backgroundColor: "black",
              display: "block",
            }}
          />
          {volumeMap.size > 0 && viewMode === "2d" && wasmScene && client && (
            <SliceViewer
              z={z}
              t={t}
              c={c}
              scene={wasmScene}
              datasets={datasetsRef.current}
              client={client}
              canvas={canvasRef.current!}
              remoteDocumentVersion={remoteDocumentVersion}
              emitPresence={emitPresence}
              breakFollow={breakFollow}
              loopRef={loopRef}
              onLoopChange={setActiveLoop}
            />
          )}
          {volumeMap.size > 0 && viewMode === "3d" && wasmScene && client && (
            <VolumeViewer
              scene={wasmScene}
              datasets={datasetsRef.current}
              client={client}
              canvas={canvasRef.current!}
              remoteDocumentVersion={remoteDocumentVersion}
              emitPresence={emitPresence}
              breakFollow={breakFollow}
              t={t}
              c={c}
              loopRef={loopRef}
              onLoopChange={setActiveLoop}
            />
          )}
          {clientReady && clientRef.current && (
            <Minimap client={clientRef.current} activeLoop={activeLoop} />
          )}
        </div>
        {volumeMap.size > 0 && (
          <div className="dimension-controls">
            <DimensionControls label="Z" value={z} max={dimZ} onChange={(v) => {
              setZ(v);
              breakFollow();
              const scene = wasmSceneRef.current;
              if (scene) {
                applyViewportCommand(scene, { type: "set_z", z: v });
                emitPresence();
              }
            }} disabled={viewMode === "3d"} />
            <DimensionControls label="C" value={c} max={dimC} onChange={(v) => {
              setC(v);
              breakFollow();
              const scene = wasmSceneRef.current;
              if (scene) {
                applyViewportCommand(scene, { type: "set_c", c: v });
                emitPresence();
              }
            }} />
            <DimensionControls label="T" value={t} max={dimT} onChange={(v) => {
              setT(v);
              breakFollow();
              const scene = wasmSceneRef.current;
              if (scene) {
                applyViewportCommand(scene, { type: "set_t", t: v });
                emitPresence();
              }
            }} />
          </div>
        )}
        {loading && <p className="secondary">Loading volume...</p>}
        {error && <p style={{ color: "#f44" }}>{error}</p>}
      </div>
    </div>
  );
}

export default App;
