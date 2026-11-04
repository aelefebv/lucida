// @vitest-environment happy-dom
//
// The capture policy for a new pin's view, tested at the helper because the
// pointer-gesture create path is awkward to unit-test. The view carries no
// source URLs, since it rides on broadcast and persisted document state, and
// it carries the author's live Z/T/C verbatim.

import { describe, it, expect, vi } from "vitest";

// `captureBuilder` imports `is_local_dataset_url` from the wasm package at
// module load; stub it so the import resolves without real wasm.
vi.mock("lucida-core", () => ({
  is_local_dataset_url: (url: string): boolean => url.startsWith("/"),
}));

import {
  buildAnnotationView,
  liveViewWithLiveTC,
  liveViewWithLiveZTC,
} from "./buildAnnotationView.ts";
import type { ViewState } from "./types.ts";

/** A mock `WasmScene` exposing only what `buildCapture` reads, keyed by a
 * workspace-local dataset id. */
function mockScene(presenceView: unknown) {
  return {
    export_presence: () =>
      JSON.stringify({
        camera: { mode: "slice", center: [1, 2], zoom: 2.0, viewport: [800, 600] },
        view: presenceView,
        display: { contrast_min: 10, contrast_max: 5000, gamma: 1.0 },
      }),
    export_dataset_presence: () =>
      JSON.stringify({
        dataset_order: ["wds-a"],
        dataset_settings: {
          "wds-a": {
            visible: true,
            opacity: 1,
            contrast_min: 0,
            contrast_max: 65535,
            gamma: 1,
            blend_mode: "alpha",
          },
        },
      }),
    dataset_ids: () => JSON.stringify(["wds-a"]),
    available_layouts: () => JSON.stringify([{ id: "source", active: true }]),
  } as never;
}

describe("buildAnnotationView", () => {
  it("captures workspace-dataset-id form: no source URLs on the pin's view", () => {
    const view = buildAnnotationView(mockScene({ z_range: { start: 0, end: 1 }, t: 0, c: 0 }));
    expect(view).not.toBeNull();
    expect(view!.datasets).toEqual([]);
    // It still references the workspace-local dataset by id.
    expect(view!.dataset_order).toEqual(["wds-a"]);
    expect(view!.active_layouts).toEqual({ "wds-a": "source" });
  });

  it("carries the live Z/T/C verbatim into the captured view", () => {
    const liveView: ViewState = {
      z_range: { start: 10, end: 11 },
      t: 7,
      c: 3,
      multi_channel: false,
    };
    // Presence reports a different, stale view; the live one must win.
    const view = buildAnnotationView(
      mockScene({ z_range: { start: 0, end: 1 }, t: 0, c: 0 }),
      liveView,
    );
    expect(view!.view).toEqual(liveView);
  });

  it("captures the live camera + display from the scene presence", () => {
    const view = buildAnnotationView(mockScene({ z_range: { start: 0, end: 1 }, t: 0, c: 0 }));
    expect(view!.camera).toEqual({ mode: "slice", center: [1, 2], zoom: 2.0, viewport: [800, 600] });
    expect(view!.display).toEqual({ contrast_min: 10, contrast_max: 5000, gamma: 1.0 });
  });

  it("returns null (rather than throwing) when capture fails", () => {
    const broken = {
      export_presence: () => {
        throw new Error("scene gone");
      },
    } as never;
    expect(buildAnnotationView(broken)).toBeNull();
  });
});

describe("liveViewWithLiveTC (3D create path)", () => {
  it("keeps the presence z-slab/multi_channel but overrides t/c with live values", () => {
    const scene = mockScene({ z_range: { start: 4, end: 9 }, t: 0, c: 0, multi_channel: true });
    const live = liveViewWithLiveTC(scene, 5, 2);
    expect(live).toEqual({ z_range: { start: 4, end: 9 }, t: 5, c: 2, multi_channel: true });
  });

  it("returns undefined when presence is unreadable", () => {
    const broken = {
      export_presence: () => "not json",
    } as never;
    expect(liveViewWithLiveTC(broken, 1, 1)).toBeUndefined();
  });
});

describe("liveViewWithLiveZTC (2D create path)", () => {
  it("preserves multi_channel AND the slab thickness from presence, with live z as the start", () => {
    // Presence has a 5-plane slab (4..9) with multi-channel on; the slider is
    // at z=20. Keep the thickness and multi_channel, re-anchored to z.
    const scene = mockScene({ z_range: { start: 4, end: 9 }, t: 0, c: 0, multi_channel: true });
    const live = liveViewWithLiveZTC(scene, 20, 7, 3);
    expect(live).toEqual({
      z_range: { start: 20, end: 25 },
      t: 7,
      c: 3,
      multi_channel: true,
    });
  });

  it("regression: does NOT collapse a multi-plane / multi-channel 2D capture to single-plane single-channel", () => {
    // A hand-rolled `{ z_range: {start: z, end: z+1} }` would drop both.
    const scene = mockScene({ z_range: { start: 2, end: 6 }, t: 0, c: 0, multi_channel: true });
    const view = buildAnnotationView(scene, liveViewWithLiveZTC(scene, 10, 1, 0));
    expect(view).not.toBeNull();
    expect(view!.view.z_range).toEqual({ start: 10, end: 14 });
    expect(view!.view.multi_channel).toBe(true);
  });

  it("falls back to a single plane when the presence slab is degenerate/missing", () => {
    const scene = mockScene({ z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false });
    const live = liveViewWithLiveZTC(scene, 12, 0, 0);
    expect(live).toEqual({
      z_range: { start: 12, end: 13 },
      t: 0,
      c: 0,
      multi_channel: false,
    });
  });

  it("returns undefined when presence is unreadable", () => {
    const broken = {
      export_presence: () => "not json",
    } as never;
    expect(liveViewWithLiveZTC(broken, 1, 1, 1)).toBeUndefined();
  });
});
