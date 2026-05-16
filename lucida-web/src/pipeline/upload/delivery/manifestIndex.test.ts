/**
 * Tests for `buildManifestByImage`.
 *
 * The index is built once per `deliverToWorker` tick from `ctx.datasets`
 * and looked up per chunk during dispatch. Eliminates the per-chunk
 * O(D × I) manifest scan in the old `sendDeliveryToWorker`.
 */
import { describe, it, expect } from "vitest";
import type { DatasetManifest, ImageSpec } from "../../../manifestTypes.ts";
import type { DatasetEntry } from "../../../renderLoopTypes.ts";
import { buildManifestByImage } from "./manifestIndex.ts";

function makeImage(imageId: string): ImageSpec {
  return {
    image_id: imageId,
    owner: imageId,
    multiscale: {
      axes: [],
      data_type: "uint16",
      levels: [
        {
          level_index: 0,
          shape: [1, 1, 1, 1024, 1024],
          chunk_shape: [1, 1, 1, 256, 256],
          grid_shape: [1, 1, 1, 4, 4],
          scale: [1, 1, 1, 1, 1],
        },
        {
          level_index: 1,
          shape: [1, 1, 1, 512, 512],
          chunk_shape: [1, 1, 1, 256, 256],
          grid_shape: [1, 1, 1, 2, 2],
          scale: [1, 1, 1, 2, 2],
        },
      ],
    },
  };
}

function makeManifest(datasetId: string, images: ImageSpec[]): DatasetManifest {
  return {
    dataset_id: datasetId,
    name: datasetId,
    kind: "Single",
    entities: [],
    transforms: [],
    images,
    source_layouts: [],
    default_layout_id: null,
  } as unknown as DatasetManifest;
}

describe("buildManifestByImage", () => {
  it("single dataset with one image — index has one entry pointing at the right shapes", () => {
    const img = makeImage("img-0");
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: makeManifest("ds1", [img]) }],
    ]);

    const out = buildManifestByImage(datasets);

    expect(out.size).toBe(1);
    const entry = out.get("img-0");
    expect(entry).toBeDefined();
    expect(entry!.manifest.dataset_id).toBe("ds1");
    expect(entry!.image).toBe(img);
    expect(entry!.levels).toBe(img.multiscale.levels);
    expect(entry!.levels[0].shape).toEqual([1, 1, 1, 1024, 1024]);
  });

  it("multi-dataset / multi-image — index keyed by image_id, every image present", () => {
    const imgA = makeImage("img-a");
    const imgB = makeImage("img-b");
    const imgC = makeImage("img-c");
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: makeManifest("ds1", [imgA, imgB]) }],
      ["ds2", { manifest: makeManifest("ds2", [imgC]) }],
    ]);

    const out = buildManifestByImage(datasets);

    expect(out.size).toBe(3);
    expect(out.get("img-a")!.manifest.dataset_id).toBe("ds1");
    expect(out.get("img-b")!.manifest.dataset_id).toBe("ds1");
    expect(out.get("img-c")!.manifest.dataset_id).toBe("ds2");
  });

  it("image not in any dataset — no entry, get() returns undefined", () => {
    const img = makeImage("img-0");
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: makeManifest("ds1", [img]) }],
    ]);

    const out = buildManifestByImage(datasets);

    expect(out.has("img-ghost")).toBe(false);
    expect(out.get("img-ghost")).toBeUndefined();
  });
});
