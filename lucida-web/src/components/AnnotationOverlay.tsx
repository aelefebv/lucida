/**
 * DOM overlay for collaborative annotations (point pins).
 *
 * Mirrors the peer-cursor overlay (`PeerCursors`): a `pointerEvents: none`
 * layer over the canvas whose markers are re-projected from 2D world space to
 * screen space every animation frame using the current camera. Because pins
 * are anchored in world space (the same frame layout/`centroidWorld` use),
 * they stay glued to the data across pan/zoom for every peer regardless of
 * their viewport.
 *
 * Authoritative annotation state lives in the WASM scene (populated by
 * `load_document` on snapshot and `apply_command` on broadcast); this
 * component reads it via `scene.annotations(datasetId)` and never owns a
 * parallel copy. `version` (the remote-document version) changes whenever a
 * pin is added/removed, which re-runs the snapshot read.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";

/** One pin, as returned by `WasmScene.annotations()` (2D world space). */
export interface Annotation {
  id: string;
  position: [number, number];
  author: string;
  kind: string;
}

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** Local client id; used to gate the remove affordance to the author. */
  myId: number;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was removed)
   * so this overlay re-reads via a fresh `version`. */
  onDocumentChanged: () => void;
}

function readAnnotations(scene: WasmScene | null, datasetId: string): Annotation[] {
  if (!scene) return [];
  try {
    const json = scene.annotations(datasetId);
    const parsed = JSON.parse(json) as Annotation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function AnnotationOverlay({ datasetId, wasmSceneRef, canvas, version, myId, sendCommand, onDocumentChanged }: Props) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  // Re-read the authoritative pin set from WASM whenever the document version
  // changes (a pin was added/removed locally or by a peer) or the scoped
  // dataset changes. Reading happens in an effect (not render) so we never
  // touch the scene ref during render. The RAF tick below only repositions
  // existing DOM nodes; it does not re-read or allocate.
  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  // Reposition markers every frame from world space using the live camera,
  // exactly like PeerCursors. Read the latest pins via a ref so the loop
  // doesn't remount when the set changes. Mirroring a value into a ref in the
  // render phase is the same idempotent pattern PeerCursors uses for its
  // per-frame reads — written, never read, during this render.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const dpr = devicePixelRatio;
        const physW = Math.round(canvas.clientWidth * dpr);
        const physH = Math.round(canvas.clientHeight * dpr);
        const zoom = scene.zoom();
        const center = scene.center();
        const centerX = center[0];
        const centerY = center[1];

        for (const pin of annotationsRef.current) {
          const el = dotRefs.current.get(pin.id);
          if (!el) continue;
          // world -> screen (inverse of SliceViewer's screen -> world);
          // divide by dpr to land in CSS pixels.
          const screenX = ((pin.position[0] - centerX) * zoom + physW / 2) / dpr;
          const screenY = ((pin.position[1] - centerY) * zoom + physH / 2) / dpr;
          el.style.transform = `translate(${screenX}px, ${screenY}px)`;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas]);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // Pins themselves accept clicks (to remove); the layer does not block
        // canvas pan/zoom/pin-placement elsewhere.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        return (
          <div
            key={pin.id}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            title={mine ? `Pin by you — click to remove` : `Pin by ${pin.author}`}
            onClick={() => {
              // Author removal. Where auth is on, the server enforces
              // author-or-admin; this just avoids offering it to non-authors.
              if (!mine) return;
              const scene = wasmSceneRef.current;
              if (!scene) return;
              // Apply locally AND send: the sender is excluded from the
              // server's rebroadcast, so the local apply is what removes the
              // pin from the author's own view. onDocumentChanged() re-reads.
              applyDocumentCommand(
                scene,
                { type: "remove_annotation", dataset_id: datasetId, id: pin.id },
                sendCommand,
              );
              onDocumentChanged();
            }}
            style={{
              // A circular marker centered exactly on the anchor, mirroring
              // the peer-cursor dot. Centering via negative margins (half the
              // size) guarantees the pin lands precisely on the data
              // coordinate the user clicked, at any zoom.
              position: "absolute",
              top: 0,
              left: 0,
              width: 12,
              height: 12,
              marginLeft: -6,
              marginTop: -6,
              borderRadius: "50%",
              transform: "translate(0px, 0px)",
              backgroundColor: "#FF3B30",
              border: "2px solid white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
              willChange: "transform",
              pointerEvents: mine ? "auto" : "none",
              cursor: mine ? "pointer" : "default",
            }}
          />
        );
      })}
    </div>
  );
}
