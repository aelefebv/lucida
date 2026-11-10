/**
 * Peer cursors: their geometry on the GPU and their labels over the canvas.
 *
 * Every peer cursor or presence message changes the peers, so this layer
 * subscribes to them itself and keeps the projected labels too. Neither a
 * message nor placing its labels renders the viewer around it.
 */
import { memo, useEffect, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { useEngine } from "../engine.ts";
import { requestRender } from "../invalidation.ts";
import { usePeerState, type PeerStore } from "../peerStore.ts";
import type { ViewMode } from "../types.ts";
import { PeerCursors, type CursorLabel } from "./PeerCursors.tsx";
import type { ViewSurface } from "./cameraProjection.ts";

interface Props {
  peerStore: PeerStore;
  viewMode: ViewMode;
  z: number;
  t: number;
  wasmSceneRef: RefObject<WasmScene | null>;
  /** The client and scene become readable when these turn true. */
  clientReady: boolean;
  wasmReady: boolean;
  /** Changes when a panel moves the canvas edges, so the labels re-project. */
  canvasSize: unknown;
  /** The view the labels sit over, and the element over its rectangle. */
  surface: ViewSurface;
}

function PeerCursorLayerBody({
  peerStore,
  viewMode,
  z,
  t,
  wasmSceneRef,
  clientReady,
  wasmReady,
  canvasSize,
  surface,
}: Props) {
  const engine = useEngine();
  const { peers, myId, followTarget } = usePeerState(peerStore);
  const [cursorLabels, setCursorLabels] = useState<CursorLabel[]>([]);

  useEffect(() => {
    const client = engine.client();
    const scene = engine.scene();
    if (!client || !scene) return;
    if (peers.size === 0) {
      client.updateCursorData(new Float32Array(0), 0);
      // The peers map is the external state this syncs to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCursorLabels([]);
      return;
    }

    const peerList = Array.from(peers.values())
      .filter((p) => {
        if (p.cursor !== null) return true;
        // Hide a defaulted cursor for a peer in a follow relationship with us.
        return !(p.following === myId || followTarget === p.client_id);
      })
      .map((p) => {
        const mode = (p.camera as { mode?: string })?.mode ?? "slice";
        if (p.cursor === null) {
          const center = mode === "slice"
            ? (p.camera as { center?: [number, number] })?.center ?? [0, 0]
            : [0.5, 0.5];
          return { id: p.client_id, cursor: center, mode, camera: p.camera, view_z: p.view?.z_range?.start, label_only: true };
        }
        return { id: p.client_id, cursor: p.cursor, mode, camera: p.camera, view_z: p.view?.z_range?.start, label_only: false };
      });
    const dpr = window.devicePixelRatio || 1;
    const screenW = Math.round(surface.element.clientWidth * dpr);
    const screenH = Math.round(surface.element.clientHeight * dpr);
    const result = JSON.parse(scene.compute_peer_cursors(JSON.stringify(peerList), myId, screenW, screenH)) as {
      gpu: number[][];
      labels: CursorLabel[];
    };

    if (result.gpu.length > 0) {
      const flat = new Float32Array(result.gpu.length * 16);
      for (let i = 0; i < result.gpu.length; i++) {
        flat.set(result.gpu[i], i * 16);
      }
      client.updateCursorData(flat, result.gpu.length);
    } else {
      client.updateCursorData(new Float32Array(0), 0);
    }

    setCursorLabels(result.labels);
    requestRender(engine.loop(), "peer_cursors");
  }, [engine, peers, myId, followTarget, viewMode, clientReady, wasmReady, canvasSize, surface]);

  if (peers.size === 0 || !engine.scene()) return null;
  return (
    <PeerCursors
      peers={peers}
      myId={myId}
      followTarget={followTarget}
      wasmSceneRef={wasmSceneRef}
      surface={surface}
      viewMode={viewMode}
      z={z}
      t={t}
      cursorLabels={cursorLabels}
    />
  );
}

export const PeerCursorLayer = memo(PeerCursorLayerBody);
