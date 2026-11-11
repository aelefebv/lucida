/**
 * The controls that divide the canvas among views: each writes the scene's
 * views and draws the next frame. A layout moves every view's camera and
 * what one shows changes what it plans, and both bump the epochs the planner
 * reads, so nothing else needs telling.
 */

import { applyViewportCommand } from "./applyAndSend.ts";
import type { ViewLayoutName } from "./commands.ts";
import type { InvalidationSink } from "./invalidation.ts";
import type { WasmScene } from "lucida-core";

export interface ViewLayoutActions {
  /** How the canvas divides now. */
  layout(): ViewLayoutName;
  /** Every view's id on the canvas, in the layout's order. */
  views(): number[];
  setLayout(layout: ViewLayoutName): void;
  /** Make `view` the one commands steer. */
  activate(view: number): void;
  /** Show these datasets alone in `view`. */
  show(view: number, datasetIds: readonly string[]): void;
  /** Show `datasetId` in `view` and in no other view, as a layer dropped on it moves there. */
  move(view: number, datasetId: string): void;
  /** Show `datasetId` in every view, as well as what each shows. */
  showEverywhere(datasetId: string): void;
  /** Show `view` alone across the canvas, or every view again with null. */
  maximize(view: number | null): void;
}

export function viewLayoutActions(
  scene: () => WasmScene | null,
  loop: () => InvalidationSink | null | undefined,
): ViewLayoutActions {
  const write = (edit: (scene: WasmScene) => void) => {
    const current = scene();
    if (!current) return;
    edit(current);
    // Every view the layout touches takes a new size, as a resize gives one.
    loop()?.markInput("resize");
  };
  return {
    layout: () => (scene()?.view_layout() as ViewLayoutName | undefined) ?? "single",
    views: () => Array.from(scene()?.view_ids() ?? []),
    setLayout: (layout) => write((s) => applyViewportCommand(s, { type: "set_view_layout", layout })),
    activate: (view) => write((s) => applyViewportCommand(s, { type: "set_active_view", view })),
    show: (view, datasetIds) => write((s) => applyViewportCommand(s, {
      type: "set_view_datasets",
      view,
      datasets: { only: [...datasetIds] },
    })),
    move: (view, datasetId) => write((s) => applyViewportCommand(s, {
      type: "move_dataset_to_view",
      view,
      dataset_id: datasetId,
    })),
    showEverywhere: (datasetId) => write((s) => {
      for (const view of s.view_ids()) {
        const shows = JSON.parse(s.view_datasets(view)) as "all" | { only: string[] } | null;
        if (shows === null || shows === "all" || shows.only.includes(datasetId)) continue;
        applyViewportCommand(s, {
          type: "set_view_datasets",
          view,
          datasets: { only: [...shows.only, datasetId] },
        });
      }
    }),
    maximize: (view) => write((s) => applyViewportCommand(s, { type: "maximize_view", view })),
  };
}
