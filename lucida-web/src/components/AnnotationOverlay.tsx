/**
 * DOM overlay for annotations and their comment threads in the 2D slice view.
 *
 * Like `PeerCursors`, it is a `pointerEvents: none` layer whose markers are
 * re-projected from world space every frame, so pins stay glued to the data
 * across pan and zoom for every peer. Annotation state lives in the WASM scene
 * and is read through `scene.annotations(datasetId)`, never copied here.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyViewportCommand } from "../applyAndSend.ts";
import type { Annotation } from "./annotationDocument.ts";
import { useAnnotationOverlay } from "./useAnnotationOverlay.ts";
import {
  capturePointer,
  emitMoveAnnotation,
  exceedsClickSlop,
  releasePointer,
} from "./annotationInteraction.ts";
import { eventToWorld, makeWorldToScreen, type ClientPoint } from "./cameraProjection.ts";
import { CommentCountBadge, OffContextHelptext } from "./AnnotationPinBadges.tsx";
import {
  annotationVertices,
  isClosedShape,
  BOX_HANDLES,
  boxHandlePoint,
  reshapeBox,
  LINE_HANDLES,
  lineHandlePoint,
  reshapeLine,
  type BoxCorners,
  type BoxHandle,
  type LineEndpoints,
  type LineHandle,
} from "./annotationGeometry.ts";
import { isOffContext, type ViewContext } from "./annotationContext.ts";
import { ThreadPopover } from "./ThreadPopover.tsx";
import type { MentionCandidate } from "./annotationMentions.ts";

import type { AnnotationOverlayHandle } from "./annotationDocument.ts";
import "./AnnotationOverlay.css";

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** The current Z/T/C. A pin that differs on any axis renders off-context:
   * dimmed, with a locator naming where it lives. */
  viewContext: ViewContext;
  /** The browser-persisted author identity from `annotationAuthorId()`, not the
   * per-connection `bridge.myId`, so a pin authored here stays mine across
   * rejoin. Gates move, reshape, and delete. */
  myId: string;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Called after a local change so this overlay re-reads via a fresh
   * `version`. */
  onDocumentChanged: () => void;
  /** Marks the render loop dirty after a pin drag pans or `focusPin`
   * recenters, as `SliceViewer` does after its own pan. */
  onViewportChanged?: () => void;
  /** Personal, view-only toggle. When false nothing renders; annotations are
   * hidden, not deleted, and nothing goes on the wire. */
  visible?: boolean;
  /** Passed through to {@link ThreadPopover}. */
  mentionCandidates?: MentionCandidate[];
  /** Passed through to {@link ThreadPopover}. */
  onGoToAuthorView?: (pinId: string) => void;
}

/** CSS px to nudge each handle outward, so it straddles the stroke and the `nw`
 * handle clears the anchor dot. Cosmetic: resize math uses the cursor's world
 * point. */
const HANDLE_OUTSET = 9;

/** How long handles linger after the pointer leaves, so they don't flicker off
 * when the cursor crosses the gap between a shape and a handle. */
const HANDLE_HOVER_LINGER_MS = 300;

/** Directional resize cursor per handle. */
const HANDLE_CURSOR: Record<BoxHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  w: "ew-resize",
  e: "ew-resize",
};

/** A gesture on an own marker, for one captured pointer. The marker sits over
 * the canvas and captures the press, so it drives both gestures: `move`
 * (Shift+drag, one `move_annotation` on release) and `pan` (plain drag, the
 * canvas's own viewport pan, never moving the pin). */
interface PinDrag {
  pinId: string;
  pointerId: number;
  /** Fixed at pointerdown from Shift. */
  mode: "move" | "pan";
  /** Press point in CSS px (clientX/Y), to measure travel against the slop. */
  startX: number;
  startY: number;
  /** Last pointer position in CSS px; a pan applies the delta since the last
   * event. */
  lastX: number;
  lastY: number;
  /** The pin's depth at press; preserved across a move (z is not edited). */
  z: number;
  /** True once travel passes the slop. */
  moved: boolean;
}

/** A box's two corners or a line's two endpoints. Both are `{position, end}`,
 * so one reshape path carries either. */
type ShapeVertices = BoxCorners & LineEndpoints;

/** A reshape gesture on an own shape's handle, for one captured pointer. Boxes
 * (eight handles) and lines (two) share the gesture; `kind` picks the
 * recompute. A handle never pans: release emits one reshape `move_annotation`. */
interface HandleDrag {
  pinId: string;
  pointerId: number;
  kind: "box" | "line";
  handle: BoxHandle | LineHandle;
  /** Press point in CSS px (clientX/Y), to measure travel against the slop. */
  startX: number;
  startY: number;
  /** Vertices at press. Every recompute builds on them, so the other handle
   * never drifts. */
  base: ShapeVertices;
  /** Depth at press; a 2D handle drag doesn't edit z. */
  z: number;
  /** True once travel passes the slop. */
  moved: boolean;
  /** Live vertices while dragging, null until past the slop. The tick previews
   * from this; release commits. */
  preview: ShapeVertices | null;
}

/** A box moves the coordinates its handle owns; a line moves only the grabbed
 * endpoint. */
function reshapeShape(
  kind: "box" | "line",
  base: ShapeVertices,
  handle: BoxHandle | LineHandle,
  world: [number, number],
): ShapeVertices {
  return kind === "box"
    ? reshapeBox(base, handle as BoxHandle, world)
    : reshapeLine(base, handle as LineHandle, world);
}

/** An own box with a second vertex, eligible for resize handles. */
function isOwnBox(pin: Annotation, myId: string): boolean {
  return pin.kind === "box" && (pin.end ?? null) !== null && pin.author === String(myId);
}

/** An own line with a far endpoint, eligible for endpoint handles. */
function isOwnLine(pin: Annotation, myId: string): boolean {
  return pin.kind === "line" && (pin.end ?? null) !== null && pin.author === String(myId);
}

/** Whether hovering this shape reveals handles: an own box or line. */
function isOwnHandledShape(pin: Annotation, myId: string): boolean {
  return isOwnBox(pin, myId) || isOwnLine(pin, myId);
}

/** A non-point pin's two vertices, or null for a degenerate shape. */
function shapeVertices(pin: Annotation): ShapeVertices | null {
  const end = pin.end ?? null;
  if (!end) return null;
  return { position: [pin.position[0], pin.position[1]], end: [end[0], end[1]] };
}

export const AnnotationOverlay = forwardRef<AnnotationOverlayHandle, Props>(function AnnotationOverlay({ datasetId, wasmSceneRef, canvas, version, viewContext, myId, sendCommand, onDocumentChanged, onViewportChanged, visible = true, mentionCandidates = [], onGoToAuthorView }: Props, ref) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Line and box elements, re-projected each frame through the same math as
  // the dot.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  // The pin set and open thread, with the lifecycle shared with the 3D overlay.
  const { annotations, annotationsRef, openPinId, setOpenPinId } = useAnnotationOverlay({
    wasmSceneRef,
    datasetId,
    version,
    visible,
  });

  // A ref so handlers mutate it without re-rendering mid-drag.
  const dragRef = useRef<PinDrag | null>(null);
  // After a real drag, swallow the trailing click so the thread doesn't toggle
  // on drop. Cleared once consumed.
  const suppressClickRef = useRef<string | null>(null);

  // The tick reads its `preview`. At most one handle drags at a time.
  const handleDragRef = useRef<HandleDrag | null>(null);
  // Keyed `${pinId}:${handle}` so the tick can reproject each handle.
  const handleRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // The hovered own shape whose handles are revealed, or null. This state, not
  // the pin set, decides whether a shape's `annot-resize-<id>-<h>` nodes exist.
  // One shape is hovered at a time, so one id suffices.
  const [activeShapeId, setActiveShapeId] = useState<string | null>(null);
  // Pending hide (hysteresis). Re-entering the shape or a handle clears it.
  const hideHandlesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shape and handle pointer-enter both call this, so crossing the gap to a
  // handle keeps the set alive.
  const revealHandles = (pinId: string) => {
    if (hideHandlesTimer.current !== null) {
      clearTimeout(hideHandlesTimer.current);
      hideHandlesTimer.current = null;
    }
    setActiveShapeId((cur) => (cur === pinId ? cur : pinId));
  };

  // Hide after the linger, only if the shape is still active. A cursor that
  // drifts past an edge re-enters and cancels this first.
  const scheduleHideHandles = (pinId: string) => {
    if (hideHandlesTimer.current !== null) clearTimeout(hideHandlesTimer.current);
    hideHandlesTimer.current = setTimeout(() => {
      hideHandlesTimer.current = null;
      // Never hide under an in-flight reshape: a captured drag fires leave
      // events, but the handle must survive until release.
      if (handleDragRef.current?.pinId === pinId) return;
      setActiveShapeId((cur) => (cur === pinId ? null : cur));
    }, HANDLE_HOVER_LINGER_MS);
  };

  // Clear any pending hide timer on unmount so a fired callback can't touch a
  // torn-down component.
  useEffect(
    () => () => {
      if (hideHandlesTimer.current !== null) clearTimeout(hideHandlesTimer.current);
    },
    [],
  );

  // Hiding also drops the hover reveal and any pending hide, so a re-show
  // doesn't flash handles on a shape the cursor has left.
  useEffect(() => {
    if (!visible) {
      // Deliberately syncs transient state to a prop change.
      setActiveShapeId(null);
      if (hideHandlesTimer.current !== null) {
        clearTimeout(hideHandlesTimer.current);
        hideHandlesTimer.current = null;
      }
    }
  }, [visible]);

  // Drop the hover if its shape vanishes from under the cursor, so its handles
  // can't linger as orphans.
  useEffect(() => {
    if (activeShapeId !== null && !annotations.some((p) => p.id === activeShapeId)) {
      // Deliberate reset driven by external data, not derived render state.
       
      setActiveShapeId(null);
    }
  }, [annotations, activeShapeId]);

  // Lets a host jump to a pin from outside, e.g. a "mentions of me" item. It
  // opens the thread and recenters with a local `set_center`, since recentering
  // is viewport state. A missing pin or unready scene is a no-op.
  useImperativeHandle(
    ref,
    () => ({
      focusPin: (pinId: string) => {
        const pin = annotationsRef.current.find((p) => p.id === pinId);
        if (!pin) return;
        setOpenPinId(pin.id);
        const scene = wasmSceneRef.current;
        if (scene) {
          applyViewportCommand(scene, {
            type: "set_center",
            x: pin.position[0],
            y: pin.position[1],
          });
          // Repaint under the recentered camera; the pull-based loop won't
          // otherwise.
          onViewportChanged?.();
        }
      },
    }),
    [wasmSceneRef, onViewportChanged, annotationsRef, setOpenPinId],
  );

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        // World to screen in CSS px, the inverse of the shared screen-to-world,
        // with the camera snapshotted once per frame.
        const project = makeWorldToScreen(scene, canvas);

        // pointermove positions a dot being Shift-moved; reprojecting its stale
        // stored position would snap it back every frame. A pan doesn't move the
        // pin, so its dot keeps reprojecting.
        const activeDrag = dragRef.current;
        const draggingId =
          activeDrag?.moved && activeDrag.mode === "move" ? activeDrag.pinId : null;
        // A reshape in flight previews from the dragged vertices.
        const resize = handleDragRef.current;
        const resizingId = resize?.moved && resize.preview ? resize.pinId : null;

        for (const pin of annotationsRef.current) {
          // Anchor dot (the interaction target) sits at the first vertex.
          const el = dotRefs.current.get(pin.id);
          if (el && pin.id !== draggingId) {
            const [ax, ay] = project(pin.position);
            el.style.transform = `translate(${ax}px, ${ay}px)`;
          }
          // Geometry and handles both use these, so they stay coincident.
          const liveVertices: ShapeVertices | null =
            pin.id === resizingId && resize?.preview ? resize.preview : shapeVertices(pin);
          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            const previewPin =
              pin.id === resizingId && liveVertices
                ? { ...pin, position: liveVertices.position, end: liveVertices.end }
                : pin;
            const pts = annotationVertices(previewPin).map(project);
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
          if (!liveVertices) continue;
          if (pin.kind === "box") {
            // Each handle is nudged outward from the box center, which lifts the
            // `nw` handle off the anchor dot at `position`, so a click or a
            // whole-shape Shift+drag still lands on the dot. Release math uses
            // eventToWorld, never this offset.
            const [cx, cy] = project([
              (liveVertices.position[0] + liveVertices.end[0]) / 2,
              (liveVertices.position[1] + liveVertices.end[1]) / 2,
            ]);
            for (const h of BOX_HANDLES) {
              const handleEl = handleRefs.current.get(`${pin.id}:${h}`);
              if (!handleEl) continue;
              const [hx, hy] = project(boxHandlePoint(liveVertices, h));
              const ox = hx - cx;
              const oy = hy - cy;
              const len = Math.hypot(ox, oy);
              // A zero-size box has no outward direction: no offset.
              const nx = len > 0.001 ? (ox / len) * HANDLE_OUTSET : 0;
              const ny = len > 0.001 ? (oy / len) * HANDLE_OUTSET : 0;
              handleEl.style.transform = `translate(${hx + nx}px, ${hy + ny}px)`;
            }
          } else if (pin.kind === "line") {
            // Each grip is nudged outward along the line's axis, away from the
            // other end, so the `start` grip clears the anchor dot as the box
            // handles do. Cosmetic only.
            const [sx, sy] = project(liveVertices.position);
            const [ex, ey] = project(liveVertices.end);
            // `start` outsets along the negated axis, `end` along the axis. A
            // zero-length line gets no offset.
            const ax = ex - sx;
            const ay = ey - sy;
            const len = Math.hypot(ax, ay);
            const ux = len > 0.001 ? ax / len : 0;
            const uy = len > 0.001 ? ay / len : 0;
            for (const h of LINE_HANDLES) {
              const handleEl = handleRefs.current.get(`${pin.id}:${h}`);
              if (!handleEl) continue;
              const [hx, hy] = project(lineHandlePoint(liveVertices, h));
              const sign = h === "start" ? -1 : 1;
              const ox = sign * ux * HANDLE_OUTSET;
              const oy = sign * uy * HANDLE_OUTSET;
              handleEl.style.transform = `translate(${hx + ox}px, ${hy + oy}px)`;
            }
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas, annotationsRef]);

  /** The shared inverse projection, tolerating an unready scene, so a moved pin
   * lands in the world frame add_annotation stores. */
  const pointerWorld = (e: ClientPoint): [number, number] => {
    const scene = wasmSceneRef.current;
    return scene ? eventToWorld(scene, canvas, e) : [0, 0];
  };

  // Pin gesture. The own marker captures the press, so it drives both gestures
  // with Pointer Events bound to it. Moving needs Shift because a plain drag is
  // too easy to trigger while panning; a plain drag pans like empty canvas. A
  // press that never passes the slop is a click: plain toggles the thread,
  // Shift does nothing.

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    // Only the author gets a gesture, on a primary press. Peers' markers have no
    // handlers, so they only click.
    if (pin.author !== String(myId)) return;
    if (e.button !== 0) return;
    // Ignore a second pointer mid-gesture so the first completes.
    if (dragRef.current) return;
    // Clear stale suppression from a drag that never got its trailing click.
    suppressClickRef.current = null;
    dragRef.current = {
      pinId: pin.id,
      pointerId: e.pointerId,
      // Fixed at press so releasing Shift mid-drag can't flip a pan into a move.
      mode: e.shiftKey ? "move" : "pan",
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      z: pin.z ?? 0,
      moved: false,
    };
    // Bind the pointer to the marker so move/up land here through the drag.
    capturePointer(e.currentTarget as Element, e.pointerId);
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    // No pointerId check: capture already guarantees it in a browser, and some
    // harnesses don't echo the id on every event.
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      // Still within the click slop.
      if (!exceedsClickSlop(drag.startX, drag.startY, e.clientX, e.clientY)) return;
      drag.moved = true;
    }

    if (drag.mode === "pan") {
      // Pan like SliceViewer: travel since the last event, scaled by dpr and
      // negated. Local only, since a pan is viewport state.
      const dpr = devicePixelRatio;
      const dx = (e.clientX - drag.lastX) * dpr;
      const dy = (e.clientY - drag.lastY) * dpr;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      const scene = wasmSceneRef.current;
      if (scene) {
        applyViewportCommand(scene, { type: "pan", dx: -dx, dy: -dy });
        // Repaint under the panned camera, like SliceViewer's
        // markInteractiveDirty.
        onViewportChanged?.();
      }
      return;
    }

    // Move: preview the dot under the cursor. The tick skips it while the drag
    // is live, and release commits the position.
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
    // Release the pointer we actually captured (its id from pointerdown).
    releasePointer(e.currentTarget as Element, drag.pointerId);

    // A pan never moves the pin. If it traveled, swallow the trailing click; if
    // not, it is a click, so let onClick toggle the thread.
    if (drag.mode === "pan") {
      if (drag.moved) suppressClickRef.current = pin.id;
      return;
    }

    // A Shift-press that never passed the slop does nothing. Swallow its click
    // so it can't open the thread.
    if (!drag.moved) {
      suppressClickRef.current = pin.id;
      return;
    }
    // Emit one move_annotation and swallow the trailing click.
    suppressClickRef.current = pin.id;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    emitMoveAnnotation(
      scene,
      { datasetId, id: pin.id, position: pointerWorld(e), z: drag.z },
      sendCommand,
    );
    onDocumentChanged();
  };

  const onPinPointerCancel = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    // A cancelled gesture (e.g. the OS stealing the pointer) never moves the pin;
    // the tick snaps the dot back.
    const captured = drag.pointerId;
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, captured);
  };

  // Reshape gesture. Each handle captures its own press, like the anchor dot.
  // A handle never pans or moves the whole shape: release emits one reshape
  // `move_annotation {position, end}`. The same handlers serve boxes and lines.

  const onHandlePointerDown =
    (pin: Annotation, handle: BoxHandle | LineHandle) => (e: ReactPointerEvent) => {
      // Belt-and-suspenders author gate (handles aren't rendered for peers).
      if (!isOwnHandledShape(pin, myId)) return;
      if (e.button !== 0) return;
      // Let an in-flight gesture finish rather than racing it.
      if (dragRef.current || handleDragRef.current) return;
      const base = shapeVertices(pin);
      if (!base) return;
      // A handle press must not also reach the anchor-dot gesture or the canvas
      // beneath: it owns this pointer outright.
      e.stopPropagation();
      // Keep the shape active for the whole drag, so leave events can't unmount
      // the captured handle.
      revealHandles(pin.id);
      handleDragRef.current = {
        pinId: pin.id,
        pointerId: e.pointerId,
        // Fixed at press so a re-read mid-drag can't switch it.
        kind: pin.kind === "line" ? "line" : "box",
        handle,
        startX: e.clientX,
        startY: e.clientY,
        base,
        z: pin.z ?? 0,
        moved: false,
        preview: null,
      };
      capturePointer(e.currentTarget as Element, e.pointerId);
    };

  const onHandlePointerMove =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      if (!drag.moved) {
        // Still within the click slop.
        if (!exceedsClickSlop(drag.startX, drag.startY, e.clientX, e.clientY)) return;
        drag.moved = true;
      }
      // Recompute from the press-time base, never the running preview, so the
      // held vertex doesn't drift.
      const world = pointerWorld(e);
      drag.preview = reshapeShape(drag.kind, drag.base, drag.handle, world);
    };

  const onHandlePointerUp =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      handleDragRef.current = null;
      releasePointer(e.currentTarget as Element, drag.pointerId);
      // Re-arm the hide. The in-flight guard swallowed every hide during the
      // captured drag, so a release off the shape would otherwise strand the
      // handles. A release over the shape is fine: the capture release fires
      // pointerenter, which cancels the hide. Before the slop check so even a
      // tiny drag can't strand them.
      scheduleHideHandles(pin.id);
      // A press that never crossed the slop is a no-op; a handle has no click.
      if (!drag.moved) return;
      // One reshape carrying both vertices. A line drag moves only the grabbed
      // end.
      const vertices = reshapeShape(drag.kind, drag.base, drag.handle, pointerWorld(e));
      const scene = wasmSceneRef.current;
      if (!scene) return;
      emitMoveAnnotation(
        scene,
        { datasetId, id: pin.id, position: vertices.position, end: vertices.end, z: drag.z },
        sendCommand,
      );
      onDocumentChanged();
    };

  const onHandlePointerCancel =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      const captured = drag.pointerId;
      handleDragRef.current = null;
      releasePointer(e.currentTarget as Element, captured);
      // Cancelled: never reshape; the tick snaps back. Re-arm the hide as on
      // release; no enter will fire to cancel it.
      scheduleHideHandles(pin.id);
    };

  // After every hook, so hook order stays stable.
  if (!visible) return null;

  return (
    <div className="lc-annotation-layer">
      {/* One SVG element per line or box, beneath the DOM markers. The tick
          rewrites their coordinates every frame. */}
      <svg className="lc-annotation-svg" width="100%" height="100%">
        {annotations.map((pin) => {
          if (pin.kind !== "line" && pin.kind !== "box") return null;
          if (!pin.end) return null;
          // Only an own box or line reveals handles on hover; a peer's stays
          // inert.
          const hoverable = isClosedShape(pin) ? isOwnBox(pin, myId) : isOwnLine(pin, myId);
          const shapeProps = {
            className: "lc-annotation-shape",
            "data-testid": `annot-shape-${pin.id}`,
            "data-author": pin.author === String(myId) ? "own" : "peer",
            // Dimmed off-context, like the dot.
            "data-off-context": isOffContext(pin, viewContext) || undefined,
            "data-hoverable": hoverable || undefined,
            onPointerEnter: hoverable ? () => revealHandles(pin.id) : undefined,
            onPointerLeave: hoverable ? () => scheduleHideHandles(pin.id) : undefined,
          };
          if (isClosedShape(pin)) {
            return (
              <polygon
                key={pin.id}
                {...shapeProps}
                ref={(el) => {
                  if (el) shapeRefs.current.set(pin.id, el);
                  else shapeRefs.current.delete(pin.id);
                }}
                points=""
              />
            );
          }
          return (
            <line
              key={pin.id}
              {...shapeProps}
              ref={(el) => {
                if (el) shapeRefs.current.set(pin.id, el);
                else shapeRefs.current.delete(pin.id);
              }}
              x1={0}
              y1={0}
              x2={0}
              y2={0}
            />
          );
        })}
      </svg>
      {/* Resize handles: eight per own box, DOM nodes because they need pointer
          capture. They render only while the box is hovered and its thread is
          closed, so an idle box has no `annot-resize-<id>-<h>` nodes and an
          open thread is never covered. */}
      {annotations.map((pin) => {
        if (!isOwnBox(pin, myId)) return null;
        if (activeShapeId !== pin.id) return null;
        if (openPinId === pin.id) return null;
        return BOX_HANDLES.map((h) => (
          <div
            key={`${pin.id}:${h}`}
            className="lc-annotation-handle"
            data-testid={`annot-resize-${pin.id}-${h}`}
            title={`Resize this box (${h})`}
            ref={(el) => {
              if (el) handleRefs.current.set(`${pin.id}:${h}`, el);
              else handleRefs.current.delete(`${pin.id}:${h}`);
            }}
            onPointerDown={onHandlePointerDown(pin, h)}
            onPointerMove={onHandlePointerMove(pin)}
            onPointerUp={onHandlePointerUp(pin)}
            onPointerCancel={onHandlePointerCancel(pin)}
            // Handles join the shape's hover region: entering cancels a pending
            // hide, leaving re-arms it.
            onPointerEnter={() => revealHandles(pin.id)}
            onPointerLeave={() => scheduleHideHandles(pin.id)}
            style={{ transform: "translate(0px, 0px)", cursor: HANDLE_CURSOR[h] }}
          />
        ));
      })}
      {/* Endpoint handles: two per own line. Dragging one moves only that end.
          Same hover gating as the box handles. */}
      {annotations.map((pin) => {
        if (!isOwnLine(pin, myId)) return null;
        if (activeShapeId !== pin.id) return null;
        if (openPinId === pin.id) return null;
        return LINE_HANDLES.map((h) => (
          <div
            key={`${pin.id}:${h}`}
            className="lc-annotation-handle"
            data-testid={`annot-resize-${pin.id}-${h}`}
            title={`Adjust this line's ${h === "start" ? "start" : "end"} point`}
            ref={(el) => {
              if (el) handleRefs.current.set(`${pin.id}:${h}`, el);
              else handleRefs.current.delete(`${pin.id}:${h}`);
            }}
            onPointerDown={onHandlePointerDown(pin, h)}
            onPointerMove={onHandlePointerMove(pin)}
            onPointerUp={onHandlePointerUp(pin)}
            onPointerCancel={onHandlePointerCancel(pin)}
            // Same hover region as the box handles.
            onPointerEnter={() => revealHandles(pin.id)}
            onPointerLeave={() => scheduleHideHandles(pin.id)}
            // An endpoint moves freely in both axes.
            style={{ transform: "translate(0px, 0px)", cursor: "move" }}
          />
        ));
      })}
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        // Pure in pin and viewContext, so navigating to the pin's Z/T/C restores
        // it with no state to clear. The marker stays clickable.
        const offCtx = isOffContext(pin, viewContext);
        return (
          <div
            key={pin.id}
            className="lc-annotation-anchor"
            data-testid={`annot-pin-wrapper-${pin.id}`}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            style={{
              // The marker is positioned via transform each frame; the popover
              // is an absolutely-positioned child anchored to it.
              transform: "translate(0px, 0px)",
              // Dimmed like an off-view peer cursor. An open thread is never
              // dimmed.
              opacity: offCtx && !isOpen ? 0.5 : 1,
              // Pins share one layer, so a later pin's dot would paint over an
              // earlier pin's open popover. Lift only the open pin.
              zIndex: isOpen ? 2 : 1,
            }}
          >
            {/* Every pin's dot opens its thread on click. For the author it also
                drives the gestures: a plain drag pans, Shift+drag moves. Delete
                lives in the thread behind a confirm. */}
            <div
              className="lc-annotation-pin"
              data-testid={`annot-pin-${pin.id}`}
              data-author={mine ? "own" : "peer"}
              data-off-context={offCtx || undefined}
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
                // Swallow the click after a real drag or a stationary
                // Shift-press, once.
                if (suppressClickRef.current === pin.id) {
                  suppressClickRef.current = null;
                  return;
                }
                setOpenPinId((cur) => (cur === pin.id ? null : pin.id));
              }}
              style={{
                // Own pins show the canvas's grab cursor, since a plain drag pans.
                cursor: mine ? "grab" : "pointer",
                touchAction: mine ? "none" : undefined,
              }}
            />
            {offCtx && <OffContextHelptext pin={pin} />}
            <CommentCountBadge
              count={comments.length}
              onToggleThread={() => setOpenPinId((cur) => (cur === pin.id ? null : pin.id))}
            />

            {/* Keyed by pin id so draft, edit, and confirm state reset on switch. */}
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
                mentionCandidates={mentionCandidates}
                onGoToAuthorView={onGoToAuthorView}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
