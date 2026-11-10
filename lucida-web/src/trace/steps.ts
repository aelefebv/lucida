/**
 * The page's side of the trace driver's scripted steps.
 *
 * Pan, zoom, orbit, a mode switch, a fit, and a resize arrive as synthesized
 * pointer, wheel, key, and touch events or a new window size, and need
 * nothing here. Scrub, select, contrast, and adding or removing a dataset
 * have nothing to click on the capture surface, so the viewer registers the
 * handlers those controls call and the driver reaches them through the trace
 * seam. The recorder still hears the input at the control. `view` is read
 * before and after each step, so a step that did not land is a fact in the
 * run rather than a silence.
 */

import type { DatasetId, SavedView, ViewState } from "../savedView/types.ts";
import { cutAxis, type SlicePlane } from "../renderer/slicePlane.ts";

/** The selectors a scrub moves. `y` and `x` are the cuts of an XZ and a YZ view. */
export type ScrubAxis = "z" | "y" | "x" | "t" | "c";
export const SCRUB_AXES: readonly ScrubAxis[] = ["z", "y", "x", "t", "c"];

/** The planes a slice view cuts. */
export const SLICE_PLANES: readonly SlicePlane[] = ["xy", "xz", "yz"];

/**
 * What a select shows or hides: a channel of the dataset in hand, a layer by
 * dataset id, or a label of the dataset in hand by its index among the labels.
 */
export type SelectTarget = { channel: number } | { layer: string } | { label: number };

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
  /** Cut `plane` with the slice view through the handler the plane toggle calls. */
  plane(plane: SlicePlane): StepOutcome;
  /** Show or hide a channel, a layer or a label through the handler the layer panel calls. */
  select(target: SelectTarget, visible: boolean): StepOutcome;
  /** Set a channel's contrast window through the handler the layer panel's limits call. */
  contrast(channel: number, min: number, max: number): StepOutcome;
  /**
   * Add a dataset by source URL through the handler the add-data dialog
   * calls. Answers once the dataset has opened or failed to, or when
   * `timeoutMs` passes first.
   */
  addDataset(url: string, timeoutMs: number): Promise<StepOutcome>;
  /** Remove the dataset opened from a source URL through the handler the layer panel calls. */
  removeDataset(url: string): Promise<StepOutcome>;
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

interface PendingOpen {
  url: string;
  openBefore: ReadonlySet<string>;
  settle(outcome: StepOutcome): void;
}

const pendingOpens: PendingOpen[] = [];

/**
 * What a scripted add of `url` answers: applied once a dataset not in
 * `openBefore` opens, refused with the server's error when the open of
 * `url` fails, and refused when neither happens within `timeoutMs`. The
 * server mints a workspace dataset's id and the open names only its
 * manifest, so the new dataset is the one that was not open before. The
 * app reports both from the session's open callbacks, which a person's add
 * goes through too.
 */
export function awaitDatasetOpen(url: string, openBefore: ReadonlySet<string>, timeoutMs: number): Promise<StepOutcome> {
  return new Promise((resolve) => {
    const pending: PendingOpen = {
      url,
      openBefore,
      settle: (outcome) => {
        clearTimeout(timer);
        const index = pendingOpens.indexOf(pending);
        if (index >= 0) pendingOpens.splice(index, 1);
        resolve(outcome);
      },
    };
    const timer = setTimeout(() => {
      pending.settle({ applied: false, reason: `${url} did not open within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    pendingOpens.push(pending);
  });
}

/** A dataset opened: the oldest scripted add it is new to has landed. */
export function noteDatasetOpened(id: string): void {
  pendingOpens.find((pending) => !pending.openBefore.has(id))?.settle({ applied: true, reason: null });
}

/** The open of `url` failed: a scripted add waiting on it says why. */
export function noteDatasetOpenFailed(url: string, error: string): void {
  for (const pending of pendingOpens.filter((candidate) => candidate.url === url)) {
    pending.settle({ applied: false, reason: `${url} did not open: ${error}` });
  }
}

/**
 * The workspace's id for the dataset opened from `url`, out of the server's
 * dataset health, the one record that pairs a source URL with an id. Both
 * sides are compared in canonical form.
 */
export function datasetIdForSource(
  url: string,
  health: readonly { workspace_dataset_id: string; source_url?: string | null }[],
  canonical: (url: string) => string,
): string | null {
  const wanted = canonical(url);
  const entry = health.find((candidate) => candidate.source_url && canonical(candidate.source_url) === wanted);
  return entry?.workspace_dataset_id ?? null;
}

/** The selectors as the dimension controls see them. */
export interface SelectorState {
  z: number;
  t: number;
  dimZ: number;
  dimT: number;
  viewMode: "2d" | "3d";
  /** The plane the slice view cuts, whose cut axis the one spatial selector moves along. */
  slicePlane: SlicePlane;
  /** The axis position along that cut, and the positions there are. */
  cutIndex: number;
  dimCut: number;
}

/**
 * Where a scrub by `count` puts the z or t selector, or why the control would
 * not move it. The refusals are the control's own: the Z selector is disabled
 * in volume mode, an axis with one position renders no selector, and the next
 * button is disabled at the end of the axis. A refused scrub marks no input,
 * exactly as a click on a disabled button marks none.
 */
export function scrubIndex(
  state: SelectorState,
  axis: "z" | "y" | "x" | "t",
  count: number,
): { index: number } | { refused: string } {
  const invalid = invalidCount(count);
  if (invalid) return { refused: invalid };
  if (axis !== "t" && state.viewMode === "3d") {
    return { refused: `the ${axis.toUpperCase()} selector is disabled in volume mode` };
  }
  const cut = cutAxis(state.slicePlane);
  if (axis !== "t" && axis !== cut) {
    return {
      refused: `the ${state.slicePlane.toUpperCase()} view cuts ${cut.toUpperCase()}, so there is no ${axis.toUpperCase()} selector`,
    };
  }
  const { current, extent } = axis === "t"
    ? { current: state.t, extent: state.dimT }
    : { current: state.cutIndex, extent: state.dimCut };
  if (extent <= 1) return { refused: `${axis} has one position, so there is no selector to move` };
  const index = Math.min(extent - 1, Math.max(0, current + count));
  if (index === current) {
    const end = count > 0 ? "end" : "start";
    return { refused: `${axis} is already at the ${end} of its axis (index ${current} of ${extent})` };
  }
  return { index };
}

/**
 * Where a `c` scrub by `count` puts a layer's solo, or why it would not move.
 * The scrub solos the layer's channels in turn, and the composite counts as
 * the position before channel 0: from the composite `c:1` solos channel 0, and
 * from channel 0 `c:-1` returns to the composite (`solo: null`).
 */
export function scrubSolo(
  solo: number | null,
  channelCount: number,
  count: number,
): { solo: number | null } | { refused: string } {
  const invalid = invalidCount(count);
  if (invalid) return { refused: invalid };
  if (channelCount <= 1) return { refused: "the layer has one channel, so there is nothing to solo" };
  const current = solo ?? -1;
  const next = Math.min(channelCount - 1, Math.max(-1, current + count));
  if (next === current) {
    const at = current === -1 ? "the composite" : `its last channel (index ${current} of ${channelCount})`;
    return { refused: `c is already at ${at}` };
  }
  return { solo: next === -1 ? null : next };
}

function invalidCount(count: number): string | null {
  if (!Number.isInteger(count)) return `a scrub count is a whole number, not ${count}`;
  if (count === 0) return "a scrub by 0 moves nothing";
  return null;
}

/**
 * The part of a view a scripted step is judged by: the camera less its
 * viewport, the selectors, whether each dataset, channel, and label is
 * shown, each layer's solo, and the contrast windows a hand set. Contrast
 * under auto-contrast is left out because it refits as data arrives, which
 * would make a hold look like a change of view. The driver reads this before
 * and after each step and compares the two; the rule lives here so the page,
 * not the driver, says what counts as the view.
 */
export interface ViewSignature {
  camera: Record<string, unknown> | null;
  view: ViewState | null;
  visibility: Record<DatasetId, {
    visible: boolean;
    channels: boolean[] | null;
    solo: number | null;
    labels: boolean[] | null;
  }>;
  /** Each channel's `[min, max]`, for the datasets whose contrast a hand set. */
  contrast: Record<DatasetId, [number, number][]>;
}

export function viewSignature(view: SavedView | null): ViewSignature | null {
  if (!view) return null;
  const { viewport: _viewport, ...camera } = view.camera ?? {};
  void _viewport;
  const visibility: ViewSignature["visibility"] = {};
  const contrast: ViewSignature["contrast"] = {};
  for (const [id, settings] of Object.entries(view.dataset_settings ?? {})) {
    visibility[id] = {
      visible: settings.visible,
      channels: settings.channel_settings?.map((channel) => channel.visible) ?? null,
      solo: settings.solo ?? null,
      labels: settings.label_settings?.map((label) => label.visible) ?? null,
    };
    if (view.auto_contrast?.[id] === false) {
      contrast[id] = settings.channel_settings?.map((channel) => [channel.contrast_min, channel.contrast_max]) ?? [];
    }
  }
  return {
    camera: Object.keys(camera).length > 0 ? camera : null,
    view: view.view ?? null,
    visibility,
    contrast,
  };
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
