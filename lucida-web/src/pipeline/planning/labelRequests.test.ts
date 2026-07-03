import { describe, it, expect } from "vitest";
import {
  computeLabelChunkRequests,
  eligibleLabelInfos,
  resolveDefaultLabel,
  resolveLabelDisplayStates,
  resolveVisibleLabels,
} from "./labelRequests.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "../../manifestTypes.ts";

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

const yeastLabel: LabelSpec = {
  name: "mitochondria",
  source_image_id: "img-0",
  image: image("img-0:label:mito", "Uint32", [85, 87], [4, 4]),
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
      manifest: manifestWithLabel(yeastLabel),
      t: 0,
      z: 0,
    });
    // 87x85 at chunk 128 → a single 1x1 grid.
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.imageId).toBe("img-0:label:mito");
    expect(r.entityId).toBe("img-0:label:mito"); // scoped away from intensity entities
    expect(r.datasetId).toBe("ds-0");
    expect(r.level).toBe(0);
    expect(r.c).toBe(0);
    expect(r.lane).toBe("detail");
    expect(r.chunkKey).toBe("0/0/0/0/0/0"); // level/t/c/z/y/x
  });

  it("emits one request per chunk of the chosen level's plane", () => {
    // 300x300 label at chunk 128 → ceil(300/128)=3 per axis → 9 chunks.
    const bigLabel: LabelSpec = {
      name: "cells",
      source_image_id: "img-0",
      image: image("img-0:label:cells", "Uint32", [300, 300], [1, 1]),
    };
    const reqs = computeLabelChunkRequests({
      datasetId: "ds-0",
      manifest: manifestWithLabel(bigLabel),
      t: 0,
      z: 0,
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
      computeLabelChunkRequests({ datasetId: "ds-0", manifest: manifestWithLabel(orphan), t: 0, z: 0 }),
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
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 7, z: 0 });
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
    expect(computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 })).toEqual([]);
  });

  it("picks a coarse fitting level (bounded requests) over a huge finest level", () => {
    const label: LabelSpec = {
      name: "cells",
      source_image_id: "img-0",
      image: {
        image_id: "img-0:label:cells",
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
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 });
    // Bounded: the coarse level's 4×4 grid, not level 0's 1024 chunks.
    expect(reqs).toHaveLength(16);
    expect(reqs.every((r) => r.level === 1)).toBe(true);
  });

  // --- MAJOR: shared default-label resolution (fetch + render agree) ---

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

  it("MAJOR: skips a first label with no fitting level and resolves the next eligible", () => {
    // First label is a giant single-scale (no level ≤ maxDim); second fits.
    const first = singleLevelLabel("huge", "Uint32", [20000, 20000]);
    const second = singleLevelLabel("ok", "Uint32", [512, 512]);
    const manifest = multiLabelManifest([first, second]);

    const resolved = resolveDefaultLabel(manifest);
    expect(resolved?.label.image.image_id).toBe("img-0:label:ok");

    // Fetch agrees: requests target the resolvable second label, not the first.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.imageId === "img-0:label:ok")).toBe(true);
  });

  it("MAJOR: fetches chunks for ONLY the one resolved label, not every label", () => {
    const manifest = multiLabelManifest([
      singleLevelLabel("a", "Uint32", [512, 512]),
      singleLevelLabel("b", "Uint32", [512, 512]),
      singleLevelLabel("c", "Uint32", [512, 512]),
    ]);
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 });
    const ids = new Set(reqs.map((r) => r.imageId));
    expect(ids.size).toBe(1); // only the first resolved label
    expect(ids.has("img-0:label:a")).toBe(true);
  });

  it("MAJOR: skips a non-uint32 (uint8) label and resolves a uint32 sibling", () => {
    const manifest = multiLabelManifest([
      singleLevelLabel("mask8", "Uint8", [512, 512]),
      singleLevelLabel("seg32", "Uint32", [512, 512]),
    ]);
    const resolved = resolveDefaultLabel(manifest);
    expect(resolved?.label.image.image_id).toBe("img-0:label:seg32");

    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 });
    expect(reqs.every((r) => r.imageId === "img-0:label:seg32")).toBe(true);
  });

  it("MAJOR: a uint8-only label set yields no requests (skipped, no pool)", () => {
    const manifest = multiLabelManifest([singleLevelLabel("mask8", "Uint8", [512, 512])]);
    expect(resolveDefaultLabel(manifest)).toBeNull();
    expect(computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, z: 0 })).toEqual([]);
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

  it("undefined settings → the first eligible label only, at the default 0.5", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, undefined);
    expect(out.map((r) => r.name)).toEqual(["a"]);
    expect(out[0].sourceImageId).toBe("img-0");
    expect(out[0].opacity).toBe(0.5);
    // Carries what render/fetch need.
    expect(out[0].label.image.image_id).toBe("img-0:label:a");
    expect(out[0].levelIdx).toBe(0);
  });

  it("empty settings → the first eligible label only (unchanged fallback)", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    expect(resolveVisibleLabels(m, []).map((r) => r.name)).toEqual(["a"]);
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

  it("still skips a non-uint32 label even when it is marked visible", () => {
    const m = manifestWithLabels([uintLabel("mask8", "Uint8"), uintLabel("seg32", "Uint32")]);
    const out = resolveVisibleLabels(m, [
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.7 },
    ]);
    // The uint8 label is ineligible and dropped; only the uint32 sibling remains,
    // keeping its own per-label opacity (index-aligned to the manifest).
    expect(out.map((r) => r.name)).toEqual(["seg32"]);
    expect(out[0].opacity).toBe(0.7);
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

  it("the seeded default (first visible, rest hidden) resolves to exactly one label", () => {
    // Mirrors the Rust `seeded_for` seed: index 0 visible, the rest hidden, all
    // at 0.5. One clean overlay on open — no fetch/pool fan-out.
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b"), uintLabel("c")]);
    const seed = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    const out = resolveVisibleLabels(m, seed);
    expect(out.map((r) => r.name)).toEqual(["a"]);
    expect(out[0].opacity).toBe(0.5);
  });

  it("a visible flag on an undrawable label is inert: draws nothing, substitutes nothing", () => {
    // Settings mark index 0 (uint8, undrawable) visible and index 1 (uint32,
    // drawable) hidden — a stale or restored settings vec can carry exactly
    // this (the scene seed never picks a non-uint32, but a saved view can
    // outlive a re-import that changed the label list). The undrawable label
    // has no panel control, so its flag must not conjure a DIFFERENT label
    // into the drawn set (the user would have no toggle that clears it): the
    // drawn set stays exactly "visible AND eligible" — empty.
    const m = manifestWithLabels([uintLabel("mask8", "Uint8"), uintLabel("cells", "Uint32")]);
    const settings = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    expect(resolveVisibleLabels(m, settings)).toEqual([]);

    // Fetch agrees — nothing is requested for either label.
    expect(
      computeLabelChunkRequests({ datasetId: "ds-0", manifest: m, t: 0, z: 0, labelSettings: settings }),
    ).toEqual([]);
  });

  it("show→hide on the drawable label round-trips to empty despite a stale undrawable flag", () => {
    // The undrawable label's stale `visible: true` never goes away (no panel
    // control targets it), so hiding the drawable label must still empty the
    // drawn set — an overlay that cannot be turned off is worse than none.
    const m = manifestWithLabels([uintLabel("mask8", "Uint8"), uintLabel("cells", "Uint32")]);
    const shown = resolveVisibleLabels(m, [
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.7 },
    ]);
    expect(shown.map((r) => r.name)).toEqual(["cells"]);
    expect(shown[0].opacity).toBe(0.7);

    const hidden = resolveVisibleLabels(m, [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.7 },
    ]);
    expect(hidden).toEqual([]);
  });

  it("honors an explicit hide-all: no fallback when NOTHING is marked visible", () => {
    // Both eligible, both hidden by the user → nothing drawn. Nothing may
    // re-show a label the user deliberately hid.
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const out = resolveVisibleLabels(m, [
      { visible: false, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ]);
    expect(out).toEqual([]);
  });

  it("no fallback when there is no eligible label at all (all uint8)", () => {
    const m = manifestWithLabels([uintLabel("m8a", "Uint8"), uintLabel("m8b", "Uint8")]);
    expect(
      resolveVisibleLabels(m, [
        { visible: true, opacity: 0.5 },
        { visible: true, opacity: 0.5 },
      ]),
    ).toEqual([]);
  });
});

describe("resolveLabelDisplayStates (the shared panel/fetch/render resolution)", () => {
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
  /** Project a state to the fields the layer panel renders. */
  function row(s: { index: number; name: string; visible: boolean; opacity: number }) {
    return { index: s.index, name: s.name, visible: s.visible, opacity: s.opacity };
  }

  it("emits one entry per DRAWABLE label, keyed by manifest index; undrawables get none", () => {
    // [uint8, uint32, uint32]: index 0 is undrawable — no entry, and its
    // visible flag has no effect. Indices 1/2 keep their manifest positions so
    // controls target the right positional settings entry.
    const m = manifestWithLabels([
      uintLabel("mask8", "Uint8"),
      uintLabel("cells"),
      uintLabel("nuclei"),
    ]);
    const states = resolveLabelDisplayStates(m, [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.25 },
      { visible: true, opacity: 0.75 },
    ]);
    expect(states.map(row)).toEqual([
      { index: 1, name: "cells", visible: false, opacity: 0.25 },
      { index: 2, name: "nuclei", visible: true, opacity: 0.75 },
    ]);
    // Each entry carries the fetch/render resolution too.
    expect(states[0].label.image.image_id).toBe("img-0:label:cells");
    expect(states[0].sourceImageId).toBe("img-0");
    expect(states[0].levelIdx).toBe(0);
  });

  it("no settings → every drawable label listed, only the FIRST visible, all at 0.5", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    expect(resolveLabelDisplayStates(m, undefined).map(row)).toEqual([
      { index: 0, name: "a", visible: true, opacity: 0.5 },
      { index: 1, name: "b", visible: false, opacity: 0.5 },
    ]);
  });

  it("a missing settings entry (short/stale snapshot) counts as hidden; opacity is clamped", () => {
    const m = manifestWithLabels([uintLabel("a"), uintLabel("b")]);
    const states = resolveLabelDisplayStates(m, [{ visible: true, opacity: 7 }]);
    expect(states.map(row)).toEqual([
      { index: 0, name: "a", visible: true, opacity: 1 }, // clamped into [0, 1]
      { index: 1, name: "b", visible: false, opacity: 0.5 }, // no entry → hidden, default opacity
    ]);
  });

  it("the visible-marked states ARE the drawn set (resolveVisibleLabels), settings or not", () => {
    // The invariant the panel relies on: rows marked visible == labels drawn,
    // for the same manifest/settings/mode — including when a stale flag sits
    // on an undrawable label, and when everything drawable is hidden.
    const m = manifestWithLabels([uintLabel("mask8", "Uint8"), uintLabel("cells"), uintLabel("nuclei")]);
    const cases = [
      undefined, // pre-controls default
      [
        { visible: true, opacity: 0.5 }, // stale flag on the undrawable label
        { visible: false, opacity: 0.5 },
        { visible: false, opacity: 0.5 },
      ],
      [
        { visible: false, opacity: 0.5 },
        { visible: true, opacity: 0.3 },
        { visible: true, opacity: 0.8 },
      ],
    ];
    for (const settings of cases) {
      const drawn = resolveVisibleLabels(m, settings);
      const visibleStates = resolveLabelDisplayStates(m, settings).filter((s) => s.visible);
      expect(drawn.map((r) => ({ name: r.name, opacity: r.opacity }))).toEqual(
        visibleStates.map((s) => ({ name: s.name, opacity: s.opacity })),
      );
    }
    // The stale-flag case draws nothing at all — no stuck overlay.
    expect(resolveVisibleLabels(m, cases[1])).toEqual([]);
  });

  it("volume mode drops a slice-only label from the states (no row, no draw)", () => {
    // Single-level label with Z over the 3D texture limit: drawable in 2D
    // (slice caps ignore Z), undrawable in 3D — so in volume mode it must not
    // appear as a controllable row at all.
    const deep: LabelSpec = {
      name: "deep",
      source_image_id: "img-0",
      image: {
        image_id: "img-0:label:deep",
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
              shape: [1, 1, 3000, 512, 512],
              chunk_shape: [1, 1, 64, 256, 256],
              grid_shape: [1, 1, 1, 1, 1],
              scale: [1, 1, 1, 1, 1],
            },
          ],
          data_type: "Uint32",
        },
      },
    };
    const m = manifestWithLabels([deep, uintLabel("flat")]);
    const settings = [
      { visible: true, opacity: 0.5 },
      { visible: false, opacity: 0.5 },
    ];
    expect(resolveLabelDisplayStates(m, settings, { mode: "slice" }).map(row)).toEqual([
      { index: 0, name: "deep", visible: true, opacity: 0.5 },
      { index: 1, name: "flat", visible: false, opacity: 0.5 },
    ]);
    // Volume: "deep" is gone, and its 2D visible flag does NOT flip "flat" on.
    expect(resolveLabelDisplayStates(m, settings, { mode: "volume" }).map(row)).toEqual([
      { index: 1, name: "flat", visible: false, opacity: 0.5 },
    ]);
    expect(resolveVisibleLabels(m, settings, { mode: "volume" })).toEqual([]);
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

  it("omits a non-uint32 label and PRESERVES the manifest index of the rest", () => {
    // [uint16, uint32, uint16] → only index 1 is drawable, and it keeps index 1
    // (so its control targets the right label_settings entry).
    const m = manifestWithLabels([
      uintLabel("nuclei", "Uint16"),
      uintLabel("cells", "Uint32"),
      uintLabel("membrane", "Uint16"),
    ]);
    expect(eligibleLabelInfos(m)).toEqual([{ index: 1, name: "cells" }]);
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
        name: "mito",
        source_image_id: "img-0",
        image: image5("img-0:label:mito", [1, 1, 4, 128, 128], [1, 1, 2, 64, 64], [1, 1, 1, 1, 1]),
      }],
    };
  }

  it("emits EVERY (z, y, x) chunk of the chosen level (the full volume)", () => {
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest: volManifest(), t: 0, z: 0, mode: "volume" });
    // gz=2, gy=2, gx=2 → 8 chunks; slice mode would emit only 4 (single z).
    expect(reqs).toHaveLength(8);
    // Both z-chunks are present (not just the mapped-Z plane).
    expect(new Set(reqs.map((r) => r.z))).toEqual(new Set([0, 1]));
    const keys = new Set(reqs.map((r) => r.chunkKey));
    expect(keys.size).toBe(8);
    expect(keys.has("0/0/0/0/0/0")).toBe(true); // z=0 corner
    expect(keys.has("0/0/0/1/1/1")).toBe(true); // z=1 far corner
    // Every request is scoped under the label's own image id.
    expect(reqs.every((r) => r.imageId === "img-0:label:mito")).toBe(true);
    expect(reqs.every((r) => r.level === 0)).toBe(true);
  });

  it("slice mode (and the default) fetches only the mapped z-plane", () => {
    const sliceReqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest: volManifest(), t: 0, z: 0, mode: "slice" });
    expect(sliceReqs).toHaveLength(4); // gy*gx, single z-chunk
    expect(new Set(sliceReqs.map((r) => r.z))).toEqual(new Set([0]));
    // Omitting `mode` behaves identically to slice (back-compat).
    const defaultReqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest: volManifest(), t: 0, z: 0 });
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
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 5, z: 0, mode: "volume" });
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
  const vol = { datasetId: "ds-0", t: 0, z: 0, mode: "volume" as const };
  const slice = { datasetId: "ds-0", t: 0, z: 0, mode: "slice" as const };

  it("skips a label whose Z exceeds the 3D limit — slice mode stays eligible", () => {
    // 512×512×3000: fine in 2D (Z ignored), but Z>2048 in 3D with no coarser level.
    const m = manifestFor([{ shape: [1, 1, 3000, 512, 512], chunk: [1, 1, 64, 256, 256], scale: SCALE1 }]);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toEqual([]);
    expect(resolveVisibleLabels(m, undefined, { mode: "volume" })).toEqual([]);
    // Slice is unaffected by the 3D caps.
    expect(computeLabelChunkRequests({ ...slice, manifest: m }).length).toBeGreaterThan(0);
    expect(resolveVisibleLabels(m, undefined, { mode: "slice" })).toHaveLength(1);
  });

  it("coarsens past a level whose X/Y exceeds the 3D limit", () => {
    const m = manifestFor([
      { shape: [1, 1, 64, 4096, 4096], chunk: [1, 1, 64, 512, 512], scale: SCALE1 }, // X/Y 4096 > 2048
      { shape: [1, 1, 16, 1024, 1024], chunk: [1, 1, 16, 512, 512], scale: [1, 1, 4, 4, 4] }, // fits
    ]);
    const reqs = computeLabelChunkRequests({ ...vol, manifest: m });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.level === 1)).toBe(true);
    expect(resolveVisibleLabels(m, undefined, { mode: "volume" })[0].levelIdx).toBe(1);
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
    // 2048·2048·33·4 B = 553 MB > 512 MB; per-axis dims + chunk count are both fine.
    const m = manifestFor([{ shape: [1, 1, 33, 2048, 2048], chunk: [1, 1, 64, 512, 512], scale: SCALE1 }]);
    expect(computeLabelChunkRequests({ ...vol, manifest: m })).toEqual([]);
    expect(resolveVisibleLabels(m, undefined, { mode: "slice" })).toHaveLength(1);
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
    expect(resolveVisibleLabels(m, undefined, { mode: "volume" })[0].levelIdx).toBe(0);
    expect(resolveVisibleLabels(m, undefined, { mode: "volume", maxChunksPerVolume: 1 })[0].levelIdx).toBe(1);
  });
});
