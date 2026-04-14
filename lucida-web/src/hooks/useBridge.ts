import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Bridge, type BridgeHandlers, type ClientId, type PresenceState } from "../bridge.ts";
import type { ChunkFetcher } from "../zarr/chunkStore.ts";
import { SharedChunkQueue } from "../zarr/chunkStore.ts";
import type { DatasetState } from "../types.ts";
import type { ContentGraph, ClientFetchDescriptor } from "../contentTypes.ts";
import { DecodePool, extractDataType } from "../pipeline/decodePool.ts";
import { ProxiedContentSource } from "../pipeline/contentSource.ts";
import type { RenderLoop } from "../renderLoop.ts";

const decodePool = new DecodePool();
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
  const contentSourceRef = useRef<ProxiedContentSource | null>(null);
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);
  const followTargetRef = useRef<ClientId | null>(null);
  followTargetRef.current = followTarget;
  const [remoteDatasetLoading, setRemoteDatasetLoading] = useState(false);
  const [remoteDatasetError, setRemoteDatasetError] = useState<string | null>(null);

  useEffect(() => {
    if (!wasmReady || bridgeRef.current) return;

    const contentSource = new ProxiedContentSource(
      (json) => bridgeRef.current?.send(json),
    );
    contentSourceRef.current = contentSource;

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
          if (doc.content_graphs) {
            for (const [dsId, content] of Object.entries(doc.content_graphs as Record<string, ContentGraph>)) {
              if (!datasetsRef.current.has(dsId)) {
                // For snapshots, we don't have the fetch descriptor.
                // Build a proxied descriptor from the content graph's images.
                const fetchDesc: ClientFetchDescriptor = {
                  Proxied: {
                    images: (content as ContentGraph).images.map(img => ({
                      image_id: img.image_id,
                      wire_format: { Raw: { data_type: img.multiscale.data_type } },
                    })),
                  },
                };
                setupFetchPipeline(content as ContentGraph, fetchDesc);
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
            if (cmd.type === "register_dataset") {
              scene = ensureScene();
            } else {
              return;
            }
          }
          scene.apply_command(commandJson);
          bumpSettingsGeneration();
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "register_dataset") {
            if (!datasetsRef.current.has(cmd.content.dataset_id)) {
              setupFetchPipeline(cmd.content as ContentGraph, cmd.fetch as ClientFetchDescriptor);
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
        contentSource.handleChunkData(key, data);
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
        contentSource.rejectAll();
      },
    };
    bridgeRef.current = new Bridge(handlers);
  }, [wasmReady]);

  function setupFetchPipeline(content: ContentGraph, fetchDesc: ClientFetchDescriptor) {
    const datasetId = content.dataset_id;

    const sharedQueue = new SharedChunkQueue();

    if ("Proxied" in fetchDesc) {
      for (const spec of fetchDesc.Proxied.images) {
        const imageId = spec.image_id;
        const remoteFetcher: ChunkFetcher = async (coord, signal) => {
          const rawBytes = await contentSourceRef.current!.fetch(
            { datasetId, imageId, chunkKey: coord.key, wireFormat: spec.wire_format },
            signal ?? new AbortSignal(),
          );
          const dataType = extractDataType(spec.wire_format);
          return decodePool.decode(rawBytes, spec.wire_format, dataType);
        };

        sharedQueue.registerMember(imageId, remoteFetcher);
      }
    }

    datasetsRef.current.set(datasetId, {
      id: datasetId,
      name: content.name,
      content,
      fetch: fetchDesc,
      sharedQueue,
    });

    initLayerMaps(datasetId);

    // Ensure per-channel settings exist for all channels.
    // RegisterDataset may only create 1 channel setting (layers.len() = 1),
    // but the real channel count is in the data shape.
    const firstImage = content.images[0];
    const channelCount = firstImage?.multiscale.levels[0]?.shape[1] ?? 1; // [T, C, Z, Y, X]
    if (channelCount > 1) {
      const scene = wasmSceneRef.current;
      if (scene) {
        // Touch the last channel to grow the vec via ensure_channel
        scene.apply_command(JSON.stringify({
          type: "set_channel_visible",
          dataset_id: datasetId,
          channel: channelCount - 1,
          visible: true,
        }));
        bumpSettingsGeneration();
      }
    }

    loopRef.current?.addDataset(datasetId, sharedQueue, content);

    const coarsestLevel = firstImage?.multiscale.levels[firstImage.multiscale.levels.length - 1];
    if (coarsestLevel) {
      const [, , depth, height, width] = coarsestLevel.shape;
      setVolumeMap(prev => {
        const next = new Map(prev);
        next.set(datasetId, { data: new Uint16Array(width * height * depth), width, height, depth });
        return next;
      });
    }

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
    contentSourceRef,
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
