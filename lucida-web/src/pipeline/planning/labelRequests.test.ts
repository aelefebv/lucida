import { describe, it, expect, vi } from "vitest";
import {
  __resetLabelWarningsForTest,
  computeLabelChunkRequests,
  eligibleLabelInfos,
  resolveVisibleLabels,
  volumeBudgetPrefix,
} from "./labelRequests.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "../../manifestTypes.ts";

/** Explicit all-visible settings of length `n`. Masks are opt-in (hidden by
 *  default), so a test that exercises level selection / the 3D memory budget /
 *  mode-eligibility with every mask SHOWN must turn them on explicitly rather
 *  than relying on an all-visible default (there no longer is one). */
function allOn(n: number): { visible: boolean; opacity: number }[] {
  return Array.from({ length: n }, () => ({ visible: true, opacity: 0.5 }));
}

function image(id: string, dtype: string, shapeYX: [number, number], scaleYX: [number, number]): ImageSpec {
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
          shape: [1, 1, 1, shapeYX[0], shapeYX[1]],
          chunk_shape: [1, 1, 1, 128, 128],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, scaleYX[0], scaleYX[1]],
        },
      ],
      data_type: dtype,
    },
  };
}

function manifestWithLabel(label?: LabelSpec): DatasetManifest {
  return {
    dataset_id: "ds-0",
    name: "test",
    kind: "Single",
    entities: [],
    transforms: [],
    images: [image("img-0", "Uint16", [340, 348], [1, 1])],
    source_layouts: [],
    default_layout_id: null,
    labels: label ? [label] : undefined,
  };
}

const volumeLabel: LabelSpec = {
  name: "region-b",
  source_image_id: "img-0",
  image: image("img-0:label:region-b", "Uint32", [85, 87], [4, 4]),
  colors: [],
  source_declared: true,
};

describe("computeLabelChunkRequests", () => {
  it("returns nothing for a label-less manifest", () => {
    expect(
      computeLabelChunkRequests({ datasetId: "ds-0", manifest: manifestWithLabel(), t: 0, z: 0 }),
    ).toEqual([]);
  });

  it("emits requests for the visible label keyed by the label's own image id", () => {
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: manifestWithLabel(volumeLabel),
      t: 0,
      z: 0,
      labelSettings: allOn(1),
    });
    // 87x85 at chunk 128 → a single 1x1 grid.
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.imageId).toBe("img-0:label:region-b");
    expect(r.entityId).toBe("img-0:label:region-b"); // scoped away from intensity entities
    expect(r.datasetId).toBe("ds-0");
    expect(r.level).toBe(0);
    expect(r.c).toBe(0);
    expect(r.lane).toBe("detail");
    expect(r.chunkKey).toBe("0/0/0/0/0/0"); // level/t/c/z/y/x
  });

  it("emits one request per chunk of the chosen level's plane", () => {
    // 300x300 label at chunk 128 → ceil(300/128)=3 per axis → 9 chunks.
    const bigLabel: LabelSpec = {
      name: "region-c",
      source_image_id: "img-0",
      image: image("img-0:label:region-c", "Uint32", [300, 300], [1, 1]),
    };
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: manifestWithLabel(bigLabel),
      t: 0,
      z: 0,
      labelSettings: allOn(1),
    });
    expect(reqs).toHaveLength(9);
    const keys = new Set(reqs.map((r) => r.chunkKey));
    expect(keys.size).toBe(9);
    expect(keys.has("0/0/0/0/0/0")).toBe(true);
    expect(keys.has("0/0/0/0/2/2")).toBe(true);
  });

  it("skips a label whose source image is absent", () => {
    const orphan: LabelSpec = {
      name: "x",
      source_image_id: "missing",
      image: image("img-0:label:x", "Uint32", [10, 10], [1, 1]),
    };
    expect(
      computeLabelChunkRequests({
        datasetId: "ds-0",
        manifest: manifestWithLabel(orphan),
        t: 0,
        z: 0,
        labelSettings: allOn(1),
      }),
    ).toEqual([]);
  });

  // --- MAJOR 2: clamp/map label t to the label's own T extent ---

  function image5(id: string, shape5: number[], chunk5: number[], scale5: number[], dtype = "Uint32"): ImageSpec {
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
        levels: [{ level_index: 0, shape: shape5, chunk_shape: chunk5, grid_shape: [1, 1, 1, 1, 1], scale: scale5 }],
        data_type: dtype,
      },
    };
  }

  it("maps a time-invariant label (T=1) over a timeseries source to t=0", () => {
    const manifest: DatasetManifest = {
      dataset_id: "ds-0", name: "ts", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [image5("img-0", [8, 1, 1, 64, 64], [1, 1, 1, 64, 64], [1, 1, 1, 1, 1])],
      labels: [{
        name: "seg",
        source_image_id: "img-0",
        image: image5("img-0:label:seg", [1, 1, 1, 64, 64], [1, 1, 1, 64, 64], [1, 1, 1, 1, 1]),
      }],
    };
    // Source at t=7, but the label has only t=0.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 7, z: 0, labelSettings: allOn(1) });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].t).toBe(0);
    expect(reqs[0].chunkKey).toBe("0/0/0/0/0/0"); // t component is 0, not 7
  });

  // --- MAJOR 3: bounded level pick / no oversized texture ---

  it("skips a giant single-scale label with no fitting level", () => {
    const manifest: DatasetManifest = {
      dataset_id: "ds-0", name: "wsi", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [image5("img-0", [1, 1, 1, 20000, 20000], [1, 1, 1, 512, 512], [1, 1, 1, 1, 1])],
      labels: [{
        name: "huge",
        source_image_id: "img-0",
        // 20000² single level: exceeds maxDim → no usable level.
        image: image5("img-0:label:huge", [1, 1, 1, 20000, 20000], [1, 1, 1, 512, 512], [1, 1, 1, 1, 1]),
      }],
    };
    expect(computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0, labelSettings: allOn(1) })).toEqual([]);
  });

  it("picks a coarse fitting level (bounded requests) over a huge finest level", () => {
    const label: LabelSpec = {
      name: "region-c",
      source_image_id: "img-0",
      image: {
        image_id: "img-0:label:region-c",
        owner: "ent-0",
        multiscale: {
          axes: [
            { name: "t", kind: "time" }, { name: "c", kind: "channel" },
            { name: "z", kind: "space" }, { name: "y", kind: "space" }, { name: "x", kind: "space" },
          ],
          levels: [
            // Level 0: 16384² at chunk 512 → 32×32 = 1024 chunks (too many + too big).
            { level_index: 0, shape: [1, 1, 1, 16384, 16384], chunk_shape: [1, 1, 1, 512, 512], grid_shape: [1, 1, 1, 32, 32], scale: [1, 1, 1, 1, 1] },
            // Level 1: 2048² at chunk 512 → 4×4 = 16 chunks (fits).
            { level_index: 1, shape: [1, 1, 1, 2048, 2048], chunk_shape: [1, 1, 1, 512, 512], grid_shape: [1, 1, 1, 4, 4], scale: [1, 1, 1, 8, 8] },
          ],
          data_type: "Uint32",
        },
      },
    };
    const manifest: DatasetManifest = {
      dataset_id: "ds-0", name: "pyr", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [image5("img-0", [1, 1, 1, 16384, 16384], [1, 1, 1, 512, 512], [1, 1, 1, 1, 1])],
      labels: [label],
    };
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0, labelSettings: allOn(1) });
    // Bounded: the coarse level's 4×4 grid, not level 0's 1024 chunks.
    expect(reqs).toHaveLength(16);
    expect(reqs.every((r) => r.level === 1)).toBe(true);
  });

  // --- MAJOR: shared visible-label resolution (fetch + render agree) ---

  function singleLevelLabel(id: string, dtype: string, yx: [number, number]): LabelSpec {
    return {
      name: id,
      source_image_id: "img-0",
      image: image5("img-0:label:" + id, [1, 1, 1, yx[0], yx[1]], [1, 1, 1, 512, 512], [1, 1, 1, 1, 1], dtype),
    };
  }

  function multiLabelManifest(labels: LabelSpec[]): DatasetManifest {
    return {
      dataset_id: "ds-0", name: "multi", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [image5("img-0", [1, 1, 1, 512, 512], [1, 1, 1, 512, 512], [1, 1, 1, 1, 1])],
      labels,
    };
  }

  it("MAJOR: skips a first label with no fitting level and requests the next eligible", () => {
    // First label is a giant single-scale (no level ≤ maxDim); second fits.
    const first = singleLevelLabel("huge", "Uint32", [20000, 20000]);
    const second = singleLevelLabel("ok", "Uint32", [512, 512]);
    const manifest = multiLabelManifest([first, second]);

    // Fetch agrees: with both masks turned on, requests target the resolvable
    // second label, not the ineligible first.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0, labelSettings: allOn(2) });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.imageId === "img-0:label:ok")).toBe(true);
  });

  it("MAJOR: nothing is fetched by default (masks opt-in); all-on fetches every eligible label", () => {
    const manifest = multiLabelManifest([
      singleLevelLabel("a", "Uint32", [512, 512]),
      singleLevelLabel("b", "Uint32", [512, 512]),
      singleLevelLabel("c", "Uint32", [512, 512]),
    ]);
    // Default (no settings): masks are opt-in, so nothing is fetched on open.
    expect(computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 })).toEqual([]);
    // With every mask explicitly turned on, all three are fetched.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0, labelSettings: allOn(3) });
    const ids = new Set(reqs.map((r) => r.imageId));
    expect(ids).toEqual(
      new Set(["img-0:label:a", "img-0:label:b", "img-0:label:c"]),
    );
  });

  it("requests every supported unsigned label width", () => {
    const manifest = multiLabelManifest([
      singleLevelLabel("mask8", "Uint8", [512, 512]),
      singleLevelLabel("mask16", "Uint16", [512, 512]),
      singleLevelLabel("seg32", "Uint32", [512, 512]),
    ]);
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0, labelSettings: allOn(3) });
    expect(new Set(reqs.map((r) => r.imageId))).toEqual(new Set([
      "img-0:label:mask8",
      "img-0:label:mask16",
      "img-0:label:seg32",
    ]));
    expect(new Set(reqs.map((r) => r.contract.dtype))).toEqual(new Set(["uint32"]));
  });

  it("widens a uint8-only label set into the canonical uint32 contract", () => {
    const manifest = multiLabelManifest([singleLevelLabel("mask8", "Uint8", [512, 512])]);
    const [request] = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0, labelSettings: allOn(1) });
    expect(request.contract).toEqual(expect.objectContaining({
      sourceDtype: "uint8",
      dtype: "uint32",
      normalization: "uint8_to_uint32",
    }));
  });
});

describe("resolveVisibleLabels", () => {
  // A small single-level label over the shared source image.
  function uintLabel(name: string, dtype = "Uint32"): LabelSpec {
    return {
      name,
      source_image_id: "img-0",
      image: image(`img-0:label:${name}`, dtype, [64, 64], [1, 1]),
    };
  }
  function manifestWithLabels(labels: LabelSpec[]): DatasetManifest {
    return {
      dataset_id: "ds-0",
      name: "multi",
      kind: "Single",
      entities: [],
      transforms: [],
      source_layouts: [],
      default_layout_id: null,
      images: [image("img-0", "Uint16", [340, 348], [1, 1])],
      labels,
    };
  }

  it("no labels → empty set", () => {
    expect(resolveVisibleLabels(manifestWithLabel(), undefined)).toEqual([]);
  });

  it("undefined settings → nothing visible (masks are opt-in)", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    // No settings at all (fresh open / pre-controls snapshot): every mask
    // defaults hidden, so nothing is drawn until the user turns one on.
    expect(resolveVisibleLabels(m, undefined)).toEqual([]);
  });

  it("empty settings → nothing visible (masks are opt-in)", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    expect(resolveVisibleLabels(m, [])).toEqual([]);
  });

  it("an explicit-on mask shows at the default 0.5 and carries what render/fetch need", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, allOn(2));
    expect(out.map((r) => r.name)).toEqual(["a", "b"]);
    expect(out[0].sourceImageId).toBe("img-0");
    expect(out.every((r) => r.opacity === 0.5)).toBe(true);
    // Carries what render/fetch need.
    expect(out[0].label.image.image_id).toBe("img-0:label:a");
    expect(out[0].levelIdx).toBe(0);
  });

  it("a label with no explicit setting (short list) defaults hidden", () => {
    // Settings cover only index 0 (an explicit ON); index 1 has no entry and
    // follows the hidden-by-default policy (masks are opt-in).
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, [{ visible: true, opacity: 0.5 }]);
    expect(out.map((r) => r.name)).toEqual(["a"]);
  });

  it("returns exactly the visible set, each carrying its per-label opacity", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b"), uintLabel("c")]);
    const out = resolveVisibleLabels(m, [
      { visible: true, opacity: 0.3 },
      { visible: false, opacity: 0.5 },
      { visible: true, opacity: 0.8 },
    ]);
    expect(out.map((r) => r.name)).toEqual(["a", "c"]);
    expect(out.map((r) => r.opacity)).toEqual([0.3, 0.8]);
  });

  it("with settings, shows ALL visible labels (generalizes past the single default)", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, [
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.5 },
    ]);
    expect(out.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("keeps uint8 and uint32 labels when both are marked visible", () => {
    const m = manifestWithLabels([uintLabel("mask8", "Uint8"), uintLabel("seg32", "Uint32")]);
    const out = resolveVisibleLabels(m, [
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.7 },
    ]);
    expect(out.map((r) => r.name)).toEqual(["mask8", "seg32"]);
    expect(out.map((r) => r.opacity)).toEqual([0.5, 0.7]);
  });

  it("hiding the only eligible label yields an empty set (nothing drawn/fetched)", () => {
    const m = manifestWithLabels([uintLabel("a")]);
    expect(resolveVisibleLabels(m, [{ visible: false, opacity: 0.5 }])).toEqual([]);
  });

  it("clamps opacity into [0,1] and defaults a non-finite value", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, [
      { visible: true, opacity: 5 },
      { visible: true, opacity: Number.NaN },
    ]);
    expect(out[0].opacity).toBe(1);
    expect(out[1].opacity).toBe(0.5);
  });

  it("fetch honors the visible set: a hidden label is not fetched, a visible one is", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: m,
      t: 0,
      z: 0,
      labelSettings: [
        { visible: false, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ],
    });
    const ids = new Set(reqs.map((r) => r.imageId));
    expect(ids.has("img-0:label:a")).toBe(false);
    expect(ids.has("img-0:label:b")).toBe(true);
  });

  it("fetch spans EVERY visible label when several are on", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: m,
      t: 0,
      z: 0,
      labelSettings: [
        { visible: true, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ],
    });
    const ids = new Set(reqs.map((r) => r.imageId));
    expect(ids.has("img-0:label:a")).toBe(true);
    expect(ids.has("img-0:label:b")).toBe(true);
  });

  it("an explicit per-mask config (one on, rest off) resolves to just the on mask", () => {
    // Explicit settings: only index 0 on. The two explicit-off masks stay off —
    // an explicit off is never auto-revealed.
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b"), uintLabel("c")]);
    const config = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    const out = resolveVisibleLabels(m, config);
    expect(out.map((r) => r.name)).toEqual(["a"]);
    expect(out[0].opacity).toBe(0.5);
  });

  it("returns [] when only ineligible labels are marked visible (no substitution)", () => {
    // Settings mark index 0 (float32, undrawable) visible and index 1 (uint32,
    // drawable) explicitly hidden. Nothing is both visible AND eligible, so
    // nothing is drawn — resolveVisibleLabels never substitutes a stand-in for
    // the ineligible visible label (that would put an overlay on screen whose own
    // checkbox reads off).
    const m = manifestWithLabels([uintLabel("mask-float", "Float32"), uintLabel("region-c", "Uint32")]);
    expect(
      resolveVisibleLabels(m, [
        { visible: true, opacity: 0.5 },
        { visible: false, opacity: 0.5 },
      ]),
    ).toEqual([]);

    // Fetch agrees — nothing is requested until a visible eligible label exists.
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: m,
      t: 0,
      z: 0,
      labelSettings: [
        { visible: true, opacity: 0.5 },
        { visible: false, opacity: 0.5 },
      ],
    });
    expect(reqs).toEqual([]);
  });

  it("honors an explicit hide-all: nothing drawn when every mask is explicitly off", () => {
    // Both eligible, both explicitly hidden by the user → nothing drawn. An
    // explicit off is sacred and never auto-revealed.
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, [
      { visible: false, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ]);
    expect(out).toEqual([]);
  });

  it("no fallback when there is no eligible label dtype", () => {
    const m = manifestWithLabels([uintLabel("mf32", "Float32"), uintLabel("mf64", "Float64")]);
    expect(
      resolveVisibleLabels(m, [
        { visible: true, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ]),
    ).toEqual([]);
  });
});

describe("resolveVisibleLabels — mode-aware, no stand-in", () => {
  // The overlay the panel toggle controls and the overlay on screen must never
  // diverge: resolveVisibleLabels returns exactly the visible + mode-eligible
  // set, never a stand-in for a visible-but-ineligible mask. A mode switch that
  // makes a visible mask ineligible draws nothing for it rather than conjuring a
  // different mask whose own checkbox reads off.
  const AXES = [
    { name: "t", kind: "time" }, { name: "c", kind: "channel" },
    { name: "z", kind: "space" }, { name: "y", kind: "space" }, { name: "x", kind: "space" },
  ];
  function img(id: string, dtype: string, shape: number[], chunk: number[]): ImageSpec {
    return {
      image_id: id,
      owner: "ent-0",
      multiscale: {
        axes: AXES,
        levels: [{ level_index: 0, shape, chunk_shape: chunk, grid_shape: [1, 1, 1, 1, 1], scale: [1, 1, 1, 1, 1] }],
        data_type: dtype,
      },
    };
  }
  // Slice-eligible (small X/Y) but volume-ineligible: chunk-Z 1 over Z=4096 fans
  // out to 4096 z-chunks, busting the volume chunk-count cap, with no coarser
  // level — eligible in 2D, not in 3D.
  const deepZ = (name: string): LabelSpec => ({
    name,
    source_image_id: "img-0",
    image: img(`img-0:label:${name}`, "Uint32", [1, 1, 4096, 64, 64], [1, 1, 1, 64, 64]),
  });
  const flat = (name: string): LabelSpec => ({
    name,
    source_image_id: "img-0",
    image: img(`img-0:label:${name}`, "Uint32", [1, 1, 1, 64, 64], [1, 1, 1, 64, 64]),
  });
  function manifestOf(labels: LabelSpec[]): DatasetManifest {
    return {
      dataset_id: "ds-0", name: "vol", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [img("img-0", "Uint16", [1, 1, 1, 340, 348], [1, 1, 1, 128, 128])],
      labels,
    };
  }
  const seen = (visibles: boolean[]) => visibles.map((v) => ({ visible: v, opacity: 0.5 }));

  it("a visible-but-volume-ineligible mask with a hidden sibling draws nothing in 3D", () => {
    // deep-Z (index 0) is visible but can't draw in volume mode; flat (index 1)
    // is explicitly hidden. Nothing visible + eligible → [], and fetch agrees, so
    // the screen matches the panel (no un-hideable re-draw of a stand-in).
    const m = manifestOf([deepZ("deep"), flat("flat")]);
    expect(resolveVisibleLabels(m, seen([true, false]), { mode: "volume" })).toEqual([]);
    expect(
      computeLabelChunkRequests({
        datasetId: "ds-0", manifest: m, t: 0, z: 0, mode: "volume",
        labelSettings: seen([true, false]),
      }),
    ).toEqual([]);
  });

  it("2D-open → 3D-switch: a 2D-only visible label draws nothing in 3D (no stand-in)", () => {
    // deep-Z (index 0) is visible and slice-eligible; a separate flat label
    // (index 1) is 3D-eligible but hidden. In 2D the visible deep-Z label draws;
    // switching to 3D must NOT substitute the flat label (whose checkbox is off)
    // for the now-ineligible visible one — it draws nothing.
    const m = manifestOf([deepZ("deep"), flat("flat")]);
    expect(resolveVisibleLabels(m, seen([true, false]), { mode: "slice" }).map((r) => r.name)).toEqual([
      "deep",
    ]);
    expect(resolveVisibleLabels(m, seen([true, false]), { mode: "volume" })).toEqual([]);
  });
});

describe("eligibleLabelInfos", () => {
  function uintLabel(name: string, dtype = "Uint32"): LabelSpec {
    return {
      name,
      source_image_id: "img-0",
      image: image(`img-0:label:${name}`, dtype, [64, 64], [1, 1]),
    };
  }
  function manifestWithLabels(labels: LabelSpec[]): DatasetManifest {
    return {
      dataset_id: "ds-0",
      name: "multi",
      kind: "Single",
      entities: [],
      transforms: [],
      source_layouts: [],
      default_layout_id: null,
      images: [image("img-0", "Uint16", [340, 348], [1, 1])],
      labels,
    };
  }

  it("returns every drawable label with its manifest index + name", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    expect(eligibleLabelInfos(m)).toEqual([
      { index: 0, name: "a" },
      { index: 1, name: "b" },
    ]);
  });

  it("keeps every unsigned width, omits floats, and preserves manifest indexes", () => {
    const m = manifestWithLabels([
      uintLabel("region-a", "Uint16"),
      uintLabel("unsupported", "Float32"),
      uintLabel("region-c", "Uint8"),
      uintLabel("region-d", "Uint32"),
    ]);
    expect(eligibleLabelInfos(m)).toEqual([
      { index: 0, name: "region-a" },
      { index: 2, name: "region-c" },
      { index: 3, name: "region-d" },
    ]);
  });

  it("returns [] for a manifest with no labels", () => {
    expect(eligibleLabelInfos(manifestWithLabel())).toEqual([]);
  });
});

describe("computeLabelChunkRequests — volume mode", () => {
  function image5(id: string, shape5: number[], chunk5: number[], scale5: number[], dtype = "Uint32"): ImageSpec {
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
        levels: [{ level_index: 0, shape: shape5, chunk_shape: chunk5, grid_shape: [1, 1, 1, 1, 1], scale: scale5 }],
        data_type: dtype,
      },
    };
  }

  // A 4-deep label at chunk-Z 2 → 2 z-chunks; 128² at chunk 64 → 2×2 (y, x).
  function volManifest(): DatasetManifest {
    return {
      dataset_id: "ds-0", name: "vol", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [image5("img-0", [1, 1, 4, 128, 128], [1, 1, 2, 64, 64], [1, 1, 1, 1, 1], "Uint16")],
      labels: [{
        name: "region-b",
        source_image_id: "img-0",
        image: image5("img-0:label:region-b", [1, 1, 4, 128, 128], [1, 1, 2, 64, 64], [1, 1, 1, 1, 1]),
      }],
    };
  }

  it("emits EVERY (z, y, x) chunk of the chosen level (the full volume)", () => {
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest: volManifest(), t: 0, z: 0, mode: "volume", labelSettings: allOn(1) });
    // gz=2, gy=2, gx=2 → 8 chunks; slice mode would emit only 4 (single z).
    expect(reqs).toHaveLength(8);
    // Both z-chunks are present (not just the mapped-Z plane).
    expect(new Set(reqs.map((r) => r.z))).toEqual(new Set([0, 1]));
    const keys = new Set(reqs.map((r) => r.chunkKey));
    expect(keys.size).toBe(8);
    expect(keys.has("0/0/0/0/0/0")).toBe(true); // z=0 corner
    expect(keys.has("0/0/0/1/1/1")).toBe(true); // z=1 far corner
    // Every request is scoped under the label's own image id.
    expect(reqs.every((r) => r.imageId === "img-0:label:region-b")).toBe(true);
    expect(reqs.every((r) => r.level === 0)).toBe(true);
  });

  it("slice mode (and the default mode) fetches only the mapped z-plane", () => {
    const sliceReqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest: volManifest(), t: 0, z: 0, mode: "slice", labelSettings: allOn(1) });
    expect(sliceReqs).toHaveLength(4); // gy*gx, single z-chunk
    expect(new Set(sliceReqs.map((r) => r.z))).toEqual(new Set([0]));
    // Omitting `mode` behaves identically to slice (back-compat).
    const defaultReqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest: volManifest(), t: 0, z: 0, labelSettings: allOn(1) });
    expect(defaultReqs).toHaveLength(4);
    expect(new Set(defaultReqs.map((r) => r.z))).toEqual(new Set([0]));
  });

  it("maps a time-invariant label (T=1) to t=0 for every z-chunk", () => {
    const manifest: DatasetManifest = {
      dataset_id: "ds-0", name: "ts", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [image5("img-0", [8, 1, 4, 64, 64], [1, 1, 2, 64, 64], [1, 1, 1, 1, 1], "Uint16")],
      labels: [{
        name: "seg",
        source_image_id: "img-0",
        image: image5("img-0:label:seg", [1, 1, 4, 64, 64], [1, 1, 2, 64, 64], [1, 1, 1, 1, 1]),
      }],
    };
    // Source at t=5, but the label has only t=0 — every z-chunk stays at t=0.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 5, z: 0, mode: "volume", labelSettings: allOn(1) });
    expect(reqs).toHaveLength(2); // gz=2, gy=gx=1
    expect(reqs.every((r) => r.t === 0)).toBe(true);
    expect(new Set(reqs.map((r) => r.z))).toEqual(new Set([0, 1]));
  });

  it("fetches nothing in volume mode for a hidden label", () => {
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: volManifest(),
      t: 0,
      z: 0,
      mode: "volume",
      labelSettings: [{ visible: false, opacity: 0.5 }],
    });
    expect(reqs).toEqual([]);
  });
});

describe("computeLabelChunkRequests — volume level selection (3D caps)", () => {
  interface Lvl { shape: number[]; chunk: number[]; scale: number[] }
  const AXES = [
    { name: "t", kind: "time" }, { name: "c", kind: "channel" },
    { name: "z", kind: "space" }, { name: "y", kind: "space" }, { name: "x", kind: "space" },
  ];
  function img(id: string, levels: Lvl[], dtype: string): ImageSpec {
    return {
      image_id: id,
      owner: "ent-0",
      multiscale: {
        axes: AXES,
        levels: levels.map((l, i) => ({
          level_index: i, shape: l.shape, chunk_shape: l.chunk, grid_shape: [1, 1, 1, 1, 1], scale: l.scale,
        })),
        data_type: dtype,
      },
    };
  }
  const SCALE1 = [1, 1, 1, 1, 1];
  function manifestFor(labelLevels: Lvl[]): DatasetManifest {
    return {
      dataset_id: "ds-0", name: "vol", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [img("img-0", [{ shape: labelLevels[0].shape, chunk: [1, 1, 64, 256, 256], scale: SCALE1 }], "Uint16")],
      labels: [{ name: "seg", source_image_id: "img-0", image: img("img-0:label:seg", labelLevels, "Uint32") }],
    };
  }
  // Masks are opt-in; these tests exercise LEVEL SELECTION with the mask turned
  // on, so `vol`/`slice` carry an explicit all-visible setting (one label each).
  const vol = { datasetId: "ds-0", t: 0, z: 0, mode: "volume" as const, labelSettings: allOn(1) };
  const slice = { datasetId: "ds-0", t: 0, z: 0, mode: "slice" as const, labelSettings: allOn(1) };

  it("renders a label whose Z busts the monolithic 3D limit when its bricks fit", () => {
    // Z=2100 > the 2048 monolithic-texture limit, but bricking tiles it across
    // slots: chunk-Z 64 → 33 z-bricks, X=Y=64 → one brick each → 33 chunks,
    // ~33 MB padded. Under the old per-axis cap this was skipped; now the
    // chunk-count + byte budgets admit it and it renders as bricks.
    const m = manifestFor([{ shape: [1, 1, 2100, 64, 64], chunk: [1, 1, 64, 64, 64], scale: SCALE1 }]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.length).toBe(33); // gz=33, gy=gx=1
    expect(reqs.every((r) => r.level === 0)).toBe(true);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(0);
  });

  it("renders a label whose X busts the monolithic 3D limit when its bricks fit", () => {
    // The relax is per-axis, not Z-only: X=4096 > 2048 tiles into 8 x-bricks
    // (chunk-X 512), ~4 MB padded → eligible at level 0.
    const m = manifestFor([{ shape: [1, 1, 4, 4096, 64], chunk: [1, 1, 4, 512, 64], scale: SCALE1 }]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.length).toBe(8); // gy=8, gz=gx=1
    expect(reqs.every((r) => r.level === 0)).toBe(true);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(0);
  });

  it("falls back to a coarser level when the finer level's single brick busts the 3D texture limit", () => {
    // A "one chunk per plane" layout (common OME-Zarr): level 0 is a single
    // 2100-wide brick, which exceeds the 2048 3D-texture floor. Its padded bytes
    // (~40 MB) and chunk count (1) fit the budgets, so the byte/chunk checks alone
    // would ADMIT it — but the atlas can't pack a 2100-wide brick, so it would
    // render BLANK. The per-brick cap skips level 0 for the coarser level 1
    // (1050-wide brick), which packs and renders.
    const m = manifestFor([
      { shape: [1, 1, 8, 600, 2100], chunk: [1, 1, 8, 600, 2100], scale: SCALE1 },
      { shape: [1, 1, 8, 300, 1050], chunk: [1, 1, 8, 300, 1050], scale: [1, 1, 1, 2, 2] },
    ]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.level === 1)).toBe(true);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(1);
  });

  it("skips a label whose only level's brick busts the 3D limit — no blank; slice stays eligible", () => {
    // The sole level is a single 2100-wide brick with no coarser fallback: volume
    // mode is INELIGIBLE (renders nothing, a clean escape hatch) rather than
    // admitting a level the atlas can't allocate. Slice mode draws from a single
    // 2D tile bounded by the far larger 2D texture limit, so it stays eligible.
    const m = manifestFor([{ shape: [1, 1, 8, 600, 2100], chunk: [1, 1, 8, 600, 2100], scale: SCALE1 }]);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toEqual([]);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })).toEqual([]);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "slice" })).toHaveLength(1);
  });

  it("DC1: a huge-Z level whose CHUNKED brick fits stays eligible under the per-brick cap", () => {
    // Z=2100 busts the monolithic 3D limit, but the chunk-Z 64 brick (64 <= 2048)
    // packs across slots. The per-brick cap gates the BRICK, not the extent, so
    // this deep label remains eligible at level 0 (33 z-bricks) — the per-axis
    // relax the feature depends on is preserved.
    const m = manifestFor([{ shape: [1, 1, 2100, 64, 64], chunk: [1, 1, 64, 64, 64], scale: SCALE1 }]);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(0);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toHaveLength(33);
  });

  it("respects a caller-supplied per-brick cap (a tighter cap coarsens further)", () => {
    const m = manifestFor([
      { shape: [1, 1, 8, 600, 1024], chunk: [1, 1, 8, 600, 1024], scale: SCALE1 },
      { shape: [1, 1, 8, 300, 512], chunk: [1, 1, 8, 300, 512], scale: [1, 1, 1, 2, 2] },
    ]);
    // Default floor (2048) accepts level 0 (1024-wide brick). A maxBrickDim3D of
    // 600 rejects level 0's 1024-wide brick and takes level 1 (512-wide brick).
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(0);
    expect(
      resolveVisibleLabels(m, allOn(1), { mode: "volume", maxBrickDim3D: 600 })[0].levelIdx,
    ).toBe(1);
  });

  it("skips a label whose padded bricks bust the byte budget — slice mode stays eligible", () => {
    // 512×512×3000 in 256²×64 chunks: the per-axis dims no longer gate, and the
    // chunk count fits (188), but the padded footprint (~3 GB) busts the 512 MB
    // budget with no coarser level — volume-ineligible, slice unaffected.
    const m = manifestFor([{ shape: [1, 1, 3000, 512, 512], chunk: [1, 1, 64, 256, 256], scale: SCALE1 }]);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toEqual([]);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })).toEqual([]);
    // Slice is unaffected by the 3D caps.
    expect(computeLabelChunkRequests({ ...slice, manifest: m }).length).toBeGreaterThan(0);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "slice" })).toHaveLength(1);
  });

  it("coarsens past a level with too many chunks AND bounds the request count", () => {
    const m = manifestFor([
      // 64·16·16 = 16384 chunks (bytes fine at 67 MB) → chunk-count rejects it.
      { shape: [1, 1, 64, 512, 512], chunk: [1, 1, 1, 32, 32], scale: SCALE1 },
      { shape: [1, 1, 16, 256, 256], chunk: [1, 1, 16, 256, 256], scale: [1, 1, 4, 2, 2] }, // 1 chunk
    ]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.every((r) => r.level === 1)).toBe(true);
    expect(reqs.length).toBeLessThanOrEqual(512); // bounded per-tick fan-out
    expect(reqs).toHaveLength(1);
  });

  it("skips a level whose texture bytes exceed the volume budget — slice stays eligible", () => {
    // 2048·2048·33·4 B = 553 MB > 512 MB; the chunk count is fine. (Here chunks
    // divide evenly, so the padded footprint equals the true 553 MB.)
    const m = manifestFor([{ shape: [1, 1, 33, 2048, 2048], chunk: [1, 1, 64, 512, 512], scale: SCALE1 }]);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toEqual([]);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "slice" })).toHaveLength(1);
  });

  it("measures the PADDED footprint: a level whose TRUE bytes fit but padded bricks bust is skipped", () => {
    // 1030²×70 in 512²×64 chunks: awkward extents pad every boundary brick, so
    // the padded footprint (128×1536×1536×4 ≈ 1.15 GB) busts the 512 MB budget
    // while the TRUE volume (~283 MB) fits it. Accounting on TRUE bytes would
    // admit a mask the atlas can't hold; accounting on padded bytes skips it.
    const m = manifestFor([{ shape: [1, 1, 70, 1030, 1030], chunk: [1, 1, 64, 512, 512], scale: SCALE1 }]);
    // The TRUE footprint is well under budget — the seam this pins.
    expect(70 * 1030 * 1030 * 4).toBeLessThan(512 * 1024 * 1024);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toEqual([]);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })).toEqual([]);
    // Slice mode is unaffected by the padded byte budget.
    expect(resolveVisibleLabels(m, allOn(1), { mode: "slice" })).toHaveLength(1);
  });

  it("coarsens past a level whose PADDED bricks bust the budget to a coarser one that fits", () => {
    // Same awkward level 0 (padded ~1.15 GB, true ~283 MB) plus a coarser level
    // 1 (padded ~146 MB). Padded accounting rejects level 0 and takes level 1 —
    // the per-mask coarser-level fallback falls out of the finest→coarsest walk.
    const m = manifestFor([
      { shape: [1, 1, 70, 1030, 1030], chunk: [1, 1, 64, 512, 512], scale: SCALE1 },
      { shape: [1, 1, 35, 515, 515], chunk: [1, 1, 64, 512, 512], scale: [1, 1, 2, 2, 2] },
    ]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.level === 1)).toBe(true);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(1);
  });

  it("coarsens past a level that busts the byte budget to one that fits", () => {
    const m = manifestFor([
      { shape: [1, 1, 33, 2048, 2048], chunk: [1, 1, 64, 512, 512], scale: SCALE1 }, // 553 MB
      { shape: [1, 1, 16, 1024, 1024], chunk: [1, 1, 16, 512, 512], scale: [1, 1, 2, 2, 2] }, // 67 MB
    ]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.level === 1)).toBe(true);
  });

  it("respects caller-supplied caps (a tighter volume cap coarsens further)", () => {
    const m = manifestFor([
      { shape: [1, 1, 8, 256, 256], chunk: [1, 1, 8, 128, 128], scale: SCALE1 }, // 2·2·1 = 4 chunks
      { shape: [1, 1, 4, 128, 128], chunk: [1, 1, 4, 128, 128], scale: [1, 1, 2, 2, 2] }, // 1 chunk
    ]);
    // Default caps accept level 0; a maxChunksPerVolume of 1 forces level 1.
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume" })[0].levelIdx).toBe(0);
    expect(resolveVisibleLabels(m, allOn(1), { mode: "volume", maxChunksPerVolume: 1 })[0].levelIdx).toBe(1);
  });
});

describe("resolveVisibleLabels — 3D total-volume memory budget", () => {
  const AXES = [
    { name: "t", kind: "time" }, { name: "c", kind: "channel" },
    { name: "z", kind: "space" }, { name: "y", kind: "space" }, { name: "x", kind: "space" },
  ];
  function img(id: string, dtype: string, shape: number[], chunk: number[]): ImageSpec {
    return {
      image_id: id,
      owner: "ent-0",
      multiscale: {
        axes: AXES,
        levels: [{ level_index: 0, shape, chunk_shape: chunk, grid_shape: [1, 1, 1, 1, 1], scale: [1, 1, 1, 1, 1] }],
        data_type: dtype,
      },
    };
  }
  // A single-level uint32 label of the given voxel dims (Z, Y, X) — each voxel is
  // 4 bytes, so bytes = Z·Y·X·4. Chunk 64 keeps the per-tick chunk count bounded.
  const label = (name: string, z: number, y: number, x: number): LabelSpec => ({
    name,
    source_image_id: "img-0",
    image: img(`img-0:label:${name}`, "Uint32", [1, 1, z, y, x], [1, 1, 64, 64, 64]),
  });
  function manifestOf(labels: LabelSpec[]): DatasetManifest {
    return {
      dataset_id: "ds-0", name: "vol", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [img("img-0", "Uint16", [1, 1, 1, 512, 512], [1, 1, 1, 128, 128])],
      labels,
    };
  }

  // A single-level uint32 label with an explicit chunk shape, so a test can pad
  // the boundary bricks (an awkward extent vs. chunk) to exercise the padded
  // total-memory accounting.
  const chunkedLabel = (name: string, shape: number[], chunk: number[]): LabelSpec => ({
    name,
    source_image_id: "img-0",
    image: img(`img-0:label:${name}`, "Uint32", shape, chunk),
  });

  it("measures the PADDED footprint in the total budget: a stack can't slip past on true bytes", () => {
    __resetLabelWarningsForTest();
    // Two masks: TRUE ~139 MB each (both would fit the 512 MB total at ~278 MB),
    // but PADDED ~384 MB each (66→2 z-bricks of 64, 1030→3 y-bricks of 512), so
    // the padded total (~768 MB) only admits the first. Accounting on true bytes
    // would admit both and OOM; padded accounting keeps only the prefix that fits.
    const a = chunkedLabel("a", [1, 1, 66, 1030, 512], [1, 1, 64, 512, 512]);
    const b = chunkedLabel("b", [1, 1, 66, 1030, 512], [1, 1, 64, 512, 512]);
    const m = manifestOf([a, b]);
    // The TRUE total is under budget — the seam this pins.
    expect(2 * 66 * 1030 * 512 * 4).toBeLessThan(512 * 1024 * 1024);
    const out = resolveVisibleLabels(m, allOn(2), { mode: "volume" });
    expect(out.map((r) => r.name)).toEqual(["a"]);
  });

  it("keeps a manifest-order prefix that fits and skips the rest in 3D", () => {
    __resetLabelWarningsForTest();
    // Three ~192 MB masks (256·256·768·4 ≈ 192 MB); the 512 MB total budget fits
    // the first two (~384 MB) but not the third (~576 MB).
    const m = manifestOf([
      label("a", 768, 256, 256),
      label("b", 768, 256, 256),
      label("c", 768, 256, 256),
    ]);
    const out = resolveVisibleLabels(m, allOn(3), { mode: "volume" });
    expect(out.map((r) => r.name)).toEqual(["a", "b"]);
    // Slice mode ignores the total-volume budget: all three show.
    expect(resolveVisibleLabels(m, allOn(3), { mode: "slice" }).map((r) => r.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a strict prefix: a smaller later mask is not slipped in past a skipped one", () => {
    __resetLabelWarningsForTest();
    // First mask ~384 MB, second ~384 MB (busts the budget at ~768 MB), third is
    // tiny. The prefix stops at the second; the tiny third is NOT greedily added.
    const m = manifestOf([
      label("big1", 768, 512, 256),
      label("big2", 768, 512, 256),
      label("tiny", 1, 64, 64),
    ]);
    const out = resolveVisibleLabels(m, allOn(3), { mode: "volume" });
    expect(out.map((r) => r.name)).toEqual(["big1"]);
  });

  it("total budget tightened to the per-texture cap: only the first mask fits", () => {
    __resetLabelWarningsForTest();
    const m = manifestOf([label("a", 64, 64, 64), label("b", 64, 64, 64)]);
    // Each mask is 64·64·64·4 = 1 MB. Setting both the per-texture cap and
    // the total to 1 MB puts the total exactly at the per-texture cap; the
    // first mask fills it and the second is dropped.
    const out = resolveVisibleLabels(m, allOn(2), {
      mode: "volume",
      maxVolumeBytes: 1024 * 1024,
      maxTotalVolumeBytes: 1024 * 1024,
    });
    expect(out.map((r) => r.name)).toEqual(["a"]);
  });

  // --- Regression: total-budget floor (Math.max clamp) ---
  // The three tests below pin the invariant that 3D never opens blank when a
  // mask is drawable. They FAIL if the clamp in resolveLabelCaps is removed
  // (reverting to rawTotal) or weakened to Math.min.

  it("never-blank: a single drawable mask renders even when maxTotalVolumeBytes is set below its size", () => {
    __resetLabelWarningsForTest();
    // 64·64·64·4 = 1 MB label, within the per-texture cap (1 MB).
    // Without the clamp, maxTotalVolumeBytes = 1 byte < 1 MB → resolves [].
    // With the clamp, maxTotalVolumeBytes = max(1, 1 MB) = 1 MB → mask fits.
    const m = manifestOf([label("only", 64, 64, 64)]);
    const out = resolveVisibleLabels(m, allOn(1), {
      mode: "volume",
      maxVolumeBytes: 1024 * 1024,  // 1 MB per-texture cap
      maxTotalVolumeBytes: 1,        // far below cap — floor must raise this
    });
    expect(out.map((r) => r.name)).toEqual(["only"]);
  });

  it("total-budget floor: first of several masks renders when total is set below the per-texture cap", () => {
    __resetLabelWarningsForTest();
    // Two 1 MB masks; total set to 1 byte (below the 1 MB per-texture cap).
    // Without the clamp: 1 MB > 1 byte → no mask fits → [].
    // With the clamp: total raised to 1 MB → first mask fills it exactly; second drops.
    const m = manifestOf([label("first", 64, 64, 64), label("second", 64, 64, 64)]);
    const out = resolveVisibleLabels(m, allOn(2), {
      mode: "volume",
      maxVolumeBytes: 1024 * 1024,
      maxTotalVolumeBytes: 1,
    });
    expect(out.map((r) => r.name)).toEqual(["first"]);
  });

  it("floor-not-ceiling: a total already above the per-texture cap is unchanged (multiple masks fit)", () => {
    __resetLabelWarningsForTest();
    // Three 1 MB masks; per-texture cap 1 MB; total 3 MB (already above cap).
    // Math.max(3 MB, 1 MB) = 3 MB — the floor is a no-op and all three fit.
    // If the clamp were Math.min instead, total would collapse to 1 MB and
    // only the first mask would fit — this test would then fail.
    const m = manifestOf([
      label("x", 64, 64, 64),
      label("y", 64, 64, 64),
      label("z", 64, 64, 64),
    ]);
    const out = resolveVisibleLabels(m, allOn(3), {
      mode: "volume",
      maxVolumeBytes: 1024 * 1024,
      maxTotalVolumeBytes: 3 * 1024 * 1024,
    });
    expect(out.map((r) => r.name)).toEqual(["x", "y", "z"]);
  });

  it("volumeBudgetPrefix returns the kept manifest indices as a prefix", () => {
    const m = manifestOf([
      label("a", 768, 256, 256),
      label("b", 768, 256, 256),
      label("c", 768, 256, 256),
    ]);
    expect(volumeBudgetPrefix(m, [0, 1, 2])).toEqual(new Set([0, 1]));
  });

  it("warns once per budget-skipped mask, and the reset re-arms the warning", () => {
    __resetLabelWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = manifestOf([
        label("a", 768, 256, 256),
        label("b", 768, 256, 256),
        label("c", 768, 256, 256),
      ]);
      resolveVisibleLabels(m, allOn(3), { mode: "volume" });
      resolveVisibleLabels(m, allOn(3), { mode: "volume" });
      // "c" is the only budget-skipped mask; warned exactly once despite two passes.
      expect(warn).toHaveBeenCalledTimes(1);
      __resetLabelWarningsForTest();
      resolveVisibleLabels(m, allOn(3), { mode: "volume" });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
