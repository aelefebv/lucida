import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type {
  Bridge,
  ClientId,
  CommandRejection,
  DatasetImportWarning,
  PresenceState,
} from "../bridge.ts";
export type { Bridge } from "../bridge.ts";
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { SessionController } from "../sessionController.ts";
export type { SavedViewBridgeHooks } from "../sessionController.ts";
import type { SavedViewBridgeHooks, ViewportSize } from "../sessionController.ts";
import type { DatasetCallbacks } from "./useDatasetSettings.ts";
import { toast } from "../ui/toastQueue.ts";

const COMMAND_REJECTION_TEXT: Record<CommandRejection, string> = {
  forbidden: "Your role in this workspace can't make this change.",
  invalid: "It refers to something the workspace no longer has.",
  unavailable: "The server couldn't save it. Try again.",
};

/** One toast covers a run of refusals, such as every step of a drag while
 *  the server can't save. Matches the toast's own minimum timeout. */
const COMMAND_REJECTION_TOAST_INTERVAL_MS = 5000;

interface Params {
  workspaceId: string;
  wasmReady: boolean;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  setWasmScene: React.Dispatch<React.SetStateAction<WasmScene | null>>;
  ensureScene: () => WasmScene;
  loopRef: React.RefObject<RenderLoop | null>;
  /** The viewer canvas, measured for the auto-fit on open. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  datasetCallbacksRef: React.RefObject<DatasetCallbacks>;
  /** Populated by the SavedView applier after construction, so it can resolve
   * pending opens without the session layer owning applier types. */
  savedViewHooksRef?: React.RefObject<SavedViewBridgeHooks | null>;
  /** Told when a session is built and when it is torn down, before the
   *  render that follows either. */
  onSessionChanged?: (session: Session | null) => void;
  // From useDatasetSettings (called before)
  bumpLayerSettingsVersion: () => void;
  initLayerMaps: (id: string) => void;
  // Lifted state (from App)
  setSelectedDatasetId: React.Dispatch<React.SetStateAction<string | null>>;
  bumpDatasetsVersion: () => void;
  bumpRemoteDocumentVersion: () => void;
  onWorkspaceArchived?: () => void;
}

/**
 * React adapter over `SessionController`, which owns the connection stack. This
 * hook builds one controller per mount, mirrors its events into React state, and
 * exposes stable callbacks that delegate to the live controller.
 *
 * The effect's create/destroy pair is complete, so a StrictMode remount builds
 * a fresh stack on a fresh WebSocket. An extra re-run costs a reconnect, never
 * correctness.
 */
export function useBridge(params: Params) {
  const { workspaceId, wasmReady } = params;

  // The bootstrap effect depends only on wasm readiness and workspace, so the
  // controller reaches every other host value through this ref. The
  // every-render effect below commits before the bootstrap effect on the same
  // pass.
  const portsRef = useRef(params);
  useEffect(() => {
    portsRef.current = params;
  });

  const controllerRef = useRef<SessionController | null>(null);
  const sessionRef = useRef<Session | null>(null);
  /** State, not a ref, so consumers re-run their effects once the bridge
   *  exists. */
  const [bridge, setBridge] = useState<Bridge | null>(null);
  // `Boolean(bridge)` is not readiness: the bridge exists while its WebSocket is
  // still CONNECTING, and `Bridge.send` silently drops frames before OPEN.
  // `connected` flips on `onopen`, `sessionReady` on the first snapshot. A
  // one-shot send such as the seed open gates on `sessionReady`. Both reset on
  // disconnect so a reconnect re-arms them.
  const [connected, setConnected] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [peers, setPeers] = useState<Map<ClientId, PresenceState>>(new Map());
  const [myId, setMyId] = useState<ClientId>(0);
  const [followTarget, setFollowTarget] = useState<ClientId | null>(null);
  // For readers outside render, such as RAF loops. Written from the controller
  // event, never during render.
  const followTargetRef = useRef<ClientId | null>(null);
  const [remoteDatasetLoading, setRemoteDatasetLoading] = useState(false);
  const [remoteDatasetError, setRemoteDatasetError] = useState<string | null>(null);
  const [remoteDatasetProgress, setRemoteDatasetProgress] = useState<string | null>(null);
  const [remoteDatasetWarnings, setRemoteDatasetWarnings] = useState<readonly string[]>([]);
  const [remoteDatasetWarningsOverflow, setRemoteDatasetWarningsOverflow] = useState(0);
  const [datasetImportWarnings, setDatasetImportWarnings] = useState<
    ReadonlyMap<string, readonly DatasetImportWarning[]>
  >(() => new Map());

  useEffect(() => {
    if (!wasmReady || controllerRef.current) return;

    let lastRejectionToastAt = -Infinity;
    const controller = new SessionController({
      workspaceId,
      ensureScene: () => portsRef.current.ensureScene(),
      getScene: () => portsRef.current.wasmSceneRef.current,
      getLoop: () => portsRef.current.loopRef.current,
      getViewportSize: () => canvasDeviceSize(portsRef.current.canvasRef.current),
      // The map identity is stable for the App's life; the controller owns
      // its contents and clears them on destroy.
      datasets: portsRef.current.datasetsRef.current,
      removeDatasetLocal: (id) =>
        portsRef.current.datasetCallbacksRef.current.removeDataset(id),
      getSavedViewHooks: () => portsRef.current.savedViewHooksRef?.current ?? null,
      bumpLayerSettingsVersion: () => portsRef.current.bumpLayerSettingsVersion(),
      initLayerMaps: (id) => portsRef.current.initLayerMaps(id),
      setSelectedDatasetId: (id) => portsRef.current.setSelectedDatasetId(id),
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
        onCommandRejected: (reason) => {
          const now = Date.now();
          if (now - lastRejectionToastAt < COMMAND_REJECTION_TOAST_INTERVAL_MS) return;
          lastRejectionToastAt = now;
          toast({
            title: "Change not saved",
            description: COMMAND_REJECTION_TEXT[reason],
            tone: "warning",
          });
        },
        onDatasetImportWarnings: setDatasetImportWarnings,
      },
    });
    controllerRef.current = controller;
    sessionRef.current = controller.session;
    portsRef.current.onSessionChanged?.(controller.session);
    setBridge(controller.bridge);

    return () => {
      controller.destroy();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      if (sessionRef.current === controller.session) {
        sessionRef.current = null;
        portsRef.current.onSessionChanged?.(null);
      }
      // Reset connection-scoped state in case this hook instance survives the
      // teardown (a StrictMode remount). No-ops on a real unmount.
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
      setDatasetImportWarnings(new Map());
      portsRef.current.bumpDatasetsVersion();
    };
  }, [wasmReady, workspaceId]);

  // Each callback reads the live controller at call time, so identity survives
  // renders and reconnects. All no-op before wasm is ready.
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

  const followablePeers = useMemo(
    () => Array.from(peers.entries()).filter(([, p]) => p.following === null || p.following === undefined),
    [peers],
  );

  // One object per change of the state in it, so a consumer keyed on it
  // re-runs only when that state moved. The callbacks never change.
  return useMemo(() => ({
    sessionRef,
    /** Non-null while the WebSocket may still be CONNECTING, so it is not a
     *  readiness signal. Use `connected` or `sessionReady` for that. */
    bridge,
    /** True once the WebSocket is OPEN. Resets on disconnect. */
    connected,
    /** True once the first snapshot is applied, so an open reliably reaches
     *  the server. Gate one-shot sends on this. Resets on disconnect. */
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
    /** Non-fatal import warnings that outlive the open. Cleared by dismiss, by
     *  a failed open (its own warnings only), or by connection loss. Capped for
     *  display. */
    remoteDatasetWarnings,
    /** Distinct warnings dropped by the display cap, so the banner can say
     *  "+N more" instead of hiding a flood. */
    remoteDatasetWarningsOverflow,
    dismissRemoteDatasetWarnings,
    /** Each dataset's import warnings by dataset id, however the dataset
     *  arrived. Unlike `remoteDatasetWarnings`, never dismissed. */
    datasetImportWarnings,
    breakFollow,
    handleFollow,
    followablePeers,
  }), [
    bridge, connected, sessionReady, peers, myId, followTarget,
    sendCommand, sendCursor, emitPresence, emitDatasetPresence, sendOpenRemoteDataset,
    remoteDatasetLoading, remoteDatasetError, remoteDatasetProgress,
    remoteDatasetWarnings, remoteDatasetWarningsOverflow, dismissRemoteDatasetWarnings,
    datasetImportWarnings, breakFollow, handleFollow, followablePeers,
  ]);
}

/**
 * The canvas's size in device pixels, rounded as the render paths round it, or
 * null while it has no layout box.
 */
function canvasDeviceSize(canvas: HTMLCanvasElement | null): ViewportSize | null {
  if (!canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  return {
    width: Math.round(canvas.clientWidth * dpr),
    height: Math.round(canvas.clientHeight * dpr),
    pixelRatio: dpr,
  };
}
