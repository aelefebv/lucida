import { describe, it, expect } from "vitest";
import { computeLabelChunkRequests, resolveDefaultLabel } from "./labelRequests.ts";
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
