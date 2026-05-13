import { useEffect, useRef, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { ClientId, PresenceState } from "../bridge.ts";
import { projectToCanvas } from "./minimapMath.ts";

const PEER_COLORS = [
  "#FF6B6B",
  "#4ECDC4",
  "#FFE66D",
  "#A8E6CF",
  "#FF8B94",
  "#B5EAD7",
  "#C7CEEA",
  "#F8B500",
];

function peerColor(clientId: ClientId): string {
  return PEER_COLORS[clientId % PEER_COLORS.length];
}

export interface CursorLabel {
  id: number;
  sx: number;
  sy: number;
  world?: [number, number, number];
  voxel?: [number, number];
}

interface Props {
  peers: Map<ClientId, PresenceState>;
  myId: ClientId;
  followTarget: ClientId | null;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  viewMode: "2d" | "3d";
  z: number;
  t: number;
  c: number;
  cursorLabels: CursorLabel[];
}

function dimBadge(peer: PresenceState, localZ: number, localT: number, localC: number, localIs3d: boolean): { dim: boolean; badge: string } {
  const view = peer.view as { z_range?: { start: number }; t?: number; c?: number } | null;
  if (!view) return { dim: false, badge: "" };

  const parts: string[] = [];
  let dim = false;

  // Z is a spatial axis in 3D — skip Z badge/dimming when local viewer is in 3D
  if (!localIs3d) {
    const peerZ = view.z_range?.start;
    if (peerZ !== undefined && peerZ !== localZ) {
      dim = true;
      parts.push(peerZ > localZ ? "▲" : "▼");
    }
  }

  const peerT = view.t;
  if (peerT !== undefined && peerT !== localT) {
    dim = true;
    parts.push(peerT > localT ? "►" : "◄");
  }

  const peerC = view.c;
  if (peerC !== undefined && peerC !== localC) {
    dim = true;
    parts.push(`C${peerC}`);
  }

  return { dim, badge: parts.join(" ") };
}

const EDGE_MARGIN = 16;

export function PeerCursors({ peers, myId, followTarget, wasmSceneRef, canvas, viewMode, z, t, c, cursorLabels }: Props) {
  const labelRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const chevronRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const chevronLabelRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const dotRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const namePillRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  // Mirror props into refs so the RAF tick below reads the latest values
  // each frame without stale closures and without re-running the effect on
  // every prop change. Mirror updates are render-phase, idempotent, and
  // never read during the same render they're written in — exactly the
  // pattern react-hooks/refs warns about but the canonical workaround.
  const peersRef = useRef(peers);
  // eslint-disable-next-line react-hooks/refs
  peersRef.current = peers;
  const viewModeRef = useRef(viewMode);
  // eslint-disable-next-line react-hooks/refs
  viewModeRef.current = viewMode;
  const cursorLabelsRef = useRef(cursorLabels);
  // eslint-disable-next-line react-hooks/refs
  cursorLabelsRef.current = cursorLabels;
  const followTargetRef = useRef(followTarget);
  // eslint-disable-next-line react-hooks/refs
  followTargetRef.current = followTarget;

  useEffect(() => {
    let rafId: number;

    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const dpr = devicePixelRatio;
        const canvasW = canvas.clientWidth;
        const canvasH = canvas.clientHeight;
        const physW = Math.round(canvasW * dpr);
        const physH = Math.round(canvasH * dpr);
        const localIs3d = viewModeRef.current === "3d";

        // Build a lookup from client_id → label data from WASM
        const labelMap = new Map<number, CursorLabel>();
        for (const lbl of cursorLabelsRef.current) {
          labelMap.set(lbl.id, lbl);
        }

        // Pre-compute camera data once per frame
        let vpMatrix: Float32Array | null = null;
        let zoom = 0, centerX = 0, centerY = 0;
        if (localIs3d) {
          vpMatrix = new Float32Array(scene.view_proj());
        } else {
          zoom = scene.zoom();
          const centerArr = scene.center();
          centerX = centerArr[0];
          centerY = centerArr[1];
        }

        for (const [clientId, el] of labelRefs.current) {
          const peer = peersRef.current.get(clientId);
          if (!peer) {
            el.style.display = "none";
            continue;
          }

          const lbl = labelMap.get(clientId);
          if (!lbl) {
            el.style.display = "none";
            continue;
          }

          const isDefaulted = peer.cursor === null;

          // Hide defaulted cursor for peers in a follow relationship with us
          if (isDefaulted && (peer.following === myId || followTargetRef.current === clientId)) {
            el.style.display = "none";
            continue;
          }

          let screenX: number, screenY: number;
          if (localIs3d) {
            // Re-project world coords with current VP matrix each frame
            if (lbl.world && vpMatrix) {
              const proj = projectToCanvas(vpMatrix, lbl.world[0], lbl.world[1], lbl.world[2], canvasW, canvasH);
              if (!proj) { el.style.display = "none"; continue; }
              [screenX, screenY] = proj;
            } else {
              screenX = lbl.sx;
              screenY = lbl.sy;
            }
          } else {
            if (lbl.voxel) {
              // 3D→2D: recompute from voxel coords for smooth camera tracking
              // zoom/center are in physical-pixel space; divide by DPR for CSS positioning
              screenX = ((lbl.voxel[0] - centerX) * zoom + physW / 2) / dpr;
              screenY = ((lbl.voxel[1] - centerY) * zoom + physH / 2) / dpr;
            } else {
              // 2D→2D: recompute from peer cursor or camera center
              const [worldX, worldY] = isDefaulted
                ? (peer.camera as { center?: [number, number] })?.center ?? [0, 0]
                : peer.cursor!;
              screenX = ((worldX - centerX) * zoom + physW / 2) / dpr;
              screenY = ((worldY - centerY) * zoom + physH / 2) / dpr;
            }
          }

          const chevronEl = chevronRefs.current.get(clientId);
          const chevronLabelEl = chevronLabelRefs.current.get(clientId);
          const dotEl = dotRefs.current.get(clientId);
          const namePillEl = namePillRefs.current.get(clientId);
          const offScreen = screenX < 0 || screenX > canvasW || screenY < 0 || screenY > canvasH;

          if (offScreen) {
            const clampedX = Math.max(EDGE_MARGIN, Math.min(screenX, canvasW - EDGE_MARGIN));
            const clampedY = Math.max(EDGE_MARGIN, Math.min(screenY, canvasH - EDGE_MARGIN));
            const angle = Math.atan2(screenY - clampedY, screenX - clampedX);
            const dist = Math.hypot(screenX - clampedX, screenY - clampedY);
            const scale = 0.25 + 1.25 * 300 / (300 + dist);

            el.style.display = "";
            el.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
            if (chevronEl) { chevronEl.style.display = ""; chevronEl.style.transform = `rotate(${angle}rad) scale(${scale})`; }
            if (chevronLabelEl) {
              chevronLabelEl.style.display = "";
              const ox = -Math.cos(angle) * 18 * scale - 8;
              const oy = -Math.sin(angle) * 18 * scale - 7;
              chevronLabelEl.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
            }
            if (dotEl) { dotEl.style.display = "none"; }
            if (namePillEl) { namePillEl.style.display = "none"; }
          } else {
            el.style.display = "";
            el.style.transform = `translate(${screenX}px, ${screenY}px)`;
            if (chevronEl) { chevronEl.style.display = "none"; }
            if (chevronLabelEl) { chevronLabelEl.style.display = "none"; }
            if (dotEl) { dotEl.style.display = isDefaulted ? "" : "none"; }
            if (namePillEl) { namePillEl.style.display = ""; }
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // myId, peers, etc. are read via the mirror refs above so the RAF tick
    // sees the latest values without re-mounting the loop on every change.
  }, [wasmSceneRef, canvas]); // eslint-disable-line react-hooks/exhaustive-deps

  const peerEntries = Array.from(peers.entries()).filter(
    ([id]) => id !== myId,
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 11,
      }}
    >
      {peerEntries.map(([clientId, peer]) => {
        const color = peerColor(clientId);
        const { dim, badge } = dimBadge(peer, z, t, c, viewMode === "3d");
        return (
          <div
            key={clientId}
            ref={(el) => {
              if (el) labelRefs.current.set(clientId, el);
              else labelRefs.current.delete(clientId);
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              display: "none",
              willChange: "transform",
              opacity: dim ? 0.5 : 1,
            }}
          >
            <div
              ref={(el) => {
                if (el) namePillRefs.current.set(clientId, el);
                else namePillRefs.current.delete(clientId);
              }}
              style={{
                position: "absolute",
                left: 12,
                top: -30,
                fontSize: 11,
                fontFamily: "monospace",
                color: "black",
                backgroundColor: color,
                padding: "1px 4px",
                borderRadius: 3,
                whiteSpace: "nowrap",
                opacity: 0.9,
              }}
            >
              {clientId}{badge ? ` ${badge}` : ""}
            </div>
            <div
              ref={(el) => {
                if (el) dotRefs.current.set(clientId, el);
                else dotRefs.current.delete(clientId);
              }}
              style={{
                position: "absolute",
                display: "none",
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: color,
                left: -4,
                top: -4,
                opacity: 0.9,
              }}
            />
            <div
              ref={(el) => {
                if (el) chevronRefs.current.set(clientId, el);
                else chevronRefs.current.delete(clientId);
              }}
              style={{
                position: "absolute",
                display: "none",
                width: 0,
                height: 0,
                borderLeft: `10px solid ${color}`,
                borderTop: "6px solid transparent",
                borderBottom: "6px solid transparent",
                transformOrigin: "center center",
                left: -5,
                top: -6,
              }}
            />
            <div
              ref={(el) => {
                if (el) chevronLabelRefs.current.set(clientId, el);
                else chevronLabelRefs.current.delete(clientId);
              }}
              style={{
                position: "absolute",
                display: "none",
                fontSize: 9,
                fontFamily: "monospace",
                color: "black",
                backgroundColor: color,
                padding: "0 2px",
                borderRadius: 2,
                lineHeight: "14px",
                whiteSpace: "nowrap",
              }}
            >
              {clientId}
            </div>
          </div>
        );
      })}
    </div>
  );
}
