// @vitest-environment happy-dom
//
// The share-warning classifier (`hasLocalFilePaths` / `localFilePathCount`),
// which delegates to the wasm `is_local_dataset_url`.
// The shim is mocked with a small reference implementation;
// `urlHelpers.test.ts` covers the real wasm wiring.

import { describe, it, expect, vi } from "vitest";

// Mock before importing the module under test so its import-time
// `is_local_dataset_url` reference picks up the stub.
vi.mock("lucida-core", () => ({
  is_local_dataset_url: (url: string): boolean => {
    if (url === "") return false;
    if (
      url.startsWith("gs://") ||
      url.startsWith("s3://") ||
      url.startsWith("http://") ||
      url.startsWith("https://")
    ) {
      return false;
    }
    // UNC canonical.
    if (url.startsWith("//")) return true;
    // Drive-letter canonical (`c:` or `c:/...`).
    if (/^[a-z]:(\/|$)/.test(url)) return true;
    // Unix.
    return url.startsWith("/");
  },
}));

import {
  buildCapture,
  hasLocalFilePaths,
  localFilePathCount,
} from "./captureBuilder.ts";
import type { SavedView } from "./types.ts";
import { SAVED_VIEW_VERSION } from "./types.ts";

function viewWith(datasets: string[]): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets,
    active_layouts: {},
    camera: {
      mode: "slice",
      center: [0, 0],
      zoom: 1.0,
      viewport: [800, 600],
    },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

describe("captureBuilder.isLocalFilePath (via hasLocalFilePaths)", () => {
  it("classifies a Unix path as local", () => {
    expect(hasLocalFilePaths(viewWith(["/data/scans/foo.zarr"]))).toBe(true);
  });

  it("classifies bare `/` as local", () => {
    expect(hasLocalFilePaths(viewWith(["/"]))).toBe(true);
  });

  it("classifies a canonical drive-letter path as local", () => {
    expect(hasLocalFilePaths(viewWith(["c:/foo"]))).toBe(true);
  });

  it("classifies a canonical UNC path as local", () => {
    expect(hasLocalFilePaths(viewWith(["//server/share/foo"]))).toBe(true);
  });

  it("does not classify gs:// as local", () => {
    expect(hasLocalFilePaths(viewWith(["gs://bucket/foo"]))).toBe(false);
  });

  it("does not classify s3:// as local", () => {
    expect(hasLocalFilePaths(viewWith(["s3://bucket/foo"]))).toBe(false);
  });

  it("does not classify http(s):// as local", () => {
    expect(hasLocalFilePaths(viewWith(["https://host.example.com/foo.zarr"]))).toBe(false);
  });

  it("returns false for an empty datasets list", () => {
    expect(hasLocalFilePaths(viewWith([]))).toBe(false);
  });

  it("counts every local path in a mixed view", () => {
    const v = viewWith([
      "gs://bucket/cloud.zarr",
      "/data/unix.zarr",
      "c:/data/windows.zarr",
      "//server/share/unc.zarr",
      "https://host/remote.zarr",
    ]);
    expect(hasLocalFilePaths(v)).toBe(true);
    expect(localFilePathCount(v)).toBe(3);
  });
});

describe("buildCapture workspace dataset references", () => {
  it("does not put source URLs into workspace-mode saved views", () => {
    const scene = {
      export_presence: () => JSON.stringify({
        camera: {
          mode: "slice",
          center: [0, 0],
          zoom: 1.0,
          viewport: [800, 600],
        },
        view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
        display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
      }),
      export_dataset_presence: () => JSON.stringify({
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
      export_views: () => "null",
      user_transforms: () => "{}",
    };

    const view = buildCapture({
      scene: scene as never,
      urlByDatasetId: new Map([["wds-a", "gs://bucket/private.zarr"]]),
      datasetReferenceMode: "workspace-dataset-id",
    });

    expect(view.datasets).toEqual([]);
    expect(view.dataset_order).toEqual(["wds-a"]);
    expect(Object.keys(view.dataset_settings)).toEqual(["wds-a"]);
    expect(view.active_layouts).toEqual({ "wds-a": "source" });
  });

  it("stamps each dataset's current label names onto its display settings", () => {
    const scene = {
      export_presence: () => JSON.stringify({
        camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
        view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
        display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
      }),
      export_dataset_presence: () => JSON.stringify({
        dataset_order: ["wds-a"],
        dataset_settings: {
          "wds-a": {
            visible: true,
            opacity: 1,
            contrast_min: 0,
            contrast_max: 65535,
            gamma: 1,
            blend_mode: "alpha",
            label_settings: [
              { visible: true, opacity: 0.5 },
              { visible: false, opacity: 0.5 },
            ],
          },
        },
      }),
      dataset_ids: () => JSON.stringify(["wds-a"]),
      available_layouts: () => JSON.stringify([{ id: "source", active: true }]),
      camera_space: () => "null",
      export_views: () => "null",
      user_transforms: () => "{}",
    };

    const view = buildCapture({
      scene: scene as never,
      urlByDatasetId: new Map(),
      datasetReferenceMode: "workspace-dataset-id",
      labelNamesFor: (id) => (id === "wds-a" ? ["region-a", "region-b"] : undefined),
    });

    expect(view.dataset_settings["wds-a"].label_names).toEqual(["region-a", "region-b"]);
  });

  it("leaves label_names absent when the dataset has no labels", () => {
    const scene = {
      export_presence: () => JSON.stringify({
        camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
        view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
        display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
      }),
      export_dataset_presence: () => JSON.stringify({
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
      export_views: () => "null",
      user_transforms: () => "{}",
    };

    const view = buildCapture({
      scene: scene as never,
      urlByDatasetId: new Map(),
      datasetReferenceMode: "workspace-dataset-id",
      labelNamesFor: () => undefined,
    });

    expect(view.dataset_settings["wds-a"].label_names).toBeUndefined();
  });
});

describe("buildCapture camera space", () => {
  const space = {
    frame: { spacing: [0.5, 0.5, 2], origin: [0, 0, 0], meters: [1e-6, 1e-6, 1e-6] },
    world: { extent: 512, top: 256 },
  };

  let transforms = "{}";

  function sceneWithSpace(json: string) {
    return {
      export_presence: () => JSON.stringify({
        camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
        view: { z_range: { start: 0, end: 1 }, t: 0 },
        display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
      }),
      export_dataset_presence: () => JSON.stringify({ dataset_order: [], dataset_settings: {} }),
      dataset_ids: () => "[]",
      available_layouts: () => "[]",
      camera_space: () => json,
      export_views: () => "null",
      user_transforms: () => transforms,
    };
  }

  it("records the spaces the camera is in, then the placement, as the Rust view serializes", () => {
    const view = buildCapture({
      scene: sceneWithSpace(JSON.stringify(space)) as never,
      urlByDatasetId: new Map(),
    });
    expect(view.camera_space).toEqual(space);
    const keys = Object.keys(JSON.parse(JSON.stringify(view)) as object);
    expect(keys.slice(-2)).toEqual(["camera_space", "user_transforms"]);
  });

  it("records where datasets sit by hand, and an empty record when none was moved", () => {
    const moved = { translation: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [3, 3, 3] };
    transforms = JSON.stringify({ "ds-a": moved });
    const view = buildCapture({ scene: sceneWithSpace("null") as never, urlByDatasetId: new Map() });
    expect(view.user_transforms).toEqual({ "ds-a": moved });
    transforms = "{}";
    const none = buildCapture({ scene: sceneWithSpace("null") as never, urlByDatasetId: new Map() });
    expect(none.user_transforms).toEqual({});
  });

  it("records every view after the placement, and none for one view of every dataset", () => {
    const record = {
      layout: "rows",
      active: 0,
      views: [
        { camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 300] }, axes: { t: 0 }, datasets: "all" },
        { camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 300] }, axes: { t: 0 }, datasets: { only: [] } },
      ],
    };
    const scene = { ...sceneWithSpace(JSON.stringify(space)), export_views: () => JSON.stringify(record) };
    const view = buildCapture({ scene: scene as never, urlByDatasetId: new Map() });
    expect(view.views).toEqual(record);
    const keys = Object.keys(JSON.parse(JSON.stringify(view)) as object);
    expect(keys.slice(-3)).toEqual(["camera_space", "user_transforms", "views"]);
    const single = buildCapture({ scene: sceneWithSpace("null") as never, urlByDatasetId: new Map() });
    expect("views" in single && single.views !== undefined).toBe(false);
  });

  it("leaves it out while no dataset fixes them", () => {
    const view = buildCapture({ scene: sceneWithSpace("null") as never, urlByDatasetId: new Map() });
    expect(JSON.stringify(view)).not.toContain("camera_space");
  });
});
