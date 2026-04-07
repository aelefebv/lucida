import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Bridge, type BridgeHandlers, type ClientId, type PresenceState } from "../bridge.ts";
import { decompressLz4Async } from "../zarr/lz4Client.ts";
import { decompress as decompressZstd } from "fzstd";
import type { ChunkFetcher } from "../zarr/chunkStore.ts";
import { SharedChunkQueue } from "../zarr/chunkStore.ts";
import type { DatasetState, DatasetMember, PendingChunkResolve } from "../types.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";
import type { VolumeData } from "../types.ts";
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
                const members: DatasetMember[] = (ds.members ?? []).length > 0
                  ? ds.members.map((m: { id: string; position: [number, number]; store_prefix: string | null }) => ({
                      id: m.id,
                      position: m.position,
                      storePrefix: m.store_prefix ?? null,
                    }))
                  : [{ id: ds.id, position: [0, 0] as [number, number], storePrefix: null }];
                setupRemoteDataset(ds.id, ds.name ?? ds.id, ds.client_metadata, members, ds.kind);
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
          bumpSettingsGeneration();
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "add_dataset" && cmd.client_metadata) {
            if (!datasetsRef.current.has(cmd.id)) {
              const members: DatasetMember[] = (cmd.members ?? []).length > 0
                ? cmd.members.map((m: { id: string; position: [number, number]; store_prefix: string | null }) => ({
                    id: m.id,
                    position: m.position,
                    storePrefix: m.store_prefix ?? null,
                  }))
                : [{ id: cmd.id, position: [0, 0] as [number, number], storePrefix: null }];
              setupRemoteDataset(cmd.id, cmd.name ?? cmd.id, cmd.client_metadata, members, cmd.kind);
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
              loopRef.current?.markViewDirty();
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
                  loopRef.current?.markViewDirty();
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
              bumpSettingsGeneration();
              bumpLayerSettingsVersion();
              loopRef.current?.markViewDirty();
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

  function setupRemoteDataset(datasetId: string, name: string, clientMetadata: DatasetInfo, members: DatasetMember[], kind?: Record<string, unknown>) {
    const info = clientMetadata;
    const CHUNK_TIMEOUT_MS = 10_000;

    const sharedQueue = new SharedChunkQueue();
    for (const member of members) {
      const remoteFetcher: ChunkFetcher = async (coord, signal) => {
        const compositeKey = member.storePrefix
          ? `${datasetId}/${member.storePrefix}/${coord.key}`
          : `${datasetId}/${coord.key}`;
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
            store_prefix: member.storePrefix ?? undefined,
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
          const hasZstd = levelMeta.codecs.some(c => c.name === "zstd");
          const hasLz4 = levelMeta.codecs.some(c => c.name === "numcodecs/lz4");
          if (hasZstd) {
            const dec = decompressZstd(new Uint8Array(rawBytes));
            return dec.buffer.slice(dec.byteOffset, dec.byteOffset + dec.byteLength);
          } else if (hasLz4) {
            return decompressLz4Async(rawBytes);
          }
        }
        return rawBytes;
      };

      sharedQueue.registerMember(member.id, remoteFetcher);
    }

    datasetsRef.current.set(datasetId, {
      id: datasetId,
      name,
      info,
      sharedQueue,
      kind: kind?.type === "plate" ? kind as unknown as import("../components/PlateSelector.tsx").PlateKind : undefined,
      members,
    });

    initLayerMaps(datasetId);
    loopRef.current?.addDataset(datasetId, sharedQueue, info);

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
                bumpSettingsGeneration();
                bumpLayerSettingsVersion();
              } catch (e) {
                console.warn("Failed to import peer dataset presence:", e);
              }
            }
            setZ(scene.z());
            setT(scene.t());
            setC(scene.c());
            setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
            loopRef.current?.markViewDirty();
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
