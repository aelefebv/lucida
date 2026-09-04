import { useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { ClientId, PeerIdentity, PresenceState } from "../bridge.ts";
import { projectToCanvas } from "./minimapMath.ts";
import { makeWorldToScreen } from "./cameraProjection.ts";

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

/**
 * Display label for a peer's cursor (#540). The server-authored
 * `identity.display_name` when present and non-blank; otherwise the numeric
 * client id (the historic fallback) so anonymous/legacy peers still get a
 * stable label.
 */
function peerLabel(clientId: ClientId, identity?: PeerIdentity | null): string {
  const name = identity?.display_name?.trim();
  return name ? name : String(clientId);
}

/**
 * Single-character chip glyph for the avatar fallback: the first letter of
 * the display name, then the server-precomputed `initial` (derived from
 * display-name-or-email server-side — the raw email never reaches the
 * client), else "?". Used when there is no avatar image (none supplied, or
 * it failed to load).
 */
function peerInitial(identity?: PeerIdentity | null): string {
  const name = identity?.display_name?.trim();
  if (name) return name.charAt(0).toUpperCase();
  const initial = identity?.initial?.trim();
  if (initial) return initial.charAt(0).toUpperCase();
  return "?";
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
        const canvasW = canvas.clientWidth;
        const canvasH = canvas.clientHeight;
        const localIs3d = viewModeRef.current === "3d";

        // Build a lookup from client_id → label data from WASM
        const labelMap = new Map<number, CursorLabel>();
        for (const lbl of cursorLabelsRef.current) {
          labelMap.set(lbl.id, lbl);
        }

        // Pre-compute camera data once per frame: the VP matrix in 3D, or the
        // shared 2D world→screen projector (one camera snapshot per frame).
        let vpMatrix: Float32Array | null = null;
        let projectWorld: ((v: [number, number]) => [number, number]) | null = null;
        if (localIs3d) {
          vpMatrix = new Float32Array(scene.view_proj());
        } else {
          projectWorld = makeWorldToScreen(scene, canvas);
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
              [screenX, screenY] = projectWorld!([lbl.voxel[0], lbl.voxel[1]]);
            } else {
              // 2D→2D: recompute from peer cursor or camera center
              const [worldX, worldY] = isDefaulted
                ? (peer.camera as { center?: [number, number] })?.center ?? [0, 0]
                : peer.cursor!;
              [screenX, screenY] = projectWorld!([worldX, worldY]);
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
            // "flex" (not "") so the avatar + name pill keeps its flex row
            // layout when the RAF re-shows it (#540 added the avatar/name flex
            // container; clearing display to "" would fall back to block).
            if (namePillEl) { namePillEl.style.display = "flex"; }
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
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontFamily: "monospace",
                color: "black",
                backgroundColor: color,
                padding: "1px 4px 1px 1px",
                borderRadius: 999,
                whiteSpace: "nowrap",
                opacity: 0.9,
                // Keep the pill legible over the bright WebGPU canvas.
                boxShadow: "0 0 0 1px rgba(0,0,0,0.25)",
              }}
            >
              <PeerCursorAvatar identity={peer.identity} color={color} />
              <span data-testid="peer-cursor-name">
                {peerLabel(clientId, peer.identity)}{badge ? ` ${badge}` : ""}
              </span>
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

const AVATAR_SIZE = 16;

/**
 * Auth icon for a peer's cursor pill (#540). Renders the avatar image from
 * `identity.picture_url` when present; on a missing or broken image it falls
 * back to a colored chip showing the peer's initial. The chip is also the
 * direct render when no `picture_url` was supplied (dev sessions) or when the
 * peer has no `identity` at all (anonymous/legacy peers).
 *
 * The load failure is local state keyed by URL. Local state keeps one
 * broken avatar from disturbing cursor positioning or other peers. Keying
 * by URL lets a changed `picture_url` retry by itself. A boolean would need
 * setState in an effect to reset it, which `react-hooks/set-state-in-effect`
 * rejects.
 */
function PeerCursorAvatar({
  identity,
  color,
}: {
  identity?: PeerIdentity | null;
  color: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const pictureUrl = identity?.picture_url;
  const initial = peerInitial(identity);

  if (pictureUrl && pictureUrl !== failedUrl) {
    return (
      <img
        src={pictureUrl}
        alt=""
        data-testid="peer-cursor-avatar"
        width={AVATAR_SIZE}
        height={AVATAR_SIZE}
        onError={() => setFailedUrl(pictureUrl)}
        style={{
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: "50%",
          objectFit: "cover",
          // White ring keeps the avatar distinct from the colored pill.
          boxShadow: "0 0 0 1px rgba(255,255,255,0.85)",
        }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-testid="peer-cursor-initial"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: "50%",
        // Solid dark chip with the same per-peer color ring so the initial
        // stays legible regardless of the pill's background color.
        background: "rgba(20,20,24,0.9)",
        color: "#fff",
        fontWeight: 700,
        fontSize: 9,
        lineHeight: `${AVATAR_SIZE}px`,
        boxShadow: `0 0 0 1px ${color}`,
      }}
    >
      {initial}
    </span>
  );
}
