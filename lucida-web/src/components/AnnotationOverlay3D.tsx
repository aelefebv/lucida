/**
 * DOM overlay for annotation pins in the 3D volume view, the counterpart to
 * {@link AnnotationOverlay}. The thread UI is the shared {@link ThreadPopover};
 * this file owns projection, the pin gesture, and popover anchoring.
 *
 * A click toggles the thread, a plain drag orbits, and Shift+drag on an own pin
 * moves it in-plane at its own depth. A plain press is handed to the canvas only
 * once it passes the click slop, so it can still resolve into a click while the
 * camera code stays the canvas's alone. Markers re-project every frame through
 * `scene.project_annotation`, the same transform the volume pass uses.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { Annotation, AnnotationOverlayHandle } from "./annotationDocument.ts";
import { useAnnotationOverlay } from "./useAnnotationOverlay.ts";
import {
  capturePointer,
  emitMoveAnnotation,
  exceedsClickSlop,
  releasePointer,
} from "./annotationInteraction.ts";
import { eventToScreenPx, makeProjectAnnotationToCss } from "./cameraProjection.ts";
import { CommentCountBadge, OffContextHelptext } from "./AnnotationPinBadges.tsx";
import { applyViewportCommand } from "../applyAndSend.ts";
import { annotationVertices, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";
import { isOffContext, type ViewContext } from "./annotationContext.ts";
import { ThreadPopover } from "./ThreadPopover.tsx";
import type { MentionCandidate } from "./annotationMentions.ts";

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** The current Z/T/C. A pin off it renders dimmed with a locator, through the
   * same {@link isOffContext} as the 2D overlay. */
  viewContext: ViewContext;
  /** The browser-persisted author identity from `annotationAuthorId()`, not the
   * per-connection `bridge.myId`, so ownership survives rejoining a workspace.
   * Own pins are tinted, and only their author may move or delete them. */
  myId: string;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Called after a local change so dependent overlays re-read via a fresh
   * `version`. */
  onDocumentChanged: () => void;
  /** Marks the render loop dirty after `focusPin` recenters, since the
   * pull-based loop won't repaint on its own. */
  onViewportChanged?: () => void;
  /** Personal, view-only toggle. When false nothing renders; annotations are
   * hidden, not deleted, and nothing goes on the wire. */
  visible?: boolean;
  /** Passed through to {@link ThreadPopover}. */
  mentionCandidates?: MentionCandidate[];
  /** Passed through to {@link ThreadPopover}. */
  onGoToAuthorView?: (pinId: string) => void;
}

/** A gesture that began on a marker, for one captured pointer. `move` is a
 * Shift+drag on an own pin; `orbit` is a plain press that stays a click or,
 * past the slop, is handed to the canvas. */
interface Pin3DDrag {
  pinId: string;
  pointerId: number;
  /** Fixed at pointerdown from Shift and authorship. */
  mode: "move" | "orbit";
  /** Press point in CSS px, to measure travel against the slop. */
  startX: number;
  startY: number;
  /** True once travel passes the slop. */
  moved: boolean;
  /** Set once an orbit press is handed to the canvas, so it is forwarded once. */
  forwarded: boolean;
}

export const AnnotationOverlay3D = forwardRef<AnnotationOverlayHandle, Props>(function AnnotationOverlay3D({ datasetId, wasmSceneRef, canvas, version, viewContext, myId, sendCommand, onDocumentChanged, onViewportChanged, visible = true, mentionCandidates = [], onGoToAuthorView }: Props, ref) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Lines and boxes re-project each frame through the same call as the dots.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  // The pin set and open thread, with the lifecycle shared with the 2D overlay.
  const { annotations, annotationsRef, openPinId, setOpenPinId } = useAnnotationOverlay({
    wasmSceneRef,
    datasetId,
    version,
    visible,
  });

  const datasetIdRef = useRef(datasetId);
   
  datasetIdRef.current = datasetId;

  // Same handle shape as the 2D `focusPin`; only the recenter differs. 2D
  // `set_center` never touches the arcball/fly camera, so this issues
  // `arcball_center_on_voxel`, which makes the pin's world point the arcball
  // target. A missing pin or unready scene is a no-op.
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
            type: "arcball_center_on_voxel",
            dataset_id: datasetIdRef.current,
            x: pin.position[0],
            y: pin.position[1],
            // The pin's depth, so the target is its full 3D point. Pins saved
            // without a depth default to 0.
            z: pin.z ?? 0,
          });
          // Repaint under the moved camera; the pull-based loop won't otherwise.
          onViewportChanged?.();
        }
      },
    }),
    [wasmSceneRef, onViewportChanged, annotationsRef, setOpenPinId],
  );

  // Declared before the RAF effect, which reads it to skip the dot being moved.
  const dragRef = useRef<Pin3DDrag | null>(null);
  // After a real drag, swallow the trailing click so the thread doesn't toggle
  // on drop. Cleared once consumed.
  const suppressClickRef = useRef<string | null>(null);

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        // `null` means the vertex is behind the camera or the dataset has no
        // anchorable member. A line or box shares one depth `z` across vertices.
        const project = makeProjectAnnotationToCss(scene, datasetIdRef.current);
        // pointermove positions a dot being Shift-moved; reprojecting its stale
        // stored position would snap it back every frame. An orbit doesn't move
        // the pin, so its dot keeps reprojecting.
        const activeDrag = dragRef.current;
        const draggingId =
          activeDrag?.moved && activeDrag.mode === "move" ? activeDrag.pinId : null;
        for (const pin of annotationsRef.current) {
          const pinZ = pin.z ?? 0;
          const verts = annotationVertices(pin);
          const projected: (ScreenPoint | null)[] = verts.map((v) => project(v, pinZ));
          // If any vertex is behind the camera, hide the whole shape and dot; a
          // partly projected line would streak across the screen.
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
  }, [wasmSceneRef, canvas, annotationsRef]);

  /** Hand a plain drag to the canvas: transfer capture and replay the
   * pointerdown from the original press point, so the canvas's first move
   * computes the right delta. */
  const forwardPressToCanvas = (drag: Pin3DDrag, e: ReactPointerEvent) => {
    releasePointer(e.currentTarget as Element, drag.pointerId);
    // Without capture support (test env), the canvas listeners still get the
    // dispatched event below.
    capturePointer(canvas, drag.pointerId);
    try {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: drag.pointerId,
          button: 0,
          buttons: e.buttons,
          // Replay from the press point so the canvas's lastPos anchors correctly.
          clientX: drag.startX,
          clientY: drag.startY,
          shiftKey: false,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      // No PointerEvent constructor (non-browser env): the drag won't orbit.
    }
  };

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return; // only a primary press starts a gesture
    // Ignore a second pointer mid-gesture so the first completes.
    if (dragRef.current) return;
    // Clear stale suppression from a drag that never got its trailing click.
    suppressClickRef.current = null;
    const mine = pin.author === String(myId);
    // Shift on an own pin moves; anything else is orbit-or-click.
    const mode: "move" | "orbit" = e.shiftKey && mine ? "move" : "orbit";
    dragRef.current = {
      pinId: pin.id,
      pointerId: e.pointerId,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      forwarded: false,
    };
    // Capture so move and up land here while deciding click versus drag.
    capturePointer(e.currentTarget as Element, e.pointerId);
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      // Still within the click slop.
      if (!exceedsClickSlop(drag.startX, drag.startY, e.clientX, e.clientY)) return;
      drag.moved = true;
    }

    if (drag.mode === "orbit") {
      // Hand a plain drag to the canvas once, the first time it passes the slop.
      if (!drag.forwarded) {
        drag.forwarded = true;
        // A real drag must not also toggle the thread on the trailing click.
        suppressClickRef.current = pin.id;
        forwardPressToCanvas(drag, e);
        // The canvas owns the rest of the gesture, so release our state now; a
        // stale orbit drag would block the next press here. The suppress flag
        // stays to swallow the trailing click.
        dragRef.current = null;
      }
      return;
    }

    // Move: preview the dot under the cursor. The tick skips it while the drag
    // is live, and release commits the position.
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
    releasePointer(e.currentTarget as Element, drag.pointerId);

    // An orbit that reaches pointerup here never traveled (a traveled one was
    // handed off), so it is a click: let onClick toggle the thread.
    if (drag.mode === "orbit") {
      return;
    }

    // A Shift-press that never passed the slop is not a move. Swallow its click
    // too, since Shift is the move modifier.
    if (!drag.moved) {
      suppressClickRef.current = pin.id;
      return;
    }
    // Resolve the release through the same depth pick a 3D drop uses. A ray miss
    // declines, so a pin never floats in empty space.
    suppressClickRef.current = pin.id;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const [screenX, screenY] = eventToScreenPx(canvas, e);
    const voxel = scene.pick_annotation_voxel(datasetId, screenX, screenY);
    if (voxel.length < 3) return; // ray missed → don't move
    // A move is in-plane only: take x/y from the picked voxel but keep the pin's
    // own depth, not `voxel[2]`, or a 3D drag would re-slice the pin. The 2D move
    // does the same. `move_annotation` carries no T/C.
    emitMoveAnnotation(
      scene,
      { datasetId, id: pin.id, position: [voxel[0], voxel[1]], z: pin.z ?? 0 },
      sendCommand,
    );
    onDocumentChanged();
  };

  const onPinPointerCancel = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    const captured = drag.pointerId;
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, captured);
    // A cancelled gesture never moves the pin; the tick snaps the dot back.
  };

  // After every hook, so hook order stays stable.
  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // The layer never blocks the canvas: only markers and an open popover
        // opt back into pointer events.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Starts hidden so nothing flashes at the origin before the first
          projection. */}
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
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        // The tick governs display; off-context only changes the look. The
        // volume renders every slice, so only T/C dim a pin here. 2D keeps Z.
        const offCtx = isOffContext(pin, viewContext, { ignoreZ: true });
        return (
          <div
            key={pin.id}
            data-testid={`annot-pin-wrapper-${pin.id}`}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            // Starts hidden; the tick reveals and positions it once projected.
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              display: "none",
              transform: "translate(0px, 0px)",
              willChange: "transform",
              pointerEvents: "none",
              // The tick writes only display and transform, so this persists.
              // An open thread is never dimmed.
              opacity: offCtx && !isOpen ? 0.5 : 1,
              // Wrappers share one layer, so a later pin's dot would paint over
              // an open popover. Lift only the open pin.
              zIndex: isOpen ? 2 : 1,
            }}
          >
            {/* Every marker takes the pointer so any pin's thread can open; a
                peer's pin just can't be Shift-moved. */}
            <div
              data-testid={`annot-pin-${pin.id}`}
              title={
                mine
                  ? "Pin by you — click for thread, Shift+drag to move, drag to orbit"
                  : `Pin by ${pin.author} — click for thread, drag to orbit`
              }
              onPointerDown={onPinPointerDown(pin)}
              onPointerMove={onPinPointerMove(pin)}
              onPointerUp={onPinPointerUp(pin)}
              onPointerCancel={onPinPointerCancel(pin)}
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
                position: "absolute",
                top: 0,
                left: 0,
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                borderRadius: "50%",
                backgroundColor: "#FF3B30",
                // Dashed off-context, as in the 2D overlay.
                border: offCtx ? "2px dashed white" : "2px solid white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
                pointerEvents: "auto",
                cursor: mine ? "grab" : "pointer",
                touchAction: "none",
              }}
            />
            {offCtx && <OffContextHelptext pin={pin} />}
            {/* A child of the wrapper, so the projection and the behind-camera
                hide carry it with the marker. */}
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
