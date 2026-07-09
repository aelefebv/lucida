import { describe, it, expect, vi } from "vitest";
import { pushLabelVolumeLayers, type LabelVolumeScene } from "./volumePath.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberRosterEntry } from "./pipeline/tickCoordinator.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "./manifestTypes.ts";

function image(id: string, yx: [number, number], scaleYX: [number, number], dtype = "Uint32"): ImageSpec {
  return {
    image_id: id,
    owner: "ent-0",
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
    dataset_id: "ds-0", name: "volume", kind: "Single",
    entities: [], transforms: [], source_layouts: [], default_layout_id: null,
    images: [image("img-0", [340, 348], [1, 1])],
    labels,
  };
}

// Column-major matrices. Identity keeps the unit cube on-screen through the
// identity viewProj (so `computeScissorRect` returns a rect, not null).
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// A distinctive inverse so the test can prove it is forwarded verbatim.
const INV_MARK = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);

function makeScene(model = IDENTITY, inv = INV_MARK): LabelVolumeScene {
  return {
    member_model_matrix: vi.fn(() => model),
    inv_member_model_matrix: vi.fn(() => inv),
  };
}

const members: MemberRosterEntry[] = [{ imageId: "img-0", position: [0, 0] }];

describe("pushLabelVolumeLayers", () => {
  it("emits every eligible label layer by default, each a first-hit surface", () => {
    const scene = makeScene();
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(
      layers,
      scene,
      "ds-0",
      manifest([
        labelSpec("region-b", "img-0:label:region-b"),
        labelSpec("foreground", "img-0:label:fg"),
      ]),
      members,
      IDENTITY,
      800,
      600,
    );
    expect(layers.map((l) => l.datasetId)).toEqual([
      "img-0:label:region-b",
      "img-0:label:fg",
    ]);
    const layer = layers[0];
    expect(layer.isLabel).toBe(true);
    expect(layer.blendMode).toBe("alpha");
    expect(layer.renderMode).toBe("translucent");
    expect(layer.opacity).toBeCloseTo(0.5);
    expect(layer.entityIndex).toBe(0);
    expect(layer.scissorRect).toBeDefined();
    expect(layers.every((l) => l.isLabel)).toBe(true);
  });

  it("places the overlay at the SOURCE member's model matrix (+ inverse)", () => {
    const scene = makeScene();
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(layers, scene, "ds-0", manifest([labelSpec("region-b", "img-0:label:region-b")]), members, IDENTITY, 800, 600);
    // Matrices are copied from the SOURCE image's placement, not the label's.
    expect(Array.from(layers[0].modelMatrix!)).toEqual(Array.from(IDENTITY));
    expect(Array.from(layers[0].invModelMatrix!)).toEqual(Array.from(INV_MARK));
    expect(scene.member_model_matrix).toHaveBeenCalledWith("ds-0", "img-0");
    expect(scene.inv_member_model_matrix).toHaveBeenCalledWith("ds-0", "img-0");
  });

  it("uses a synthesized member's own matrices when present (group-as-proxy path)", () => {
    const scene = makeScene();
    const ownModel = new Float32Array([3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1]);
    const ownInv = new Float32Array([5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1]);
    const membersWithMatrices: MemberRosterEntry[] = [
      { imageId: "img-0", position: [0, 0], modelMatrix: ownModel, invModelMatrix: ownInv },
    ];
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(layers, scene, "ds-0", manifest([labelSpec("region-b", "img-0:label:region-b")]), membersWithMatrices, IDENTITY, 800, 600);
    // Same-extent label (85·4 == 340, 87·4 == 348) → the roster's matrices
    // pass through by value (copied, then scaled by identity ratios).
    expect(Array.from(layers[0].modelMatrix!)).toEqual(Array.from(ownModel));
    expect(Array.from(layers[0].invModelMatrix!)).toEqual(Array.from(ownInv));
    // The scene wasn't consulted — the roster carried the matrices.
    expect(scene.member_model_matrix).not.toHaveBeenCalled();
  });

  it("forwards declared image-label.colors to the layer", () => {
    const colors: LabelSpec["colors"] = [{ value: 2, rgba: [230, 25, 75, 255] }];
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(layers, makeScene(), "ds-0", manifest([labelSpec("region-b", "img-0:label:region-b", colors)]), members, IDENTITY, 800, 600);
    expect(layers[0].labelColors).toEqual(colors);
  });

  it("respects the per-label visible set + opacity", () => {
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(
      layers,
      makeScene(),
      "ds-0",
      manifest([labelSpec("a", "img-0:label:a"), labelSpec("b", "img-0:label:b"), labelSpec("c", "img-0:label:c")]),
      members,
      IDENTITY,
      800,
      600,
      [
        { visible: true, opacity: 0.3 },
        { visible: false, opacity: 0.5 },
        { visible: true, opacity: 0.8 },
      ],
    );
    expect(layers.map((l) => l.datasetId)).toEqual(["img-0:label:a", "img-0:label:c"]);
    expect(layers.map((l) => l.opacity)).toEqual([0.3, 0.8]);
  });

  it("emits nothing for a label-less manifest", () => {
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(layers, makeScene(), "ds-0", manifest([]), members, IDENTITY, 800, 600);
    expect(layers).toHaveLength(0);
  });

  it("skips a non-uint32 (uint8) label and renders the uint32 sibling", () => {
    const layers: VolumeLayerParams[] = [];
    pushLabelVolumeLayers(
      layers,
      makeScene(),
      "ds-0",
      manifest([
        labelSpec("mask8", "img-0:label:mask8", undefined, "Uint8"),
        labelSpec("seg32", "img-0:label:seg32"),
      ]),
      members,
      IDENTITY,
      800,
      600,
    );
    expect(layers).toHaveLength(1);
    expect(layers[0].datasetId).toBe("img-0:label:seg32");
  });
});
