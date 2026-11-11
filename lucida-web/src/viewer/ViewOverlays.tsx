/**
 * What lies over each view's rectangle beside its pane: four-up's plane
 * lines, the crosshair of the point under the pointer in another view, a
 * comparison's swipe divider across it, and one column at its top holding
 * the compare bar and, below it, the notices that the view covers less than
 * it asks for, of where a link took it past its data, and that the point
 * under the pointer is outside its data. The column keeps them from covering
 * each other, and the bar comes first so a notice coming or going never moves
 * it under the pointer.
 *
 * They lie beside the pane, not in it: the viewers listen on the pane itself,
 * and a press on a control would also pan the view. A press or focus in them
 * makes their view the active one first, as a press in the pane does, so the
 * comparison controls, which steer the active view, steer the comparison
 * they show.
 */
import { useSyncExternalStore } from "react";
import { setAsideNote, type ComparisonActions } from "../comparison.ts";
import { ComparisonBar, SwipeDivider } from "../components/Comparison.tsx";
import type { SceneStore, ViewPane } from "../sceneStore.ts";
import type { ViewLinkNotices } from "../viewLinks.ts";
import { CoverageNotice, type Coverage } from "./CoverageNotice.tsx";
import { Crosshair, CrosshairOutside } from "./Crosshair.tsx";
import type { Hover } from "./hover.ts";
import { LinkNotices } from "./LinkNotices.tsx";
import { ViewPlaneLines } from "./PlaneLines.tsx";
import type { FourUpPlanes } from "./planeLines.ts";
import type { SpatialAxis } from "../renderer/slicePlane.ts";
import "./ViewOverlays.css";

interface Props {
  views: readonly ViewPane[];
  store: Pick<SceneStore, "subscribe" | "getComparisons">;
  actions: ComparisonActions;
  nameOf(datasetId: string): string;
  /** Make `view` the one commands steer. */
  activate(view: number): void;
  /** With several views, how much of what `view` asks for fit in the memory they share. */
  coverageOf(view: number): Coverage | undefined;
  /** Says when a pair lines up because someone placed it by hand, or null. */
  byHand(a: string, b: string): string | null;
  /** With two linked views, where the links took each past its data. */
  linkNotices?: readonly ViewLinkNotices[];
  /** Where four-up's planes cross each view. */
  planes?: FourUpPlanes | null;
  /** Move `axis`'s plane to `fraction` of the way across `view`, as dragging its line does. */
  dragPlane?: (view: number, axis: SpatialAxis, fraction: number) => void;
  /** The crosshairs the point under the pointer puts in the other views. */
  hover?: Pick<Hover, "subscribe" | "markOf">;
  /** Whether a running blink holds still, as a capture asks. */
  still?: boolean;
}

export function ViewOverlays({
  views, store, actions, nameOf, activate, coverageOf, byHand, linkNotices, planes, dragPlane, hover, still,
}: Props) {
  const comparisons = useSyncExternalStore(store.subscribe, store.getComparisons, store.getComparisons);
  return (
    <div className="lc-view-overlays">
      {views.map((pane) => {
        const comparison = comparisons.get(pane.id) ?? null;
        const [x, y, width, height] = pane.rect;
        const select = () => {
          if (!pane.active) activate(pane.id);
        };
        return (
          <div
            key={pane.id}
            className="lc-view-overlay"
            data-view={pane.id}
            data-active={pane.active ? "" : undefined}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
            onPointerDownCapture={select}
            onFocusCapture={select}
          >
            {/* Under the column, so its controls and notices cover the lines. */}
            {planes && (
              <ViewPlaneLines
                planes={planes}
                view={pane.id}
                onDrag={dragPlane && pane.cameraMode === "slice" ? (axis, fraction) => dragPlane(pane.id, axis, fraction) : undefined}
              />
            )}
            {hover && <Crosshair hover={hover} view={pane.id} />}
            {/* Before the column, so the bar covers the line where they cross. */}
            {comparison && <SwipeDivider comparison={comparison} actions={actions} nameOf={nameOf} />}
            <div className="lc-view-overlay-top">
              {comparison && (
                <div className="lc-view-comparison-bar">
                  <ComparisonBar
                    comparison={comparison}
                    actions={actions}
                    nameOf={nameOf}
                    setAside={setAsideNote(pane.setAside)}
                    byHand={byHand(comparison.a, comparison.b)}
                    active={pane.active}
                    still={still}
                  />
                </div>
              )}
              <CoverageNotice coverage={coverageOf(pane.id)} />
              <LinkNotices notices={linkNotices?.find((shown) => shown.view === pane.id)?.notices ?? []} />
              {hover && <CrosshairOutside hover={hover} view={pane.id} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
