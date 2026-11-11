/**
 * An element over each view's rectangle of the canvas, which takes that
 * view's input and holds what is drawn over it. A press or a wheel in a view
 * makes it the active view before anything handles it, so the commands the
 * gesture sends steer that view; hovering never changes which view is
 * active. With several views, a double click shows one alone and shows them
 * all again, and a layer dropped on a view moves there.
 */
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { ViewPane } from "../sceneStore.ts";
import type { ViewSurface } from "../components/cameraProjection.ts";
import { DATASET_DRAG_TYPE } from "./viewPane.ts";
import "./ViewPanes.css";

/** What the panes call: the view layout controls. */
export interface PaneActions {
  /** Make `view` the active view. */
  activate(view: number): void;
  /** Show `view` alone across the canvas, or every view again with null. */
  maximize(view: number | null): void;
  /** Show `datasetId` in `view` and in no other view. */
  move(view: number, datasetId: string): void;
}

interface Props {
  views: readonly ViewPane[];
  /** The view shown alone across the canvas, if one is. */
  maximized: number | null;
  actions: PaneActions;
  /** What a view's pane holds, once its element exists. */
  children(pane: ViewPane, surface: ViewSurface): ReactNode;
  /** The element that holds every pane, which a pointer over any view reaches. */
  rootRef?: (element: HTMLDivElement | null) => void;
}

export function ViewPanes({ views, maximized, actions, children, rootRef }: Props) {
  // A double click shows one view alone, or all of them again.
  const toggles = views.length > 1 || maximized !== null;
  return (
    <div ref={rootRef} className="lc-view-panes">
      {views.map((pane) => (
        <Pane
          key={pane.id}
          pane={pane}
          actions={actions}
          several={views.length > 1}
          onToggle={toggles ? () => actions.maximize(maximized === null ? pane.id : null) : undefined}
        >
          {children}
        </Pane>
      ))}
    </div>
  );
}

function Pane({ pane, actions, several, onToggle, children }: {
  pane: ViewPane;
  actions: PaneActions;
  several: boolean;
  onToggle?: () => void;
  children: Props["children"];
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [dropping, setDropping] = useState(false);
  const pointerType = useRef("mouse");
  // One object while the view and its element last, so what depends on it
  // binds once.
  const surface = useMemo(() => (element ? { view: pane.id, element } : null), [element, pane.id]);
  const [x, y, width, height] = pane.rect;
  const select = () => {
    if (!pane.active) actions.activate(pane.id);
  };
  // Only a layer from the panel drops on a view.
  const dragsLayer = (event: DragEvent) => several && event.dataTransfer.types.includes(DATASET_DRAG_TYPE);
  return (
    <div
      ref={setElement}
      className="lc-view-pane"
      data-view-pane={pane.id}
      data-camera={pane.cameraMode}
      data-active={several && pane.active ? "" : undefined}
      data-drop-target={dropping ? "" : undefined}
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
      onPointerDownCapture={(event) => {
        pointerType.current = event.pointerType;
        select();
      }}
      onWheelCapture={select}
      // A finger's double tap zooms the view instead.
      onDoubleClick={onToggle && (() => pointerType.current !== "touch" && onToggle())}
      onDragOver={(event) => {
        if (!dragsLayer(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        const datasetId = event.dataTransfer.getData(DATASET_DRAG_TYPE);
        if (!datasetId) return;
        event.preventDefault();
        actions.move(pane.id, datasetId);
      }}
    >
      {surface && children(pane, surface)}
      {several && pane.shows !== "all" && pane.shows.length === 0 && (
        <p className="lc-view-pane-hint">Drag a layer here</p>
      )}
    </div>
  );
}
