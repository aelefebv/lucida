import { useEffect, useRef, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { ClientId, PresenceState } from "../bridge.ts";

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
}

interface Props {
  peers: Map<ClientId, PresenceState>;
  myId: ClientId;
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

export function PeerCursors({ peers, myId, wasmSceneRef, canvas, viewMode, z, t, c, cursorLabels }: Props) {
  const labelRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const cursorLabelsRef = useRef(cursorLabels);
  cursorLabelsRef.current = cursorLabels;

  useEffect(() => {
    let rafId: number;

    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const canvasW = canvas.clientWidth;
        const canvasH = canvas.clientHeight;
        const localIs3d = viewModeRef.current === "3d";

        // Build a lookup from client_id → screen position from WASM labels
        const labelMap = new Map<number, { sx: number; sy: number }>();
        for (const lbl of cursorLabelsRef.current) {
          labelMap.set(lbl.id, lbl);
        }

        for (const [clientId, el] of labelRefs.current) {
          const peer = peersRef.current.get(clientId);
          if (!peer?.cursor) {
            el.style.display = "none";
            continue;
          }

          // Use WASM-computed label positions (handles all mode combinations)
          const lbl = labelMap.get(clientId);
          if (!lbl) {
            el.style.display = "none";
            continue;
          }

          let screenX: number, screenY: number;
          if (localIs3d) {
            // For 3D, use WASM-projected screen coords directly
            screenX = lbl.sx;
            screenY = lbl.sy;
          } else {
            // For 2D, recompute from voxel coords for smooth camera tracking
            const zoom = scene.zoom();
            const centerArr = scene.center();
            const [worldX, worldY] = peer.cursor;
            const peerIs3d = (peer.camera as { mode?: string })?.mode === "3d";
            if (peerIs3d) {
              // Cross-mode 3D→2D: use WASM-projected coords
              screenX = lbl.sx;
              screenY = lbl.sy;
            } else {
              screenX = (worldX - centerArr[0]) * zoom + canvasW / 2;
              screenY = (worldY - centerArr[1]) * zoom + canvasH / 2;
            }
          }

          if (screenX < -20 || screenX > canvasW + 20 || screenY < -20 || screenY > canvasH + 20) {
            el.style.display = "none";
          } else {
            el.style.display = "";
            el.style.transform = `translate(${screenX}px, ${screenY}px)`;
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas]);

  const peerEntries = Array.from(peers.entries()).filter(
    ([id, p]) => id !== myId && p.cursor !== null,
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
        zIndex: 5,
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
              style={{
                position: "absolute",
                left: 12,
                top: -8,
                fontSize: 11,
                fontFamily: "monospace",
                color: "white",
                backgroundColor: color,
                padding: "1px 4px",
                borderRadius: 3,
                whiteSpace: "nowrap",
                opacity: 0.9,
              }}
            >
              {clientId}{badge ? ` ${badge}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
