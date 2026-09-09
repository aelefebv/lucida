/**
 * The page's side of the trace driver's scripted steps (ADR 0051, as
 * amended).
 *
 * A script's pan, zoom, and orbit reach the page as the pointer and wheel
 * events the driver synthesizes over the DevTools protocol, so they need
 * nothing here: the viewers' own handlers take them. Scrub and select have no
 * such path on the capture surface, where the selectors and the layer panel
 * are hidden and a synthesized click has nothing to land on. So the viewer
 * registers the handlers those controls call, and the driver reaches them
 * through the trace seam. From the handler on, the path is the one a drag of
 * the slider or a click on the checkbox takes, and the recorder hears the
 * input where it always does: at the control.
 *
 * `view` is how the driver learns what a step did. It is the view as the page
 * would save it, read before and after each step, so a step that did not
 * land is a fact in the run rather than a silence.
 */

import type { DatasetId, SavedView, ViewState } from "../savedView/types.ts";

/** The selectors a scrub moves. */
export type ScrubAxis = "z" | "t" | "c";
export const SCRUB_AXES: readonly ScrubAxis[] = ["z", "t", "c"];

/** What a select shows or hides: a channel of the dataset in hand, or a layer by dataset id. */
export type SelectTarget = { channel: number } | { layer: string };

export interface StepOutcome {
  /** Whether the handler ran. False when the page had nothing to apply the step to. */
  applied: boolean;
  /** Why not, when it did not run. Null when it did. */
  reason: string | null;
}

/** What the viewer registers. Each answers for one step kind. */
export interface ScriptControls {
  /** The view as the page would save it, or null before a scene exists. */
  view(): SavedView | null;
  /** Move a selector by `count` positions through the handler the dimension control calls. */
  scrub(axis: ScrubAxis, count: number): StepOutcome;
  /** Show or hide a channel or a layer through the handler the layer panel calls. */
  select(target: SelectTarget, visible: boolean): StepOutcome;
}

let registered: ScriptControls | null = null;

/**
 * Register the viewer's controls, or withdraw them with null. Called by the
 * app once the selectors and the layer handlers exist.
 */
export function setScriptControls(controls: ScriptControls | null): void {
  registered = controls;
}

export function scriptControls(): ScriptControls | null {
  return registered;
}

/** The selectors as the dimension controls see them. */
export interface SelectorState {
  z: number;
  t: number;
  c: number;
  dimZ: number;
  dimT: number;
  dimC: number;
  viewMode: "2d" | "3d";
}

/**
 * Where a scrub by `count` puts the selector, or why the control would not
 * move it. The refusals are the control's own: the Z selector is disabled in
 * volume mode, an axis with one position renders no selector, and the next
 * button is disabled at the end of the axis. A refused scrub marks no input,
 * exactly as a click on a disabled button marks none.
 */
export function scrubIndex(
  state: SelectorState,
  axis: ScrubAxis,
  count: number,
): { index: number } | { refused: string } {
  if (!Number.isInteger(count)) return { refused: `a scrub count is a whole number, not ${count}` };
  if (count === 0) return { refused: "a scrub by 0 moves nothing" };
  if (axis === "z" && state.viewMode === "3d") {
    return { refused: "the Z selector is disabled in volume mode" };
  }
  const { current, extent } = selectorOn(state, axis);
  if (extent <= 1) return { refused: `${axis} has one position, so there is no selector to move` };
  const index = Math.min(extent - 1, Math.max(0, current + count));
  if (index === current) {
    const end = count > 0 ? "end" : "start";
    return { refused: `${axis} is already at the ${end} of its axis (index ${current} of ${extent})` };
  }
  return { index };
}

function selectorOn(state: SelectorState, axis: ScrubAxis): { current: number; extent: number } {
  const byAxis = {
    z: { current: state.z, extent: state.dimZ },
    t: { current: state.t, extent: state.dimT },
    c: { current: state.c, extent: state.dimC },
  };
  return byAxis[axis];
}

/**
 * The part of a view a scripted step is judged by: the camera less its
 * viewport, the selectors, and whether each dataset, channel, and label is
 * shown. Contrast is left out because auto-contrast refits it as data
 * arrives, which would make a hold look like a change of view. The driver
 * reads this before and after each step and compares the two; the rule
 * lives here so the page, not the driver, says what counts as the view.
 */
export interface ViewSignature {
  camera: Record<string, unknown> | null;
  view: ViewState | null;
  visibility: Record<DatasetId, { visible: boolean; channels: boolean[] | null; labels: boolean[] | null }>;
}

export function viewSignature(view: SavedView | null): ViewSignature | null {
  if (!view) return null;
  const { viewport: _viewport, ...camera } = view.camera ?? {};
  void _viewport;
  const visibility: ViewSignature["visibility"] = {};
  for (const [id, settings] of Object.entries(view.dataset_settings ?? {})) {
    visibility[id] = {
      visible: settings.visible,
      channels: settings.channel_settings?.map((channel) => channel.visible) ?? null,
      labels: settings.label_settings?.map((label) => label.visible) ?? null,
    };
  }
  return { camera: Object.keys(camera).length > 0 ? camera : null, view: view.view ?? null, visibility };
}

/**
 * The dataset a channel select is about: the selected one, else the only one
 * open. Null when nothing is open, when the selection names a dataset that
 * has since closed, or when several are open and none is selected, which
 * the page cannot resolve on the driver's behalf.
 */
export function selectDataset(selectedId: string | null, openIds: readonly string[]): string | null {
  if (selectedId !== null) return openIds.includes(selectedId) ? selectedId : null;
  return openIds.length === 1 ? openIds[0] : null;
}
