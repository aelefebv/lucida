/**
 * The Move and scale tool over a slice view: the selected layer's outline,
 * which a drag moves, and a handle on each corner, which a drag scales from
 * the opposite corner, alike on every axis unless Shift is held. A drag shows
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
import { userTransformAfter, type UserTransform } from "../userTransform.ts";
import { eventToWorld, makeWorldToScreen, type ViewSurface } from "./cameraProjection.ts";
import { CORNERS, cornerPoint, moveMap, scaleMap, type Corner, type PlaneRect } from "./moveScaleGesture.ts";
import "./MoveScaleOverlay.css";

/** The smallest an outline may be scaled to, in CSS px. */
const MIN_EXTENT_PX = 12;

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
  grip: "move" | Corner;
  from: UserTransform;
  latest: UserTransform;
  start: [number, number];
  rect: PlaneRect;
  plane: SlicePlane;
  cutOrigin: number;
  /** One CSS pixel in the plane's units, at the press. */
  pixel: number;
  endEscape: () => void;
}

export function MoveScaleOverlay({ datasetId, name, scene, surface, actions }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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
      if (!box) return;
      const bounds = scene.dataset_plane_bounds(surface.view, datasetId);
      if (bounds.length < 4) {
        box.hidden = true;
        for (const handle of handleRefs.current.values()) handle.hidden = true;
        return;
      }
      const project = makeWorldToScreen(scene, surface);
      const [x0, y0] = project([bounds[0], bounds[1]]);
      const [x1, y1] = project([bounds[2], bounds[3]]);
      box.hidden = false;
      box.style.transform = `translate(${x0}px, ${y0}px)`;
      box.style.width = `${x1 - x0}px`;
      box.style.height = `${y1 - y0}px`;
      const rect: PlaneRect = [x0, y0, x1, y1];
      for (const [corner, handle] of handleRefs.current) {
        const [hx, hy] = cornerPoint(rect, corner);
        handle.hidden = false;
        handle.style.transform = `translate(${hx}px, ${hy}px)`;
      }
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
      const bounds = scene.dataset_plane_bounds(surface.view, datasetId);
      if (bounds.length < 4) return;
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
        rect: [bounds[0], bounds[1], bounds[2], bounds[3]],
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
      const map = drag.grip === "move"
        ? moveMap(drag.start, now, cut)
        : scaleMap(drag.rect, drag.grip, drag.start, now, {
          uniform: !e.shiftKey,
          cut,
          cutOrigin: drag.cutOrigin,
          minExtent: MIN_EXTENT_PX * drag.pixel,
        });
      const next = userTransformAfter(scene, datasetId, drag.from, map);
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
        aria-label={`${name}: drag to move, drag a corner to scale`}
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
    </div>
  );
}
