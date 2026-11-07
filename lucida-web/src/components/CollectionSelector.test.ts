// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { __resetPreferencesForTesting, getPreference } from "../theme/preferences.ts";
import { navigatorCardPreference } from "./canvasCards.ts";
import { CollectionSelector, extractCollectionData } from "./CollectionSelector.tsx";
import type { DatasetManifest, Entity, ImageSpec, TransformEdge } from "../manifestTypes.ts";

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

afterEach(cleanup);

function makeImage(image_id: string, owner: string, sizeY = 256, sizeX = 256): ImageSpec {
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
          shape: [1, 1, 1, sizeY, sizeX],
          chunk_shape: [1, 1, 1, sizeY, sizeX],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, 1, 1],
        },
      ],
      data_type: "Uint16",
    },
  };
}

function collection2x2(): DatasetManifest {
  return {
    dataset_id: "collection-2x2",
    name: "collection",
    kind: { Collection: { rows: ["A", "B"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
    entities: [
      { id: "e0", kind: "Image", parent: null, labels: { row_index: 0, column_index: 0 } },
      { id: "e1", kind: "Image", parent: null, labels: { row_index: 0, column_index: 1 } },
      { id: "e2", kind: "Image", parent: null, labels: { row_index: 1, column_index: 0 } },
      { id: "e3", kind: "Image", parent: null, labels: { row_index: 1, column_index: 1 } },
    ],
    transforms: [],
    images: ["e0", "e1", "e2", "e3"].map((id) => makeImage(`img-${id}`, id)),
    source_layouts: [
      {
        id: "default",
        name: "Default",
        placements: [
          { entity_id: "e0", position: [0, 0] },
          { entity_id: "e1", position: [256, 0] },
          { entity_id: "e2", position: [0, 256] },
          { entity_id: "e3", position: [256, 256] },
        ],
      },
    ],
    default_layout_id: "default",
  };
}

describe("extractCollectionData", () => {
  it("returns null for Single dataset kind", () => {
    const g: DatasetManifest = {
      dataset_id: "ds",
      name: "ds",
      kind: "Single",
      entities: [],
      transforms: [],
      images: [],
      source_layouts: [],
      default_layout_id: null,
    };
    expect(extractCollectionData(g)).toBeNull();
  });

  it("uses source default placements when no active overrides are passed", () => {
    const data = extractCollectionData(collection2x2());
    expect(data).not.toBeNull();
    expect(data!.members).toHaveLength(4);
    const e0 = data!.members.find((m) => m.id === "e0")!;
    expect(e0.position).toEqual([0, 0]);
  });

  it("uses active layout placements when provided", () => {
    const dense = [
      { entity_id: "e0", position: [0, 0] as [number, number] },
      { entity_id: "e1", position: [256, 0] as [number, number] },
      { entity_id: "e2", position: [512, 0] as [number, number] }, // dense-style: row 0
      { entity_id: "e3", position: [768, 0] as [number, number] },
    ];
    const data = extractCollectionData(collection2x2(), dense);
    expect(data).not.toBeNull();
    const e2 = data!.members.find((m) => m.id === "e2")!;
    expect(e2.position).toEqual([512, 0]);
    const e3 = data!.members.find((m) => m.id === "e3")!;
    expect(e3.position).toEqual([768, 0]);
  });

  it("falls back to source layout when activeLayoutPlacements is empty", () => {
    const data = extractCollectionData(collection2x2(), []);
    expect(data).not.toBeNull();
    const e3 = data!.members.find((m) => m.id === "e3")!;
    // Source default puts e3 at (256, 256), not whatever empty would produce.
    expect(e3.position).toEqual([256, 256]);
  });

  it("preserves rowIndex/columnIndex from entity labels regardless of which placements are used", () => {
    const dense = [
      { entity_id: "e0", position: [42, 99] as [number, number] },
    ];
    const data = extractCollectionData(collection2x2(), dense);
    const e0 = data!.members.find((m) => m.id === "e0")!;
    expect(e0.rowIndex).toBe(0);
    expect(e0.columnIndex).toBe(0);
  });
});

function translation(from: string, to: string, tx: number, ty: number): TransformEdge {
  return { from, to, transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1] } };
}

/**
 * Two groups in one row, each holding tiles placed by tile→group transforms,
 * the shape import builds: the layout places groups only.
 */
function groupedCollection(
  tileOffsets: [number, number][],
  hasExplicitPositions: boolean,
): DatasetManifest {
  const entities: Entity[] = [];
  const images: ImageSpec[] = [];
  const transforms: TransformEdge[] = [];
  for (const [col, group] of ["g0", "g1"].entries()) {
    entities.push({ id: group, kind: "Group", parent: null, labels: { row_index: 0, column_index: col } });
    tileOffsets.forEach(([tx, ty], i) => {
      const tile = `${group}:t${i}`;
      entities.push({ id: tile, kind: "Tile", parent: group, labels: { tile_index: i } });
      images.push(makeImage(`${tile}:img`, tile, 80, 100));
      transforms.push(translation(tile, group, tx, ty));
    });
  }
  return {
    dataset_id: "grouped",
    name: "grouped",
    kind: {
      Collection: {
        rows: ["A"],
        columns: ["1", "2"],
        positioning_mode: hasExplicitPositions ? "Explicit" : "Derived",
        has_explicit_positions: hasExplicitPositions,
      },
    },
    entities,
    transforms,
    images,
    source_layouts: [
      {
        id: "source",
        name: "Source",
        placements: [
          { entity_id: "g0", position: [0, 0] },
          { entity_id: "g1", position: [1000, 0] },
        ],
      },
    ],
    default_layout_id: "source",
  };
}

// 2×2 tiles of 100×80 with an 8% gap, as the grid transforms lay them out.
const GRID_OFFSETS: [number, number][] = [[0, 0], [108, 0], [0, 86.4], [108, 86.4]];

describe("extractCollectionData bounds", () => {
  it("covers a grid-derived group's tiles from its placement", () => {
    const data = extractCollectionData(groupedCollection(GRID_OFFSETS, false))!;
    const g1 = data.members.find((m) => m.id === "g1")!;
    expect(g1.bounds).toEqual({ min: [1000, 0], max: [1208, 166.4] });
  });

  it("covers explicitly positioned tiles, wherever they sit in the group", () => {
    const data = extractCollectionData(
      groupedCollection([[0, 40], [350, 0], [120, 500]], true),
    )!;
    const g0 = data.members.find((m) => m.id === "g0")!;
    expect(g0.bounds).toEqual({ min: [0, 0], max: [450, 580] });
  });

  it("follows the active layout's placement", () => {
    const data = extractCollectionData(groupedCollection(GRID_OFFSETS, false), [
      { entity_id: "g0", position: [5000, 7000] },
    ])!;
    const g0 = data.members.find((m) => m.id === "g0")!;
    expect(g0.bounds).toEqual({ min: [5000, 7000], max: [5208, 7166.4] });
  });

  it("spans a placed image entity's own image", () => {
    const data = extractCollectionData(collection2x2())!;
    const e3 = data.members.find((m) => m.id === "e3")!;
    expect(e3.bounds).toEqual({ min: [256, 256], max: [512, 512] });
  });
});

describe("CollectionSelector group click", () => {
  it("reports the whole group's bounds, not its origin", () => {
    const data = extractCollectionData(groupedCollection(GRID_OFFSETS, false))!;
    const onGroupClick = vi.fn();
    render(
      createElement(CollectionSelector, {
        collectionKind: data.collectionKind,
        members: data.members,
        collectionName: "grouped",
        onGroupClick,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "A2" }));
    expect(onGroupClick).toHaveBeenCalledWith({ min: [1000, 0], max: [1208, 166.4] });
  });
});

describe("CollectionSelector current group", () => {
  const isCurrent = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-current") === "location";

  it("marks the group under the view's center and names it in the header", async () => {
    const data = extractCollectionData(collection2x2())!;
    let center = [300, 100];
    render(
      createElement(CollectionSelector, {
        collectionKind: data.collectionKind,
        members: data.members,
        collectionName: "collection",
        onGroupClick: vi.fn(),
        getViewCenter: () => center,
      }),
    );
    await waitFor(() => expect(isCurrent("A2")).toBe(true));
    expect(document.querySelector(".lc-panel-header-meta")?.textContent).toBe("A2");

    center = [100, 300];
    await waitFor(() => expect(isCurrent("B1")).toBe(true));
    expect(isCurrent("A2")).toBe(false);

    // Off every group, nothing is marked.
    center = [900, 900];
    await waitFor(() => expect(isCurrent("B1")).toBe(false));
    expect(document.querySelector(".lc-panel-header-meta")).toBeNull();
  });

  it("folds and hides through its header", () => {
    const data = extractCollectionData(collection2x2())!;
    render(
      createElement(CollectionSelector, {
        collectionKind: data.collectionKind,
        members: data.members,
        collectionName: "collection",
        onGroupClick: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse collection selector" }));
    expect(getPreference(navigatorCardPreference)).toBe("collapsed");
    expect(screen.queryByRole("button", { name: "A1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand collection selector" }));
    expect(screen.getByRole("button", { name: "A1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide collection selector" }));
    expect(getPreference(navigatorCardPreference)).toBe("hidden");
    expect(screen.queryByRole("group", { name: "Collection selector" })).toBeNull();
  });
});
