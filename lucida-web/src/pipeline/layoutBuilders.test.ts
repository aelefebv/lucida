import { describe, it, expect } from "vitest";
import {
  buildPlateGridLayout,
  buildDenseSquareLayout,
  derivedBuildersFor,
} from "./layoutBuilders.ts";
import type { DatasetManifest, ImageSpec, LayoutSpec } from "../manifestTypes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeImage(image_id: string, owner: string, fovY = 256, fovX = 256): ImageSpec {
  return {
    image_id,
    owner,
    multiscale: {
      axes: [
        { name: "t", kind: "Time" },
        { name: "c", kind: "Channel" },
        { name: "z", kind: "Space" },
        { name: "y", kind: "Space" },
        { name: "x", kind: "Space" },
      ],
      levels: [
        {
          level_index: 0,
          shape: [1, 1, 1, fovY, fovX],
          chunk_shape: [1, 1, 1, fovY, fovX],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, 1, 1],
        },
      ],
      data_type: "Uint16",
    },
  };
}

/** Single-image dataset with no source layouts. */
function singleImageGraph(): DatasetManifest {
  return {
    dataset_id: "ds-single",
    name: "single",
    kind: "Single",
    entities: [{ id: "e0", kind: "Image", parent: null, labels: {} }],
    transforms: [],
    images: [makeImage("img-0", "e0")],
    source_layouts: [],
    default_layout_id: null,
  };
}

/** 2x2 plate, all 4 wells populated (each entity gets its own corner). */
function plate2x2Graph(): DatasetManifest {
  const W = 256;
  const H = 256;
  const placements: LayoutSpec["placements"] = [
    { entity_id: "e0", position: [0, 0] },
    { entity_id: "e1", position: [W, 0] },
    { entity_id: "e2", position: [0, H] },
    { entity_id: "e3", position: [W, H] },
  ];
  return {
    dataset_id: "plate-2x2",
    name: "plate",
    kind: { Plate: { rows: ["A", "B"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
    entities: ["e0", "e1", "e2", "e3"].map((id) => ({ id, kind: "Image", parent: null, labels: {} })),
    transforms: [],
    images: ["e0", "e1", "e2", "e3"].map((id) => makeImage(`img-${id}`, id, H, W)),
    source_layouts: [{ id: "default", name: "Default", placements }],
    default_layout_id: "default",
  };
}

/** Sparse plate: 3 entities placed (one well empty). */
function plateSparseGraph(): DatasetManifest {
  const W = 256;
  const H = 256;
  const placements: LayoutSpec["placements"] = [
    { entity_id: "e0", position: [0, 0] },
    { entity_id: "e1", position: [W, 0] },
    { entity_id: "e2", position: [0, H] },
  ];
  return {
    dataset_id: "plate-sparse",
    name: "plate-sparse",
    kind: { Plate: { rows: ["A", "B"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
    entities: ["e0", "e1", "e2"].map((id) => ({ id, kind: "Image", parent: null, labels: {} })),
    transforms: [],
    images: ["e0", "e1", "e2"].map((id) => makeImage(`img-${id}`, id, H, W)),
    source_layouts: [{ id: "default", name: "Default", placements }],
    default_layout_id: "default",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPlateGridLayout", () => {
  it("returns null for single-image dataset (no source layout)", () => {
    expect(buildPlateGridLayout(singleImageGraph())).toBeNull();
  });

  it("mirrors the source default layout's placements verbatim", () => {
    const spec = buildPlateGridLayout(plate2x2Graph());
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe("derived:plate-grid");
    expect(spec!.name).toBe("Plate grid");
    expect(spec!.placements).toEqual([
      { entity_id: "e0", position: [0, 0] },
      { entity_id: "e1", position: [256, 0] },
      { entity_id: "e2", position: [0, 256] },
      { entity_id: "e3", position: [256, 256] },
    ]);
  });
});

describe("buildDenseSquareLayout", () => {
  it("returns null for single-image dataset", () => {
    expect(buildDenseSquareLayout(singleImageGraph())).toBeNull();
  });

  it("packs 4 image-level entities into a 2x2 square with one-field gap", () => {
    const spec = buildDenseSquareLayout(plate2x2Graph());
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe("derived:dense-square");
    expect(spec!.name).toBe("Dense (square)");
    // cols = ceil(sqrt(4)) = 2; footprint = 256 (image FOV); gap = 256;
    // stride = 256 + 256 = 512.
    expect(spec!.placements).toEqual([
      { entity_id: "e0", position: [0, 0] },
      { entity_id: "e1", position: [512, 0] },
      { entity_id: "e2", position: [0, 512] },
      { entity_id: "e3", position: [512, 512] },
    ]);
  });

  it("packs 3 entities into the first 3 cells of a 2x2 (sparse)", () => {
    const spec = buildDenseSquareLayout(plateSparseGraph());
    expect(spec).not.toBeNull();
    // cols = ceil(sqrt(3)) = 2; stride = 512 (256 footprint + 256 gap).
    expect(spec!.placements).toEqual([
      { entity_id: "e0", position: [0, 0] },
      { entity_id: "e1", position: [512, 0] },
      { entity_id: "e2", position: [0, 512] },
    ]);
  });

  it("returns null when source default has only 1 entity", () => {
    const g: DatasetManifest = {
      ...singleImageGraph(),
      source_layouts: [{ id: "default", name: "Default", placements: [{ entity_id: "e0", position: [0, 0] }] }],
      default_layout_id: "default",
    };
    expect(buildDenseSquareLayout(g)).toBeNull();
  });
});

/** Plate with 2 wells, each containing a 2x2 grid of 256x256 fields.
 *  Source layout places wells at (0,0) and (1000,0). Field offsets within
 *  each well are (0,0), (256,0), (0,256), (256,256) → well bbox is 512x512. */
function plateWithFieldsGraph(): DatasetManifest {
  const wells = ["W1", "W2"];
  const wellPositions: Record<string, [number, number]> = {
    W1: [0, 0],
    W2: [1000, 0],
  };
  const fieldOffsets: [number, number][] = [
    [0, 0],
    [256, 0],
    [0, 256],
    [256, 256],
  ];

  const entities: DatasetManifest["entities"] = [];
  const transforms: DatasetManifest["transforms"] = [];
  const images: ImageSpec[] = [];

  for (const well of wells) {
    entities.push({ id: well, kind: "Well", parent: null, labels: {} });
    fieldOffsets.forEach(([fx, fy], i) => {
      const fieldId = `${well}-F${i}`;
      entities.push({ id: fieldId, kind: "Field", parent: well, labels: {} });
      images.push(makeImage(`${fieldId}-img`, fieldId, 256, 256));
      transforms.push({
        from: fieldId,
        to: well,
        // column-major matrix; tx at [12], ty at [13]
        transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, fx, fy, 0, 1] },
      });
    });
  }

  return {
    dataset_id: "plate-with-fields",
    name: "plate-with-fields",
    kind: { Plate: { rows: ["A"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
    entities,
    transforms,
    images,
    source_layouts: [
      {
        id: "default",
        name: "Default",
        placements: wells.map((w) => ({ entity_id: w, position: wellPositions[w] })),
      },
    ],
    default_layout_id: "default",
  };
}

describe("buildDenseSquareLayout — well/field hierarchy", () => {
  it("uses well bbox + one-field gap as packing stride", () => {
    const spec = buildDenseSquareLayout(plateWithFieldsGraph());
    expect(spec).not.toBeNull();
    // 2 wells, cols=ceil(sqrt(2))=2, single-row layout.
    // Well bbox = 512x512; field FOV = 256; stride = 512 + 256 = 768.
    expect(spec!.placements).toEqual([
      { entity_id: "W1", position: [0, 0] },
      { entity_id: "W2", position: [768, 0] },
    ]);
  });
});

describe("derivedBuildersFor", () => {
  it("returns [] for single-image dataset", () => {
    expect(derivedBuildersFor(singleImageGraph())).toEqual([]);
  });

  it("returns both derived layouts for a 2x2 plate", () => {
    const out = derivedBuildersFor(plate2x2Graph());
    expect(out.map((s) => s.id)).toEqual(["derived:plate-grid", "derived:dense-square"]);
  });

  it("returns only plate-grid when dense is filtered out (1-entity dataset with source layout)", () => {
    const g: DatasetManifest = {
      ...singleImageGraph(),
      source_layouts: [{ id: "default", name: "Default", placements: [{ entity_id: "e0", position: [0, 0] }] }],
      default_layout_id: "default",
    };
    const out = derivedBuildersFor(g);
    expect(out.map((s) => s.id)).toEqual(["derived:plate-grid"]);
  });
});
