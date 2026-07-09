// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import type { WasmScene } from "lucida-core";
import { buildLayerInfos } from "./useDatasetSettings.ts";
import type { DatasetState } from "../types.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "../manifestTypes.ts";

// A single-level image with the given dtype + [Y, X] shape (chunked so a small
// label's footprint fits the default caps).
function image(id: string, dtype: string, yx: [number, number]): ImageSpec {
  return {
    image_id: id,
    owner: "ent-0",
    multiscale: {
      axes: [
        { name: "t", kind: "time" },
        { name: "c", kind: "channel" },
        { name: "z", kind: "space" },
        { name: "y", kind: "space" },
        { name: "x", kind: "space" },
      ],
      levels: [
        {
          level_index: 0,
          shape: [1, 1, 1, yx[0], yx[1]],
          chunk_shape: [1, 1, 1, 128, 128],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, 1, 1],
        },
      ],
      data_type: dtype,
    },
  };
}

function label(name: string, dtype = "Uint32"): LabelSpec {
  return {
    name,
    source_image_id: "img-0",
    image: image(`img-0:label:${name}`, dtype, [64, 64]),
  };
}

function manifest(labels: LabelSpec[]): DatasetManifest {
  return {
    dataset_id: "ds-0",
    name: "volume",
    kind: "Single",
    entities: [],
    transforms: [],
    source_layouts: [],
    default_layout_id: null,
    images: [image("img-0", "Uint16", [340, 348])],
    labels,
  };
}

/** A stub WasmScene exposing only what {@link buildLayerInfos} reads. */
function stubScene(
  order: string[],
  allSettings: Record<string, unknown>,
  c = 0,
): WasmScene {
  return {
    dataset_order: () => JSON.stringify(order),
    all_dataset_settings: () => JSON.stringify(allSettings),
    dataset_name: (id: string) => id,
    c: () => c,
  } as unknown as WasmScene;
}

function datasetsWith(labels: LabelSpec[]): Map<string, DatasetState> {
  return new Map([["ds-0", { manifest: manifest(labels) } as unknown as DatasetState]]);
}

const emptyMaps = {
  autoContrast: new Map<string, boolean>(),
  fullRange: new Map<string, boolean>(),
  dataRange: new Map<string, { min: number; max: number }>(),
};

// The full per-dataset settings shape the scene serializes, with the
// `label_settings` the Rust seed produces.
function settingsWith(labelSettings: { visible: boolean; opacity: number }[]) {
  return {
    "ds-0": {
      visible: true,
      opacity: 1,
      contrast_min: 0,
      contrast_max: 65535,
      gamma: 1,
      blend_mode: "alpha",
      render_mode: "translucent",
      channel_settings: [
        { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
      ],
      label_settings: labelSettings,
      channel_blend_mode: "additive",
    },
  };
}

describe("buildLayerInfos label rows (scene → LayerInfo seam)", () => {
  it("surfaces label_settings from all_dataset_settings into labelRows", () => {
    // THE regression this guards: the section renders live only if buildLayerInfos
    // reads `label_settings` out of the scene JSON and maps it onto the LayerInfo.
    const scene = stubScene(
      ["ds-0"],
      settingsWith([
        { visible: true, opacity: 0.5 },
        { visible: false, opacity: 0.25 },
      ]),
    );
    const infos = buildLayerInfos(scene, datasetsWith([label("region-b"), label("region-c")]), emptyMaps);
    expect(infos).toHaveLength(1);
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "region-b", visible: true, opacity: 0.5 },
      { index: 1, name: "region-c", visible: false, opacity: 0.25 },
    ]);
  });

  it("omits an ineligible (uint16) label and PRESERVES the manifest index", () => {
    // [uint16, uint32]: only index 1 is drawable, and its row keeps index 1 so the
    // toggle/opacity handlers target the right label_settings entry.
    const scene = stubScene(
      ["ds-0"],
      settingsWith([
        { visible: false, opacity: 0.5 },
        { visible: true, opacity: 0.7 },
      ]),
    );
    const infos = buildLayerInfos(
      scene,
      datasetsWith([label("region-a", "Uint16"), label("region-c", "Uint32")]),
      emptyMaps,
    );
    expect(infos[0].labelRows).toEqual([{ index: 1, name: "region-c", visible: true, opacity: 0.7 }]);
  });

  it("with NO label_settings (empty), every drawable label is LISTED but hidden (opt-in)", () => {
    // Masks are opt-in: the panel still lists every drawable mask (so any can be
    // toggled on with one click), but each row starts hidden.
    const scene = stubScene(["ds-0"], settingsWith([]));
    const infos = buildLayerInfos(scene, datasetsWith([label("region-b"), label("region-c")]), emptyMaps);
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "region-b", visible: false, opacity: 0.5 },
      { index: 1, name: "region-c", visible: false, opacity: 0.5 },
    ]);
  });

  it("leaves labelRows undefined for a dataset with no drawable labels", () => {
    const scene = stubScene(["ds-0"], settingsWith([]));
    // A single uint8 (ineligible) label → no drawable rows.
    const infos = buildLayerInfos(scene, datasetsWith([label("mask", "Uint8")]), emptyMaps);
    expect(infos[0].labelRows).toBeUndefined();
  });
});

// A single-level uint32 label that is slice-eligible (small X/Y) but
// volume-ineligible (Z busts the 3D per-axis cap), with no coarser level.
function deepZLabel(name: string): LabelSpec {
  return {
    name,
    source_image_id: "img-0",
    image: {
      image_id: `img-0:label:${name}`,
      owner: "ent-0",
      multiscale: {
        axes: [
          { name: "t", kind: "time" },
          { name: "c", kind: "channel" },
          { name: "z", kind: "space" },
          { name: "y", kind: "space" },
          { name: "x", kind: "space" },
        ],
        levels: [
          {
            level_index: 0,
            shape: [1, 1, 4096, 64, 64],
            chunk_shape: [1, 1, 1, 64, 64],
            grid_shape: [1, 1, 1, 1, 1],
            scale: [1, 1, 1, 1, 1],
          },
        ],
        data_type: "Uint32",
      },
    },
  } as LabelSpec;
}

describe("buildLayerInfos view-mode-aware label rows", () => {
  it("lists a slice-eligible/volume-ineligible label as a normal row in 2D", () => {
    const scene = stubScene(["ds-0"], settingsWith([{ visible: true, opacity: 0.5 }]));
    const infos = buildLayerInfos(
      scene,
      datasetsWith([deepZLabel("deep")]),
      emptyMaps,
      "2d",
    );
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "deep", visible: true, opacity: 0.5 },
    ]);
  });

  it("marks the same label disabled with the reason in 3D (union still lists it)", () => {
    const scene = stubScene(["ds-0"], settingsWith([{ visible: true, opacity: 0.5 }]));
    const infos = buildLayerInfos(
      scene,
      datasetsWith([deepZLabel("deep")]),
      emptyMaps,
      "3d",
    );
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "deep", visible: true, opacity: 0.5, disabledReason: "too large to render in 3D" },
    ]);
  });

  it("defaults viewMode to 2d for 3-arg callers (no disabledReason)", () => {
    const scene = stubScene(["ds-0"], settingsWith([{ visible: true, opacity: 0.5 }]));
    const infos = buildLayerInfos(scene, datasetsWith([deepZLabel("deep")]), emptyMaps);
    expect(infos[0].labelRows?.[0].disabledReason).toBeUndefined();
  });

  it("keeps a fully-eligible label interactive in both modes; disables only the over-cap one in 3D", () => {
    const scene = stubScene(
      ["ds-0"],
      settingsWith([
        { visible: true, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ]),
    );
    const infos = buildLayerInfos(
      scene,
      datasetsWith([deepZLabel("deep"), label("flat")]),
      emptyMaps,
      "3d",
    );
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "deep", visible: true, opacity: 0.5, disabledReason: "too large to render in 3D" },
      { index: 1, name: "flat", visible: true, opacity: 0.5 },
    ]);
  });

  // A single-level uint32 label of the given voxel dims (Z, Y, X): 4 B/voxel, so
  // bytes = Z·Y·X·4. Volume-eligible on its own but heavy enough to exercise the
  // total-volume budget when several are shown at once.
  function bigVolumeLabel(name: string, z: number, y: number, x: number): LabelSpec {
    return {
      name,
      source_image_id: "img-0",
      image: {
        image_id: `img-0:label:${name}`,
        owner: "ent-0",
        multiscale: {
          axes: [
            { name: "t", kind: "time" },
            { name: "c", kind: "channel" },
            { name: "z", kind: "space" },
            { name: "y", kind: "space" },
            { name: "x", kind: "space" },
          ],
          levels: [
            {
              level_index: 0,
              shape: [1, 1, z, y, x],
              chunk_shape: [1, 1, 64, 64, 64],
              grid_shape: [1, 1, 1, 1, 1],
              scale: [1, 1, 1, 1, 1],
            },
          ],
          data_type: "Uint32",
        },
      },
    } as LabelSpec;
  }

  it("disables an over-budget mask in 3D with a memory reason, distinct from the per-mask reason", () => {
    // Three ~192 MB masks; the 512 MB total budget fits the first two, so the
    // third is disabled with a memory-budget reason (NOT the volume-ineligible
    // "too large to render in 3D" reason).
    const scene = stubScene(
      ["ds-0"],
      settingsWith([
        { visible: true, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ]),
    );
    const infos = buildLayerInfos(
      scene,
      datasetsWith([
        bigVolumeLabel("a", 768, 256, 256),
        bigVolumeLabel("b", 768, 256, 256),
        bigVolumeLabel("c", 768, 256, 256),
      ]),
      emptyMaps,
      "3d",
    );
    const rows = infos[0].labelRows!;
    expect(rows[0].disabledReason).toBeUndefined();
    expect(rows[1].disabledReason).toBeUndefined();
    expect(rows[2].disabledReason).toContain("memory");
    // The same masks are fully interactive in 2D (budget is 3D-only).
    const infos2d = buildLayerInfos(
      scene,
      datasetsWith([
        bigVolumeLabel("a", 768, 256, 256),
        bigVolumeLabel("b", 768, 256, 256),
        bigVolumeLabel("c", 768, 256, 256),
      ]),
      emptyMaps,
      "2d",
    );
    expect(infos2d[0].labelRows!.every((r) => r.disabledReason === undefined)).toBe(true);
  });

  it("does not budget-skip a mask the user has explicitly hidden in 3D", () => {
    // The heavy first two are hidden; the third (visible) then fits alone, so it
    // stays interactive — a hidden mask never counts toward the 3D budget.
    const scene = stubScene(
      ["ds-0"],
      settingsWith([
        { visible: false, opacity: 0.5 },
        { visible: false, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ]),
    );
    const infos = buildLayerInfos(
      scene,
      datasetsWith([
        bigVolumeLabel("a", 768, 256, 256),
        bigVolumeLabel("b", 768, 256, 256),
        bigVolumeLabel("c", 768, 256, 256),
      ]),
      emptyMaps,
      "3d",
    );
    const rows = infos[0].labelRows!;
    expect(rows[2].visible).toBe(true);
    expect(rows[2].disabledReason).toBeUndefined();
  });
});
