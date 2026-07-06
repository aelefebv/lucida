import { describe, it, expect } from "vitest";
import { extractPlateData } from "./PlateSelector.tsx";
import type { DatasetManifest, ImageSpec } from "../manifestTypes.ts";

function makeImage(image_id: string, owner: string): ImageSpec {
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
          shape: [1, 1, 1, 256, 256],
          chunk_shape: [1, 1, 1, 256, 256],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, 1, 1],
        },
      ],
      data_type: "Uint16",
    },
  };
}

function plate2x2(): DatasetManifest {
  return {
    dataset_id: "plate-2x2",
    name: "plate",
    kind: { Plate: { rows: ["A", "B"], columns: ["1", "2"], positioning_mode: "Derived", has_explicit_positions: false } },
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

describe("extractPlateData", () => {
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
    expect(extractPlateData(g)).toBeNull();
  });

  it("uses source default placements when no active overrides are passed", () => {
    const data = extractPlateData(plate2x2());
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
    const data = extractPlateData(plate2x2(), dense);
    expect(data).not.toBeNull();
    const e2 = data!.members.find((m) => m.id === "e2")!;
    expect(e2.position).toEqual([512, 0]);
    const e3 = data!.members.find((m) => m.id === "e3")!;
    expect(e3.position).toEqual([768, 0]);
  });

  it("falls back to source layout when activeLayoutPlacements is empty", () => {
    const data = extractPlateData(plate2x2(), []);
    expect(data).not.toBeNull();
    const e3 = data!.members.find((m) => m.id === "e3")!;
    // Source default puts e3 at (256, 256), not whatever empty would produce.
    expect(e3.position).toEqual([256, 256]);
  });

  it("preserves rowIndex/columnIndex from entity labels regardless of which placements are used", () => {
    const dense = [
      { entity_id: "e0", position: [42, 99] as [number, number] },
    ];
    const data = extractPlateData(plate2x2(), dense);
    const e0 = data!.members.find((m) => m.id === "e0")!;
    expect(e0.rowIndex).toBe(0);
    expect(e0.columnIndex).toBe(0);
  });
});
