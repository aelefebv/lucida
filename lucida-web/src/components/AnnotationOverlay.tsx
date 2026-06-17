/**
 * DOM overlay for collaborative annotations (point pins) and their comment
 * threads.
 *
 * Mirrors the peer-cursor overlay (`PeerCursors`): a `pointerEvents: none`
 * layer over the canvas whose markers are re-projected from 2D world space to
 * screen space every animation frame using the current camera. Because pins
 * are anchored in world space (the same frame layout/`centroidWorld` use),
 * they stay glued to the data across pan/zoom for every peer regardless of
 * their viewport. Each pin carries a small comment-count badge; clicking a pin
 * opens a popover with its thread, where any peer can add a comment and an
 * author can remove their own.
 *
 * Authoritative annotation state (pins AND their nested comments) lives in the
 * WASM scene (populated by `load_document` on snapshot and `apply_command` on
 * broadcast); this component reads it via `scene.annotations(datasetId)` — which
 * returns each pin with its `comments` array — and never owns a parallel copy.
 * `version` (the remote-document version) changes whenever a pin or comment is
 * added/removed, which re-runs the snapshot read.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";
import { annotationVertices, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";
import { ThreadPopover } from "./ThreadPopover.tsx";

/** One comment in a pin's thread (as returned nested in `annotations()`). */
export interface Comment {
  id: string;
  author: string;
  text: string;
}

/** One pin, as returned by `WasmScene.annotations()`. `position` is the
 * in-plane world point; `z` is the additive depth, so the pin's full world
 * point is `(position[0], position[1], z)`. */
export interface Annotation {
  id: string;
  position: [number, number];
  /** The second in-plane world vertex: a line's far endpoint or a box's
   * opposite corner. Absent/`null` for a point (and for any slice-1..4 pin). */
  end?: [number, number] | null;
  /** Additive depth. Absent on a slice-1/2 pin → defaulted to 0 on read. */
  z?: number;
  author: string;
  /** "point" | "line" | "box". Absent on a slice-1 pin → treated as "point". */
  kind: string;
  /** Flat, insertion-ordered comment thread. Absent on a slice-1 pin →
   * defaulted to an empty array on read. */
  comments?: Comment[];
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
  /** Notify the parent that the document changed locally (a pin/comment was
   * added or removed) so this overlay re-reads via a fresh `version`. */
  onDocumentChanged: () => void;
  /** Notify the parent that the *viewport* changed locally (a plain drag on an
   * own pin panned the view). The parent marks the render loop dirty so the
   * canvas actually repaints under the panned camera — the same thing
   * `SliceViewer` does after its own pan. Optional + defaulted to a no-op so the
   * gesture (and the move/click paths) work without it; a panned view simply
   * wouldn't repaint until the next frame the loop already redraws. */
  onViewportChanged?: () => void;
}

/** Max pointer travel (CSS px) for a press+release to count as a click, not a
 * drag. Mirrors SliceViewer's PIN_CLICK_SLOP so moving a pin and dropping one
 * share the same "did the pointer really travel?" threshold. */
const PIN_CLICK_SLOP = 4;

/** Live state for an in-progress pointer gesture that began on an own marker,
 * scoped to one captured pointer. The marker sits over the canvas and captures
 * the press, so it must drive BOTH gestures itself:
 *  - `mode: "move"` — a Shift+drag, which repositions the pin and emits one
 *    `move_annotation` on release (the deliberate, gated move gesture).
 *  - `mode: "pan"` — a plain (non-Shift) drag, which forwards the SAME viewport
 *    pan the canvas uses (`applyViewportCommand({ type: "pan", … })`, dpr-aware
 *    and negated) so dragging off a pin pans exactly like dragging empty canvas,
 *    and never moves the pin. */
interface PinDrag {
  pinId: string;
  pointerId: number;
  /** What this gesture does once it passes the slop: move the pin (Shift) or
   * pan the view (plain). Fixed at pointerdown from the Shift modifier. */
  mode: "move" | "pan";
  /** Press point in CSS px (clientX/Y), to measure travel against the slop. */
  startX: number;
  startY: number;
  /** Last pointer position in CSS px — the pan path consumes incremental deltas
   * (cur − last) each move so it pans by exactly the travel since the last
   * event, just like SliceViewer's frame-to-frame pan. */
  lastX: number;
  lastY: number;
  /** The pin's depth at press; preserved across a move (z is not edited). */
  z: number;
  /** Flips true once travel passes the slop — the press becomes a real drag. */
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

export function AnnotationOverlay({ datasetId, wasmSceneRef, canvas, version, myId, sendCommand, onDocumentChanged, onViewportChanged }: Props) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // SVG geometry element per non-point pin (the line segment / box outline),
  // re-projected each frame through the SAME world->screen math as the dot.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Which pin's thread popover is open (by pin id), or null when none. The
  // overlay owns only WHICH pin is open and where it sits on screen; the thread
  // UI itself (comment list, add box, edit/remove, delete+confirm) lives in the
  // shared <ThreadPopover>, which owns its own ephemeral draft/edit/confirm state
  // and is remounted (keyed by pin id) whenever the open pin changes.
  const [openPinId, setOpenPinId] = useState<string | null>(null);

  // The live pin drag, if any. A ref (not state) so the per-pointer handlers
  // mutate it without re-rendering mid-drag; the RAF tick keeps repositioning
  // the dot from world space, so we don't need to store a screen offset here.
  const dragRef = useRef<PinDrag | null>(null);
  // After a real drag (not a click), swallow the click event the browser still
  // fires on pointerup so the thread popover doesn't toggle on drop. Keyed off
  // the pin id; cleared once the suppressed click is consumed.
  const suppressClickRef = useRef<string | null>(null);

  // Re-read the authoritative pin set (with threads) from WASM whenever the
  // document version changes (a pin/comment was added/removed locally or by a
  // peer) or the scoped dataset changes. Reading happens in an effect (not
  // render) so we never touch the scene ref during render. The RAF tick below
  // only repositions existing DOM nodes; it does not re-read or allocate.
  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  // If the pin whose thread is open disappears (removed by its author or a
  // peer, or its dataset changed), close the popover so it can't dangle.
  useEffect(() => {
    if (openPinId !== null && !annotations.some((p) => p.id === openPinId)) {
      setOpenPinId(null);
    }
  }, [annotations, openPinId]);

  useEffect(() => {
    setOpenPinId(null);
  }, [datasetId]);

  // A pending delete confirm and an in-flight edit live INSIDE <ThreadPopover>,
  // which the host remounts (keyed by pin id) whenever the open pin changes — so
  // closing the thread, switching pins, or a pin vanishing all drop that
  // transient state automatically: re-opening a pin always starts back at the
  // plain Delete trigger with an empty edit/draft. No effect is needed here.

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
        // world -> screen (inverse of SliceViewer's screen -> world); divide by
        // dpr to land in CSS pixels. This is the single per-vertex projection
        // every kind reuses — the dot, the line, and the box corners all go
        // through it.
        const project = (v: ScreenPoint): ScreenPoint => [
          ((v[0] - centerX) * zoom + physW / 2) / dpr,
          ((v[1] - centerY) * zoom + physH / 2) / dpr,
        ];

        // The pin (if any) being actively MOVE-dragged past the slop: its dot is
        // positioned by the pointermove handler under the cursor, so the tick
        // must NOT reproject it from its (still-old) stored position — that would
        // fight the drag and snap the dot back every frame. On release the drag
        // clears and the tick resumes from the freshly-applied position. A PAN
        // drag is deliberately excluded: it doesn't move the pin, so the dot must
        // keep reprojecting from world space every frame to track the panning
        // camera — exactly like every other (undragged) marker.
        const activeDrag = dragRef.current;
        const draggingId =
          activeDrag?.moved && activeDrag.mode === "move" ? activeDrag.pinId : null;

        for (const pin of annotationsRef.current) {
          // Anchor dot (the interaction target) sits at the first vertex.
          const el = dotRefs.current.get(pin.id);
          if (el && pin.id !== draggingId) {
            const [ax, ay] = project(pin.position);
            el.style.transform = `translate(${ax}px, ${ay}px)`;
          }
          // Line/box geometry: project every vertex through the same `project`
          // and rewrite the shared SVG element's coordinates in place.
          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            const pts = annotationVertices(pin).map(project);
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
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas]);

  /** Convert a pointer event to 2D world coords — the inverse camera projection,
   * identical to SliceViewer's `eventToWorld` (world = (screenPx − half)/zoom +
   * center). Reused so a moved pin lands in the SAME world frame add_annotation
   * stores, regardless of pan/zoom. */
  const eventToWorld = (e: { clientX: number; clientY: number }): [number, number] => {
    const scene = wasmSceneRef.current;
    if (!scene) return [0, 0];
    const dpr = devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const cursorX = (e.clientX - rect.left) * dpr;
    const cursorY = (e.clientY - rect.top) * dpr;
    const zoom = scene.zoom();
    const center = scene.center();
    const halfW = (canvas.clientWidth * dpr) / 2;
    const halfH = (canvas.clientHeight * dpr) / 2;
    return [(cursorX - halfW) / zoom + center[0], (cursorY - halfH) / zoom + center[1]];
  };

  // --- Pin gesture (Shift+drag moves; plain drag pans) -----------------------
  // The author's own pin marker captures the press (it sits over the canvas), so
  // it must drive BOTH gestures itself. We use Pointer Events ON the marker
  // (capture on down; move/up on the marker) so the pointer stays bound to it
  // even if it slides off — exactly the pattern the interaction contract asks
  // for and the harness dispatches to.
  //
  // Moving a pin now requires Shift+click+drag (issue #778): a plain drag is far
  // too easy to trigger by accident while trying to pan. So the modifier at
  // pointerdown picks the gesture:
  //  - Shift+press → a MOVE drag: past the slop, the dot previews under the
  //    cursor and release emits one move_annotation (author-only).
  //  - plain press → a PAN drag: past the slop, each move forwards the same
  //    viewport pan the canvas uses, so a drag that happens to start on a pin
  //    pans the view identically to a drag on empty canvas — and never moves the
  //    pin. (Safe to gate move behind Shift now that #770 took delete off
  //    shift-click, freeing Shift.)
  // Either way a press that never passes the slop is a click: a plain click
  // falls through to onClick and toggles the thread; a Shift-click that doesn't
  // travel does nothing at all (no move, no toggle — see onPinPointerUp).

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    // Only the author gets a marker-driven gesture, and only on a primary press.
    // (A non-author marker has no handlers wired at all — see the JSX — so a
    // peer's pin only ever clicks.) Other buttons fall through to the click.
    if (pin.author !== String(myId)) return;
    if (e.button !== 0) return;
    // A gesture is already in flight (a second pointer pressed mid-drag): ignore
    // it so the in-progress gesture completes rather than being silently reset.
    if (dragRef.current) return;
    // Start each gesture with a clean slate: clear any stale click-suppression
    // from a prior drag that never received its trailing click, so it can never
    // eat a future legitimate click on this pin.
    suppressClickRef.current = null;
    dragRef.current = {
      pinId: pin.id,
      pointerId: e.pointerId,
      // Shift gates the move; a plain press pans. Fixed here at press time so a
      // Shift release mid-drag can't silently flip a pan into a move.
      mode: e.shiftKey ? "move" : "pan",
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      z: pin.z ?? 0,
      moved: false,
    };
    // Bind the pointer to the marker so move/up land here through the drag.
    // happy-dom may lack pointer capture; it's a progressive enhancement, never
    // required for the gesture to complete.
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // capture unsupported (e.g. test env) — moves/ups still arrive on target
    }
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    // Scope to the active drag's pin (only one drag at a time). We don't gate on
    // pointerId equality — a captured pointer already guarantees same-id delivery
    // in a real browser, and not gating keeps the gesture robust to harnesses
    // that don't echo the id on every event.
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      const travel = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (travel <= PIN_CLICK_SLOP) return; // still within click slop — not yet a drag
      drag.moved = true;
    }

    if (drag.mode === "pan") {
      // A plain drag pans the view — it never moves the pin. Forward the SAME
      // viewport pan SliceViewer applies: incremental travel since the last
      // event, scaled to physical pixels (dpr-aware) and negated (dragging the
      // image right moves the camera left). Apply-locally only — a pan is
      // viewport state, never a document command, so it is not sent to peers.
      const dpr = devicePixelRatio;
      const dx = (e.clientX - drag.lastX) * dpr;
      const dy = (e.clientY - drag.lastY) * dpr;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      const scene = wasmSceneRef.current;
      if (scene) {
        applyViewportCommand(scene, { type: "pan", dx: -dx, dy: -dy });
        // Ask the parent to repaint under the panned camera (marks the render
        // loop dirty), mirroring SliceViewer's markInteractiveDirty after a pan.
        // No-op when unwired (e.g. the test harness) — the pan still applied.
        onViewportChanged?.();
      }
      return;
    }

    // mode === "move": a Shift+drag. Past the slop, preview the move by
    // repositioning the dot live under the cursor (CSS px relative to the
    // canvas). The RAF tick reprojects from world space every frame, so this
    // transform only governs the in-flight frames; the authoritative position
    // updates on release via apply_command.
    const el = dotRefs.current.get(pin.id);
    if (el) {
      const rect = canvas.getBoundingClientRect();
      el.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px)`;
    }
  };

  const onPinPointerUp = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    dragRef.current = null;
    try {
      // Release the pointer we actually captured (its id from pointerdown).
      (e.currentTarget as Element).releasePointerCapture?.(drag.pointerId);
    } catch {
      // ignore — capture may not have been taken
    }

    // A plain (pan) gesture never moves the pin. If it actually traveled, it was
    // a real pan, so swallow the trailing click the browser fires on release —
    // a drag must not also toggle the thread. If it never traveled, it's a plain
    // click: emit nothing and let onClick toggle the thread (don't suppress).
    if (drag.mode === "pan") {
      if (drag.moved) suppressClickRef.current = pin.id;
      return;
    }

    // mode === "move": a Shift gesture. A Shift-press that never passed the slop
    // does NOTHING — no move and no thread toggle (per the contract, Shift is the
    // move modifier, not a thread toggle). Suppress the trailing click so a
    // stationary Shift-press can't open the thread.
    if (!drag.moved) {
      suppressClickRef.current = pin.id;
      return;
    }
    // A real Shift+drag: emit exactly one move_annotation (release point in the
    // existing world frame) and suppress the trailing click so the drop doesn't
    // also pop the thread.
    suppressClickRef.current = pin.id;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const position = eventToWorld(e);
    applyDocumentCommand(
      scene,
      {
        type: "move_annotation",
        dataset_id: datasetId,
        id: pin.id,
        position,
        z: drag.z,
      },
      sendCommand,
    );
    onDocumentChanged();
  };

  const onPinPointerCancel = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    // A cancelled gesture (e.g. the OS stealing the pointer) never moves the pin;
    // the RAF tick snaps the dot back to its stored world position next frame.
    const captured = drag.pointerId;
    dragRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture?.(captured);
    } catch {
      // ignore
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // Pins and their popovers accept clicks; the layer itself does not
        // block canvas pan/zoom/pin-placement elsewhere.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Shape layer: one SVG element per line/box, drawn beneath the DOM
          markers. Each shape's coordinates are rewritten every frame by the RAF
          tick (projecting its vertices through the shared `project`), so it
          stays glued to the data across pan/zoom — exactly like the dots. */}
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
            />
          );
        })}
      </svg>
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        return (
          <div
            key={pin.id}
            data-testid={`annot-pin-wrapper-${pin.id}`}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            style={{
              // The marker is positioned via transform each frame; the popover
              // is an absolutely-positioned child anchored to it.
              position: "absolute",
              top: 0,
              left: 0,
              transform: "translate(0px, 0px)",
              willChange: "transform",
              pointerEvents: "none",
              // Every pin shares one overlay layer with no per-marker stacking,
              // so DOM order alone decides paint order — a *later* pin's dot
              // would paint over an *earlier* pin's open popover (issue #772).
              // Fix: give every wrapper a base z-index and lift only the pin
              // whose thread is open above the rest, so its popover (a child of
              // this wrapper) clears every other marker. Closing or switching
              // pins drops it back to the shared base, so normal pins never
              // jockey. Keyed solely to the existing `openPinId` — no reorder,
              // no portal, no new state.
              zIndex: isOpen ? 2 : 1,
            }}
          >
            {/* The pin marker itself: a circular dot centered on the anchor,
                mirroring the peer-cursor dot, AND the thread-open click target
                for every pin — so its testid is now on every dot regardless of
                author. A plain click toggles the thread. For the author the dot
                also drives the pointer gestures (handlers below): a plain drag
                pans the view (it never moves the pin), and a Shift+drag moves it
                (issue #778 — moving now requires Shift so it can't fire by
                accident while panning). Deletion lives in the open thread as a
                deliberate, confirmed Delete. A peer's pin only clicks (no gesture
                handlers, no delete affordance). */}
            <div
              data-testid={`annot-pin-${pin.id}`}
              title={
                mine
                  ? `Pin by you — click for thread, Shift+drag to move`
                  : `Pin by ${pin.author} — click for thread`
              }
              onPointerDown={mine ? onPinPointerDown(pin) : undefined}
              onPointerMove={mine ? onPinPointerMove(pin) : undefined}
              onPointerUp={mine ? onPinPointerUp(pin) : undefined}
              onPointerCancel={mine ? onPinPointerCancel(pin) : undefined}
              onClick={() => {
                // A real drag (a pan, or a Shift+drag move) just finished, or a
                // stationary Shift-press resolved: swallow the trailing click so
                // it doesn't also toggle the thread. Consume the flag once.
                if (suppressClickRef.current === pin.id) {
                  suppressClickRef.current = null;
                  return;
                }
                // A plain click on the dot toggles the comment thread popover.
                // (A Shift gesture never reaches here un-suppressed — Shift is the
                // move modifier now, and a stationary Shift-press is swallowed
                // above so it neither moves nor toggles.)
                setOpenPinId((cur) => (cur === pin.id ? null : pin.id));
              }}
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
                pointerEvents: "auto",
                // Own pins show the same grab cursor the canvas uses (a plain
                // drag from the pin pans, exactly like dragging the canvas;
                // Shift+drag moves the pin). A peer's pin stays a plain pointer
                // (click-only).
                cursor: mine ? "grab" : "pointer",
                touchAction: mine ? "none" : undefined,
              }}
            />
            {/* Comment-count badge: only when the pin has at least one comment.
                A tiny pill at the pin's upper-right, like a notification count. */}
            {comments.length > 0 && (
              <div
                aria-label={`${comments.length} comment${comments.length === 1 ? "" : "s"}`}
                onClick={() => setOpenPinId((cur) => (cur === pin.id ? null : pin.id))}
                style={{
                  position: "absolute",
                  top: -14,
                  left: 4,
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 8,
                  backgroundColor: "#1f6feb",
                  color: "white",
                  fontSize: 11,
                  lineHeight: "16px",
                  textAlign: "center",
                  fontWeight: 600,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
                  pointerEvents: "auto",
                  cursor: "pointer",
                }}
              >
                {comments.length}
              </div>
            )}
            {/* Thread popover: the flat, ordered comment list plus an add box,
                edit/remove, and delete+confirm — all in the shared
                <ThreadPopover>, the ONE place this UI lives (2D and 3D). Anchored
                just below-right of the pin; because it's a child of this pin's
                wrapper, lifting the wrapper's z-index when open (above) carries
                the popover above every other marker. Keyed by pin id so its
                ephemeral draft/edit/confirm state resets when the open pin
                switches. */}
            {isOpen && (
              <ThreadPopover
                key={pin.id}
                pin={pin}
                datasetId={datasetId}
                myId={myId}
                wasmSceneRef={wasmSceneRef}
                sendCommand={sendCommand}
                onDocumentChanged={onDocumentChanged}
                onClose={() => setOpenPinId(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
