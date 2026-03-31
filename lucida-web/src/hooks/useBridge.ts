import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Bridge, type BridgeHandlers, type ClientId, type PresenceState } from "../bridge.ts";
import { decompressLz4Async } from "../zarr/lz4Client.ts";
import type { ChunkFetcher } from "../zarr/chunkStore.ts";
import { ChunkStore } from "../zarr/chunkStore.ts";
import type { DatasetState, PendingChunkResolve } from "../types.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetCallbacks } from "./useDatasetSettings.ts";

interface Params {
  wasmReady: boolean;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  setWasmScene: React.Dispatch<React.SetStateAction<WasmScene | null>>;
  ensureScene: () => WasmScene;
  loopRef: React.RefObject<RenderLoop | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  pendingChunkRequests: React.RefObject<Map<string, PendingChunkResolve>>;
  datasetCallbacksRef: React.RefObject<DatasetCallbacks>;
  // From useDatasetSettings (called before)
  bumpLayerSettingsVersion: () => void;
  initLayerMaps: (id: string) => void;
  // From useDimensions (called before)
  setZ: React.Dispatch<React.SetStateAction<number>>;
  setC: React.Dispatch<React.SetStateAction<number>>;
  setT: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<React.SetStateAction<"2d" | "3d">>;
  // Lifted state (from App)
  setSelectedDatasetId: React.Dispatch<React.SetStateAction<string | null>>;
  setVolumeMap: React.Dispatch<React.SetStateAction<Map<string, VolumeData>>>;
  bumpDatasetsVersion: () => void;
  bumpRemoteDocumentVersion: () => void;
}

export function useBridge({
  wasmReady,
  wasmSceneRef,
  setWasmScene,
  ensureScene,
  loopRef,
  datasetsRef,
  pendingChunkRequests,
  datasetCallbacksRef,
  bumpLayerSettingsVersion,
  initLayerMaps,
  setZ,
  setC,
  setT,
  setViewMode,
  setSelectedDatasetId,
  setVolumeMap,
  bumpDatasetsVersion,
  bumpRemoteDocumentVersion,
}: Params) {
  const bridgeRef = useRef<Bridge | null>(null);
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);
  const followTargetRef = useRef<ClientId | null>(null);
  followTargetRef.current = followTarget;
  const [remoteDatasetLoading, setRemoteDatasetLoading] = useState(false);
  const [remoteDatasetError, setRemoteDatasetError] = useState<string | null>(null);

  useEffect(() => {
    if (!wasmReady || bridgeRef.current) return;

    const handlers: BridgeHandlers = {
      onSnapshot: (_seq, documentJson, snapshotPeers, yourId) => {
        try {
          const scene = ensureScene();
          scene.load_document(documentJson);
          setMyId(yourId);

          const peerMap = new Map<ClientId, PresenceState>();
          for (const peer of snapshotPeers) {
            if (peer.client_id !== yourId) {
              peerMap.set(peer.client_id, peer);
            }
          }
          setPeers(peerMap);

          const doc = JSON.parse(documentJson);
          if (doc.datasets) {
            for (const ds of doc.datasets) {
              if (ds.client_metadata && !datasetsRef.current.has(ds.id)) {
                setupRemoteDataset(ds.id, ds.name ?? ds.id, ds.client_metadata);
              }
            }
          }

          bumpRemoteDocumentVersion();
          bumpDatasetsVersion();
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
              scene = ensureScene();
            } else {
              return;
            }
          }
          scene.apply_command(commandJson);
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "add_dataset" && cmd.client_metadata) {
            if (!datasetsRef.current.has(cmd.id)) {
              setupRemoteDataset(cmd.id, cmd.name ?? cmd.id, cmd.client_metadata);
            }
            setRemoteDatasetLoading(false);
            setWasmScene(scene);
          }
          if (cmd.type === "remove_dataset") {
            datasetCallbacksRef.current.removeDataset(cmd.id);
          }
          bumpRemoteDocumentVersion();
        } catch (e) {
          console.warn("[Bridge] bad command:", e);
        }
      },
      onAck: (_seq) => {},
      onChunkFetch: (clientId, datasetId, key) => {
        serveChunkFetch(clientId, datasetId, key);
      },
      onChunkData: (key, data) => {
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
        if (followTargetRef.current === clientId) {
          setFollowTarget(null);
        }
      },
      onPresenceUpdate: (clientId, camera, view, display) => {
        setPeers(prev => {
          const next = new Map(prev);
          const existing = next.get(clientId);
          if (existing) {
            next.set(clientId, { ...existing, camera, view, display });
          }
          return next;
        });
        if (followTargetRef.current === clientId) {
          const scene = wasmSceneRef.current;
          if (scene) {
            try {
              const presenceJson = JSON.stringify({ camera, view, display });
              scene.import_presence(presenceJson);
              setZ(scene.z());
              setT(scene.t());
              setC(scene.c());
              setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
              loopRef.current?.markDirty();
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
                  setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
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
        if (clientId === myId) {
          setFollowTarget(target);
        }
      },
      onDatasetPresenceUpdate: (clientId, datasetOrder, datasetSettings) => {
        setPeers(prev => {
          const next = new Map(prev);
          const existing = next.get(clientId);
          if (existing) {
            next.set(clientId, { ...existing, dataset_order: datasetOrder, dataset_settings: datasetSettings });
          }
          return next;
        });
        if (followTargetRef.current === clientId) {
          const scene = wasmSceneRef.current;
          if (scene) {
            try {
              const json = JSON.stringify({ dataset_order: datasetOrder, dataset_settings: datasetSettings });
              scene.import_dataset_presence(json);
              bumpLayerSettingsVersion();
              loopRef.current?.markDirty();
            } catch (e) {
              console.warn("[Bridge] failed to import dataset presence:", e);
            }
          }
        }
      },
      onOpenDatasetFailed: (_url, error) => {
        setRemoteDatasetLoading(false);
        setRemoteDatasetError(error);
      },
      onDisconnect: () => {
        setRemoteDatasetLoading(false);
        for (const [, pending] of pendingChunkRequests.current) {
          pending.reject(new Error("Bridge disconnected"));
        }
        pendingChunkRequests.current.clear();
      },
    };
    bridgeRef.current = new Bridge(handlers);
  }, [wasmReady]);

  function setupRemoteDataset(datasetId: string, name: string, clientMetadata: DatasetInfo) {
    const info = clientMetadata;
    const CHUNK_TIMEOUT_MS = 10_000;

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

      if (rawBytes.byteLength === 0) {
        return rawBytes;
      }

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

    initLayerMaps(datasetId);
    loopRef.current?.addDataset(datasetId, store, info);

    const coarsest = info.levels[info.levels.length - 1];
    const [, , depth, height, width] = coarsest.shape;
    setVolumeMap(prev => {
      const next = new Map(prev);
      next.set(datasetId, { data: new Uint16Array(width * height * depth), width, height, depth });
      return next;
    });

    if (datasetsRef.current.size === 1) {
      setSelectedDatasetId(datasetId);
    }

    bumpDatasetsVersion();
  }

  function sendEmptyChunkResponse(clientId: number, datasetId: string, key: string) {
    const compositeKey = `${datasetId}/${key}`;
    const keyBytes = new TextEncoder().encode(compositeKey);
    const headerSize = 4 + 2 + keyBytes.length;
    const message = new Uint8Array(headerSize);
    const view = new DataView(message.buffer);
    view.setUint32(0, clientId, true);
    view.setUint16(4, keyBytes.length, true);
    message.set(keyBytes, 6);
    bridgeRef.current?.sendBinary(message);
  }

  async function serveChunkFetch(clientId: number, datasetId: string, key: string) {
    const ds = datasetsRef.current.get(datasetId);
    if (!ds || !ds.fileIndex) {
      sendEmptyChunkResponse(clientId, datasetId, key);
      return;
    }

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

    const path = `${levelMeta.path}/c/${t}/${c}/${z}/${y}/${x}`;
    const file = ds.fileIndex.get(path);
    if (!file) {
      sendEmptyChunkResponse(clientId, datasetId, key);
      return;
    }

    try {
      const rawBytes = await file.arrayBuffer();
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

  const sendCommand = useCallback((json: string) => {
    bridgeRef.current?.sendCommand(json);
  }, []);

  const emitPresence = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    bridgeRef.current?.sendPresence(scene.export_presence());
  }, [wasmSceneRef]);

  const emitDatasetPresence = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    bridgeRef.current?.sendDatasetPresence(scene.export_dataset_presence());
  }, [wasmSceneRef]);

  const sendCursor = useCallback((position: [number, number] | null) => {
    bridgeRef.current?.sendCursor(position);
  }, []);

  const sendOpenRemoteDataset = useCallback((url: string) => {
    setRemoteDatasetLoading(true);
    setRemoteDatasetError(null);
    bridgeRef.current?.sendOpenRemoteDataset(url);
  }, []);

  const breakFollow = useCallback(() => {
    if (followTargetRef.current !== null) {
      setFollowTarget(null);
      bridgeRef.current?.sendFollow(null);
    }
  }, []);

  const handleFollow = useCallback((targetId: ClientId | null) => {
    if (targetId === myId) return;
    setFollowTarget(targetId);
    bridgeRef.current?.sendFollow(targetId);
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
            if (peer.dataset_order && peer.dataset_settings) {
              try {
                const layerJson = JSON.stringify({
                  dataset_order: peer.dataset_order,
                  dataset_settings: peer.dataset_settings,
                });
                scene.import_dataset_presence(layerJson);
                bumpLayerSettingsVersion();
              } catch (e) {
                console.warn("Failed to import peer dataset presence:", e);
              }
            }
            setZ(scene.z());
            setT(scene.t());
            setC(scene.c());
            setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
            loopRef.current?.markDirty();
          } catch (e) {
            console.warn("Failed to import peer presence:", e);
          }
        }
      }
    }
  }, [peers, myId, wasmSceneRef, loopRef, setZ, setC, setT, setViewMode, bumpLayerSettingsVersion]);

  const followablePeers = Array.from(peers.entries())
    .filter(([, p]) => p.following === null || p.following === undefined);

  return {
    bridgeRef,
    peers,
    myId,
    followTarget,
    followTargetRef,
    sendCommand,
    sendCursor,
    emitPresence,
    emitDatasetPresence,
    sendOpenRemoteDataset,
    remoteDatasetLoading,
    remoteDatasetError,
    breakFollow,
    handleFollow,
    followablePeers,
  };
}
