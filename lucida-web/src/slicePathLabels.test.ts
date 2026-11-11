import { beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";
import { labelPlaneAt, pushLabelLayers } from "./slicePath.ts";
import { IDENTITY_PLANE_MAP } from "./placement.ts";
import { layerCut, readResolvedLayers } from "./resolvedLayers.ts";
import { resolveVisibleLabels } from "./pipeline/planning/labelRequests.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { SlicePlane, SpatialAxis } from "./renderer/slicePlane.ts";
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
    dataset_id: "ds-0", name: "volume", kind: "Single",
    entities: [], transforms: [], source_layouts: [], default_layout_id: null,
    images: [image("img-0", [340, 348], [1, 1])],
    labels,
  };
}

const members: MemberRosterEntry[] = [{ imageId: "img-0", position: [0, 0] }];

/** Explicit all-visible settings of length `n`. Masks are opt-in (hidden by
 *  default), so a test that renders every eligible overlay must turn them on. */
function allOn(n: number): { visible: boolean; opacity: number }[] {
  return Array.from({ length: n }, () => ({ visible: true, opacity: 0.5 }));
}

describe("pushLabelLayers", () => {
  it("emits every eligible label layer when all are on, in manifest order", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(
      layers,
      manifest([
        labelSpec("region-b", "img-0:label:region-b"),
        labelSpec("foreground", "img-0:label:fg"),
        labelSpec("region-a", "img-0:label:region-a"),
      ]),
      members,
      IDENTITY_PLANE_MAP,
      allOn(3),
    );
    expect(layers).toHaveLength(3);
    expect(layers.map((l) => l.datasetId)).toEqual([
      "img-0:label:region-b",
      "img-0:label:fg",
      "img-0:label:region-a",
    ]);
    expect(layers.every((l) => l.isLabel)).toBe(true);
    for (const l of layers) expect(l.opacity).toBeCloseTo(0.5);
  });

  it("aligns the overlay to the source footprint (4x-coarse label → source extent)", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([labelSpec("region-b", "img-0:label:region-b")]), members, IDENTITY_PLANE_MAP, allOn(1));
    expect(layers[0].quad.across[0]).toBeCloseTo(348, 3); // 87 * 4 / 1
    expect(layers[0].quad.down[1]).toBeCloseTo(340, 3);
    expect(layers[0].quad.origin[0]).toBe(0);
    expect(layers[0].quad.origin[1]).toBe(0);
  });

  it("forwards declared image-label.colors to the layer", () => {
    const colors: LabelSpec["colors"] = [{ value: 2, rgba: [230, 25, 75, 255] }];
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([labelSpec("region-b", "img-0:label:region-b", colors)]), members, IDENTITY_PLANE_MAP, allOn(1));
    expect(layers[0].labelColors).toEqual(colors);
  });

  it("emits nothing for a label-less manifest", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([]), members, IDENTITY_PLANE_MAP);
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
      IDENTITY_PLANE_MAP,
      allOn(2),
    );
    expect(layers).toHaveLength(1);
    expect(layers[0].datasetId).toBe("img-0:label:seg32");
  });

  it("MAJOR: renders nothing for a uint8-only label (matches the fetch skip)", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(layers, manifest([labelSpec("mask8", "img-0:label:mask8", undefined, "Uint8")]), members, IDENTITY_PLANE_MAP, allOn(1));
    expect(layers).toHaveLength(0);
  });

  it("MAJOR (collection): places a label whose source tile is OFF the active roster at its scene position, not the origin", () => {
    // Labels on two tiles. The near tile (D/3/0) is in the active roster; the
    // far tile (M/13/0) is off-view, so it is not.
    const near = image("collection:image:D/3/0", [340, 348], [1, 1], "Uint32", "collection:tile:D/3/0");
    const far = image("collection:image:M/13/0", [340, 348], [1, 1], "Uint32", "collection:tile:M/13/0");
    const dsm: DatasetManifest = {
      dataset_id: "collection", name: "collection",
      kind: { Collection: { rows: ["D", "M"], columns: ["3", "13"], positioning_mode: "Derived", has_explicit_positions: false } },
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [near, far],
      labels: [
        { name: "region-c", source_image_id: "collection:image:D/3/0", image: image("collection:image:D/3/0:label:region-c", [85, 87], [4, 4]) },
        { name: "region-c", source_image_id: "collection:image:M/13/0", image: image("collection:image:M/13/0:label:region-c", [85, 87], [4, 4]) },
      ],
    };
    // The far tile's placement must come from the scene position map, keyed by
    // source entity id.
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
      IDENTITY_PLANE_MAP,
      [{ visible: true, opacity: 0.5 }, { visible: true, opacity: 0.5 }],
      memberPositions,
    );
    expect(layers).toHaveLength(2);
    const d3 = layers.find((l) => l.datasetId === "collection:image:D/3/0:label:region-c");
    const m13 = layers.find((l) => l.datasetId === "collection:image:M/13/0:label:region-c");
    // Not [0, 0], which would stack the off-roster label on the first group.
    expect([d3?.quad.origin[0], d3?.quad.origin[1]]).toEqual([0, 0]);
    expect([m13?.quad.origin[0], m13?.quad.origin[1]]).toEqual([5000, 6000]);
  });

  it("places each overlay where its dataset's placement puts the source", () => {
    const layers: SliceLayerParams[] = [];
    pushLabelLayers(
      layers,
      manifest([labelSpec("region-b", "img-0:label:region-b")]),
      [{ imageId: "img-0", position: [10, 20] }],
      { offset: [100, 200], linear: [[0.5, 0], [0, 2]] },
      allOn(1),
    );
    expect(layers).toHaveLength(1);
    expect([layers[0].quad.origin[0], layers[0].quad.origin[1]]).toEqual([105, 240]);
    expect([layers[0].quad.across[0], layers[0].quad.down[1]]).toEqual([348 * 0.5, 340 * 2]);
  });
});

/** A 3D image level: `zyx` samples in `chunk` chunks, each `scale` long along `[z, y, x]`. */
function volumeImage(id: string, zyx: [number, number, number], chunk: number, scale: [number, number, number], dtype: string): ImageSpec {
  const shape = [1, 1, ...zyx];
  const chunkShape = [1, 1, chunk, chunk, chunk];
  return {
    image_id: id,
    owner: "ent-0",
    multiscale: {
      axes: [
        { name: "t", kind: "Time" }, { name: "c", kind: "Channel" },
        { name: "z", kind: "Space" }, { name: "y", kind: "Space" }, { name: "x", kind: "Space" },
      ],
      levels: [{
        level_index: 0,
        shape,
        chunk_shape: chunkShape,
        grid_shape: shape.map((n, i) => Math.ceil(n / chunkShape[i])),
        scale: [1, 1, ...scale],
      }],
      data_type: dtype,
    },
  };
}

describe("a side view's label overlay", () => {
  it("spans the source's extent across and down the plane it cuts", () => {
    // 64 deep, 48 tall, 32 wide, under a label at half the resolution.
    const dsm: DatasetManifest = {
      dataset_id: "ds-0", name: "volume", kind: "Single",
      entities: [], transforms: [], source_layouts: [], default_layout_id: null,
      images: [volumeImage("img-0", [64, 48, 32], 16, [1, 1, 1], "Uint16")],
      labels: [{ name: "regions", source_image_id: "img-0", image: volumeImage("img-0:label", [32, 24, 16], 16, [2, 2, 2], "Uint32") }],
    };
    const spans = (axis: SpatialAxis) => {
      const layers: SliceLayerParams[] = [];
      pushLabelLayers(layers, dsm, members, IDENTITY_PLANE_MAP, allOn(1), undefined, { t: 0, cut: { axis, index: 20 } });
      return { across: layers[0].quad.across[0], down: layers[0].quad.down[1], chunk: layers[0].labelChunk };
    };
    expect(spans("z")).toEqual({ across: 32, down: 48, chunk: { level: 0, t: 0, z: 0, plane: 10 } });
    expect(spans("y")).toEqual({ across: 32, down: 64, chunk: { level: 0, t: 0, z: 0, plane: 10, axis: "y" } });
    expect(spans("x")).toEqual({ across: 48, down: 64, chunk: { level: 0, t: 0, z: 0, plane: 10, axis: "x" } });
  });
});

describe("the plane a label draws under scene-frame places", () => {
  beforeAll(async () => {
    // wasm-bindgen web target: init with the built .wasm bytes (cwd is lucida-web).
    await initWasm({ module_or_path: readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm")) });
  });

  /** A dataset of one 3D image, one micrometer a sample unless `scale` says otherwise, at `origin` (`[z, y, x]`). */
  function placed(
    id: string,
    image: ImageSpec,
    origin: [number, number, number],
    labels: LabelSpec[] = [],
  ): DatasetManifest {
    return {
      dataset_id: id, name: id, kind: "Single",
      entities: [{ id: "ent-0", kind: "Image", parent: null, labels: {} }],
      transforms: [],
      images: [image],
      source_layouts: [{ id: "source", name: "Source positions", placements: [{ entity_id: "ent-0", position: [0, 0] }] }],
      default_layout_id: "source",
      labels,
      space: { units: ["micrometer", "micrometer", "micrometer"], origin },
    } as DatasetManifest;
  }

  it("is the plane of the label's own grid that lines up with the plane of its image the view cuts", () => {
    // A reference at the origin, one micrometer a sample, so the scene's grid
    // steps by one micrometer from there. The labeled image sits 40 deep and
    // 24 down, two micrometers a sample along Z, under a label at half its
    // resolution on every axis.
    const reference = placed("ref", volumeImage("ref-img", [128, 128, 128], 64, [1, 1, 1], "Uint16"), [0, 0, 0]);
    const label: LabelSpec = {
      name: "regions",
      source_image_id: "img-0",
      image: volumeImage("img-0:label", [16, 32, 32], 8, [4, 2, 2], "Uint32"),
    };
    const labeled = placed("ds", volumeImage("img-0", [32, 64, 64], 16, [2, 1, 1], "Uint16"), [40, 24, 0], [label]);
    const scene = new WasmScene(800, 600);
    scene.load_document(JSON.stringify({ manifests: { ref: reference, ds: labeled }, annotations: {} }));
    const run = (command: object) => scene.apply_command(JSON.stringify(command));
    const drawn = (plane: SlicePlane) => {
      const layer = readResolvedLayers(scene, scene.active_view()).get("ds")!;
      const cut = layerCut(layer, plane);
      const [resolved] = resolveVisibleLabels(labeled, allOn(1), { cutAxis: cut.axis });
      return { image: cut.index, label: labelPlaneAt(resolved, { t: 0, cut }) };
    };

    // 60 micrometers deep is the image's plane 10, which the label holds at 5.
    run({ type: "set_z", z: 60 });
    expect(drawn("xy")).toEqual({ image: 10, label: { level: 0, t: 0, z: 0, plane: 5 } });
    // 40 micrometers down is the image's row 16, the label's 8.
    run({ type: "set_slice_plane", plane: "xz" });
    run({ type: "set_y", y: 40 });
    expect(drawn("xz")).toEqual({ image: 16, label: { level: 0, t: 0, z: 1, plane: 8, axis: "y" } });
    // 30 micrometers across is column 30 of both images, the label's 15.
    run({ type: "set_slice_plane", plane: "yz" });
    run({ type: "set_x", x: 30 });
    expect(drawn("yz")).toEqual({ image: 30, label: { level: 0, t: 0, z: 1, plane: 15, axis: "x" } });
  });
});
