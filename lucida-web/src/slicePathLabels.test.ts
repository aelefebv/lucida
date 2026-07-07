import { describe, it, expect } from "vitest";
import { pushLabelLayers } from "./slicePath.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberRosterEntry } from "./pipeline/tickCoordinator.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "./manifestTypes.ts";

function image(id: string, yx: [number, number], scaleYX: [number, number], dtype = "Uint32", owner = "ent-0"): ImageSpec {
  return {
    image_id: id,
    owner,
    multiscale: {
      axes: [
        { name: "t", kind: "time" }, { name: "c", kind: "channel" },
        { name: "z", kind: "space" }, { name: "y", kind: "space" }, { name: "x", kind: "space" },
      ],
      levels: [{
        level_index: 0,
        shape: [1, 1, 1, yx[0], yx[1]],
        chunk_shape: [1, 1, 1, 128, 128],
        grid_shape: [1, 1, 1, 1, 1],
        scale: [1, 1, 1, scaleYX[0], scaleYX[1]],
      }],
      data_type: dtype,
    },
  };
}

function labelSpec(name: string, imgId: string, colors?: LabelSpec["colors"], dtype = "Uint32"): LabelSpec {
  return { name, source_image_id: "img-0", image: image(imgId, [85, 87], [4, 4], dtype), colors };
}

function manifest(labels: LabelSpec[]): DatasetManifest {
  return {
    dataset_id: "ds-0", name: "yeast", kind: "Single",
    entities: [], transforms: [], source_layouts: [], default_layout_id: null,
    images: [image("img-0", [340, 348], [1, 1])],
    labels,
  };
}

const members: MemberRosterEntry[] = [{ imageId: "img-0", position: [0, 0] }];

describe("pushLabelLayers", () => {
  it("emits exactly ONE label layer (the first) by default, not the whole stack", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(
      layers,
      manifest([
        labelSpec("mitochondria", "img-0:label:mito"),
        labelSpec("foreground", "img-0:label:fg"),
        labelSpec("nuclei", "img-0:label:nuc"),
      ]),
      members,
    );
    expect(layers).toHaveLength(1);
    expect(layers[0].datasetId).toBe("img-0:label:mito"); // manifest order = first
    expect(layers[0].isLabel).toBe(true);
    expect(layers[0].opacity).toBeCloseTo(0.5);
  });

  it("aligns the overlay to the source footprint (4x-coarse label → source extent)", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([labelSpec("mito", "img-0:label:mito")]), members);
    expect(layers[0].dataW).toBeCloseTo(348, 3); // 87 * 4 / 1
    expect(layers[0].dataH).toBeCloseTo(340, 3);
    expect(layers[0].offsetX).toBe(0);
    expect(layers[0].offsetY).toBe(0);
  });

  it("forwards declared image-label.colors to the layer", () => {
    const colors: LabelSpec["colors"] = [{ value: 2, rgba: [230, 25, 75, 255] }];
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([labelSpec("mito", "img-0:label:mito", colors)]), members);
    expect(layers[0].labelColors).toEqual(colors);
  });

  it("emits nothing for a label-less manifest", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([]), members);
    expect(layers).toHaveLength(0);
  });

  it("MAJOR: skips a non-uint32 (uint8) label and renders the uint32 sibling instead", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(
      layers,
      manifest([
        labelSpec("mask8", "img-0:label:mask8", undefined, "Uint8"),
        labelSpec("seg32", "img-0:label:seg32"),
      ]),
      members,
    );
    expect(layers).toHaveLength(1);
    expect(layers[0].datasetId).toBe("img-0:label:seg32");
  });

  it("MAJOR: renders nothing for a uint8-only label (matches the fetch skip)", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([labelSpec("mask8", "img-0:label:mask8", undefined, "Uint8")]), members);
    expect(layers).toHaveLength(0);
  });

  it("MAJOR (collection): places a label whose source tile is OFF the active roster at its scene position, not the origin", () => {
    // A collection with labels on two different tiles. The near tile (D/3/0) is in
    // the active roster; the far tile (M/13/0) is not — it renders as a group
    // proxy or is off-view, so its tile member is absent from `members`.
    const near = image("collection:image:D/3/0", [340, 348], [1, 1], "Uint32", "collection:tile:D/3/0");
    const far = image("collection:image:M/13/0", [340, 348], [1, 1], "Uint32", "collection:tile:M/13/0");
    const dsm: DatasetManifest = {
      dataset_id: "collection", name: "collection",
      kind: { Collection: { rows: ["D", "M"], columns: ["3", "13"], positioning_mode: "Derived", has_explicit_positions: false } },
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [near, far],
      labels: [
        { name: "cells", source_image_id: "collection:image:D/3/0", image: image("collection:image:D/3/0:label:cells", [85, 87], [4, 4]) },
        { name: "cells", source_image_id: "collection:image:M/13/0", image: image("collection:image:M/13/0:label:cells", [85, 87], [4, 4]) },
      ],
    };
    // Only the near tile is active; the far tile's placement must come from
    // the scene position map (keyed by the source ENTITY id).
    const roster: MemberRosterEntry[] = [{ imageId: "collection:image:D/3/0", position: [0, 0] }];
    const memberPositions: Record<string, [number, number]> = {
      "collection:tile:D/3/0": [0, 0],
      "collection:tile:M/13/0": [5000, 6000],
    };
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(
      layers,
      dsm,
      roster,
      [{ visible: true, opacity: 0.5 }, { visible: true, opacity: 0.5 }],
      memberPositions,
    );
    expect(layers).toHaveLength(2);
    const d3 = layers.find((l) => l.datasetId === "collection:image:D/3/0:label:cells");
    const m13 = layers.find((l) => l.datasetId === "collection:image:M/13/0:label:cells");
    // In-roster label uses its roster position; off-roster label uses the scene
    // position — NOT [0, 0], which would stack it on the first group (the bug).
    expect([d3?.offsetX, d3?.offsetY]).toEqual([0, 0]);
    expect([m13?.offsetX, m13?.offsetY]).toEqual([5000, 6000]);
  });
});
