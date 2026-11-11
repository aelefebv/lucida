/**
 * Each view's comparison controls over that view's rectangle: the compare
 * bar at its top and the swipe divider across it, so the divider stands
 * where the view splits.
 *
 * They lie beside the view's pane, not in it: the viewers listen on the pane
 * itself, and a press on a control would also pan the view. A press or focus
 * in them makes their view the active one first, as a press in the pane
 * does, so the controls, which steer the active view, steer the comparison
 * they show.
 */
import { useSyncExternalStore } from "react";
import { setAsideNote, type ComparisonActions } from "../comparison.ts";
import { ComparisonBar, SwipeDivider } from "../components/Comparison.tsx";
import type { SceneStore, ViewPane } from "../sceneStore.ts";
import "./ViewComparisons.css";

interface Props {
  views: readonly ViewPane[];
  store: Pick<SceneStore, "subscribe" | "getComparisons">;
  actions: ComparisonActions;
  nameOf(datasetId: string): string;
  /** Make `view` the one commands steer. */
  activate(view: number): void;
}

export function ViewComparisons({ views, store, actions, nameOf, activate }: Props) {
  const comparisons = useSyncExternalStore(store.subscribe, store.getComparisons, store.getComparisons);
  return (
    <div className="lc-view-comparisons">
      {views.map((pane) => {
        const comparison = comparisons.get(pane.id);
        if (!comparison) return null;
        const [x, y, width, height] = pane.rect;
        const select = () => {
          if (!pane.active) activate(pane.id);
        };
        return (
          <div
            key={pane.id}
            className="lc-view-comparison"
            data-view={pane.id}
            data-active={pane.active ? "" : undefined}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
            onPointerDownCapture={select}
            onFocusCapture={select}
          >
            {/* Before the bar, so the bar covers the line where they cross. */}
            <SwipeDivider comparison={comparison} actions={actions} nameOf={nameOf} />
            <div className="lc-view-comparison-bar">
              <ComparisonBar
                comparison={comparison}
                actions={actions}
                nameOf={nameOf}
                setAside={setAsideNote(pane.setAside)}
                active={pane.active}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
