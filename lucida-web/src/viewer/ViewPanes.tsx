/**
 * An element over each view's rectangle of the canvas, which takes that
 * view's input and holds what is drawn over it. A press or a wheel in a view
 * makes it the active view before anything handles it, so the commands the
 * gesture sends steer that view; hovering never changes which view is
 * active.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { ViewPane } from "../sceneStore.ts";
import type { ViewSurface } from "../components/cameraProjection.ts";
import "./ViewPanes.css";

interface Props {
  views: readonly ViewPane[];
  /** Make `view` the active view. */
  activate(view: number): void;
  /** What a view's pane holds, once its element exists. */
  children(pane: ViewPane, surface: ViewSurface): ReactNode;
  /** The element that holds every pane, which a pointer over any view reaches. */
  rootRef?: (element: HTMLDivElement | null) => void;
}

export function ViewPanes({ views, activate, children, rootRef }: Props) {
  return (
    <div ref={rootRef} className="lc-view-panes">
      {views.map((pane) => (
        <Pane key={pane.id} pane={pane} activate={activate} several={views.length > 1}>
          {children}
        </Pane>
      ))}
    </div>
  );
}

function Pane({ pane, activate, several, children }: {
  pane: ViewPane;
  activate(view: number): void;
  several: boolean;
  children: Props["children"];
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  // One object while the view and its element last, so what depends on it
  // binds once.
  const surface = useMemo(() => (element ? { view: pane.id, element } : null), [element, pane.id]);
  const [x, y, width, height] = pane.rect;
  const select = () => {
    if (!pane.active) activate(pane.id);
  };
  return (
    <div
      ref={setElement}
      className="lc-view-pane"
      data-view-pane={pane.id}
      data-active={several && pane.active ? "" : undefined}
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
      onPointerDownCapture={select}
      onWheelCapture={select}
    >
      {surface && children(pane, surface)}
    </div>
  );
}
