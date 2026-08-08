import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { Bridge, ClientId, PresenceState } from "../bridge.ts";
export type { Bridge } from "../bridge.ts";
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { SessionController } from "../sessionController.ts";
export type { SavedViewBridgeHooks } from "../sessionController.ts";
import type { SavedViewBridgeHooks } from "../sessionController.ts";
import type { DatasetCallbacks } from "./useDatasetSettings.ts";

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
   * Lets the applier resolve its pending opens without the session layer
   * owning applier-specific types. */
  savedViewHooksRef?: React.RefObject<SavedViewBridgeHooks | null>;
  // From useDatasetSettings (called before)
  bumpLayerSettingsVersion: () => void;
  initLayerMaps: (id: string) => void;
  // From useDimensions (called before)
  setZ: React.Dispatch<React.SetStateAction<number>>;
  setC: React.Dispatch<React.SetStateAction<number>>;
  setT: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<React.SetStateAction<"2d" | "3d">>;
  setMultiChannel: React.Dispatch<React.SetStateAction<boolean>>;
  // Lifted state (from App)
  setSelectedDatasetId: React.Dispatch<React.SetStateAction<string | null>>;
  bumpDatasetsVersion: () => void;
  bumpRemoteDocumentVersion: () => void;
  onWorkspaceArchived?: () => void;
}

/**
 * React adapter over [`SessionController`], which owns the whole connection
 * stack (DecodePool/ProxiedContentSource/CpuCache/Bridge/Session) and its
 * handler wiring. This hook only (a) constructs a controller per mount and
 * destroys it on cleanup, (b) mirrors controller events into React state,
 * and (c) exposes stable send/follow callbacks that delegate to the live
 * controller.
 *
 * StrictMode safety comes from the fresh-instance-per-mount pattern
 * the bootstrap effect's
 * create/destroy pair is complete, so mount → cleanup → mount builds a
 * brand-new stack against a fresh WebSocket rather than restarting a dead
 * one, and an extra effect re-run costs a reconnect, never correctness.
 */
export function useBridge(params: Params) {
  const { workspaceId, wasmReady } = params;

  // Latest host values for the controller. The bootstrap effect depends only
  // on session *identity* (wasm readiness + workspace), so the controller
  // reaches everything else through this ref — kept current by the passive
  // every-render effect below, which commits before the bootstrap effect on
  // the same pass (hook-internal effect order).
  const portsRef = useRef(params);
  useEffect(() => {
    portsRef.current = params;
  });

  const controllerRef = useRef<SessionController | null>(null);
  const sessionRef = useRef<Session | null>(null);
  /** Mirrors `controller.bridge` as React state so consumers (e.g.
   *  `useBookmarks` for `bookmark_changed` subscriptions) re-run effects when
   *  the bridge becomes available. Set immediately after construction. */
  const [bridge, setBridge] = useState<Bridge | null>(null);
  // REAL transport-readiness signals, distinct from `Boolean(bridge)` (which
  // flips synchronously when the Bridge is constructed, while its WebSocket is
  // still CONNECTING — and `Bridge.send` silently drops frames sent before
  // OPEN). `connected` flips on the WS `onopen`; `sessionReady` flips on the
  // first snapshot (the session is fully established and the document loaded).
  // Consumers that must not lose a one-shot send (e.g. the #697 seed open) gate
  // on `sessionReady` so the open reliably reaches the server. Both reset on
  // disconnect so a reconnect re-arms them.
  const [connected, setConnected] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);
  // Ref mirror of followTarget for consumers that read it outside render
  // (RAF loops). Written from the controller event, never during render.
  const followTargetRef = useRef<ClientId | null>(null);
  const [remoteDatasetLoading, setRemoteDatasetLoading] = useState(false);
  const [remoteDatasetError, setRemoteDatasetError] = useState<string | null>(null);
  const [remoteDatasetProgress, setRemoteDatasetProgress] = useState<string | null>(null);
  // Durable non-fatal import warnings collected across dataset opens. Unlike
  // `remoteDatasetProgress`, these survive open completion; they are cleared by
  // an explicit dismiss, a failed open (only that open's own), or connection
  // loss.
  const [remoteDatasetWarnings, setRemoteDatasetWarnings] = useState<readonly string[]>([]);
  // How many further distinct warnings occurred beyond the ones retained in
  // `remoteDatasetWarnings` (the display cap). Lets the banner render "+N more"
  // so a bounded list never hides that a flood happened. Reset alongside the
  // warnings themselves.
  const [remoteDatasetWarningsOverflow, setRemoteDatasetWarningsOverflow] = useState(0);

  useEffect(() => {
    if (!wasmReady || controllerRef.current) return;

    const controller = new SessionController({
      workspaceId,
      ensureScene: () => portsRef.current.ensureScene(),
      getScene: () => portsRef.current.wasmSceneRef.current,
      getLoop: () => portsRef.current.loopRef.current,
      // The map identity is stable for the life of the App instance; the
      // controller owns its contents (and clears them on destroy).
      datasets: portsRef.current.datasetsRef.current,
      removeDatasetLocal: (id) =>
        portsRef.current.datasetCallbacksRef.current.removeDataset(id),
      getSavedViewHooks: () => portsRef.current.savedViewHooksRef?.current ?? null,
      bumpLayerSettingsVersion: () => portsRef.current.bumpLayerSettingsVersion(),
      initLayerMaps: (id) => portsRef.current.initLayerMaps(id),
      setSelectedDatasetId: (id) => portsRef.current.setSelectedDatasetId(id),
      viewState: {
        setZ: (v) => portsRef.current.setZ(v),
        setC: (v) => portsRef.current.setC(v),
        setT: (v) => portsRef.current.setT(v),
        setViewMode: (mode) => portsRef.current.setViewMode(mode),
        setMultiChannel: (multi) => portsRef.current.setMultiChannel(multi),
      },
      events: {
        onConnectedChanged: setConnected,
        onSessionReadyChanged: setSessionReady,
        onSelfIdChanged: setMyId,
        onPeersChanged: setPeers,
        onFollowTargetChanged: (target) => {
          followTargetRef.current = target;
          setFollowTarget(target);
        },
        onRemoteDatasetActivity: (activity) => {
          setRemoteDatasetLoading(activity.loading);
          setRemoteDatasetError(activity.error);
          setRemoteDatasetProgress(activity.progress);
          setRemoteDatasetWarnings(activity.warnings);
          setRemoteDatasetWarningsOverflow(activity.warningsOverflow);
        },
        onSceneChanged: (scene) => portsRef.current.setWasmScene(scene),
        onDatasetsChanged: () => portsRef.current.bumpDatasetsVersion(),
        onRemoteDocumentChanged: () => portsRef.current.bumpRemoteDocumentVersion(),
        onWorkspaceArchived: () => portsRef.current.onWorkspaceArchived?.(),
      },
    });
    controllerRef.current = controller;
    sessionRef.current = controller.session;
    // Publish the bridge as React state so consumer hooks (useBookmarks
    // subscribes to `bookmark_changed`) can take a dependency on it and run
    // their subscribe effect once it's live.
    setBridge(controller.bridge);

    return () => {
      // Tear down the whole stack this effect's controller built (WebSocket +
      // timers, in-flight fetches, decode workers, dataset registry contents).
      controller.destroy();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      if (sessionRef.current === controller.session) {
        sessionRef.current = null;
      }
      // Reset connection-scoped React state so nothing from the dead stack is
      // consulted if this hook instance survives the teardown (dev StrictMode
      // mount→cleanup→mount; all no-ops on real unmount).
      setBridge(null);
      setConnected(false);
      setSessionReady(false);
      setPeers(new Map());
      setMyId(0);
      setFollowTarget(null);
      followTargetRef.current = null;
      setRemoteDatasetLoading(false);
      setRemoteDatasetError(null);
      setRemoteDatasetProgress(null);
      setRemoteDatasetWarnings([]);
      setRemoteDatasetWarningsOverflow(0);
      portsRef.current.bumpDatasetsVersion();
    };
  }, [wasmReady, workspaceId]);

  // Stable delegating callbacks: each reads the live controller at call time,
  // so identity never changes across renders or reconnect cycles. All no-op
  // before wasm is ready (no controller yet) — same as an unopened socket.
  const sendCommand = useCallback((json: string) => {
    controllerRef.current?.sendCommand(json);
  }, []);

  const emitPresence = useCallback(() => {
    controllerRef.current?.emitPresence();
  }, []);

  const emitDatasetPresence = useCallback(() => {
    controllerRef.current?.emitDatasetPresence();
  }, []);

  const sendCursor = useCallback((position: [number, number] | null) => {
    controllerRef.current?.sendCursor(position);
  }, []);

  const sendOpenRemoteDataset = useCallback((url: string) => {
    controllerRef.current?.openRemoteDataset(url);
  }, []);

  const breakFollow = useCallback(() => {
    controllerRef.current?.breakFollow();
  }, []);

  const handleFollow = useCallback((targetId: ClientId | null) => {
    controllerRef.current?.follow(targetId);
  }, []);

  const dismissRemoteDatasetWarnings = useCallback(() => {
    controllerRef.current?.dismissOpenWarnings();
  }, []);

  const followablePeers = Array.from(peers.entries())
    .filter(([, p]) => p.following === null || p.following === undefined);

  return {
    sessionRef,
    /** Live bridge once the WS is constructed. `null` until the
     *  wasm-ready effect has run. NOTE: this flips true while the WebSocket is
     *  still CONNECTING — it is NOT a transport-readiness signal. Use
     *  `connected` / `sessionReady` to know a send won't be dropped. */
    bridge,
    /** True once the WebSocket is OPEN (`onopen`) — `bridge.send` no longer
     *  silently drops. Resets on disconnect. */
    connected,
    /** True once the first snapshot has been applied: the session is fully
     *  established and an open reliably reaches the server. The robust gate for
     *  one-shot sends like the #697 seed open. Resets on disconnect. */
    sessionReady,
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
    remoteDatasetProgress,
    /** Durable non-fatal import warnings collected across opens. Stays
     *  populated after an open completes; cleared by
     *  `dismissRemoteDatasetWarnings`, a failed open (its own only), or
     *  connection loss. Capped for display; see `remoteDatasetWarningsOverflow`
     *  for how many further distinct warnings the cap elided. */
    remoteDatasetWarnings,
    /** Count of further distinct warnings beyond the retained
     *  `remoteDatasetWarnings` (the display cap). Zero unless a flood exceeded
     *  the cap; drives the banner's "+N more" affordance. */
    remoteDatasetWarningsOverflow,
    dismissRemoteDatasetWarnings,
    breakFollow,
    handleFollow,
    followablePeers,
  };
}
