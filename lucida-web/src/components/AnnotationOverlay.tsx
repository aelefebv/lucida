/**
 * DOM overlay for annotations and their comment threads in the 2D slice view.
 *
 * Like `PeerCursors`, it is a `pointerEvents: none` layer whose markers are
 * re-projected from world space every frame, so pins stay glued to the data
 * across pan and zoom for every peer. Annotation state lives in the WASM scene
 * and is read through `scene.annotations(datasetId)`, never copied here.
 *
 * Editing is select-then-drag, so it needs neither hover nor a modifier key: a
 * tap or click selects one's own shape or pin, a selected one moves by
 * dragging and a shape reshapes by its handles, and a tap on empty canvas
 * deselects. Hover-revealed handles and Shift+drag still work with a mouse.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyViewportCommand } from "../applyAndSend.ts";
import { frameClock, useWakeFramesOnRender } from "../frameClock.ts";
import { usePointerCoarse } from "../theme/viewport.ts";
import { buildAnnotationView } from "../savedView/buildAnnotationView.ts";
import type { Annotation } from "./annotationDocument.ts";
import { useAnnotationOverlay } from "./useAnnotationOverlay.ts";
import { useAnnotationEditing, type AnnotationPlacement } from "./useAnnotationEditing.ts";
import {
  capturePointer,
  emitMoveAnnotation,
  exceedsPressSlop,
  forwardPressToCanvas,
  releasePointer,
  startLongPress,
  useCanvasTaps,
} from "./annotationInteraction.ts";
import { eventToFrame, makeFrameToScreen, type ClientPoint, type ViewSurface } from "./cameraProjection.ts";
import { frameToScene, readPlaneMap } from "../placement.ts";
import { CommentCountBadge, OffContextHelptext } from "./AnnotationPinBadges.tsx";
import { AnnotationContextMenu, type CanvasMenuRequest } from "./AnnotationContextMenu.tsx";
import {
  annotationVertices,
  hitTestShapes,
  isClosedShape,
  translateShape,
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
  type ScreenPoint,
} from "./annotationGeometry.ts";
import { isOffContext, pinLabel, type ViewContext } from "./annotationContext.ts";
import type { Tool } from "./annotationTool.ts";
import { ThreadPopover } from "./ThreadPopover.tsx";
import type { MentionCandidate } from "./annotationMentions.ts";

import type { AnnotationOverlayHandle } from "./annotationDocument.ts";
import "./AnnotationOverlay.css";

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  /** The view whose pins show, and the element over its rectangle, which they sit in. */
  surface: ViewSurface;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** The current Z/T/C. A pin that differs on any axis renders off-context:
   * dimmed, with a locator naming where it lives. */
  viewContext: ViewContext;
  /** The browser-persisted author identity from `annotationAuthorId()`, not the
   * per-connection `myId`, so a pin authored here stays mine across
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
  /** The canvas tool. A tap selects only with the pan tool, since a drawing
   * tool's tap draws. */
  tool?: Tool;
  /** Passed through to {@link ThreadPopover}. */
  mentionCandidates?: MentionCandidate[];
  /** Passed through to {@link ThreadPopover}. */
  onGoToAuthorView?: (pinId: string) => void;
}

/** CSS px to nudge each handle outward, so it straddles the stroke and the `nw`
 * handle clears the anchor dot. Cosmetic: resize math uses the cursor's world
 * point. A finger's larger handles sit farther out, so more of their hit area
 * lies outside the shape, where a drag would otherwise move the whole shape. */
const HANDLE_OUTSET = 9;
const COARSE_HANDLE_OUTSET = 14;

/** How far (CSS px) a tap may land from a stroke and still select its shape. */
const TAP_TOLERANCE = 6;
const TOUCH_TAP_TOLERANCE = 22;

/** Corner handles only under a finger: eight 44 px targets crowd a small box. */
const COARSE_BOX_HANDLES: readonly BoxHandle[] = ["nw", "ne", "se", "sw"];

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

/** A gesture on a marker, for one captured pointer. `move` drags one's own pin
 * (when it is selected, or with Shift), sending one `move_annotation` on
 * release. `pan` is a mouse's plain drag on an unselected own pin, which pans
 * the viewport as the canvas would. `forward` hands a finger's drag to the
 * canvas once it passes the slop, so it pans and pinches as the canvas does. */
interface PinDrag {
  pinId: string;
  pointerId: number;
  pointerType: string;
  /** Fixed at pointerdown. */
  mode: "move" | "pan" | "forward";
  /** Whether Shift was held at the press, which makes a stationary press
   * nothing rather than a click. */
  shift: boolean;
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
  /** The dragged anchor's world point while a move is under way. */
  preview: [number, number] | null;
  cancelLongPress: () => void;
}

/** A box's two corners or a line's two endpoints. Both are `{position, end}`,
 * so one reshape path carries either. */
type ShapeVertices = BoxCorners & LineEndpoints;

/** A drag on one's own shape, for one captured pointer: a handle reshapes it,
 * and `body` (the selected shape itself) moves it whole. Release emits one
 * `move_annotation`, with `end` for a reshape and without for a move. */
interface HandleDrag {
  pinId: string;
  pointerId: number;
  pointerType: string;
  kind: "box" | "line";
  handle: BoxHandle | LineHandle | "body";
  /** Press point in CSS px (clientX/Y), to measure travel against the slop. */
  startX: number;
  startY: number;
  /** The press in world space, which a body drag measures its travel from. */
  startWorld: [number, number];
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
  cancelLongPress: () => void;
}

/** The vertices a drag to `world` gives: a box handle moves the coordinates it
 * owns, a line handle only its endpoint, and the body everything. */
function dragShape(drag: HandleDrag, world: [number, number]): ShapeVertices {
  if (drag.handle === "body") {
    return translateShape(drag.base, [world[0] - drag.startWorld[0], world[1] - drag.startWorld[1]]);
  }
  return drag.kind === "box"
    ? reshapeBox(drag.base, drag.handle as BoxHandle, world)
    : reshapeLine(drag.base, drag.handle as LineHandle, world);
}

/** An own box with a second vertex, eligible for resize handles. */
function isOwnBox(pin: Annotation, myId: string): boolean {
  return pin.kind === "box" && (pin.end ?? null) !== null && pin.author === String(myId);
}

/** An own line with a far endpoint, eligible for endpoint handles. */
function isOwnLine(pin: Annotation, myId: string): boolean {
  return pin.kind === "line" && (pin.end ?? null) !== null && pin.author === String(myId);
}

/** Whether this shape has handles to edit: an own box or line. */
function isOwnHandledShape(pin: Annotation, myId: string): boolean {
  return isOwnBox(pin, myId) || isOwnLine(pin, myId);
}

/** A non-point pin's two vertices, or null for a degenerate shape. */
function shapeVertices(pin: Annotation): ShapeVertices | null {
  const end = pin.end ?? null;
  if (!end) return null;
  return { position: [pin.position[0], pin.position[1]], end: [end[0], end[1]] };
}

/** Points for an SVG polygon or line from projected vertices. */
function setShapeGeometry(el: SVGLineElement | SVGPolygonElement, pts: ScreenPoint[], closed: boolean): void {
  if (closed) {
    el.setAttribute("points", pts.map((p) => `${p[0]},${p[1]}`).join(" "));
  } else if (pts.length >= 2) {
    el.setAttribute("x1", String(pts[0][0]));
    el.setAttribute("y1", String(pts[0][1]));
    el.setAttribute("x2", String(pts[1][0]));
    el.setAttribute("y2", String(pts[1][1]));
  }
}

export const AnnotationOverlay = forwardRef<AnnotationOverlayHandle, Props>(function AnnotationOverlay({ datasetId, wasmSceneRef, surface, version, viewContext, myId, sendCommand, onDocumentChanged, onViewportChanged, visible = true, tool = "pan", mentionCandidates = [], onGoToAuthorView }: Props, ref) {
  // The view's own element: its pixels and its pointer events.
  const { element } = surface;
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Line and box elements, re-projected each frame through the same math as
  // the dot.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  // The selected shape's own hit target, wider than its stroke, which a drag
  // moves. At most one shape is selected.
  const bodyRef = useRef<SVGLineElement | SVGPolygonElement | null>(null);
  // The pin set, open thread, and selection, with the lifecycle shared with
  // the 3D overlay.
  const overlay = useAnnotationOverlay({
    wasmSceneRef,
    datasetId,
    version,
    visible,
  });
  const { annotations, annotationsRef, openPinId, setOpenPinId, selectedId, setSelectedId } = overlay;
  const editing = useAnnotationEditing({ state: overlay, datasetId, myId, wasmSceneRef, sendCommand, onDocumentChanged });
  const coarse = usePointerCoarse();
  const [menu, setMenu] = useState<CanvasMenuRequest | null>(null);

  // Mirrors for the RAF tick, written after each commit.
  const selectedIdRef = useRef(selectedId);
  const handleOutsetRef = useRef(HANDLE_OUTSET);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    handleOutsetRef.current = coarse ? COARSE_HANDLE_OUTSET : HANDLE_OUTSET;
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

  // The hovered own shape whose handles are revealed, or null. With the
  // selection, this decides whether a shape's `annot-resize-<id>-<h>` nodes
  // exist. One shape is hovered at a time, so one id suffices.
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

  /** The shared inverse projection, tolerating an unready scene, so a moved pin
   * lands in the dataset frame add_annotation stores. */
  const pointerWorld = (e: ClientPoint): [number, number] => {
    const scene = wasmSceneRef.current;
    return scene ? eventToFrame(scene, surface, e, datasetId) : [0, 0];
  };

  /** One's own line or box under a client point, or null. */
  const ownShapeAt = (point: ClientPoint, tolerance: number): string | null => {
    const scene = wasmSceneRef.current;
    if (!scene) return null;
    const project = makeFrameToScreen(scene, surface, datasetId);
    const rect = element.getBoundingClientRect();
    const shapes = annotationsRef.current
      .filter((pin) => isOwnHandledShape(pin, myId))
      .map((pin) => ({ id: pin.id, points: annotationVertices(pin).map(project), closed: isClosedShape(pin) }));
    return hitTestShapes([point.clientX - rect.left, point.clientY - rect.top], shapes, tolerance);
  };

  /** Open the canvas menu at a client point. A press on one's own annotation
   * selects it, so the menu can delete it; a press elsewhere deselects. */
  const openMenu = (point: ClientPoint, pointerType: string, pinId?: string) => {
    if (visible) {
      if (pinId !== undefined) {
        const pin = annotationsRef.current.find((p) => p.id === pinId);
        setSelectedId(pin && pin.author === String(myId) ? pinId : null);
      } else {
        setSelectedId(ownShapeAt(point, pointerType === "touch" ? TOUCH_TAP_TOLERANCE : TAP_TOLERANCE));
      }
    }
    const scene = wasmSceneRef.current;
    setMenu({
      x: point.clientX,
      y: point.clientY,
      target: scene ? { position: eventToFrame(scene, surface, point, datasetId), z: viewContext.z } : null,
    });
  };

  // Read by the canvas listener, which binds once.
  const openMenuRef = useRef(openMenu);
  useEffect(() => {
    openMenuRef.current = openMenu;
  });

  // A right-click on the canvas opens the menu. A finger's long press arrives
  // through `openContextMenu` from the viewer's gesture recognizer instead.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const pointerType = (e as PointerEvent).pointerType ?? "mouse";
      if (pointerType === "touch") return;
      e.preventDefault();
      openMenuRef.current(e, pointerType);
    };
    element.addEventListener("contextmenu", onContextMenu);
    return () => element.removeEventListener("contextmenu", onContextMenu);
  }, [element]);

  // A tap or click on the canvas selects one's own shape under it, or clears
  // the selection on empty element. Pins take their own taps.
  useCanvasTaps(element, (tap) => {
    if (!visible) return;
    if (tool !== "pan" || tap.shiftKey) {
      setSelectedId(null);
      return;
    }
    setSelectedId(ownShapeAt(tap, tap.pointerType === "touch" ? TOUCH_TAP_TOLERANCE : TAP_TOLERANCE));
  });

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
          const [x, y] = frameToScene(readPlaneMap(scene, datasetId), pin.position);
          applyViewportCommand(scene, { type: "set_center", x, y });
          // Repaint under the recentered camera; the pull-based loop won't
          // otherwise.
          onViewportChanged?.();
        }
      },
      openContextMenu: (at: ClientPoint) => openMenuRef.current(at, "touch"),
    }),
    [wasmSceneRef, onViewportChanged, annotationsRef, setOpenPinId, datasetId],
  );

  // A new or changed pin needs a frame to be placed.
  useWakeFramesOnRender();
  useEffect(() => {
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        // Frame to screen in CSS px, the inverse of the shared screen-to-frame,
        // with the camera snapshotted once per frame.
        const project = makeFrameToScreen(scene, surface, datasetId);

        // A pin being moved previews at the pointer, carrying its shape along;
        // a pan doesn't move the pin, so its dot keeps reprojecting.
        const activeDrag = dragRef.current;
        const pinMove = activeDrag?.moved && activeDrag.mode === "move" && activeDrag.preview ? activeDrag : null;
        // A reshape or body move in flight previews from the dragged vertices.
        const resize = handleDragRef.current;
        const resizingId = resize?.moved && resize.preview ? resize.pinId : null;
        const outset = handleOutsetRef.current;

        for (const pin of annotationsRef.current) {
          // Geometry, the dot, and handles all use these, so they stay
          // coincident.
          let liveVertices: ShapeVertices | null = shapeVertices(pin);
          let anchor: [number, number] = pin.position;
          if (pin.id === resizingId && resize?.preview) {
            liveVertices = resize.preview;
            anchor = liveVertices.position;
          } else if (pinMove && pin.id === pinMove.pinId && pinMove.preview) {
            const to = pinMove.preview;
            if (liveVertices) liveVertices = translateShape(liveVertices, [to[0] - pin.position[0], to[1] - pin.position[1]]);
            anchor = to;
          }
          // Anchor dot (the interaction target) sits at the first vertex.
          const el = dotRefs.current.get(pin.id);
          if (el) {
            const [ax, ay] = project(anchor);
            el.style.transform = `translate(${ax}px, ${ay}px)`;
          }
          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            const previewPin = liveVertices ? { ...pin, position: liveVertices.position, end: liveVertices.end } : pin;
            const pts = annotationVertices(previewPin).map(project);
            setShapeGeometry(shape, pts, isClosedShape(pin));
            if (pin.id === selectedIdRef.current && bodyRef.current) {
              setShapeGeometry(bodyRef.current, pts, isClosedShape(pin));
            }
          }
          if (!liveVertices) continue;
          if (pin.kind === "box") {
            // Each handle is nudged outward from the box center, which lifts the
            // `nw` handle off the anchor dot at `position`, so a click or a
            // whole-shape Shift+drag still lands on the dot. Release math uses
            // eventToFrame, never this offset.
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
              const nx = len > 0.001 ? (ox / len) * outset : 0;
              const ny = len > 0.001 ? (oy / len) * outset : 0;
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
              const ox = sign * ux * outset;
              const oy = sign * uy * outset;
              handleEl.style.transform = `translate(${hx + ox}px, ${hy + oy}px)`;
            }
          }
        }
      }
    };
    return frameClock.subscribe(tick);
  }, [surface, wasmSceneRef, element, annotationsRef, datasetId]);

  /** A right-click on a marker or shape opens the canvas menu on it. A finger's
   * long press is timed by the gesture instead, so its native menu is only
   * suppressed. */
  const onAnnotationContextMenu = (pin: Annotation) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pointerType = (e.nativeEvent as PointerEvent).pointerType ?? "mouse";
    if (pointerType === "touch") return;
    openMenu(e, pointerType, pin.id);
  };

  // Pin gesture. The marker captures the press, so it drives every gesture
  // with Pointer Events bound to it. One's own pin moves when it is selected
  // or with Shift; otherwise a mouse drag pans and a finger's drag goes to the
  // element. A press that never passes the slop is a click: plain toggles the
  // thread and selects, Shift does nothing. A finger held still opens the menu.

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // Ignore a second pointer mid-gesture so the first completes.
    if (dragRef.current || handleDragRef.current) return;
    const mine = pin.author === String(myId);
    const touch = e.pointerType === "touch";
    const mode: PinDrag["mode"] | null =
      mine && (e.shiftKey || selectedId === pin.id) ? "move" : touch ? "forward" : mine ? "pan" : null;
    // A peer's pin under a mouse only clicks, as it always has.
    if (!mode) return;
    // Clear stale suppression from a drag that never got its trailing click.
    suppressClickRef.current = null;
    const target = e.currentTarget as Element;
    const drag: PinDrag = {
      pinId: pin.id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      mode,
      shift: e.shiftKey,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      z: pin.z ?? 0,
      moved: false,
      preview: null,
      cancelLongPress: () => {},
    };
    if (touch) {
      drag.cancelLongPress = startLongPress(() => {
        if (dragRef.current !== drag || drag.moved) return;
        dragRef.current = null;
        releasePointer(target, drag.pointerId);
        suppressClickRef.current = pin.id;
        openMenu({ clientX: drag.startX, clientY: drag.startY }, "touch", pin.id);
      });
    }
    dragRef.current = drag;
    // Bind the pointer to the marker so move/up land here through the drag.
    capturePointer(target, e.pointerId);
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    // No pointerId check: capture already guarantees it in a browser, and some
    // harnesses don't echo the id on every event.
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      // Still within the click slop.
      if (!exceedsPressSlop(drag.pointerType, drag.startX, drag.startY, e.clientX, e.clientY)) return;
      drag.moved = true;
      drag.cancelLongPress();
    }

    if (drag.mode === "forward") {
      // The canvas owns the rest, pinch included; the trailing click must not
      // toggle the thread.
      suppressClickRef.current = pin.id;
      dragRef.current = null;
      forwardPressToCanvas(e.currentTarget as Element, element, drag, e.buttons);
      return;
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

    // Move: the tick previews the pin under the pointer, and release commits.
    drag.preview = pointerWorld(e);
  };

  const onPinPointerUp = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    drag.cancelLongPress();
    dragRef.current = null;
    // Release the pointer we actually captured (its id from pointerdown).
    releasePointer(e.currentTarget as Element, drag.pointerId);

    // A press that never travelled is a click, and onClick toggles the thread;
    // a stationary Shift-press does nothing, so its click is swallowed.
    if (!drag.moved) {
      if (drag.mode === "move" && drag.shift) suppressClickRef.current = pin.id;
      return;
    }
    // A pan never moves the pin; swallow its trailing click.
    suppressClickRef.current = pin.id;
    if (drag.mode !== "move") return;
    // Emit one move_annotation.
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
    drag.cancelLongPress();
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, drag.pointerId);
  };

  // Shape gesture. Each handle captures its own press, like the anchor dot, and
  // so does the selected shape's body. Neither pans: release emits one
  // `move_annotation`. The same handlers serve boxes and lines.

  const beginShapeDrag = (pin: Annotation, handle: HandleDrag["handle"], e: ReactPointerEvent) => {
    // Belt-and-suspenders author gate (handles aren't rendered for peers).
    if (!isOwnHandledShape(pin, myId)) return;
    if (e.button !== 0) return;
    // Let an in-flight gesture finish rather than racing it.
    if (dragRef.current || handleDragRef.current) return;
    const base = shapeVertices(pin);
    if (!base) return;
    // The press must not also reach the anchor-dot gesture or the canvas
    // beneath: it owns this pointer outright.
    e.stopPropagation();
    // Keep the shape active for the whole drag, so leave events can't unmount
    // the captured handle.
    if (handle !== "body") revealHandles(pin.id);
    const target = e.currentTarget as Element;
    const drag: HandleDrag = {
      pinId: pin.id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      // Fixed at press so a re-read mid-drag can't switch it.
      kind: pin.kind === "line" ? "line" : "box",
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startWorld: pointerWorld(e),
      base,
      z: pin.z ?? 0,
      moved: false,
      preview: null,
      cancelLongPress: () => {},
    };
    if (e.pointerType === "touch") {
      drag.cancelLongPress = startLongPress(() => {
        if (handleDragRef.current !== drag || drag.moved) return;
        handleDragRef.current = null;
        releasePointer(target, drag.pointerId);
        openMenu({ clientX: drag.startX, clientY: drag.startY }, "touch", pin.id);
      });
    }
    handleDragRef.current = drag;
    capturePointer(target, e.pointerId);
  };

  const onHandlePointerDown =
    (pin: Annotation, handle: BoxHandle | LineHandle) => (e: ReactPointerEvent) =>
      beginShapeDrag(pin, handle, e);

  const onBodyPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => beginShapeDrag(pin, "body", e);

  const onHandlePointerMove =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      if (!drag.moved) {
        // Still within the click slop.
        if (!exceedsPressSlop(drag.pointerType, drag.startX, drag.startY, e.clientX, e.clientY)) return;
        drag.moved = true;
        drag.cancelLongPress();
      }
      // Recompute from the press-time base, never the running preview, so the
      // held vertex doesn't drift.
      drag.preview = dragShape(drag, pointerWorld(e));
    };

  const onHandlePointerUp =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      drag.cancelLongPress();
      handleDragRef.current = null;
      releasePointer(e.currentTarget as Element, drag.pointerId);
      // Re-arm the hide. The in-flight guard swallowed every hide during the
      // captured drag, so a release off the shape would otherwise strand the
      // handles. A release over the shape is fine: the capture release fires
      // pointerenter, which cancels the hide. Before the slop check so even a
      // tiny drag can't strand them.
      if (drag.handle !== "body") scheduleHideHandles(pin.id);
      // A press that never crossed the slop is a no-op; a handle has no click.
      if (!drag.moved) return;
      const vertices = dragShape(drag, pointerWorld(e));
      const scene = wasmSceneRef.current;
      if (!scene) return;
      // A reshape carries both vertices (a line drag moves only the grabbed
      // end); a whole-shape move carries only the anchor.
      emitMoveAnnotation(
        scene,
        drag.handle === "body"
          ? { datasetId, id: pin.id, position: vertices.position, z: drag.z }
          : { datasetId, id: pin.id, position: vertices.position, end: vertices.end, z: drag.z },
        sendCommand,
      );
      onDocumentChanged();
    };

  const onHandlePointerCancel =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      drag.cancelLongPress();
      handleDragRef.current = null;
      releasePointer(e.currentTarget as Element, drag.pointerId);
      // Cancelled: never reshape; the tick snaps back. Re-arm the hide as on
      // release; no enter will fire to cancel it.
      if (drag.handle !== "body") scheduleHideHandles(pin.id);
    };

  /** Where a new point from the menu goes, captured with the view as a drawn
   * point would be. */
  const viewForNewPoint = () => {
    const scene = wasmSceneRef.current;
    return scene ? buildAnnotationView(scene) : null;
  };
  const addPoint = (at: AnnotationPlacement, openThread: boolean) => {
    editing.addPoint(at, { t: viewContext.t, c: viewContext.channels[0] ?? 0, view: viewForNewPoint(), openThread });
    onViewportChanged?.();
  };

  const contextMenu = (
    <AnnotationContextMenu
      request={menu}
      onClose={() => setMenu(null)}
      annotationsVisible={visible}
      selected={editing.selected}
      onComment={(at) => addPoint(at, true)}
      onDropPoint={(at) => addPoint(at, false)}
      onDelete={editing.remove}
    />
  );

  // After every hook, so hook order stays stable.
  if (!visible) return contextMenu;

  const showsHandles = (pin: Annotation) =>
    (activeShapeId === pin.id || selectedId === pin.id) && openPinId !== pin.id;
  const selectedShape = annotations.find((p) => p.id === selectedId && isOwnHandledShape(p, myId)) ?? null;

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
          const hoverable = isOwnHandledShape(pin, myId);
          const shapeProps = {
            className: "lc-annotation-shape",
            "data-testid": `annot-shape-${pin.id}`,
            "data-author": pin.author === String(myId) ? "own" : "peer",
            // Dimmed off-context, like the dot.
            "data-off-context": isOffContext(pin, viewContext) || undefined,
            "data-hoverable": hoverable || undefined,
            "data-selected": selectedId === pin.id || undefined,
            onPointerEnter: hoverable ? () => revealHandles(pin.id) : undefined,
            onPointerLeave: hoverable ? () => scheduleHideHandles(pin.id) : undefined,
            // A finger that lands on the stroke itself gets what it would on
            // the canvas: a drag navigates and a long press opens the menu.
            // A mouse keeps the plain hover and click.
            onPointerDown: hoverable
              ? (e: ReactPointerEvent) => {
                  if (e.pointerType === "touch") onPinPointerDown(pin)(e);
                }
              : undefined,
            onPointerMove: hoverable ? onPinPointerMove(pin) : undefined,
            onPointerUp: hoverable ? onPinPointerUp(pin) : undefined,
            onPointerCancel: hoverable ? onPinPointerCancel(pin) : undefined,
            onClick: hoverable
              ? () => {
                  if (suppressClickRef.current === pin.id) {
                    suppressClickRef.current = null;
                    return;
                  }
                  setSelectedId(pin.id);
                }
              : undefined,
            onContextMenu: hoverable ? onAnnotationContextMenu(pin) : undefined,
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
        {/* The selected shape's drag target: its inside and a band around its
            stroke wide enough for a finger. */}
        {selectedShape && (() => {
          const bodyProps = {
            className: "lc-annotation-body",
            "data-testid": `annot-body-${selectedShape.id}`,
            ref: (el: SVGLineElement | SVGPolygonElement | null) => {
              bodyRef.current = el;
            },
            onPointerDown: onBodyPointerDown(selectedShape),
            onPointerMove: onHandlePointerMove(selectedShape),
            onPointerUp: onHandlePointerUp(selectedShape),
            onPointerCancel: onHandlePointerCancel(selectedShape),
            onContextMenu: onAnnotationContextMenu(selectedShape),
          };
          return isClosedShape(selectedShape) ? (
            <polygon key={selectedShape.id} {...bodyProps} points="" />
          ) : (
            <line key={selectedShape.id} {...bodyProps} x1={0} y1={0} x2={0} y2={0} />
          );
        })()}
      </svg>
      {/* Resize handles: eight per own box (four under a finger), DOM nodes
          because they need pointer capture. They render only while the box is
          hovered or selected and its thread is closed, so an idle box has no
          `annot-resize-<id>-<h>` nodes and an open thread is never covered. */}
      {annotations.map((pin) => {
        if (!isOwnBox(pin, myId)) return null;
        if (!showsHandles(pin)) return null;
        return (coarse ? COARSE_BOX_HANDLES : BOX_HANDLES).map((h) => (
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
            onContextMenu={onAnnotationContextMenu(pin)}
            // Handles join the shape's hover region: entering cancels a pending
            // hide, leaving re-arms it.
            onPointerEnter={() => revealHandles(pin.id)}
            onPointerLeave={() => scheduleHideHandles(pin.id)}
            style={{ transform: "translate(0px, 0px)", cursor: HANDLE_CURSOR[h] }}
          />
        ));
      })}
      {/* Endpoint handles: two per own line. Dragging one moves only that end.
          Same gating as the box handles. */}
      {annotations.map((pin) => {
        if (!isOwnLine(pin, myId)) return null;
        if (!showsHandles(pin)) return null;
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
            onContextMenu={onAnnotationContextMenu(pin)}
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
        const selected = mine && selectedId === pin.id;
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
            {/* Every pin's dot opens its thread on click, and selects one's own.
                For the author it also drives the gestures: a selected pin or a
                Shift+drag moves it. Delete lives in the thread behind a
                confirm, and in the context menu. A native button, so Tab
                reaches it and Enter opens the thread, without React Aria's
                press handling claiming the pointer the gestures need. */}
            {/* eslint-disable-next-line no-restricted-syntax -- see above */}
            <button
              type="button"
              className="lc-annotation-pin"
              aria-label={pinLabel(pin, mine, offCtx)}
              data-testid={`annot-pin-${pin.id}`}
              data-author={mine ? "own" : "peer"}
              data-off-context={offCtx || undefined}
              // A selected shape shows it on its outline instead.
              data-selected={(selected && !pin.end) || undefined}
              title={
                mine
                  ? `Pin by you — click for thread; drag once selected, or Shift+drag, to move`
                  : `Pin by ${pin.author} — click for thread`
              }
              onPointerDown={onPinPointerDown(pin)}
              onPointerMove={onPinPointerMove(pin)}
              onPointerUp={onPinPointerUp(pin)}
              onPointerCancel={onPinPointerCancel(pin)}
              onContextMenu={onAnnotationContextMenu(pin)}
              onClick={() => {
                // Swallow the click after a real drag or a stationary
                // Shift-press, once.
                if (suppressClickRef.current === pin.id) {
                  suppressClickRef.current = null;
                  return;
                }
                setOpenPinId((cur) => (cur === pin.id ? null : pin.id));
                if (mine) setSelectedId(pin.id);
              }}
              style={{
                // A selected pin moves on drag; an unselected one pans, so it
                // shows the canvas's grab cursor.
                cursor: selected ? "move" : mine ? "grab" : "pointer",
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
                key={editing.threadKey(pin.id)}
                pin={pin}
                datasetId={datasetId}
                myId={myId}
                wasmSceneRef={wasmSceneRef}
                sendCommand={sendCommand}
                onDocumentChanged={onDocumentChanged}
                onClose={() => setOpenPinId(null)}
                mentionCandidates={mentionCandidates}
                onGoToAuthorView={onGoToAuthorView}
                armDelete={editing.armsDelete(pin.id)}
                focusComposer={editing.focusesComposer(pin.id)}
              />
            )}
          </div>
        );
      })}
      {contextMenu}
    </div>
  );
});
