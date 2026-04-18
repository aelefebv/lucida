import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Bridge, type BridgeHandlers, type ClientId, type PresenceState } from "../bridge.ts";
import type { DatasetState } from "../types.ts";
import type { DatasetManifest, FetchSource } from "../manifestTypes.ts";
import { DecodePool } from "../pipeline/decodePool.ts";
import { ProxiedContentSource } from "../pipeline/contentSource.ts";
import { CpuCache } from "../pipeline/cpuCache.ts";
import { derivedBuildersFor } from "../pipeline/layoutBuilders.ts";
import { Session } from "../session.ts";
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
  const sessionRef = useRef<Session | null>(null);
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);
  const followTargetRef = useRef<ClientId | null>(null);
  followTargetRef.current = followTarget;
  const [remoteDatasetLoading, setRemoteDatasetLoading] = useState(false);
  const [remoteDatasetError, setRemoteDatasetError] = useState<string | null>(null);

  useEffect(() => {
    if (!wasmReady || sessionRef.current) return;

    const decodePool = new DecodePool();
    const contentSource = new ProxiedContentSource(
      (json) => sessionRef.current?.bridge.send(json),
    );
    const cpuCache = new CpuCache(contentSource, decodePool);

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

          sessionRef.current?.setScene(scene);

          const doc = JSON.parse(documentJson);
          if (doc.manifests) {
            for (const [dsId, manifest] of Object.entries(doc.manifests as Record<string, DatasetManifest>)) {
              if (!datasetsRef.current.has(dsId)) {
                // For snapshots, we don't have the fetch source.
                // Build a proxied source from the manifest's images.
                const fetchDesc: FetchSource = {
                  Proxied: {
                    images: (manifest as DatasetManifest).images.map(img => ({
                      image_id: img.image_id,
                      wire_format: { Raw: { data_type: img.multiscale.data_type } },
                    })),
                  },
                };
                setupFetchPipeline(manifest as DatasetManifest, fetchDesc);
              }
              // Mirror the snapshot's asset catalog into the JS-side
              // AssetCatalog. `load_document` already parsed it on the
              // WASM side; this keeps the mirror consistent.
              const catalog = doc.asset_catalogs?.[dsId] ?? { entries: [] };
              sessionRef.current?.ensureAssetCatalog()?.applyInitial(dsId, catalog);

              // Auto-register browser-authored derived layouts and seed the
              // registry's active id from the snapshot's document state.
              // Re-registration is idempotent thanks to lucida-core's
              // RegisterLayout dedupe.
              const registry = sessionRef.current?.ensureLayoutRegistry();
              if (registry) {
                const sendCmd = (json: string) => sessionRef.current?.bridge.sendCommand(json);
                for (const spec of derivedBuildersFor(manifest as DatasetManifest)) {
                  registry.register(dsId, spec, sendCmd);
                }
                registry.refresh(dsId);
                const snapActive =
                  (doc.active_layout_ids as Record<string, string> | undefined)?.[dsId];
                const fallback = (manifest as DatasetManifest).default_layout_id;
                const activeId = snapActive ?? fallback;
                if (activeId) registry.setActiveLocal(dsId, activeId);
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
            if (cmd.type === "dataset_opened") {
              scene = ensureScene();
            } else {
              return;
            }
          }
          scene.apply_command(commandJson);
          bumpSettingsGeneration();
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "dataset_opened") {
            sessionRef.current?.setScene(scene);
            if (!datasetsRef.current.has(cmd.manifest.dataset_id)) {
              setupFetchPipeline(cmd.manifest as DatasetManifest, cmd.fetch as FetchSource);
            }
            // Mirror the initial catalog into the JS-side AssetCatalog so
            // Planning's snapshot view stays consistent with WASM. Empty
            // in S3; populated by S5 once the server actually sends data.
            const catalog = cmd.catalog ?? { entries: [] };
            sessionRef.current?.ensureAssetCatalog()?.applyInitial(cmd.manifest.dataset_id, catalog);

            // Auto-register browser-authored derived layouts. RegisterLayout
            // is idempotent in lucida-core (issue #425), so peers that
            // already registered the same id don't accumulate duplicates.
            const registry = sessionRef.current?.ensureLayoutRegistry();
            if (registry) {
              const sendCmd = (json: string) => sessionRef.current?.bridge.sendCommand(json);
              const manifest = cmd.manifest as DatasetManifest;
              for (const spec of derivedBuildersFor(manifest)) {
                registry.register(manifest.dataset_id, spec, sendCmd);
              }
              const activeId =
                manifest.default_layout_id ?? manifest.source_layouts[0]?.id;
              if (activeId) {
                registry.setActive(manifest.dataset_id, activeId, sendCmd);
              }
            }

            setRemoteDatasetLoading(false);
            setWasmScene(scene);
          }
          if (cmd.type === "remove_dataset") {
            datasetCallbacksRef.current.removeDataset(cmd.id);
            sessionRef.current?.ensureAssetCatalog()?.removeDataset(cmd.id);
            sessionRef.current?.ensureLayoutRegistry()?.removeDataset(cmd.id);
          }
          if (cmd.type === "register_layout" || cmd.type === "set_active_layout") {
            // Inbound layout broadcast: refresh the mirror so peers' changes
            // appear locally. setActiveLocal updates the active id without
            // re-broadcasting (the WASM side already applied via apply_command
            // above). markViewDirty so the GPU canvas re-renders without
            // requiring local user interaction.
            const registry = sessionRef.current?.ensureLayoutRegistry();
            if (registry && cmd.dataset_id) {
              registry.refresh(cmd.dataset_id);
              if (cmd.type === "set_active_layout" && cmd.layout_id) {
                registry.setActiveLocal(cmd.dataset_id, cmd.layout_id);
              }
              loopRef.current?.markViewDirty();
            }
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
      onProxyData: (key, data) => {
        contentSource.handleProxyData(key, data);
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
              sessionRef.current?.bridge.sendPresence(scene.export_presence());
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
                  sessionRef.current?.bridge.sendPresence(scene.export_presence());
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
      onAssetCatalogUpdate: (datasetId, deltaJson) => {
        try {
          const delta = JSON.parse(deltaJson);
          sessionRef.current?.ensureAssetCatalog()?.applyDelta(datasetId, delta);
        } catch (e) {
          console.warn("[Bridge] bad asset_catalog_update:", e);
        }
      },
      onDisconnect: () => {
        setRemoteDatasetLoading(false);
        contentSource.rejectAll();
      },
    };
    const bridge = new Bridge(handlers);
    sessionRef.current = new Session({ bridge, contentSource, cpuCache, decodePool });
  }, [wasmReady]);

  function setupFetchPipeline(manifest: DatasetManifest, fetchDesc: FetchSource) {
    const datasetId = manifest.dataset_id;

    if ("Proxied" in fetchDesc) {
      for (const spec of fetchDesc.Proxied.images) {
        sessionRef.current!.contentSource.registerImage(spec.image_id, spec.wire_format);
      }
    }

    datasetsRef.current.set(datasetId, {
      id: datasetId,
      name: manifest.name,
      manifest,
      fetch: fetchDesc,
    });

    initLayerMaps(datasetId);

    // Ensure per-channel settings exist for all channels.
    // DatasetOpened may only create 1 channel setting (layers.len() = 1),
    // but the real channel count is in the data shape.
    const firstImage = manifest.images[0];
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

    loopRef.current?.addDataset(datasetId, manifest);

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
    sessionRef.current?.bridge.sendCommand(json);
  }, []);

  const emitPresence = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    sessionRef.current?.bridge.sendPresence(scene.export_presence());
  }, [wasmSceneRef]);

  const emitDatasetPresence = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    sessionRef.current?.bridge.sendDatasetPresence(scene.export_dataset_presence());
  }, [wasmSceneRef]);

  const sendCursor = useCallback((position: [number, number] | null) => {
    sessionRef.current?.bridge.sendCursor(position);
  }, []);

  const sendOpenRemoteDataset = useCallback((url: string) => {
    setRemoteDatasetLoading(true);
    setRemoteDatasetError(null);
    sessionRef.current?.bridge.sendOpenRemoteDataset(url);
  }, []);

  const breakFollow = useCallback(() => {
    if (followTargetRef.current !== null) {
      setFollowTarget(null);
      sessionRef.current?.bridge.sendFollow(null);
    }
  }, []);

  const handleFollow = useCallback((targetId: ClientId | null) => {
    if (targetId === myId) return;
    setFollowTarget(targetId);
    sessionRef.current?.bridge.sendFollow(targetId);
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
    sessionRef,
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
