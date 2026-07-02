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
    name: "yeast",
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
    const infos = buildLayerInfos(scene, datasetsWith([label("mito"), label("cells")]), emptyMaps);
    expect(infos).toHaveLength(1);
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "mito", visible: true, opacity: 0.5 },
      { index: 1, name: "cells", visible: false, opacity: 0.25 },
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
      datasetsWith([label("nuclei", "Uint16"), label("cells", "Uint32")]),
      emptyMaps,
    );
    expect(infos[0].labelRows).toEqual([{ index: 1, name: "cells", visible: true, opacity: 0.7 }]);
  });

  it("with NO label_settings (empty), the first drawable label shows (render fallback)", () => {
    const scene = stubScene(["ds-0"], settingsWith([]));
    const infos = buildLayerInfos(scene, datasetsWith([label("mito"), label("cells")]), emptyMaps);
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "mito", visible: true, opacity: 0.5 },
      { index: 1, name: "cells", visible: false, opacity: 0.5 },
    ]);
  });

  it("leaves labelRows undefined for a dataset with no drawable labels", () => {
    const scene = stubScene(["ds-0"], settingsWith([]));
    // A single uint8 (ineligible) label → no drawable rows.
    const infos = buildLayerInfos(scene, datasetsWith([label("mask", "Uint8")]), emptyMaps);
    expect(infos[0].labelRows).toBeUndefined();
  });
});
