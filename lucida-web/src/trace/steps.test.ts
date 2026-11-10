// @vitest-environment happy-dom
/**
 * The page's side of the driver's scripted steps: the registered controls a
 * scrub and a select go through, and what they answer when there is nothing
 * to apply them to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SavedView } from "../savedView/types.ts";
import {
  awaitDatasetOpen,
  comparisonPair,
  datasetIdForSource,
  noteDatasetOpened,
  noteDatasetOpenFailed,
  scriptControls,
  scrubIndex,
  scrubSolo,
  selectDataset,
  setScriptControls,
  viewSignature,
  type SelectorState,
} from "./steps.ts";

const selectors: SelectorState = { z: 5, t: 0, dimZ: 10, dimT: 4, viewMode: "2d" };

describe("where a scrub lands", () => {
  it("moves the selector by the count, clamped to the axis", () => {
    expect(scrubIndex(selectors, "z", 2)).toEqual({ index: 7 });
    expect(scrubIndex(selectors, "z", -9)).toEqual({ index: 0 });
    expect(scrubIndex(selectors, "t", 40)).toEqual({ index: 3 });
  });

  it("moves a c scrub through the composite and then each channel alone", () => {
    expect(scrubSolo(null, 3, 1)).toEqual({ solo: 0 });
    expect(scrubSolo(null, 3, 2)).toEqual({ solo: 1 });
    expect(scrubSolo(1, 3, 9)).toEqual({ solo: 2 });
    expect(scrubSolo(0, 3, -1)).toEqual({ solo: null });
    expect(scrubSolo(2, 3, -9)).toEqual({ solo: null });
  });

  it("refuses a c scrub with nowhere to go", () => {
    expect(scrubSolo(null, 3, -1)).toEqual({ refused: "c is already at the composite" });
    expect(scrubSolo(2, 3, 1)).toEqual({ refused: "c is already at its last channel (index 2 of 3)" });
    expect(scrubSolo(null, 1, 1)).toEqual({
      refused: "the layer has one channel, so there is nothing to solo",
    });
    expect(scrubSolo(null, 3, 0)).toEqual({ refused: "a scrub by 0 moves nothing" });
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
    view: { z_range: { start: 0, end: 1 }, t },
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

  it("changes with a layer's solo, which leaves the visibility flags alone", () => {
    const soloed = view(0.5, 0, true, 100, [1440, 900]);
    soloed.dataset_settings["ds-1"].solo = 1;
    expect(changed(soloed)).toBe(true);
  });

  it("ignores a contrast refit and the viewport", () => {
    expect(changed(view(0.5, 0, true, 250, [1440, 900]))).toBe(false);
    expect(changed(view(0.5, 0, true, 100, [800, 600]))).toBe(false);
    expect(viewSignature(base)!.camera).not.toHaveProperty("viewport");
  });

  it("changes with a contrast window a hand set, which stops auto-contrast", () => {
    const manual = (max: number) => {
      const set = view(0.5, 0, true, max, [1440, 900]);
      set.auto_contrast = { "ds-1": false };
      return set;
    };
    expect(changed(manual(100))).toBe(true);
    const handSet = JSON.stringify(viewSignature(manual(100)));
    expect(JSON.stringify(viewSignature(manual(100)))).toBe(handSet);
    expect(JSON.stringify(viewSignature(manual(250)))).not.toBe(handSet);
  });

  it("changes with the comparison, which no saved view records", () => {
    const swipe = { a: "ds-1", b: "ds-2", mode: "swipe", divider: 0.5, showing: "a" } as const;
    const signature = (comparison: typeof swipe | null) => JSON.stringify(viewSignature(base, comparison));
    expect(signature(swipe)).not.toBe(signature(null));
    expect(signature({ ...swipe, divider: 0.25 } as never)).not.toBe(signature(swipe));
  });

  it("is null before a scene exists", () => {
    expect(viewSignature(null)).toBeNull();
  });
});

describe("a scripted add's answer", () => {
  afterEach(() => vi.useRealTimers());

  it("lands when a dataset that was not open opens, says why when its open fails, and gives up at the timeout", async () => {
    const opened = awaitDatasetOpen("/data/b.zarr", new Set(["wds-a"]), 5000);
    // A dataset that was open already, opened again, is not the one added.
    noteDatasetOpened("wds-a");
    noteDatasetOpened("wds-b");
    await expect(opened).resolves.toEqual({ applied: true, reason: null });

    const failed = awaitDatasetOpen("/data/c.zarr", new Set(), 5000);
    noteDatasetOpenFailed("/data/other.zarr", "nope");
    noteDatasetOpenFailed("/data/c.zarr", "not found");
    await expect(failed).resolves.toEqual({ applied: false, reason: "/data/c.zarr did not open: not found" });

    vi.useFakeTimers();
    const late = awaitDatasetOpen("/data/d.zarr", new Set(), 3000);
    vi.advanceTimersByTime(3000);
    await expect(late).resolves.toEqual({ applied: false, reason: "/data/d.zarr did not open within 3 s" });
    // A late open after the answer changes nothing.
    noteDatasetOpened("wds-d");
  });

  it("finds a dataset's workspace id by its source URL in canonical form", () => {
    const health = [
      { workspace_dataset_id: "wds-a", source_url: "/data/a.zarr" },
      { workspace_dataset_id: "wds-b", source_url: null },
    ];
    const canonical = (url: string) => url.toLowerCase();
    expect(datasetIdForSource("/DATA/A.zarr", health, canonical)).toBe("wds-a");
    expect(datasetIdForSource("/data/b.zarr", health, canonical)).toBeNull();
  });
});

describe("the registration", () => {
  beforeEach(() => setScriptControls(null));

  it("compares the two open datasets, or the one in hand with the one named", () => {
    expect(comparisonPair(null, ["a", "b"], null)).toEqual({ a: "a", b: "b" });
    expect(comparisonPair("b", ["a", "b", "c"], "c")).toEqual({ a: "b", b: "c" });
    expect(comparisonPair("c", ["a", "b", "c"], "c")).toEqual({ a: "a", b: "c" });
    expect(comparisonPair(null, ["a", "b", "c"], null)).toHaveProperty("refused");
    expect(comparisonPair(null, ["c"], "c")).toEqual({ refused: "nothing is open to compare c with" });
  });

  it("holds the controls the viewer registered and forgets them when withdrawn", () => {
    const controls = {
      view: () => null,
      comparison: () => null,
      scrub: () => ({ applied: true, reason: null }),
      select: () => ({ applied: true, reason: null }),
      contrast: () => ({ applied: true, reason: null }),
      addDataset: () => Promise.resolve({ applied: true, reason: null }),
      removeDataset: () => Promise.resolve({ applied: true, reason: null }),
      swipe: () => Promise.resolve({ applied: true, reason: null }),
      blink: () => Promise.resolve({ applied: true, reason: null }),
    };
    expect(scriptControls()).toBeNull();
    setScriptControls(controls);
    expect(scriptControls()).toBe(controls);
    setScriptControls(null);
    expect(scriptControls()).toBeNull();
  });
});
