import { describe, it, expect } from "vitest";
import {
  buildCollectionGridLayout,
  buildDenseSquareLayout,
  derivedBuildersFor,
} from "./layoutBuilders.ts";
import type { DatasetManifest, ImageSpec, LayoutSpec } from "../manifestTypes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeImage(image_id: string, owner: string, footprintY = 256, footprintX = 256): ImageSpec {
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
          shape: [1, 1, 1, footprintY, footprintX],
          chunk_shape: [1, 1, 1, footprintY, footprintX],
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

/** 2x2 collection, all 4 groups populated (each entity gets its own corner). */
function collection2x2Graph(): DatasetManifest {
  const W = 256;
  const H = 256;
  const placements: LayoutSpec["placements"] = [
    { entity_id: "e0", position: [0, 0] },
    { entity_id: "e1", position: [W, 0] },
    { entity_id: "e2", position: [0, H] },
    { entity_id: "e3", position: [W, H] },
  ];
  return {
    dataset_id: "collection-2x2",
    name: "collection",
    kind: { Collection: { rows: ["A", "B"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
    entities: ["e0", "e1", "e2", "e3"].map((id) => ({ id, kind: "Image", parent: null, labels: {} })),
    transforms: [],
    images: ["e0", "e1", "e2", "e3"].map((id) => makeImage(`img-${id}`, id, H, W)),
    source_layouts: [{ id: "default", name: "Default", placements }],
    default_layout_id: "default",
  };
}

/** Sparse collection: 3 entities placed (one group empty). */
function collectionSparseGraph(): DatasetManifest {
  const W = 256;
  const H = 256;
  const placements: LayoutSpec["placements"] = [
    { entity_id: "e0", position: [0, 0] },
    { entity_id: "e1", position: [W, 0] },
    { entity_id: "e2", position: [0, H] },
  ];
  return {
    dataset_id: "collection-sparse",
    name: "collection-sparse",
    kind: { Collection: { rows: ["A", "B"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
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

describe("buildCollectionGridLayout", () => {
  it("returns null for single-image dataset (no source layout)", () => {
    expect(buildCollectionGridLayout(singleImageGraph())).toBeNull();
  });

  it("mirrors the source default layout's placements verbatim", () => {
    const spec = buildCollectionGridLayout(collection2x2Graph());
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe("derived:collection-grid");
    expect(spec!.name).toBe("Collection grid");
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

  it("packs 4 image-level entities into a 2x2 square with one-tile gap", () => {
    const spec = buildDenseSquareLayout(collection2x2Graph());
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe("derived:dense-square");
    expect(spec!.name).toBe("Dense (square)");
    // cols = ceil(sqrt(4)) = 2; footprint = 256 (image tile); gap = 256;
    // stride = 256 + 256 = 512.
    expect(spec!.placements).toEqual([
      { entity_id: "e0", position: [0, 0] },
      { entity_id: "e1", position: [512, 0] },
      { entity_id: "e2", position: [0, 512] },
      { entity_id: "e3", position: [512, 512] },
    ]);
  });

  it("packs 3 entities into the first 3 cells of a 2x2 (sparse)", () => {
    const spec = buildDenseSquareLayout(collectionSparseGraph());
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

/** Collection with 2 groups, each containing a 2x2 grid of 256x256 tiles.
 *  Source layout places groups at (0,0) and (1000,0). Tile offsets within
 *  each group are (0,0), (256,0), (0,256), (256,256) → group bbox is 512x512. */
function collectionWithTilesGraph(): DatasetManifest {
  const groups = ["W1", "W2"];
  const groupPositions: Record<string, [number, number]> = {
    W1: [0, 0],
    W2: [1000, 0],
  };
  const tileOffsets: [number, number][] = [
    [0, 0],
    [256, 0],
    [0, 256],
    [256, 256],
  ];

  const entities: DatasetManifest["entities"] = [];
  const transforms: DatasetManifest["transforms"] = [];
  const images: ImageSpec[] = [];

  for (const group of groups) {
    entities.push({ id: group, kind: "Group", parent: null, labels: {} });
    tileOffsets.forEach(([fx, fy], i) => {
      const tileId = `${group}-F${i}`;
      entities.push({ id: tileId, kind: "Tile", parent: group, labels: {} });
      images.push(makeImage(`${tileId}-img`, tileId, 256, 256));
      transforms.push({
        from: tileId,
        to: group,
        // column-major matrix; tx at [12], ty at [13]
        transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, fx, fy, 0, 1] },
      });
    });
  }

  return {
    dataset_id: "collection-with-tiles",
    name: "collection-with-tiles",
    kind: { Collection: { rows: ["A"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
    entities,
    transforms,
    images,
    source_layouts: [
      {
        id: "default",
        name: "Default",
        placements: groups.map((w) => ({ entity_id: w, position: groupPositions[w] })),
      },
    ],
    default_layout_id: "default",
  };
}

describe("buildDenseSquareLayout — group/tile hierarchy", () => {
  it("uses group bbox + one-tile gap as packing stride", () => {
    const spec = buildDenseSquareLayout(collectionWithTilesGraph());
    expect(spec).not.toBeNull();
    // 2 groups, cols=ceil(sqrt(2))=2, single-row layout.
    // Group bbox = 512x512; tile size = 256; stride = 512 + 256 = 768.
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

  it("returns both derived layouts for a 2x2 collection", () => {
    const out = derivedBuildersFor(collection2x2Graph());
    expect(out.map((s) => s.id)).toEqual(["derived:collection-grid", "derived:dense-square"]);
  });

  it("returns only collection-grid when dense is filtered out (1-entity dataset with source layout)", () => {
    const g: DatasetManifest = {
      ...singleImageGraph(),
      source_layouts: [{ id: "default", name: "Default", placements: [{ entity_id: "e0", position: [0, 0] }] }],
      default_layout_id: "default",
    };
    const out = derivedBuildersFor(g);
    expect(out.map((s) => s.id)).toEqual(["derived:collection-grid"]);
  });
});
