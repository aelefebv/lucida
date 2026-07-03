// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import type { WasmScene } from "lucida-core";
import { buildLayerInfos } from "./useDatasetSettings.ts";
import { resolveVisibleLabels } from "../pipeline/planning/labelRequests.ts";
import type { DatasetState } from "../types.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "../manifestTypes.ts";

// A single-level image with the given dtype + [Y, X] shape (chunked so a small
// label's footprint fits the default caps). `z` deepens the volume: a
// single-level label with z over the 3D texture limit is drawable in 2D but
// not in 3D.
function image(id: string, dtype: string, yx: [number, number], z = 1): ImageSpec {
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
          shape: [1, 1, z, yx[0], yx[1]],
          chunk_shape: [1, 1, 1, 128, 128],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, 1, 1],
        },
      ],
      data_type: dtype,
    },
  };
}

function label(name: string, dtype = "Uint32", z = 1): LabelSpec {
  return {
    name,
    source_image_id: "img-0",
    image: image(`img-0:label:${name}`, dtype, [64, 64], z),
  };
}

/** A uint32 label that can never render: its source image does not exist.
 *  (The scene seed never picks an orphan, but a restored saved view or stale
 *  snapshot can still mark one visible — the pathological case the
 *  row/drawn-set agreement guards.) */
function orphanLabel(name: string): LabelSpec {
  return {
    name,
    source_image_id: "missing",
    image: image(`img-0:label:${name}`, "Uint32", [64, 64]),
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

/** A stub WasmScene exposing only what {@link buildLayerInfos} reads.
 *  `cameraMode` mirrors `WasmScene.camera_mode()`: `"slice"` for the 2D view,
 *  an orbit/fly mode string ("arcball"/"fly") for 3D. */
function stubScene(
  order: string[],
  allSettings: Record<string, unknown>,
  c = 0,
  cameraMode = "slice",
): WasmScene {
  return {
    dataset_order: () => JSON.stringify(order),
    all_dataset_settings: () => JSON.stringify(allSettings),
    dataset_name: (id: string) => id,
    c: () => c,
    camera_mode: () => cameraMode,
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

describe("buildLayerInfos label rows follow the active view mode", () => {
  it("omits a slice-eligible but volume-ineligible label while the camera is 3D", () => {
    // A single-level uint32 label with Z=3000: drawable in 2D (the slice caps
    // ignore Z) but over the 3D texture limit, so the volume render path skips
    // it. In 3D the panel must not offer an eye/slider that can't take effect;
    // back in 2D the row returns.
    const labels = [label("deep", "Uint32", 3000)];
    const settings = settingsWith([{ visible: true, opacity: 0.5 }]);

    const sliceInfos = buildLayerInfos(stubScene(["ds-0"], settings), datasetsWith(labels), emptyMaps);
    expect(sliceInfos[0].labelRows).toEqual([
      { index: 0, name: "deep", visible: true, opacity: 0.5 },
    ]);

    const volumeInfos = buildLayerInfos(
      stubScene(["ds-0"], settings, 0, "arcball"),
      datasetsWith(labels),
      emptyMaps,
    );
    expect(volumeInfos[0].labelRows).toBeUndefined();

    // The rows mirror what each mode's render path draws.
    const ls = [{ visible: true, opacity: 0.5 }];
    expect(resolveVisibleLabels(manifest(labels), ls, { mode: "slice" }).map((r) => r.name)).toEqual(["deep"]);
    expect(resolveVisibleLabels(manifest(labels), ls, { mode: "volume" })).toEqual([]);
  });

  it("keeps a volume-drawable label's row (with its stored state) in 3D", () => {
    // A flat 64² label fits both the slice and volume caps, so its row (and
    // stored visibility/opacity) is identical across the mode switch.
    const labels = [label("mito")];
    const settings = settingsWith([{ visible: false, opacity: 0.8 }]);
    for (const mode of ["slice", "fly"]) {
      const infos = buildLayerInfos(stubScene(["ds-0"], settings, 0, mode), datasetsWith(labels), emptyMaps);
      expect(infos[0].labelRows).toEqual([{ index: 0, name: "mito", visible: false, opacity: 0.8 }]);
    }
  });
});

describe("buildLayerInfos label rows == the drawn set (shared resolution)", () => {
  /** The names the panel presents as visible — must equal what render draws. */
  function visibleRowNames(infos: ReturnType<typeof buildLayerInfos>): string[] {
    return (infos[0].labelRows ?? []).filter((r) => r.visible).map((r) => r.name);
  }

  it("a stale visible flag on an undrawable label: one hidden row, nothing drawn", () => {
    // Stored settings mark index 0 visible, but that label is an orphan
    // (uint32, no source image) — it can never render and gets no row. (A
    // fresh seed never picks an orphan, but a restored view whose label lost
    // its source can carry exactly this.) The drawable label at index 1 is
    // stored hidden. Panel: exactly one row, hidden. Render: nothing. The
    // stale flag must neither surface a row it can't honor nor force the
    // OTHER label on (which the panel would then show as hidden — an overlay
    // with no working off switch).
    const labels = [orphanLabel("ghost"), label("cells")];
    const seed = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    const infos = buildLayerInfos(stubScene(["ds-0"], settingsWith(seed)), datasetsWith(labels), emptyMaps);
    expect(infos[0].labelRows).toEqual([{ index: 1, name: "cells", visible: false, opacity: 0.5 }]);

    const drawn = resolveVisibleLabels(manifest(labels), seed);
    expect(drawn).toEqual([]);
    expect(visibleRowNames(infos)).toEqual(drawn.map((r) => r.name));
  });

  it("a fresh-open seed that skips an undrawable first label draws the drawable one", () => {
    // The scene-side seed spends its single visible pick on the first label
    // that could plausibly draw — for [orphan, cells] that is index 1 — so a
    // fresh open shows exactly one overlay, with one visible row controlling
    // it. (An orphan-first dataset must not open blank while a drawable
    // sibling exists.)
    const labels = [orphanLabel("ghost"), label("cells")];
    const seed = [
      { visible: false, opacity: 0.5 },
      { visible: true, opacity: 0.5 },
    ];
    const infos = buildLayerInfos(stubScene(["ds-0"], settingsWith(seed)), datasetsWith(labels), emptyMaps);
    expect(infos[0].labelRows).toEqual([{ index: 1, name: "cells", visible: true, opacity: 0.5 }]);
    expect(resolveVisibleLabels(manifest(labels), seed).map((r) => r.name)).toEqual(["cells"]);
  });

  it("showing then hiding the drawable label keeps panel and render in lockstep", () => {
    const labels = [orphanLabel("ghost"), label("cells")];

    // The user turns the drawable label on via its row (index 1)…
    const shown = [
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.5 },
    ];
    const shownInfos = buildLayerInfos(stubScene(["ds-0"], settingsWith(shown)), datasetsWith(labels), emptyMaps);
    expect(shownInfos[0].labelRows).toEqual([{ index: 1, name: "cells", visible: true, opacity: 0.5 }]);
    expect(resolveVisibleLabels(manifest(labels), shown).map((r) => r.name)).toEqual(["cells"]);

    // …and off again: every row hidden ⇒ nothing drawn, even though the
    // orphan's stale flag is still true (no control exists to clear it).
    const hidden = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    const hiddenInfos = buildLayerInfos(stubScene(["ds-0"], settingsWith(hidden)), datasetsWith(labels), emptyMaps);
    expect(visibleRowNames(hiddenInfos)).toEqual([]);
    expect(resolveVisibleLabels(manifest(labels), hidden)).toEqual([]);
  });

  it("normal all-drawable dataset: seeded default shows the first label, hide-all draws nothing", () => {
    const labels = [label("mito"), label("cells")];
    // Fresh open (seed: first drawable visible, rest hidden).
    const seed = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    const infos = buildLayerInfos(stubScene(["ds-0"], settingsWith(seed)), datasetsWith(labels), emptyMaps);
    expect(infos[0].labelRows).toEqual([
      { index: 0, name: "mito", visible: true, opacity: 0.5 },
      { index: 1, name: "cells", visible: false, opacity: 0.5 },
    ]);
    expect(resolveVisibleLabels(manifest(labels), seed).map((r) => r.name)).toEqual(["mito"]);

    // Explicit hide-all: both rows stay (still drawable), nothing drawn.
    const allHidden = [
      { visible: false, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    const hiddenInfos = buildLayerInfos(stubScene(["ds-0"], settingsWith(allHidden)), datasetsWith(labels), emptyMaps);
    expect(hiddenInfos[0].labelRows?.map((r) => r.visible)).toEqual([false, false]);
    expect(resolveVisibleLabels(manifest(labels), allHidden)).toEqual([]);
  });
});
