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

interface Props {
  peers: Map<ClientId, PresenceState>;
  myId: ClientId;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  z: number;
  t: number;
  c: number;
}

function dimBadge(peer: PresenceState, localZ: number, localT: number, localC: number): { dim: boolean; badge: string } {
  const view = peer.view as { z_range?: { start: number }; t?: number; c?: number } | null;
  if (!view) return { dim: false, badge: "" };

  const parts: string[] = [];
  let dim = false;

  const peerZ = view.z_range?.start;
  if (peerZ !== undefined && peerZ !== localZ) {
    dim = true;
    parts.push(peerZ > localZ ? "▲" : "▼");
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

export function PeerCursors({ peers, myId, wasmSceneRef, canvas, z, t, c }: Props) {
  const cursorRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const peersRef = useRef(peers);
  peersRef.current = peers;

  useEffect(() => {
    let rafId: number;

    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const zoom = scene.zoom();
        const centerArr = scene.center();
        const canvasW = canvas.clientWidth;
        const canvasH = canvas.clientHeight;

        for (const [clientId, el] of cursorRefs.current) {
          const peer = peersRef.current.get(clientId);
          if (!peer?.cursor) {
            el.style.display = "none";
            continue;
          }

          const [worldX, worldY] = peer.cursor;
          const screenX = (worldX - centerArr[0]) * zoom + canvasW / 2;
          const screenY = (worldY - centerArr[1]) * zoom + canvasH / 2;

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
        const { dim, badge } = dimBadge(peer, z, t, c);
        return (
          <div
            key={clientId}
            ref={(el) => {
              if (el) cursorRefs.current.set(clientId, el);
              else cursorRefs.current.delete(clientId);
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
                width: 10,
                height: 10,
                borderRadius: "50%",
                backgroundColor: color,
                border: "2px solid white",
                boxShadow: "0 0 4px rgba(0,0,0,0.5)",
                transform: "translate(-50%, -50%)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 8,
                top: -4,
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
