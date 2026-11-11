// @vitest-environment happy-dom
//
// The capture policy for a new pin's view, tested at the helper because the
// pointer-gesture create path is awkward to unit-test. The view carries no
// source URLs, since it rides on broadcast and persisted document state, and
// it carries the scene's view, which is the author's live Z/T/C.

import { describe, it, expect, vi } from "vitest";

// `captureBuilder` imports `is_local_dataset_url` from the wasm package at
// module load; stub it so the import resolves without real wasm.
vi.mock("lucida-core", () => ({
  is_local_dataset_url: (url: string): boolean => url.startsWith("/"),
}));

import { buildAnnotationView } from "./buildAnnotationView.ts";

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
    camera_space: () => "null",
    user_transforms: () => JSON.stringify({ "ds-a": { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }),
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

  it("leaves placement by hand out, so opening the pin never moves a dataset", () => {
    const view = buildAnnotationView(mockScene({ z_range: { start: 0, end: 1 }, t: 0, c: 0 }));
    expect(view).not.toBeNull();
    expect("user_transforms" in view!).toBe(false);
  });

  it("carries the scene's z slab, t, c, and multi-channel flag", () => {
    const presenceView = { z_range: { start: 4, end: 9 }, t: 7, c: 3, multi_channel: true };
    const view = buildAnnotationView(mockScene(presenceView));
    expect(view!.view).toEqual(presenceView);
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
