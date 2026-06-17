/**
 * DOM overlay that renders collaborative annotation pins as markers in the 3D
 * volume view.
 *
 * This is the 3D counterpart to {@link AnnotationOverlay} (which owns the 2D
 * slice view and its comment-thread UI). It is deliberately minimal — just the
 * pin markers — so the rich thread UI lives in exactly one place (the 2D
 * overlay) while the 3D view shows where each pin sits in the volume.
 *
 * For gesture consistency with 2D (issue #778), an own marker is interactive:
 * a Shift+drag moves the pin (the release point is depth-picked back into the
 * volume via `pick_annotation_voxel`, declining on a ray miss), while a plain
 * drag orbits the camera as usual — the marker hands a plain press straight to
 * the canvas rather than re-implementing the orbit, so 3D camera behavior is
 * unchanged. A peer's marker stays inert. Move is author-only.
 *
 * Like the peer-cursor 3D path (`PeerCursors`), each marker is re-projected
 * from the pin's world point every animation frame using the renderer's own
 * camera machinery. Rather than reproject by hand, it calls
 * `scene.project_annotation(datasetId, x, y, z)`, which lifts the pin's stored
 * in-plane-voxel + voxel-depth point to world space through the SAME rendering
 * transform the volume render pass uses, then projects it with the active
 * camera. That keeps a marker glued to its voxel as the camera orbits, and the
 * call returns an empty result when the point is behind the camera — so a
 * marker naturally hides as it swings behind the volume.
 *
 * Authoritative pin state lives in the WASM scene; this component reads it via
 * `scene.annotations(datasetId)` and never owns a parallel copy. `version` (the
 * remote-document version) bumps whenever a pin is added/removed, re-running the
 * read.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { Annotation } from "./AnnotationOverlay.tsx";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { annotationVertices, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** Local client id; the author's own pins are tinted distinctly, and only the
   * author may move their own pin. */
  myId: number;
  /** Send a wire command (already wrapped by the bridge). Optional so the
   * marker-only render path still works without it; a Shift+drag move needs it.
   * Mirrors the 2D overlay's apply-locally-and-send seam. */
  sendCommand?: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was moved) so
   * dependent overlays re-read via a fresh `version`. Optional for the same
   * reason. */
  onDocumentChanged?: () => void;
}

/** Max pointer travel (CSS px) for a Shift press+release to count as a click,
 * not a move. Mirrors the 2D overlay's PIN_CLICK_SLOP so a Shift-press that
 * barely jitters doesn't emit a spurious move. */
const PIN_CLICK_SLOP = 4;

/** Live state for an in-progress Shift+drag move on an own 3D marker, scoped to
 * one captured pointer. Only Shift+drag is intercepted here; a plain press is
 * handed straight to the canvas so the camera orbits/flies exactly as usual. */
interface Pin3DDrag {
  pinId: string;
  pointerId: number;
  /** Press point in CSS px, to measure travel against the slop. */
  startX: number;
  startY: number;
  /** Flips true once travel passes the slop — the press becomes a real move. */
  moved: boolean;
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

export function AnnotationOverlay3D({ datasetId, wasmSceneRef, canvas, version, myId, sendCommand, onDocumentChanged }: Props) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // SVG geometry element per line/box, re-projected each frame through the SAME
  // `project_annotation` call the dots use — so a line/box tracks the volume as
  // the camera orbits, just like a point marker.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  // Re-read the authoritative pin set from WASM whenever the document version
  // or the scoped dataset changes. Reading happens in an effect (never during
  // render) so we don't touch the scene ref mid-render. The RAF tick below only
  // repositions existing DOM nodes; it does not re-read or allocate.
  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  // Mirror the latest pins into a ref so the RAF loop reads them without
  // remounting when the set changes — the same render-phase, write-only mirror
  // pattern PeerCursors and AnnotationOverlay use.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;
  const datasetIdRef = useRef(datasetId);
  // eslint-disable-next-line react-hooks/refs
  datasetIdRef.current = datasetId;

  // The live Shift+drag move, if any. Declared before the RAF effect because the
  // tick reads it to skip reprojecting the dot being dragged (see below).
  const dragRef = useRef<Pin3DDrag | null>(null);

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const dpr = devicePixelRatio;
        const ds = datasetIdRef.current;
        // The single per-vertex projection every kind reuses: lift (x, y, z) to
        // world and project via the renderer's camera. An empty result means the
        // vertex is behind the camera (or the dataset has no anchorable member).
        // project_annotation returns physical pixels; divide by DPR for CSS. The
        // shared depth `z` applies to every vertex of a line/box.
        const project = (v: ScreenPoint, z: number): ScreenPoint | null => {
          const proj = scene.project_annotation(ds, v[0], v[1], z);
          return proj.length < 2 ? null : [proj[0] / dpr, proj[1] / dpr];
        };
        // The pin (if any) being actively Shift-moved past the slop: its dot is
        // positioned by the pointermove handler under the cursor, so the tick
        // must NOT reproject it from its (still-old) stored position — that would
        // fight the drag and snap the dot back every frame. On release the drag
        // clears and the tick resumes from the freshly-picked position.
        const activeDrag = dragRef.current;
        const draggingId = activeDrag?.moved ? activeDrag.pinId : null;
        for (const pin of annotationsRef.current) {
          const pinZ = pin.z ?? 0;
          const verts = annotationVertices(pin);
          const projected: (ScreenPoint | null)[] = verts.map((v) => project(v, pinZ));
          // If ANY vertex is behind the camera, hide the whole shape + dot — a
          // partially-projected line/box would streak across the screen.
          const allVisible = projected.every((p) => p !== null);

          const el = dotRefs.current.get(pin.id);
          if (el && pin.id !== draggingId) {
            const anchor = projected[0];
            if (!allVisible || !anchor) {
              el.style.display = "none";
            } else {
              el.style.display = "";
              el.style.transform = `translate(${anchor[0]}px, ${anchor[1]}px)`;
            }
          }

          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            if (!allVisible) {
              shape.style.display = "none";
            } else {
              shape.style.display = "";
              const pts = projected as ScreenPoint[];
              if (isClosedShape(pin)) {
                (shape as SVGPolygonElement).setAttribute(
                  "points",
                  pts.map((p) => `${p[0]},${p[1]}`).join(" "),
                );
              } else if (pts.length >= 2) {
                const line = shape as SVGLineElement;
                line.setAttribute("x1", String(pts[0][0]));
                line.setAttribute("y1", String(pts[0][1]));
                line.setAttribute("x2", String(pts[1][0]));
                line.setAttribute("y2", String(pts[1][1]));
              }
            }
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas]);

  // --- 3D pin gesture (Shift+drag moves; plain drag orbits) ------------------
  // For consistency with the 2D overlay (issue #778), an own 3D marker's
  // Shift+drag MOVES the pin, while a plain drag ORBITS the camera as usual.
  //
  // The camera (orbit in arcball, look-around in fly) is owned entirely by the
  // canvas's pointer handlers (VolumeViewer). The marker sits over the canvas,
  // so to keep a plain drag orbiting EXACTLY as today — in both arcball and fly
  // modes, with zero re-implementation or regression risk — the marker does not
  // try to drive the camera itself. Instead it intercepts ONLY a Shift+press
  // (the move) and HANDS a plain press straight back to the canvas: it re-fires
  // the pointerdown on the canvas and transfers pointer capture there, so the
  // canvas runs its normal orbit/fly drag for the rest of the gesture. A peer's
  // marker isn't interactive at all (no handlers), so it never intercepts.
  // (`dragRef` is declared above — the RAF tick reads it.)

  /** Hand a plain (non-Shift) press to the canvas so the camera orbits/flies as
   * usual. Transfers capture to the canvas and replays the pointerdown there,
   * then the canvas's own move/up handlers own the gesture. */
  const forwardPressToCanvas = (e: ReactPointerEvent) => {
    // Move pointer capture to the canvas so subsequent move/up for this pointer
    // are delivered to the canvas's listeners (which is what drives the orbit).
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      // never captured — fine
    }
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // capture unsupported (e.g. test env) — orbit still proceeds via the
      // canvas listeners on the bubbling/forwarded event
    }
    // Replay the down on the canvas so it starts its drag from this point. A
    // fresh event dispatched on the canvas bubbles to the shared parent, never
    // into this overlay subtree (the overlay is a sibling of the canvas), so
    // there's no recursion back into this handler.
    try {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: e.pointerId,
          button: e.button,
          buttons: e.buttons,
          clientX: e.clientX,
          clientY: e.clientY,
          shiftKey: e.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      // PointerEvent ctor unsupported — nothing more we can do; the plain drag
      // simply won't orbit in this (non-browser) environment.
    }
  };

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    if (pin.author !== String(myId)) return;
    if (e.button !== 0) return;
    if (!e.shiftKey) {
      // Plain press → orbit: hand the whole gesture to the canvas.
      forwardPressToCanvas(e);
      return;
    }
    // Shift+press → begin a move drag on this marker.
    if (dragRef.current) return; // a gesture is already in flight
    dragRef.current = {
      pinId: pin.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // capture unsupported (test env) — move/up still arrive on target
    }
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      const travel = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (travel <= PIN_CLICK_SLOP) return; // still within click slop
      drag.moved = true;
    }
    // Preview the dot under the cursor (CSS px relative to the canvas). The RAF
    // tick skips reprojecting this dot while the drag is live; the authoritative
    // position updates on release.
    const el = dotRefs.current.get(pin.id);
    if (el) {
      const rect = canvas.getBoundingClientRect();
      el.style.display = "";
      el.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px)`;
    }
  };

  const onPinPointerUp = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    dragRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture?.(drag.pointerId);
    } catch {
      // ignore
    }
    // A Shift-press that never passed the slop is not a move — emit nothing. (No
    // 3D thread UI, so there's nothing to toggle either.)
    if (!drag.moved) return;
    const scene = wasmSceneRef.current;
    if (!scene || !sendCommand) return;
    // Resolve the release point through the SAME depth pick a 3D pin drop uses:
    // ray-cast into the volume for an in-plane-voxel + voxel-depth point. Decline
    // on a ray miss — a pin must anchor to data, never float in empty space, so a
    // Shift+drag that releases off the volume leaves the pin where it was.
    const dpr = devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const screenX = (e.clientX - rect.left) * dpr;
    const screenY = (e.clientY - rect.top) * dpr;
    const voxel = scene.pick_annotation_voxel(datasetId, screenX, screenY);
    if (voxel.length < 3) return; // ray missed → don't move
    applyDocumentCommand(
      scene,
      {
        type: "move_annotation",
        dataset_id: datasetId,
        id: pin.id,
        position: [voxel[0], voxel[1]],
        z: voxel[2],
      },
      sendCommand,
    );
    onDocumentChanged?.();
  };

  const onPinPointerCancel = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    const captured = drag.pointerId;
    dragRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture?.(captured);
    } catch {
      // ignore
    }
    // A cancelled gesture never moves the pin; the tick snaps the dot back to its
    // projected position next frame.
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // The layer itself never blocks camera orbit/zoom or the shift-click pin
        // drop handled on the canvas. Only an own marker opts back into pointer
        // events (to gate its Shift+drag move); a plain drag on it is handed
        // straight to the canvas, so the camera still owns every plain gesture.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Line/box geometry, projected per-vertex through the volume transform
          every frame (see the tick). Starts hidden so nothing flashes at the
          origin before the first projection. */}
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {annotations.map((pin) => {
          if (pin.kind !== "line" && pin.kind !== "box") return null;
          if (!pin.end) return null;
          const color = pin.author === String(myId) ? "#FF3B30" : "#FF9F0A";
          if (isClosedShape(pin)) {
            return (
              <polygon
                key={pin.id}
                ref={(el) => {
                  if (el) shapeRefs.current.set(pin.id, el);
                  else shapeRefs.current.delete(pin.id);
                }}
                points=""
                fill={color}
                fillOpacity={0.12}
                stroke={color}
                strokeWidth={2.5}
                strokeLinejoin="round"
                style={{ display: "none" }}
              />
            );
          }
          return (
            <line
              key={pin.id}
              ref={(el) => {
                if (el) shapeRefs.current.set(pin.id, el);
                else shapeRefs.current.delete(pin.id);
              }}
              x1={0}
              y1={0}
              x2={0}
              y2={0}
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              style={{ display: "none" }}
            />
          );
        })}
      </svg>
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        return (
          <div
            key={pin.id}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            // Start hidden; the RAF tick reveals + positions it once projected,
            // so a marker never flashes at the origin for a frame.
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              display: "none",
              transform: "translate(0px, 0px)",
              willChange: "transform",
              pointerEvents: "none",
            }}
          >
            <div
              data-testid={`annot-pin-${pin.id}`}
              title={mine ? "Pin by you — Shift+drag to move, drag to orbit" : `Pin by ${pin.author}`}
              // Only an own marker is interactive: it intercepts a Shift+drag to
              // move the pin and hands a plain drag back to the canvas to orbit.
              // A peer's marker stays inert (pointerEvents: none), so it never
              // blocks the camera and can't be moved.
              onPointerDown={mine ? onPinPointerDown(pin) : undefined}
              onPointerMove={mine ? onPinPointerMove(pin) : undefined}
              onPointerUp={mine ? onPinPointerUp(pin) : undefined}
              onPointerCancel={mine ? onPinPointerCancel(pin) : undefined}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                borderRadius: "50%",
                backgroundColor: "#FF3B30",
                border: "2px solid white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
                // Own markers accept the pointer (to gate move on Shift); peers'
                // stay transparent to clicks so the camera owns every gesture.
                pointerEvents: mine ? "auto" : "none",
                cursor: mine ? "grab" : undefined,
                touchAction: mine ? "none" : undefined,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
