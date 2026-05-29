import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Bridge, bridgeLog, type BridgeHandlers, type ClientId, type PresenceState } from "../bridge.ts";
export type { Bridge } from "../bridge.ts";
import type { DatasetState } from "../types.ts";
import { Axis } from "../axes.ts";
import type { DatasetManifest, FetchSource } from "../manifestTypes.ts";
import { DecodePool, ProxiedContentSource, CpuCache } from "../pipeline/fetch/index.ts";
import type {
  WireGeneratedAvailabilityByDataset,
  WireGeneratedAvailabilityDelta,
  WireGeneratedAvailabilitySnapshot,
} from "../pipeline/generatedAvailability.ts";
import { derivedBuildersFor } from "../pipeline/layoutBuilders.ts";
import { Session } from "../session.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";
import type { DatasetCallbacks } from "./useDatasetSettings.ts";

/** Callback ref the SavedView applier registers into so it sees the
 * relevant lifecycle events without useBridge importing applier types
 * directly. Optional: when null, useBridge skips the call. */
export interface SavedViewBridgeHooks {
  onDatasetOpened: (datasetId: string) => void;
  onOpenDatasetFailed: (url: string, error: string) => void;
}

interface Params {
  workspaceId: string;
  wasmReady: boolean;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  setWasmScene: React.Dispatch<React.SetStateAction<WasmScene | null>>;
  ensureScene: () => WasmScene;
  loopRef: React.RefObject<RenderLoop | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  datasetCallbacksRef: React.RefObject<DatasetCallbacks>;
  /** Optional ref the SavedView applier populates after construction.
   * Lets the applier resolve its pending opens without useBridge owning
   * applier-specific types. */
  savedViewHooksRef?: React.RefObject<SavedViewBridgeHooks | null>;
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
  bumpDatasetsVersion: () => void;
  bumpRemoteDocumentVersion: () => void;
  onWorkspaceArchived?: () => void;
}

export function useBridge({
  workspaceId,
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
  savedViewHooksRef,
  bumpDatasetsVersion,
  bumpRemoteDocumentVersion,
  onWorkspaceArchived,
}: Params) {
  const sessionRef = useRef<Session | null>(null);
  /** Mirrors `sessionRef.current?.bridge` as React state so consumers
   *  (e.g. `useBookmarks` for `bookmark_changed` subscriptions) re-run
   *  effects when the bridge becomes available. The bridge is constructed
   *  once inside the wasm-ready effect; we set this state immediately
   *  after assigning `sessionRef.current`. */
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);
  // Mirror followTarget state into a ref for handlers that read it
  // outside their declaration closure (RAF loops, websocket callbacks).
  const followTargetRef = useRef<ClientId | null>(null);
  // eslint-disable-next-line react-hooks/refs
  followTargetRef.current = followTarget;
  const [remoteDatasetLoading, setRemoteDatasetLoading] = useState(false);
  const [remoteDatasetError, setRemoteDatasetError] = useState<string | null>(null);
  // Last open_remote_dataset.send timestamp (performance.now() ms). Used
  // to derive a round-trip on receipt. Approximate when concurrent opens
  // are in flight — overwritten by each send.
  const lastOpenSendTimeRef = useRef<number | null>(null);

  function applyGeneratedAvailabilitySnapshots(
    snapshots: WireGeneratedAvailabilityByDataset,
  ): void {
    for (const [datasetId, snapshot] of Object.entries(snapshots)) {
      applyGeneratedAvailabilitySnapshot(datasetId, snapshot);
    }
  }

  function applyGeneratedAvailabilitySnapshot(
    datasetId: string,
    snapshot: WireGeneratedAvailabilitySnapshot,
  ): void {
    const session = sessionRef.current;
    if (!session) return;
    session.generatedAvailability.applySnapshot(datasetId, snapshot);
    refreshRuntimeGeneratedManifest(datasetId);
  }

  function applyGeneratedAvailabilityDelta(
    datasetId: string,
    delta: WireGeneratedAvailabilityDelta,
  ): void {
    const session = sessionRef.current;
    if (!session) return;
    session.generatedAvailability.applyDelta(datasetId, delta);
    refreshRuntimeGeneratedManifest(datasetId);
  }

  function refreshRuntimeGeneratedManifest(datasetId: string): void {
    const session = sessionRef.current;
    const entry = datasetsRef.current.get(datasetId);
    if (!session || !entry) return;
    const merged = session.generatedAvailability.mergeManifest(datasetId, entry.manifest);
    datasetsRef.current.set(datasetId, { ...entry, manifest: merged });
    loopRef.current?.updateDatasetManifest(datasetId, merged);
    bumpDatasetsVersion();
    loopRef.current?.markResidencyDirty("generated_availability_update");
  }

  useEffect(() => {
    if (!wasmReady || sessionRef.current) return;

    const decodePool = new DecodePool();
    const contentSource = new ProxiedContentSource(
      (json) => sessionRef.current?.bridge.send(json),
    );
    const cpuCache = new CpuCache(contentSource, decodePool);

    const handlers: BridgeHandlers = {
      onSnapshot: (_seq, documentJson, snapshotPeers, yourId, generatedAvailability) => {
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
                // setupFetchPipeline is a hoisted function declaration below;
                // the forward reference works at runtime via JS hoisting and
                // is intentional (effect setup needs the helper, helper needs
                // closures over things declared between).
                // eslint-disable-next-line react-hooks/immutability
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
          applyGeneratedAvailabilitySnapshots(generatedAvailability);

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
            const fetchVariant = typeof cmd.fetch === "string"
              ? cmd.fetch
              : Object.keys(cmd.fetch ?? {})[0] ?? "unknown";
            const kind = typeof cmd.manifest?.kind === "string"
              ? cmd.manifest.kind
              : Object.keys(cmd.manifest?.kind ?? {})[0] ?? "unknown";
            const sendTime = lastOpenSendTimeRef.current;
            const roundTripMs = sendTime !== null
              ? +(performance.now() - sendTime).toFixed(1)
              : null;
            lastOpenSendTimeRef.current = null;
            bridgeLog("open_remote_dataset.received", {
              datasetId: cmd.manifest?.dataset_id,
              kind,
              fetchVariant,
              nImages: cmd.manifest?.images?.length ?? 0,
              roundTripMs,
            });
            sessionRef.current?.setScene(scene);
            const datasetId = cmd.manifest.dataset_id;
            if (!datasetsRef.current.has(datasetId)) {
              setupFetchPipeline(cmd.manifest as DatasetManifest, cmd.fetch as FetchSource);
            } else {
              bridgeLog("setup_fetch_pipeline.skipped_existing", { datasetId });
            }
            // Mirror the initial catalog into the JS-side AssetCatalog so
            // Planning's snapshot view stays consistent with WASM.
            const catalog = cmd.catalog ?? { entries: [] };
            sessionRef.current?.ensureAssetCatalog()?.applyInitial(cmd.manifest.dataset_id, catalog);

            // Auto-register browser-authored derived layouts. RegisterLayout
            // is idempotent in lucida-core, so peers that already registered
            // the same id don't accumulate duplicates.
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
            bridgeLog("open_remote_dataset.loading_clear", {
              datasetId: cmd.manifest?.dataset_id,
              reason: "success",
            });
            setWasmScene(scene);
            // Notify the saved-view applier (if registered) so its
            // pending-open promise resolves. Safe even when the open
            // wasn't applier-initiated — `notifyDatasetOpened` is a
            // no-op for ids it doesn't know.
            savedViewHooksRef?.current?.onDatasetOpened(cmd.manifest.dataset_id);
          }
          if (cmd.type === "remove_dataset") {
            datasetCallbacksRef.current.removeDataset(cmd.id);
            sessionRef.current?.ensureAssetCatalog()?.removeDataset(cmd.id);
            sessionRef.current?.generatedAvailability.removeDataset(cmd.id);
            sessionRef.current?.ensureLayoutRegistry()?.removeDataset(cmd.id);
          }
          if (cmd.type === "register_layout" || cmd.type === "set_active_layout") {
            // Inbound layout broadcast: refresh the mirror so peers' changes
            // appear locally. setActiveLocal updates the active id without
            // re-broadcasting (the WASM side already applied via apply_command
            // above). markInteractiveDirty so the GPU canvas re-renders without
            // requiring local user interaction.
            const registry = sessionRef.current?.ensureLayoutRegistry();
            if (registry && cmd.dataset_id) {
              registry.refresh(cmd.dataset_id);
              if (cmd.type === "set_active_layout" && cmd.layout_id) {
                registry.setActiveLocal(cmd.dataset_id, cmd.layout_id);
              }
              loopRef.current?.markInteractiveDirty();
            }
          }
          bumpRemoteDocumentVersion();
        } catch (e) {
          let cmdType: string | undefined;
          try {
            cmdType = JSON.parse(commandJson)?.type;
          } catch {
            // commandJson itself wasn't valid JSON — fall through with undefined
          }
          bridgeLog("apply_command.failed", {
            commandType: cmdType,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
      onAck: (_seq) => {},
      onBinary: (key, data) => {
        contentSource.handleBinary(key, data);
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
              loopRef.current?.markInteractiveDirty();
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
                  loopRef.current?.markInteractiveDirty();
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
              loopRef.current?.markInteractiveDirty();
            } catch (e) {
              console.warn("[Bridge] failed to import dataset presence:", e);
            }
          }
        }
      },
      onOpenDatasetFailed: (url, error) => {
        bridgeLog("open_remote_dataset.failed", { url, error });
        setRemoteDatasetLoading(false);
        setRemoteDatasetError(error);
        savedViewHooksRef?.current?.onOpenDatasetFailed(url, error);
      },
      onAssetCatalogUpdate: (datasetId, deltaJson) => {
        try {
          const delta = JSON.parse(deltaJson);
          sessionRef.current?.ensureAssetCatalog()?.applyDelta(datasetId, delta);
        } catch (e) {
          console.warn("[Bridge] bad asset_catalog_update:", e);
        }
      },
      onGeneratedAvailabilityUpdate: (datasetId, deltaJson) => {
        try {
          const delta = JSON.parse(deltaJson) as WireGeneratedAvailabilityDelta;
          applyGeneratedAvailabilityDelta(datasetId, delta);
        } catch (e) {
          console.warn("[Bridge] bad generated_availability_update:", e);
        }
      },
      onGeneratedChunkStatus: (datasetId, imageId, key, status, message) => {
        sessionRef.current?.contentSource.handleChunkStatus(
          datasetId,
          imageId,
          key,
          status,
          message,
        );
      },
      onWorkspaceArchived: () => {
        setRemoteDatasetLoading(false);
        contentSource.rejectAll();
        onWorkspaceArchived?.();
      },
      onDisconnect: () => {
        setRemoteDatasetLoading(false);
        contentSource.rejectAll();
      },
    };
    const bridge = new Bridge(handlers, undefined, workspaceId);
    sessionRef.current = new Session({ bridge, contentSource, cpuCache, decodePool });
    // Publish the bridge as React state so consumer hooks
    // (useBookmarks subscribes to `bookmark_changed`) can take a
    // dependency on it and run their subscribe effect once it's live.
    setBridge(bridge);
    // Intentionally minimal deps: this is the bridge bootstrap effect
    // that runs once when WASM is ready. Re-running on any of the
    // listed callback/ref/state-bumper deps would re-mount the entire
    // WebSocket session and tear down all in-flight downloads.
  }, [wasmReady]); // eslint-disable-line react-hooks/exhaustive-deps

  function setupFetchPipeline(manifest: DatasetManifest, fetchDesc: FetchSource) {
    const datasetId = manifest.dataset_id;
    const firstImage = manifest.images[0];
    const channelCount = firstImage?.multiscale.levels[0]?.shape[Axis.C] ?? 1; // [T, C, Z, Y, X]
    const fetchVariant = Object.keys(fetchDesc as object)[0] ?? "unknown";

    // Shape summary — mirrors the WASM-side `analyze_manifest_shape`
    // counts so a JS-only debugger can spot Plate vs. Single anomalies
    // without enabling the wasm category.
    const entityIds = new Set(manifest.entities.map(e => e.id));
    let nWells = 0;
    let nFields = 0;
    let nOrphans = 0;
    for (const e of manifest.entities) {
      if (e.kind === "Well") nWells++;
      else if (e.kind === "Field") {
        nFields++;
        if (e.parent !== null && !entityIds.has(e.parent)) nOrphans++;
      }
    }

    bridgeLog("setup_fetch_pipeline.start", {
      datasetId,
      kind: typeof manifest.kind === "string" ? manifest.kind : Object.keys(manifest.kind ?? {})[0] ?? "unknown",
      fetchVariant,
      nImages: manifest.images.length,
      channelCount,
      nWells,
      nFields,
      nOrphans,
      nLayouts: manifest.source_layouts.length,
      defaultLayoutId: manifest.default_layout_id,
    });

    const t0 = performance.now();

    let registeredImages = 0;
    if ("Proxied" in fetchDesc) {
      for (const spec of fetchDesc.Proxied.images) {
        sessionRef.current!.contentSource.registerImage(spec.image_id, spec.wire_format);
        registeredImages++;
      }
    } else {
      bridgeLog("setup_fetch_pipeline.fetch_variant_unsupported", {
        datasetId,
        fetchVariant,
      });
    }
    const t1 = performance.now();

    datasetsRef.current.set(datasetId, {
      id: datasetId,
      name: manifest.name,
      manifest,
      fetch: fetchDesc,
    });
    const t2 = performance.now();

    initLayerMaps(datasetId);
    const t3 = performance.now();

    // Ensure per-channel settings exist for all channels.
    // DatasetOpened may only create 1 channel setting (layers.len() = 1),
    // but the real channel count is in the data shape.
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
    const t4 = performance.now();

    if (loopRef.current) {
      loopRef.current.addDataset(datasetId, manifest);
    } else {
      bridgeLog("setup_fetch_pipeline.loop_not_ready", { datasetId });
    }
    const t5 = performance.now();

    if (datasetsRef.current.size === 1) {
      setSelectedDatasetId(datasetId);
    }

    bumpDatasetsVersion();

    bridgeLog("setup_fetch_pipeline.complete", {
      datasetId,
      registeredImages,
      channelCount,
      totalMs: +(t5 - t0).toFixed(1),
      stepsMs: {
        registerImages: +(t1 - t0).toFixed(2),
        datasetsRefSet: +(t2 - t1).toFixed(2),
        initLayerMaps: +(t3 - t2).toFixed(2),
        setChannelVisible: +(t4 - t3).toFixed(2),
        addDataset: +(t5 - t4).toFixed(2),
      },
    });
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
    lastOpenSendTimeRef.current = performance.now();
    bridgeLog("open_remote_dataset.loading_start", { url });
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
            loopRef.current?.markInteractiveDirty();
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
    /** Live bridge once the WS is constructed. `null` until the
     *  wasm-ready effect has run. */
    bridge,
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
