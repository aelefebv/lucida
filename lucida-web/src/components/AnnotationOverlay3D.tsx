/**
 * DOM overlay for annotation pins in the 3D volume view, the counterpart to
 * {@link AnnotationOverlay}. The thread UI is the shared {@link ThreadPopover};
 * this file owns projection, the pin gesture, and popover anchoring.
 *
 * A click toggles the thread and selects one's own pin, a plain drag orbits,
 * and a selected pin or a Shift+drag on one's own moves it in-plane at its own
 * depth. A plain press is handed to the canvas only once it passes the click
 * slop, so it can still resolve into a click while the camera code stays the
 * canvas's alone. A tap on one's own line or box selects it for the context
 * menu and the Delete key. Markers re-project every frame through
 * `scene.project_annotation`, the same transform the volume pass uses.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { Annotation, AnnotationOverlayHandle } from "./annotationDocument.ts";
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
import { eventToScreenPx, makeProjectAnnotationToCss, type ClientPoint } from "./cameraProjection.ts";
import { CommentCountBadge, OffContextHelptext } from "./AnnotationPinBadges.tsx";
import { AnnotationContextMenu, type CanvasMenuRequest } from "./AnnotationContextMenu.tsx";
import { applyViewportCommand } from "../applyAndSend.ts";
import { frameClock, useWakeFramesOnRender } from "../frameClock.ts";
import { buildAnnotationView } from "../savedView/buildAnnotationView.ts";
import { annotationVertices, hitTestShapes, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";
import { isOffContext, pinLabel, type ViewContext } from "./annotationContext.ts";
import type { Tool } from "./annotationTool.ts";
import { ThreadPopover } from "./ThreadPopover.tsx";
import type { MentionCandidate } from "./annotationMentions.ts";
import "./AnnotationOverlay.css";

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
  /** The canvas tool. A tap selects only with the pan tool, since a drawing
   * tool's tap draws. */
  tool?: Tool;
  /** Passed through to {@link ThreadPopover}. */
  mentionCandidates?: MentionCandidate[];
  /** Passed through to {@link ThreadPopover}. */
  onGoToAuthorView?: (pinId: string) => void;
}

/** How far (CSS px) a tap may land from a stroke and still select its shape. */
const TAP_TOLERANCE = 6;
const TOUCH_TAP_TOLERANCE = 22;

/** A gesture that began on a marker, for one captured pointer. `move` drags
 * one's own pin, when selected or with Shift; `orbit` is a press that stays a
 * click or, past the slop, is handed to the canvas. */
interface Pin3DDrag {
  pinId: string;
  pointerId: number;
  pointerType: string;
  /** Fixed at pointerdown from Shift, authorship, and the selection. */
  mode: "move" | "orbit";
  /** Whether Shift was held at the press, which makes a stationary press
   * nothing rather than a click. */
  shift: boolean;
  /** Press point in CSS px, to measure travel against the slop. */
  startX: number;
  startY: number;
  /** True once travel passes the slop. */
  moved: boolean;
  /** Set once an orbit press is handed to the canvas, so it is forwarded once. */
  forwarded: boolean;
  cancelLongPress: () => void;
}

export const AnnotationOverlay3D = forwardRef<AnnotationOverlayHandle, Props>(function AnnotationOverlay3D({ datasetId, wasmSceneRef, canvas, version, viewContext, myId, sendCommand, onDocumentChanged, onViewportChanged, visible = true, tool = "pan", mentionCandidates = [], onGoToAuthorView }: Props, ref) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Lines and boxes re-project each frame through the same call as the dots.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  // The pin set, open thread, and selection, with the lifecycle shared with
  // the 2D overlay.
  const overlay = useAnnotationOverlay({
    wasmSceneRef,
    datasetId,
    version,
    visible,
  });
  const { annotations, annotationsRef, openPinId, setOpenPinId, selectedId, setSelectedId } = overlay;
  const editing = useAnnotationEditing({ state: overlay, datasetId, myId, wasmSceneRef, sendCommand, onDocumentChanged });
  const [menu, setMenu] = useState<CanvasMenuRequest | null>(null);

  const datasetIdRef = useRef(datasetId);

  datasetIdRef.current = datasetId;

  /** Where a client point lands in the volume, by the same depth pick a 3D
   * drop uses, or null when the ray misses. */
  const pickPlacement = (point: ClientPoint): AnnotationPlacement | null => {
    const scene = wasmSceneRef.current;
    if (!scene) return null;
    const [screenX, screenY] = eventToScreenPx(canvas, point);
    const voxel = scene.pick_annotation_voxel(datasetId, screenX, screenY);
    if (voxel.length < 3) return null;
    // A far-face pick can round past the last plane, where 2D could never
    // reach the point; clamp as a drawn point does.
    const depth = scene.dataset_volume_shape(datasetId)[0] ?? 0;
    const z = depth > 0 ? Math.max(0, Math.min(voxel[2], depth - 1)) : voxel[2];
    return { position: [voxel[0], voxel[1]], z };
  };

  /** One's own line or box under a client point, as projected now, or null. */
  const ownShapeAt = (point: ClientPoint, tolerance: number): string | null => {
    const scene = wasmSceneRef.current;
    if (!scene) return null;
    const project = makeProjectAnnotationToCss(scene, datasetId);
    const rect = canvas.getBoundingClientRect();
    const shapes = [];
    for (const pin of annotationsRef.current) {
      if (pin.author !== String(myId) || !pin.end || (pin.kind !== "line" && pin.kind !== "box")) continue;
      const points = annotationVertices(pin).map((v) => project(v, pin.z ?? 0));
      if (points.some((p) => p === null)) continue;
      shapes.push({ id: pin.id, points: points as ScreenPoint[], closed: isClosedShape(pin) });
    }
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
    setMenu({ x: point.clientX, y: point.clientY, target: pickPlacement(point) });
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
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => canvas.removeEventListener("contextmenu", onContextMenu);
  }, [canvas]);

  // A tap on one's own line or box selects it; a tap elsewhere deselects.
  useCanvasTaps(canvas, (tap) => {
    if (!visible) return;
    if (tool !== "pan" || tap.shiftKey) {
      setSelectedId(null);
      return;
    }
    setSelectedId(ownShapeAt(tap, tap.pointerType === "touch" ? TOUCH_TAP_TOLERANCE : TAP_TOLERANCE));
  });

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
      openContextMenu: (at: ClientPoint) => openMenuRef.current(at, "touch"),
    }),
    [wasmSceneRef, onViewportChanged, annotationsRef, setOpenPinId],
  );

  // Declared before the RAF effect, which reads it to skip the dot being moved.
  const dragRef = useRef<Pin3DDrag | null>(null);
  // After a real drag, swallow the trailing click so the thread doesn't toggle
  // on drop. Cleared once consumed.
  const suppressClickRef = useRef<string | null>(null);

  // A new or changed pin needs a frame to be placed.
  useWakeFramesOnRender();
  useEffect(() => {
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        // `null` means the vertex is behind the camera or the dataset has no
        // anchorable member. A line or box shares one depth `z` across vertices.
        const project = makeProjectAnnotationToCss(scene, datasetIdRef.current);
        // pointermove positions a dot being moved; reprojecting its stale
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
    };
    return frameClock.subscribe(tick);
  }, [wasmSceneRef, canvas, annotationsRef]);

  /** A right-click on a marker opens the canvas menu on it. A finger's long
   * press is timed by the gesture instead, so its native menu is only
   * suppressed. */
  const onPinContextMenu = (pin: Annotation) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pointerType = (e.nativeEvent as PointerEvent).pointerType ?? "mouse";
    if (pointerType === "touch") return;
    openMenu(e, pointerType, pin.id);
  };

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return; // only a primary press starts a gesture
    // Ignore a second pointer mid-gesture so the first completes.
    if (dragRef.current) return;
    // Clear stale suppression from a drag that never got its trailing click.
    suppressClickRef.current = null;
    const mine = pin.author === String(myId);
    // One's own pin moves when selected or with Shift; anything else is
    // orbit-or-click.
    const mode: "move" | "orbit" = mine && (e.shiftKey || selectedId === pin.id) ? "move" : "orbit";
    const target = e.currentTarget as Element;
    const drag: Pin3DDrag = {
      pinId: pin.id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      mode,
      shift: e.shiftKey,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      forwarded: false,
      cancelLongPress: () => {},
    };
    if (e.pointerType === "touch") {
      drag.cancelLongPress = startLongPress(() => {
        if (dragRef.current !== drag || drag.moved) return;
        dragRef.current = null;
        releasePointer(target, drag.pointerId);
        suppressClickRef.current = pin.id;
        openMenu({ clientX: drag.startX, clientY: drag.startY }, "touch", pin.id);
      });
    }
    dragRef.current = drag;
    // Capture so move and up land here while deciding click versus drag.
    capturePointer(target, e.pointerId);
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      // Still within the click slop.
      if (!exceedsPressSlop(drag.pointerType, drag.startX, drag.startY, e.clientX, e.clientY)) return;
      drag.moved = true;
      drag.cancelLongPress();
    }

    if (drag.mode === "orbit") {
      // Hand a plain drag to the canvas once, the first time it passes the slop.
      if (!drag.forwarded) {
        drag.forwarded = true;
        // A real drag must not also toggle the thread on the trailing click.
        suppressClickRef.current = pin.id;
        forwardPressToCanvas(e.currentTarget as Element, canvas, drag, e.buttons);
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
    drag.cancelLongPress();
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, drag.pointerId);

    // A press that never travelled is a click, and onClick toggles the thread.
    // A stationary Shift-press is not a move and not a click either, since
    // Shift is the move modifier, so its click is swallowed.
    if (!drag.moved) {
      if (drag.mode === "move" && drag.shift) suppressClickRef.current = pin.id;
      return;
    }
    // An orbit that traveled was handed off before reaching here.
    if (drag.mode === "orbit") return;
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
    drag.cancelLongPress();
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, drag.pointerId);
    // A cancelled gesture never moves the pin; the tick snaps the dot back.
  };

  const addPoint = (at: AnnotationPlacement, openThread: boolean) => {
    const scene = wasmSceneRef.current;
    const view = scene ? buildAnnotationView(scene) : null;
    editing.addPoint(at, { t: viewContext.t, c: viewContext.channels[0] ?? 0, view, openThread });
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

  return (
    <div className="lc-annotation-layer">
      {/* Starts hidden so nothing flashes at the origin before the first
          projection. */}
      <svg className="lc-annotation-svg" width="100%" height="100%">
        {annotations.map((pin) => {
          if (pin.kind !== "line" && pin.kind !== "box") return null;
          if (!pin.end) return null;
          const author = pin.author === String(myId) ? "own" : "peer";
          const shapeProps = {
            className: "lc-annotation-shape",
            "data-author": author,
            "data-selected": selectedId === pin.id || undefined,
            ref: (el: SVGLineElement | SVGPolygonElement | null) => {
              if (el) shapeRefs.current.set(pin.id, el);
              else shapeRefs.current.delete(pin.id);
            },
            style: { display: "none" },
          };
          if (isClosedShape(pin)) {
            return <polygon key={pin.id} {...shapeProps} points="" />;
          }
          return <line key={pin.id} {...shapeProps} x1={0} y1={0} x2={0} y2={0} />;
        })}
      </svg>
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        const selected = mine && selectedId === pin.id;
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        // The tick governs display; off-context only changes the look. The
        // volume renders every slice, so only T/C dim a pin here. 2D keeps Z.
        const offCtx = isOffContext(pin, viewContext, { ignoreZ: true });
        return (
          <div
            key={pin.id}
            className="lc-annotation-anchor"
            data-testid={`annot-pin-wrapper-${pin.id}`}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            // Starts hidden; the tick reveals and positions it once projected.
            style={{
              display: "none",
              transform: "translate(0px, 0px)",
              // The tick writes only display and transform, so this persists.
              // An open thread is never dimmed.
              opacity: offCtx && !isOpen ? 0.5 : 1,
              // Wrappers share one layer, so a later pin's dot would paint over
              // an open popover. Lift only the open pin.
              zIndex: isOpen ? 2 : 1,
            }}
          >
            {/* Every marker takes the pointer so any pin's thread can open; a
                peer's pin just can't be moved. A native button, as in the 2D
                overlay, so the gestures keep the pointer. */}
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
                  ? "Pin by you — click for thread; drag once selected, or Shift+drag, to move; drag to orbit"
                  : `Pin by ${pin.author} — click for thread, drag to orbit`
              }
              onPointerDown={onPinPointerDown(pin)}
              onPointerMove={onPinPointerMove(pin)}
              onPointerUp={onPinPointerUp(pin)}
              onPointerCancel={onPinPointerCancel(pin)}
              onContextMenu={onPinContextMenu(pin)}
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
              style={{ cursor: selected ? "move" : mine ? "grab" : "pointer" }}
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
