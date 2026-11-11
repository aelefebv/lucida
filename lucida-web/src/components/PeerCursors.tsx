import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { ClientId, PeerIdentity, PresenceState } from "../bridge.ts";
import { projectToCanvas } from "./minimapMath.ts";
import { makeWorldToScreen, type ViewSurface } from "./cameraProjection.ts";
import { peerColor } from "../peerColor.ts";
import { frameClock, useWakeFramesOnRender } from "../frameClock.ts";
import "./PeerCursors.css";

/**
 * A peer's cursor label: the server-authored `identity.display_name` when
 * non-blank, else the numeric client id, so anonymous peers still get a stable
 * label.
 */
function peerLabel(clientId: ClientId, identity?: PeerIdentity | null): string {
  const name = identity?.display_name?.trim();
  return name ? name : String(clientId);
}

/**
 * The avatar fallback glyph: the display name's first letter, then the
 * server-computed `initial`, else "?". The server computes `initial` so the raw
 * email never reaches the client.
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
  /** Screen position in device pixels. */
  sx: number;
  sy: number;
  world?: [number, number, number];
  voxel?: [number, number];
}

interface Props {
  peers: ReadonlyMap<ClientId, PresenceState>;
  myId: ClientId;
  followTarget: ClientId | null;
  wasmSceneRef: RefObject<WasmScene | null>;
  /** The view the labels sit over, and the element over its rectangle. */
  surface: ViewSurface;
  viewMode: "2d" | "3d";
  /** The place along Z this view cuts, in the scene frame. */
  zPlace: number;
  t: number;
  cursorLabels: CursorLabel[];
}

/** Whether `peer` stands elsewhere along Z or T than this view, and which way.
 *  Z compares places in the scene frame: a peer one grid position over cuts
 *  another place. */
function dimBadge(peer: PresenceState, localZ: number, localT: number, localIs3d: boolean): { dim: boolean; badge: string } {
  const view = peer.view;
  if (!view) return { dim: false, badge: "" };

  const parts: string[] = [];
  let dim = false;

  // Z is a spatial axis in 3D, so skip the Z badge and dimming there.
  if (!localIs3d) {
    const peerZ = view.z ? (view.z.start + view.z.end) / 2 : undefined;
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

  return { dim, badge: parts.join(" ") };
}

const EDGE_MARGIN = 16;

export function PeerCursors({ peers, myId, followTarget, wasmSceneRef, surface, viewMode, zPlace, t, cursorLabels }: Props) {
  const labelRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const chevronRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const chevronLabelRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const dotRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  const namePillRefs = useRef<Map<ClientId, HTMLDivElement>>(new Map());
  // Mirror props into refs so the frame tick below reads the latest values
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

  // A peer's move arrives as a render; it needs a frame to be placed.
  useWakeFramesOnRender();
  useEffect(() => {
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const canvasW = surface.element.clientWidth;
        const canvasH = surface.element.clientHeight;
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
          vpMatrix = new Float32Array(scene.view_proj(surface.view));
        } else {
          projectWorld = makeWorldToScreen(scene, surface);
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
              const dpr = window.devicePixelRatio || 1;
              screenX = lbl.sx / dpr;
              screenY = lbl.sy / dpr;
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
            // "flex", not "": clearing display would drop the avatar and name
            // pill's flex row back to block layout.
            if (namePillEl) { namePillEl.style.display = "flex"; }
          }
        }
      }

    };

    return frameClock.subscribe(tick);
    // myId, peers, etc. are read via the mirror refs above so the tick sees
    // the latest values without re-subscribing on every change.
  }, [wasmSceneRef, surface]); // eslint-disable-line react-hooks/exhaustive-deps

  const peerEntries = Array.from(peers.entries()).filter(
    ([id]) => id !== myId,
  );

  // The tick shows and hides each part by writing `style.display`, so every
  // part starts hidden inline rather than in the stylesheet, where clearing
  // the inline value would fall back to hidden.
  return (
    <div className="lc-peer-cursors">
      {peerEntries.map(([clientId, peer]) => {
        const { dim, badge } = dimBadge(peer, zPlace, t, viewMode === "3d");
        return (
          <div
            key={clientId}
            ref={(el) => {
              if (el) labelRefs.current.set(clientId, el);
              else labelRefs.current.delete(clientId);
            }}
            className="lc-peer-cursor"
            data-dim={dim || undefined}
            style={{ "--peer-color": peerColor(clientId), display: "none" } as CSSProperties}
          >
            <div
              ref={(el) => {
                if (el) namePillRefs.current.set(clientId, el);
                else namePillRefs.current.delete(clientId);
              }}
              className="lc-peer-pill"
              style={{ display: "none" }}
            >
              <PeerCursorAvatar identity={peer.identity} />
              <span data-testid="peer-cursor-name">
                {peerLabel(clientId, peer.identity)}{badge ? ` ${badge}` : ""}
              </span>
            </div>
            <div
              ref={(el) => {
                if (el) dotRefs.current.set(clientId, el);
                else dotRefs.current.delete(clientId);
              }}
              className="lc-peer-dot"
              style={{ display: "none" }}
            />
            <div
              ref={(el) => {
                if (el) chevronRefs.current.set(clientId, el);
                else chevronRefs.current.delete(clientId);
              }}
              className="lc-peer-chevron"
              style={{ display: "none" }}
            />
            <div
              ref={(el) => {
                if (el) chevronLabelRefs.current.set(clientId, el);
                else chevronLabelRefs.current.delete(clientId);
              }}
              className="lc-peer-chevron-label"
              style={{ display: "none" }}
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
 * Avatar for a peer's cursor pill from `identity.picture_url`, falling back to
 * a chip with the peer's initial when the image is missing or broken, or the
 * peer has no `identity`.
 *
 * The load failure is local state keyed by URL. Local state keeps one
 * broken avatar from disturbing cursor positioning or other peers. Keying
 * by URL lets a changed `picture_url` retry by itself. A boolean would need
 * setState in an effect to reset it, which `react-hooks/set-state-in-effect`
 * rejects.
 */
function PeerCursorAvatar({ identity }: { identity?: PeerIdentity | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const pictureUrl = identity?.picture_url;
  const initial = peerInitial(identity);

  if (pictureUrl && pictureUrl !== failedUrl) {
    return (
      <img
        src={pictureUrl}
        alt=""
        data-testid="peer-cursor-avatar"
        className="lc-peer-avatar"
        width={AVATAR_SIZE}
        height={AVATAR_SIZE}
        onError={() => setFailedUrl(pictureUrl)}
      />
    );
  }

  return (
    <span aria-hidden="true" data-testid="peer-cursor-initial" className="lc-peer-avatar lc-peer-initial">
      {initial}
    </span>
  );
}
