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
  type ScreenPoint,
} from "./annotationGeometry.ts";
import { isOffContext, offContextLabel, type ViewContext } from "./annotationContext.ts";
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
  /** The timepoint (T) the pin was placed on. Absent on a pre-slice-14 pin →
   * defaulted to 0 on read. Drives off-context rendering vs the current view. */
  t?: number;
  /** The channel (C) the pin was placed on. Absent on a pre-slice-14 pin →
   * defaulted to 0 on read. Drives off-context rendering vs the current view. */
  c?: number;
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
  /** The current view's Z/T/C selectors (issue #779) — App passes `{ z: dims.z,
   * t: dims.t, c: dims.c }`. A pin whose own z/t/c all equal this renders
   * on-context (today's look); a pin that differs in any axis renders
   * off-context (dimmed + a helptext naming where it lives), mirroring an
   * off-view peer cursor. Pure: as the view changes this recomputes, so
   * navigating to the pin's slice flips it back to normal automatically. */
  viewContext: ViewContext;
  /** Stable, browser-persisted annotation-author identity (issue #777): the pin
   * `author` to match against for the mine/ownership checks (move/delete + own-
   * pin controls). Sourced from `annotationAuthorId()`, not the per-connection
   * `bridge.myId`, so a pin authored by this browser stays mine across rejoin.
   * (Prop name kept as `myId` for continuity; its value/type is now the string
   * identity.) */
  myId: string;
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

/** Side length (CSS px) of a square resize handle. Small, so the handles are a
 * distinct, deliberate target that doesn't swallow the box body. */
const HANDLE_SIZE = 10;

/** How far (CSS px) to nudge each handle OUTWARD from the box center, so the
 * handles straddle the stroke (the conventional look) and the `nw` handle clears
 * the anchor dot that shares the `position` corner. Cosmetic only — the resize
 * math always uses the cursor's world point, never this offset. */
const HANDLE_OUTSET = 9;

/** Grace period (ms) the resize handles linger after the pointer leaves the box
 * (and isn't over a handle), so they don't flicker off when the cursor drifts
 * just past an edge or crosses the small gap between the box and a handle.
 * Re-entering the box or a handle inside this window cancels the pending hide. */
const HANDLE_HOVER_LINGER_MS = 300;

/** The directional resize cursor for each handle, so the affordance reads as
 * "drag to resize from here" (a corner resizes both axes; an edge, one). Keyed
 * by the handle's vertex-role name, mapped to the screen direction it grows. */
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

/** A pair of opposite in-plane world vertices — a box's two corners OR a line's
 * two endpoints (structurally identical: `{position, end}`). The reshape gesture
 * carries either through one path, branching on the shape kind only where the
 * per-vertex math differs (which handle owns which coordinate). */
type ShapeVertices = BoxCorners & LineEndpoints;

/** Live state for an in-progress RESHAPE gesture that began on one of an own
 * shape's handles, scoped to one captured pointer. Covers BOTH a box (eight
 * corner/edge handles) and a line (two endpoint handles): the gesture is the
 * same — press, slop, preview, release emits one reshape — only the geometry
 * differs, so a `kind` tag picks the recompute (`reshapeBox` vs `reshapeLine`).
 * Distinct from {@link PinDrag} (the anchor-dot move/pan gesture): a handle
 * never pans — it only reshapes, emitting one reshape `move_annotation` on
 * release. */
interface HandleDrag {
  pinId: string;
  pointerId: number;
  /** Which family of geometry this drag reshapes — picks the recompute helper
   * and which handle-name set is valid. */
  kind: "box" | "line";
  /** Which handle is held: a box corner/edge (nw|ne|se|sw|n|e|s|w) or a line
   * endpoint (start|end) — picks the per-vertex recompute. */
  handle: BoxHandle | LineHandle;
  /** Press point in CSS px (clientX/Y), to measure travel against the slop. */
  startX: number;
  startY: number;
  /** The shape's two vertices at press, the fixed base every recompute builds
   * on (so dragging one handle never drifts the other). For a box these are its
   * opposite corners; for a line, its two endpoints. */
  base: ShapeVertices;
  /** The shape's depth at press; preserved across a reshape (z is not edited by
   * a 2D handle drag). */
  z: number;
  /** Flips true once travel passes the slop — the press becomes a real drag. */
  moved: boolean;
  /** The live reshaped vertices while dragging (null until the first move past
   * the slop). The RAF tick reads this to preview the shape + handles under the
   * cursor; the authoritative reshape lands on release via apply_command. */
  preview: ShapeVertices | null;
}

/** Recompute a shape's two vertices after dragging `handle` to `world`, picking
 * the per-vertex math by kind: a box moves the coordinates its corner/edge owns
 * (`reshapeBox`); a line moves only the grabbed endpoint (`reshapeLine`). One
 * call site for both so the press/slop/preview/release gesture stays shared. */
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

/** Whether `pin` is an own box eligible for resize handles: kind "box", has a
 * second vertex, and authored by me. A point/line, or any non-author shape,
 * gets no box handles. */
function isOwnBox(pin: Annotation, myId: string): boolean {
  return pin.kind === "box" && (pin.end ?? null) !== null && pin.author === String(myId);
}

/** Whether `pin` is an own line eligible for endpoint handles: kind "line", has
 * a far endpoint, and authored by me. A point/box, or any non-author shape, gets
 * no endpoint handles. The line analog of {@link isOwnBox}. */
function isOwnLine(pin: Annotation, myId: string): boolean {
  return pin.kind === "line" && (pin.end ?? null) !== null && pin.author === String(myId);
}

/** Whether `pin` is an own shape that carries hover-revealed handles at all —
 * a box (eight corner/edge handles) or a line (two endpoint handles). Used to
 * gate the shared hover/hysteresis reveal and the hoverable-stroke styling, so
 * one predicate drives "does hovering this shape reveal handles?" for both. */
function isOwnHandledShape(pin: Annotation, myId: string): boolean {
  return isOwnBox(pin, myId) || isOwnLine(pin, myId);
}

/** The two opposite world vertices of a non-point pin (anchor + opposite). For a
 * box these are its corners; for a line, its endpoints — structurally the same
 * `{position, end}`. Returns null if it has no second vertex (so a caller can
 * skip a degenerate shape). */
function shapeVertices(pin: Annotation): ShapeVertices | null {
  const end = pin.end ?? null;
  if (!end) return null;
  return { position: [pin.position[0], pin.position[1]], end: [end[0], end[1]] };
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

export function AnnotationOverlay({ datasetId, wasmSceneRef, canvas, version, viewContext, myId, sendCommand, onDocumentChanged, onViewportChanged }: Props) {
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

  // The live resize-handle drag, if any (a ref, not state, so handlers mutate it
  // without re-rendering mid-drag; the RAF tick reads its `preview` to reproject
  // the box + handles under the cursor). At most one handle drags at a time.
  const handleDragRef = useRef<HandleDrag | null>(null);
  // One DOM node per resize handle, keyed `${pinId}:${handle}`, so the tick can
  // reproject each handle from world space every frame — exactly like the dots.
  const handleRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Which own SHAPE is currently "active" (pointer over its shape or a handle),
  // so its handles are revealed — null when none is hovered (issue #789, #790).
  // Covers BOTH a box (its eight corner/edge handles) and a line (its two
  // endpoint handles): handles are no longer always-on for either, and this
  // state, not the pin set, gates whether a shape's `annot-resize-<id>-<h>` nodes
  // exist in the DOM at all. At most one shape is active at a time (you hover one
  // shape), so a single id (not a set) is enough and keeps the reveal/hide
  // reasoning simple.
  const [activeShapeId, setActiveShapeId] = useState<string | null>(null);
  // A pending "hide the handles" timer (hysteresis). On pointer-leave we don't
  // hide immediately; we arm this timer so the handles linger briefly. Moving
  // back onto the box or a handle clears it (the hide is cancelled). A ref so
  // arming/cancelling never re-renders, and so the cleanup effect can clear a
  // still-pending timer on unmount.
  const hideHandlesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reveal a shape's handles now: cancel any pending hide and mark it active.
  // Used by both the shape's and each handle's pointer-enter, so crossing the gap
  // from the shape to a handle keeps the set alive. Shared verbatim by boxes and
  // lines — the reveal logic is identical; only what each shape renders differs.
  const revealHandles = (pinId: string) => {
    if (hideHandlesTimer.current !== null) {
      clearTimeout(hideHandlesTimer.current);
      hideHandlesTimer.current = null;
    }
    setActiveShapeId((cur) => (cur === pinId ? cur : pinId));
  };

  // Begin hiding a shape's handles after the linger grace period — but only if
  // it's still the active shape (a fast move onto another shape already switched
  // it). The delay is the hysteresis: a cursor that drifts just past an edge, or
  // hops the small gap to a handle, re-enters and cancels this before it fires.
  const scheduleHideHandles = (pinId: string) => {
    if (hideHandlesTimer.current !== null) clearTimeout(hideHandlesTimer.current);
    hideHandlesTimer.current = setTimeout(() => {
      hideHandlesTimer.current = null;
      // Never hide out from under an in-flight reshape of this shape: a captured
      // handle drag fires leave events as the cursor travels, but the handle must
      // survive until the gesture ends (release re-evaluates the hover normally).
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

  // If the active (hovered) shape disappears — removed, or its dataset changed —
  // drop the hover so its handles can't linger as orphans pointing at a pin that
  // no longer exists. Mirrors the open-thread cleanup above. The pointer-leave
  // path handles the normal case; this only covers a shape vanishing out from
  // under the cursor. Covers both a box and a line (same active-shape state).
  useEffect(() => {
    if (activeShapeId !== null && !annotations.some((p) => p.id === activeShapeId)) {
      setActiveShapeId(null);
    }
  }, [annotations, activeShapeId]);

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
        // A reshape in flight (past the slop) previews the shape from the dragged
        // vertices, so this pin's outline + handles track the cursor instead of
        // its (still-old) stored geometry. One ref covers a box resize AND a line
        // endpoint drag.
        const resize = handleDragRef.current;
        const resizingId = resize?.moved && resize.preview ? resize.pinId : null;

        for (const pin of annotationsRef.current) {
          // Anchor dot (the interaction target) sits at the first vertex.
          const el = dotRefs.current.get(pin.id);
          if (el && pin.id !== draggingId) {
            const [ax, ay] = project(pin.position);
            el.style.transform = `translate(${ax}px, ${ay}px)`;
          }
          // The shape's effective vertices this frame: the live reshape preview
          // if this pin is being reshaped, else its stored anchor/end. For a box
          // these are its opposite corners; for a line, its two endpoints. Drives
          // both the SVG geometry and the handle positions so they stay
          // coincident.
          const liveVertices: ShapeVertices | null =
            pin.id === resizingId && resize?.preview ? resize.preview : shapeVertices(pin);
          // Line/box geometry: project every vertex through the same `project`
          // and rewrite the shared SVG element's coordinates in place.
          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            // While previewing a reshape, derive the outline/segment from the
            // live vertices; otherwise use the pin's stored vertices.
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
            // Box resize handles (own boxes only): reproject each of the eight
            // from the same `project`, off the live corners, so they ride the box
            // across pan/zoom AND track the cursor during an in-flight resize.
            //
            // Each handle is nudged a few CSS px OUTWARD from the box center
            // (along the projected center->handle direction). Purely cosmetic —
            // it makes the handles straddle the stroke (the conventional look)
            // and, crucially, lifts the `nw` handle off the anchor DOT that also
            // sits at `position`, so a plain click / Shift+drag on the dot (open
            // thread / move the whole box, #776) still lands on the dot, not the
            // handle. The resize MATH is unaffected: release uses eventToWorld,
            // never this visual offset.
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
              // Outset along the outward direction; for a degenerate (zero-size)
              // box the direction is undefined, so fall back to no offset.
              const nx = len > 0.001 ? (ox / len) * HANDLE_OUTSET : 0;
              const ny = len > 0.001 ? (oy / len) * HANDLE_OUTSET : 0;
              handleEl.style.transform = `translate(${hx + nx}px, ${hy + ny}px)`;
            }
          } else if (pin.kind === "line") {
            // Line endpoint handles (own lines only): reproject the two endpoint
            // grips from the same `project`, off the live endpoints, so they ride
            // the line across pan/zoom AND track the cursor during an in-flight
            // endpoint drag.
            //
            // Each grip is nudged a few CSS px OUTWARD along the line's own axis,
            // AWAY from the opposite endpoint (the box-handle trick, #790): the
            // `start` grip is pushed off `position` in the position->away-from-end
            // direction, the `end` grip off `end` away from `start`. Purely
            // cosmetic — it lifts the `start` grip off the anchor DOT that also
            // sits at `position`, so a plain click / Shift+drag on the dot (open
            // thread / rigid whole-line move, #776/#778) still lands on the dot,
            // not the grip. The reshape MATH is unaffected: release uses
            // eventToWorld, never this visual offset.
            const [sx, sy] = project(liveVertices.position);
            const [ex, ey] = project(liveVertices.end);
            // The projected axis direction (start->end); its negation is the
            // outward direction for `start`, itself the outward direction for
            // `end`. For a degenerate (zero-length) line the axis is undefined, so
            // fall back to no offset.
            const ax = ex - sx;
            const ay = ey - sy;
            const len = Math.hypot(ax, ay);
            const ux = len > 0.001 ? ax / len : 0;
            const uy = len > 0.001 ? ay / len : 0;
            for (const h of LINE_HANDLES) {
              const handleEl = handleRefs.current.get(`${pin.id}:${h}`);
              if (!handleEl) continue;
              const [hx, hy] = project(lineHandlePoint(liveVertices, h));
              // `start` outsets away from `end` (−axis); `end` away from `start`
              // (+axis). Same HANDLE_OUTSET the box corners use.
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

  // --- Shape reshape gesture (drag a box corner/edge OR a line endpoint) ------
  // Each handle on an own SHAPE captures its own press (it sits over the canvas,
  // above the shape's outline/segment) and drives a self-contained reshape
  // gesture using Pointer Events ON the handle — capture on down; move/up on the
  // handle — so the pointer stays bound even as it slides far from the handle,
  // exactly like the anchor-dot gesture. A handle NEVER pans and never moves the
  // whole shape rigidly: it only reshapes, emitting ONE reshape
  // `move_annotation {position, end}` on release (author-only — non-author
  // shapes render no handles at all). The SAME four handlers serve a box
  // (eight corner/edge handles) and a line (two endpoint handles): only the
  // per-vertex recompute differs, chosen by the pin's kind via `reshapeShape`.

  const onHandlePointerDown =
    (pin: Annotation, handle: BoxHandle | LineHandle) => (e: ReactPointerEvent) => {
      // Belt-and-suspenders author gate (handles aren't rendered for peers).
      if (!isOwnHandledShape(pin, myId)) return;
      if (e.button !== 0) return;
      // Don't start a reshape on top of an in-flight gesture (anchor drag or
      // another handle): let the active one finish rather than racing it.
      if (dragRef.current || handleDragRef.current) return;
      const base = shapeVertices(pin);
      if (!base) return;
      // A handle press must not also reach the anchor-dot gesture or the canvas
      // beneath: it owns this pointer outright.
      e.stopPropagation();
      // Pin the shape active for the whole drag and cancel any pending hide, so a
      // reshape that drags the cursor far off the shape (firing leave events) can
      // never unmount the handle the gesture is captured on mid-drag.
      revealHandles(pin.id);
      handleDragRef.current = {
        pinId: pin.id,
        pointerId: e.pointerId,
        // The kind picks the recompute (box corners vs line endpoints) for the
        // whole gesture; fixed here at press from the pin so a re-read mid-drag
        // can't switch it.
        kind: pin.kind === "line" ? "line" : "box",
        handle,
        startX: e.clientX,
        startY: e.clientY,
        base,
        z: pin.z ?? 0,
        moved: false,
        preview: null,
      };
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        // capture unsupported (e.g. test env) — moves/ups still arrive on target
      }
    };

  const onHandlePointerMove =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      if (!drag.moved) {
        const travel = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
        if (travel <= PIN_CLICK_SLOP) return; // within click slop — not yet a drag
        drag.moved = true;
      }
      // Recompute the two vertices from the FIXED press-time base (never the
      // running preview) so the held vertex stays anchored and there's no drift.
      // The RAF tick reprojects the outline/segment + handles from this preview.
      const world = eventToWorld(e);
      drag.preview = reshapeShape(drag.kind, drag.base, drag.handle, world);
    };

  const onHandlePointerUp =
    (pin: Annotation) => (e: ReactPointerEvent) => {
      const drag = handleDragRef.current;
      if (!drag || drag.pinId !== pin.id) return;
      handleDragRef.current = null;
      try {
        (e.currentTarget as Element).releasePointerCapture?.(drag.pointerId);
      } catch {
        // ignore — capture may not have been taken
      }
      // Re-arm the hysteresis hide now the drag is over. While the handle was
      // captured, every leave that crossed the shape fired a hide that the
      // in-flight guard (scheduleHideHandles) correctly no-op'd — so at release
      // NO hide is pending and `activeShapeId` is still set. Without this the
      // handles would linger forever after a drag that releases OFF the shape (no
      // leave/enter fires on a captured pointer to re-evaluate the hover). Arming
      // it here makes an off-shape release hide the handles after the linger
      // delay; a release where the pointer is still over the shape or a handle is
      // harmless because the implicit capture-release fires `pointerenter` on that
      // element, and revealHandles cancels this pending hide before it can run.
      // Done before the slop check so even a tiny, no-reshape drag can't strand
      // the handles.
      scheduleHideHandles(pin.id);
      // A press that never crossed the slop is a no-op: no reshape (and there's
      // no thread/click affordance on a handle to fall through to).
      if (!drag.moved) return;
      // Resolve the final vertices at the release point in the existing world
      // frame, and emit exactly one reshape move carrying BOTH vertices. For a
      // line endpoint drag this moves only the grabbed end (`reshapeLine` holds
      // the other), so the far endpoint equals the line's original vertex.
      const vertices = reshapeShape(drag.kind, drag.base, drag.handle, eventToWorld(e));
      const scene = wasmSceneRef.current;
      if (!scene) return;
      applyDocumentCommand(
        scene,
        {
          type: "move_annotation",
          dataset_id: datasetId,
          id: pin.id,
          position: vertices.position,
          end: vertices.end,
          z: drag.z,
        },
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
      try {
        (e.currentTarget as Element).releasePointerCapture?.(captured);
      } catch {
        // ignore
      }
      // Cancelled: never reshape; the RAF tick snaps the shape + handles back to
      // the stored geometry next frame. Re-arm the hysteresis hide for the same
      // reason as on a normal release (above): the in-flight guard swallowed
      // every hide during the captured drag, so without this the handles would
      // stay stuck visible. A cancel means the pointer was lost, so no enter will
      // fire to cancel it — the handles correctly fade after the linger delay.
      scheduleHideHandles(pin.id);
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
          // Dim a line/box that lives off the current Z/T/C, matching the dot's
          // off-context treatment so the whole shape reads as "anchored
          // elsewhere".
          const shapeOpacity = isOffContext(pin, viewContext) ? 0.5 : 1;
          if (isClosedShape(pin)) {
            // Only an OWN box is hover-revealable (handles are author-only); a
            // peer's box stays inert. The shape is the hover target that toggles
            // its handles' visibility (issue #789).
            const hoverable = isOwnBox(pin, myId);
            return (
              <polygon
                key={pin.id}
                data-testid={`annot-shape-${pin.id}`}
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
                opacity={shapeOpacity}
                // Reveal this box's handles on enter; arm the linger-then-hide on
                // leave (hysteresis). Only own boxes carry these — a peer box has
                // no handles to reveal.
                onPointerEnter={hoverable ? () => revealHandles(pin.id) : undefined}
                onPointerLeave={hoverable ? () => scheduleHideHandles(pin.id) : undefined}
                style={
                  hoverable
                    ? {
                        // Limit hit-testing to the painted STROKE, not the filled
                        // interior: hovering the outline reveals the handles, but
                        // a press inside the box still falls through to the canvas
                        // for pan/zoom. We only ever track enter/leave here — no
                        // pointerdown/move handler — so the shape never starts a
                        // gesture or steals the canvas's drag.
                        pointerEvents: "stroke",
                        // The outline reads as the resize affordance's edge.
                        cursor: "pointer",
                      }
                    : undefined
                }
              />
            );
          }
          // Only an OWN line is hover-revealable (endpoint handles are
          // author-only); a peer's line stays inert. The segment is the hover
          // target that toggles its two endpoint handles' visibility — the line
          // analog of the box's hoverable outline (issue #790).
          const hoverable = isOwnLine(pin, myId);
          return (
            <line
              key={pin.id}
              data-testid={`annot-shape-${pin.id}`}
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
              opacity={shapeOpacity}
              // Reveal this line's endpoint handles on enter; arm the
              // linger-then-hide on leave (hysteresis) — the SAME machinery the
              // box outline uses. Only own lines carry these.
              onPointerEnter={hoverable ? () => revealHandles(pin.id) : undefined}
              onPointerLeave={hoverable ? () => scheduleHideHandles(pin.id) : undefined}
              style={
                hoverable
                  ? {
                      // Hit-test only the painted STROKE, so hovering the line
                      // reveals its endpoint handles but a press elsewhere still
                      // falls through to the canvas for pan/zoom. We only track
                      // enter/leave here — no pointerdown/move — so the segment
                      // never starts a gesture or steals the canvas's drag.
                      pointerEvents: "stroke",
                      // The segment reads as the endpoint-adjust affordance.
                      cursor: "pointer",
                    }
                  : undefined
              }
            />
          );
        })}
      </svg>
      {/* Resize-handle layer: eight small draggable squares on each OWN box, at
          its projected corners + edge midpoints. Author-only — a non-author box
          (or a point/line) renders none, so a peer can't reshape my box and a
          point/line has no resize affordance. Each handle is a DOM node (it
          needs pointer capture) repositioned every frame by the RAF tick off the
          live (or stored) corners, so it rides the box across pan/zoom and
          tracks the cursor mid-resize. Dragging one emits ONE reshape
          move_annotation carrying both opposite corners (see the handlers).

          NO LONGER ALWAYS-ON (issue #789): a box's handles render only while it
          is the active (hovered) box AND its thread is closed — so an idle box
          has zero `annot-resize-<id>-<h>` nodes in the DOM (no clutter), and an
          open thread is never overlapped by resize handles. The hover is revealed
          by the box shape's pointer-enter and lingers briefly after leave
          (hysteresis); see revealHandles / scheduleHideHandles. */}
      {annotations.map((pin) => {
        if (!isOwnBox(pin, myId)) return null;
        // Hover-gated reveal: only the actively-hovered box shows its handles…
        if (activeShapeId !== pin.id) return null;
        // …and never while this box's thread is open, so nothing resize-related
        // can draw over the open thread window.
        if (openPinId === pin.id) return null;
        return BOX_HANDLES.map((h) => (
          <div
            key={`${pin.id}:${h}`}
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
            // A handle is part of the box's active zone: entering one cancels a
            // pending hide (so hopping the small gap from the box's edge to a
            // handle never makes the set vanish), and leaving one arms the linger
            // again — together with the shape's enter/leave this keeps the whole
            // box+handles cluster as one hover region with hysteresis.
            onPointerEnter={() => revealHandles(pin.id)}
            onPointerLeave={() => scheduleHideHandles(pin.id)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              transform: "translate(0px, 0px)",
              willChange: "transform",
              // Centered on the handle's projected point.
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              marginLeft: -HANDLE_SIZE / 2,
              marginTop: -HANDLE_SIZE / 2,
              boxSizing: "border-box",
              // A small white square with the box's accent border — the
              // conventional resize grip, visually distinct from the round dot.
              backgroundColor: "white",
              border: "1.5px solid #FF3B30",
              borderRadius: 2,
              boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
              pointerEvents: "auto",
              touchAction: "none",
              // A directional resize cursor per handle, so the affordance reads
              // as "drag to resize" rather than "move".
              cursor: HANDLE_CURSOR[h],
              zIndex: 3,
            }}
          />
        ));
      })}
      {/* Endpoint-handle layer: two small draggable squares on each OWN line,
          just OFF its projected `position` (start) and `end` vertices — each
          grip is outset along the line's axis away from the opposite end (see the
          RAF tick) so the `start` grip clears the anchor dot that shares
          `position`. Author-only — a non-author line (or a point/box) renders
          none, so a peer can't adjust my line and a point has no endpoint
          affordance. Each handle is a DOM node (it needs pointer capture)
          repositioned every frame by the RAF tick off the live (or stored)
          endpoints, so it rides the line across pan/zoom and tracks the cursor
          mid-drag. Dragging one emits ONE reshape move_annotation that moves only
          that endpoint (the other is held).

          NOT ALWAYS-ON (issue #790): a line's endpoint handles render only while
          it is the active (hovered) shape AND its thread is closed — so an idle
          line has zero `annot-resize-<id>-start`/`-end` nodes, and an open thread
          is never overlapped. The hover is revealed by the line segment's
          pointer-enter and lingers briefly after leave (the SAME hysteresis the
          box handles use); see revealHandles / scheduleHideHandles. */}
      {annotations.map((pin) => {
        if (!isOwnLine(pin, myId)) return null;
        // Hover-gated reveal: only the actively-hovered line shows its endpoints…
        if (activeShapeId !== pin.id) return null;
        // …and never while this line's thread is open, so nothing endpoint-related
        // can draw over the open thread window.
        if (openPinId === pin.id) return null;
        return LINE_HANDLES.map((h) => (
          <div
            key={`${pin.id}:${h}`}
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
            // A handle is part of the line's active zone: entering one cancels a
            // pending hide (so hopping the small gap from the segment to a handle
            // never makes the pair vanish), and leaving one arms the linger again
            // — together with the segment's enter/leave this keeps the whole
            // line+handles cluster as one hover region with hysteresis.
            onPointerEnter={() => revealHandles(pin.id)}
            onPointerLeave={() => scheduleHideHandles(pin.id)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              transform: "translate(0px, 0px)",
              willChange: "transform",
              // Centered on the endpoint's projected point.
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              marginLeft: -HANDLE_SIZE / 2,
              marginTop: -HANDLE_SIZE / 2,
              boxSizing: "border-box",
              // A small white square with the line's accent border — the same
              // grip look the box handles use, visually distinct from the dot.
              backgroundColor: "white",
              border: "1.5px solid #FF3B30",
              borderRadius: 2,
              boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
              pointerEvents: "auto",
              touchAction: "none",
              // An endpoint grip moves freely in both axes, so the omnidirectional
              // move cursor reads as "drag this end anywhere".
              cursor: "move",
              zIndex: 3,
            }}
          />
        ));
      })}
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        // Off-context (issue #779): the pin lives on a different Z/T/C than the
        // current view. Pure function of (pin vs viewContext), so navigating the
        // view to match flips it back to on-context on the next render — no state
        // to clear. Mirrors the off-view peer cursor: dimmed + a "where it lives"
        // helptext. The marker still renders and stays clickable (thread opens).
        const offCtx = isOffContext(pin, viewContext);
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
              // Dim the whole marker group when off-context, exactly like an
              // off-view peer cursor (PeerCursors uses opacity 0.5). An open
              // thread is never dimmed — you're actively reading it.
              opacity: offCtx && !isOpen ? 0.5 : 1,
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
                // Off-context pins get a distinct dashed outline (on top of the
                // group dimming above), so they read as "anchored elsewhere"
                // even at a glance — the same intent as an off-view peer cursor.
                border: offCtx ? "2px dashed white" : "2px solid white",
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
            {/* Off-context helptext (issue #779): only when the pin lives on a
                different Z/T/C than the current view. Names where the pin
                actually lives in the exact contract form `slice <z> · t=<t> · ch
                =<c>`, mirroring the off-view peer cursor's locator badge. The
                marker above still renders + clicks (its thread still opens), so
                this is purely an informative overlay. Absent entirely when the
                pin is on-context — so an on-context pin carries NO
                annot-offcontext-<id> testid. */}
            {offCtx && (
              <div
                data-testid={`annot-offcontext-${pin.id}`}
                title={`This pin lives on ${offContextLabel(pin)} — navigate there to edit it in place`}
                style={{
                  position: "absolute",
                  left: 10,
                  top: -10,
                  fontSize: 10,
                  fontFamily: "monospace",
                  color: "white",
                  backgroundColor: "rgba(0,0,0,0.7)",
                  padding: "1px 4px",
                  borderRadius: 3,
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                }}
              >
                {offContextLabel(pin)}
              </div>
            )}
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
