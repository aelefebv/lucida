/**
 * The Move, scale and rotate tool over a slice view: the selected layer's
 * outline, which a drag moves; a handle on each corner, which a drag scales
 * from the opposite corner along the layer's own edges, alike on every axis
 * unless Shift is held; and a round handle past its top edge, which a drag
 * around the layer turns about its center in the view's plane. A drag shows
 * the layer where it goes on this page alone; letting go places it for
 * everyone as one step that undo takes back, and Escape puts it back.
 */
import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import { frameClock, useWakeFramesOnRender } from "../frameClock.ts";
import type { UserTransformActions } from "../hooks/useUserTransforms.ts";
import { readPlacement } from "../placement.ts";
import { cutAxis, xyz, type SlicePlane } from "../renderer/slicePlane.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { userTransformAfter, userTransformTurnedInView, type UserTransform } from "../userTransform.ts";
import { eventToWorld, makeWorldToScreen, type ViewSurface } from "./cameraProjection.ts";
import {
  CORNERS,
  cornerPoint,
  moveMap,
  quadCenter,
  scaleMap,
  turnAngle,
  type Corner,
  type PlaneQuad,
} from "./moveScaleGesture.ts";
import "./MoveScaleOverlay.css";

/** The smallest an outline may be scaled to, in CSS px. */
const MIN_EXTENT_PX = 12;

/** How far past the outline's top edge the turn handle sits, in CSS px. */
const TURN_HANDLE_REACH_PX = 24;

interface Props {
  datasetId: string;
  /** What the outline names, for its accessible label. */
  name: string;
  scene: WasmScene;
  surface: ViewSurface;
  actions: UserTransformActions;
}

interface Drag {
  pointerId: number;
  target: Element;
  grip: "move" | "turn" | Corner;
  from: UserTransform;
  latest: UserTransform;
  start: [number, number];
  quad: PlaneQuad;
  plane: SlicePlane;
  cutOrigin: number;
  /** One CSS pixel in the plane's units, at the press. */
  pixel: number;
  endEscape: () => void;
}

/** `datasetId`'s footprint on `view`'s plane, or null where it has none. */
function readPlaneQuad(scene: WasmScene, view: number, datasetId: string): PlaneQuad | null {
  const q = scene.dataset_plane_quad(view, datasetId);
  if (q.length < 6) return null;
  return { origin: [q[0], q[1]], across: [q[2], q[3]], down: [q[4], q[5]] };
}

export function MoveScaleOverlay({ datasetId, name, scene, surface, actions }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef<HTMLDivElement>(null);
  const handleRefs = useRef(new Map<Corner, HTMLDivElement>());
  const dragRef = useRef<Drag | null>(null);
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });

  // The outline follows the camera and the layer every frame, between renders.
  useWakeFramesOnRender();
  useEffect(() => {
    const tick = () => {
      const box = boxRef.current;
      const turn = turnRef.current;
      if (!box || !turn) return;
      const quad = readPlaneQuad(scene, surface.view, datasetId);
      if (!quad) {
        box.hidden = true;
        turn.hidden = true;
        for (const handle of handleRefs.current.values()) handle.hidden = true;
        return;
      }
      const project = makeWorldToScreen(scene, surface);
      const corner = (c: Corner) => project(cornerPoint(quad, c));
      const origin = corner("nw");
      const [ne, sw] = [corner("ne"), corner("sw")];
      const across = [ne[0] - origin[0], ne[1] - origin[1]];
      const down = [sw[0] - origin[0], sw[1] - origin[1]];
      const width = Math.hypot(across[0], across[1]);
      const height = Math.hypot(down[0], down[1]);
      const unit = (v: number[], length: number) => (length > 0 ? [v[0] / length, v[1] / length] : [0, 0]);
      const [ax, ay] = unit(across, width);
      const [dx, dy] = unit(down, height);
      // The box's own axes run along the outline's edges on screen, which a
      // turn, or a view that draws its plane transposed, carries off the
      // screen's.
      box.hidden = false;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      box.style.transform = `matrix(${ax}, ${ay}, ${dx}, ${dy}, ${origin[0]}, ${origin[1]})`;
      for (const [c, handle] of handleRefs.current) {
        const [hx, hy] = corner(c);
        handle.hidden = false;
        handle.style.transform = `translate(${hx}px, ${hy}px)`;
      }
      const top = [(origin[0] + ne[0]) / 2, (origin[1] + ne[1]) / 2];
      turn.hidden = false;
      turn.style.transform =
        `translate(${top[0] - dx * TURN_HANDLE_REACH_PX}px, ${top[1] - dy * TURN_HANDLE_REACH_PX}px)`;
    };
    return frameClock.subscribe(tick);
  }, [scene, surface, datasetId]);

  // Native listeners on the overlay, which the view's own element would
  // otherwise also hear and pan by as the press bubbles past it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const settle = (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      drag.endEscape();
      try {
        drag.target.releasePointerCapture(drag.pointerId);
      } catch {
        // The capture may already be gone.
      }
      if (commit) actionsRef.current.commit(datasetId, drag.from, drag.latest);
      else actionsRef.current.preview(datasetId, drag.from);
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-grip]") : null;
      if (!target || e.button !== 0 || dragRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      const quad = readPlaneQuad(scene, surface.view, datasetId);
      if (!quad) return;
      const plane = scene.slice_plane(surface.view) as SlicePlane;
      const from = actionsRef.current.current(datasetId);
      const placement = readPlacement(scene, datasetId);
      const drag: Drag = {
        pointerId: e.pointerId,
        target,
        grip: target.dataset.grip as Drag["grip"],
        from,
        latest: from,
        start: eventToWorld(scene, surface, e),
        quad,
        plane,
        cutOrigin: placement.offset[xyz(cutAxis(plane))],
        pixel: devicePixelRatio / scene.zoom(surface.view),
        endEscape: () => {},
      };
      drag.endEscape = pushEscapeLayer(() => settle(false));
      dragRef.current = drag;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Moves still arrive over the overlay without the capture.
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.stopPropagation();
      const now = eventToWorld(scene, surface, e);
      const cut = cutAxis(drag.plane);
      let next: UserTransform | null;
      if (drag.grip === "turn") {
        const angle = turnAngle(quadCenter(drag.quad), drag.start, now);
        next = userTransformTurnedInView(scene, surface.view, datasetId, drag.from, angle);
      } else {
        const map = drag.grip === "move"
          ? moveMap(drag.start, now, cut)
          : scaleMap(drag.quad, drag.grip, drag.start, now, {
            uniform: !e.shiftKey,
            cut,
            cutOrigin: drag.cutOrigin,
            minExtent: MIN_EXTENT_PX * drag.pixel,
          });
        next = userTransformAfter(scene, datasetId, drag.from, map);
      }
      if (!next) return;
      drag.latest = next;
      actionsRef.current.preview(datasetId, next);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (dragRef.current?.pointerId !== e.pointerId) return;
      e.stopPropagation();
      settle(true);
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (dragRef.current?.pointerId !== e.pointerId) return;
      settle(false);
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", onPointerCancel);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerCancel);
      // A drag cut short by the tool closing goes back where it began.
      settle(false);
    };
  }, [scene, surface, datasetId]);

  return (
    <div ref={rootRef} className="lc-move-scale" data-testid="move-scale-overlay">
      <div
        ref={boxRef}
        className="lc-move-scale-box"
        data-grip="move"
        role="img"
        aria-label={`${name}: drag to move, drag a corner to scale, drag the round handle to rotate`}
        hidden
      />
      {CORNERS.map((corner) => (
        <div
          key={corner}
          ref={(el) => {
            if (el) handleRefs.current.set(corner, el);
            else handleRefs.current.delete(corner);
          }}
          className="lc-move-scale-handle"
          data-grip={corner}
          data-corner={corner}
          hidden
        />
      ))}
      <div ref={turnRef} className="lc-move-scale-turn" data-grip="turn" hidden />
    </div>
  );
}
