// @vitest-environment happy-dom
/**
 * The page's side of the driver's scripted steps: the registered controls a
 * scrub and a select go through, and what they answer when there is nothing
 * to apply them to.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SavedView } from "../savedView/types.ts";
import {
  scriptControls,
  scrubIndex,
  selectDataset,
  setScriptControls,
  viewSignature,
  type SelectorState,
} from "./steps.ts";

const selectors: SelectorState = { z: 5, t: 0, c: 1, dimZ: 10, dimT: 4, dimC: 3, viewMode: "2d" };

describe("where a scrub lands", () => {
  it("moves the selector by the count, clamped to the axis", () => {
    expect(scrubIndex(selectors, "z", 2)).toEqual({ index: 7 });
    expect(scrubIndex(selectors, "z", -9)).toEqual({ index: 0 });
    expect(scrubIndex(selectors, "t", 40)).toEqual({ index: 3 });
    expect(scrubIndex(selectors, "c", -1)).toEqual({ index: 0 });
  });

  it("refuses a scrub the control itself would refuse", () => {
    expect(scrubIndex({ ...selectors, t: 3 }, "t", 1)).toEqual({
      refused: "t is already at the end of its axis (index 3 of 4)",
    });
    expect(scrubIndex(selectors, "z", 0)).toEqual({ refused: "a scrub by 0 moves nothing" });
    expect(scrubIndex({ ...selectors, dimT: 1 }, "t", 1)).toEqual({
      refused: "t has one position, so there is no selector to move",
    });
    expect(scrubIndex({ ...selectors, viewMode: "3d" }, "z", 1)).toEqual({
      refused: "the Z selector is disabled in volume mode",
    });
  });

  it("refuses a count that is not a whole number rather than guessing", () => {
    expect(scrubIndex(selectors, "z", 1.5)).toEqual({ refused: "a scrub count is a whole number, not 1.5" });
    expect(scrubIndex(selectors, "z", Number.NaN)).toEqual({ refused: "a scrub count is a whole number, not NaN" });
  });
});

describe("which dataset a select is about", () => {
  it("takes the selected dataset, then the only open one", () => {
    expect(selectDataset("ds-2", ["ds-1", "ds-2"])).toBe("ds-2");
    expect(selectDataset(null, ["ds-1"])).toBe("ds-1");
  });

  it("answers null when nothing is open or the selection names a dataset that is gone", () => {
    expect(selectDataset(null, [])).toBeNull();
    expect(selectDataset("ds-9", ["ds-1"])).toBeNull();
    // Several open and none selected is a question the page cannot answer alone.
    expect(selectDataset(null, ["ds-1", "ds-2"])).toBeNull();
  });
});

function view(theta: number, t: number, channelVisible: boolean, contrastMax: number, viewport: [number, number]): SavedView {
  return {
    v: 1,
    datasets: ["ds-1"],
    active_layouts: {},
    camera: { mode: "arcball", theta, phi: 0.2, distance: 900, fov: 45, viewport, near: 1, far: 1000, target: [0, 0, 0] },
    view: { z_range: { start: 0, end: 1 }, t, c: 0 },
    display: { contrast_min: 0, contrast_max: contrastMax, gamma: 1 },
    dataset_order: ["ds-1"],
    dataset_settings: {
      "ds-1": {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: contrastMax,
        gamma: 1,
        blend_mode: "alpha",
        channel_settings: [
          { visible: true, colormap: "gray", contrast_min: 0, contrast_max: contrastMax, gamma: 1 },
          { visible: channelVisible, colormap: "gray", contrast_min: 0, contrast_max: 1, gamma: 1 },
        ],
      },
    },
  };
}

describe("what a step is judged by", () => {
  const base = view(0.5, 0, true, 100, [1440, 900]);
  const changed = (other: SavedView) => JSON.stringify(viewSignature(base)) !== JSON.stringify(viewSignature(other));

  it("changes with the camera, the selectors, and the visibility", () => {
    expect(changed(base)).toBe(false);
    expect(changed(view(0.9, 0, true, 100, [1440, 900]))).toBe(true);
    expect(changed(view(0.5, 1, true, 100, [1440, 900]))).toBe(true);
    expect(changed(view(0.5, 0, false, 100, [1440, 900]))).toBe(true);
  });

  it("ignores a contrast refit and the viewport", () => {
    expect(changed(view(0.5, 0, true, 250, [1440, 900]))).toBe(false);
    expect(changed(view(0.5, 0, true, 100, [800, 600]))).toBe(false);
    expect(viewSignature(base)!.camera).not.toHaveProperty("viewport");
  });

  it("is null before a scene exists", () => {
    expect(viewSignature(null)).toBeNull();
  });
});

describe("the registration", () => {
  beforeEach(() => setScriptControls(null));

  it("holds the controls the viewer registered and forgets them when withdrawn", () => {
    const controls = {
      view: () => null,
      scrub: () => ({ applied: true, reason: null }),
      select: () => ({ applied: true, reason: null }),
    };
    expect(scriptControls()).toBeNull();
    setScriptControls(controls);
    expect(scriptControls()).toBe(controls);
    setScriptControls(null);
    expect(scriptControls()).toBeNull();
  });
});
