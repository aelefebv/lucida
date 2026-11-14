/**
 * The controls that divide the canvas among views and link them: each
 * writes the scene's views and draws the next frame. A layout moves every
 * view's camera, a link can move the other view's, and what one shows
 * changes what it plans; each bumps the epochs the planner reads, so nothing
 * else needs telling.
 */

import { applyViewportCommand } from "./applyAndSend.ts";
import type { LinkMode, LinkProperty, ViewLayoutName } from "./commands.ts";
import type { InvalidationSink } from "./invalidation.ts";
import type { WasmScene } from "lucida-core";
import { everyLinkChanges, readViewLinks, type EveryLinkMode, type ViewLinks } from "./viewLinks.ts";

/** Every layout, in the order the layout menu offers them. */
export const VIEW_LAYOUTS: readonly ViewLayoutName[] = ["single", "columns", "rows", "grid", "four_up"];

/** Each layout as the layout menu names it. */
export const LAYOUT_LABELS: Readonly<Record<ViewLayoutName, string>> = {
  single: "1",
  columns: "1×2",
  rows: "2×1",
  grid: "2×2",
  four_up: "Four-up",
};

/** The layouts a phone offers: one view, or two stacked. */
export const PHONE_LAYOUTS: readonly ViewLayoutName[] = ["single", "rows"];

/** How many views each layout divides the canvas into. */
const VIEW_COUNT: Readonly<Record<ViewLayoutName, number>> = {
  single: 1,
  columns: 2,
  rows: 2,
  grid: 4,
  four_up: 4,
};

/** The layouts a screen offers. */
export function layoutsFor(phone: boolean): readonly ViewLayoutName[] {
  return phone ? PHONE_LAYOUTS : VIEW_LAYOUTS;
}

/** The most views any of `layouts` holds. */
export function mostViews(layouts: readonly ViewLayoutName[]): number {
  return Math.max(...layouts.map((layout) => VIEW_COUNT[layout]));
}

export function isViewLayoutName(value: string): value is ViewLayoutName {
  return (VIEW_LAYOUTS as readonly string[]).includes(value);
}

/**
 * The layout that gives each of `count` datasets a view of its own: two side
 * by side, or stacked on a phone, which offers no columns, and three or four
 * in quarters.
 */
export function layoutForEach(count: number, phone: boolean): ViewLayoutName {
  if (count <= 1) return "single";
  if (count === 2) return phone ? "rows" : "columns";
  return "grid";
}

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
  /**
   * Show these datasets in `view` as well as what it shows. Four-up shows
   * one set of datasets in all four views, so there they join every view.
   */
  add(view: number, datasetIds: readonly string[]): void;
  /**
   * Divide the canvas as `layout` does, every view showing nothing, for
   * datasets about to open into them one each. Returns the views in order.
   */
  layOutEmpty(layout: ViewLayoutName): number[];
  /** Show `view` alone across the canvas, or every view again with null. */
  maximize(view: number | null): void;
  /** How the two views link, or null with one view. */
  links(): ViewLinks | null;
  /** Link `property` between the two views in `mode`. */
  link(property: LinkProperty, mode: LinkMode): void;
  /** Link every property the views can link, or turn every one off, in one write. */
  linkAll(mode: EveryLinkMode): void;
}

/**
 * `changed` runs after every write, for what shares the views: presence and
 * the URL.
 */
export function viewLayoutActions(
  scene: () => WasmScene | null,
  loop: () => InvalidationSink | null | undefined,
  changed: () => void = () => {},
): ViewLayoutActions {
  const write = (edit: (scene: WasmScene) => void) => {
    const current = scene();
    if (!current) return;
    edit(current);
    // Every view the layout touches takes a new size, as a resize gives
    // one, and a link can move the other view.
    loop()?.markInput("resize");
    changed();
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
      for (const view of s.view_ids()) addTo(s, view, [datasetId]);
    }),
    add: (view, datasetIds) => write((s) => {
      const views = s.view_layout() === "four_up" ? Array.from(s.view_ids()) : [view];
      for (const each of views) addTo(s, each, datasetIds);
    }),
    layOutEmpty: (layout) => {
      let views: number[] = [];
      write((s) => {
        applyViewportCommand(s, { type: "set_view_layout", layout });
        views = Array.from(s.view_ids());
        for (const view of views) {
          applyViewportCommand(s, { type: "set_view_datasets", view, datasets: { only: [] } });
        }
      });
      return views;
    },
    maximize: (view) => write((s) => applyViewportCommand(s, { type: "maximize_view", view })),
    links: () => {
      const current = scene();
      return current ? readViewLinks(current) : null;
    },
    link: (property, mode) => write((s) => applyViewportCommand(s, { type: "set_view_link", property, mode })),
    linkAll: (mode) => write((s) => {
      const links = readViewLinks(s);
      if (!links) return;
      for (const property of everyLinkChanges(links, mode)) {
        applyViewportCommand(s, { type: "set_view_link", property, mode });
      }
    }),
  };
}

/** Show `datasetIds` in `view` as well as what it shows. */
function addTo(scene: WasmScene, view: number, datasetIds: readonly string[]): void {
  const shows = JSON.parse(scene.view_datasets(view)) as "all" | { only: string[] } | null;
  if (shows === null || shows === "all") return;
  const added = datasetIds.filter((id) => !shows.only.includes(id));
  if (added.length === 0) return;
  applyViewportCommand(scene, { type: "set_view_datasets", view, datasets: { only: [...shows.only, ...added] } });
}
