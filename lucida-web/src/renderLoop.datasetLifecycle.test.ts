import { describe, expect, it, vi } from "vitest";
import type { DatasetManifest } from "./manifestTypes.ts";
import { ProxiedContentSource } from "./pipeline/fetch/contentSource.ts";
import { RenderLoop } from "./renderLoop.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { Session } from "./session.ts";

function image(imageId: string, owner: string, dataType: string) {
  return {
    image_id: imageId,
    owner,
    multiscale: {
      axes: [],
      data_type: dataType,
      levels: [{
        level_index: 0,
        shape: [1, 1, 1, 2, 2],
        chunk_shape: [1, 1, 1, 2, 2],
        grid_shape: [1, 1, 1, 1, 1],
        scale: [1, 1, 1, 1, 1],
      }],
    },
  };
}

function labeledManifest(): DatasetManifest {
  const sourceA = image("collection:image:A", "tile-A", "Uint16");
  const sourceB = image("collection:image:B", "tile-B", "Uint16");
  return {
    dataset_id: "collection",
    name: "collection-labels.ome.zarr",
    kind: "Single",
    entities: [],
    transforms: [],
    images: [sourceA, sourceB],
    labels: [{
      name: "regions",
      source_image_id: sourceB.image_id,
      image: image("collection:image:B:label:regions", "tile-B", "Uint32"),
    }],
    source_layouts: [],
    default_layout_id: null,
  };
}

describe("RenderLoop dataset lifecycle", () => {
  it("unregisters both intensity and sparse label image descriptors on removal", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const cancelDataset = vi.fn();
    const contentSource = new ProxiedContentSource(() => true, () => {});
    contentSource.registerImage(
      "collection",
      "collection:image:A",
      { Raw: { data_type: "Uint16" } },
    );
    contentSource.registerImage(
      "collection",
      "collection:image:B",
      { Raw: { data_type: "Uint16" } },
    );
    contentSource.registerImage(
      "collection",
      "collection:image:B:label:regions",
      { Raw: { data_type: "Uint32" } },
    );
    const session = {
      cpuCache: {
        subscribe: vi.fn(() => vi.fn()),
        cancelDataset,
      },
      contentSource,
      scene: null,
    } as unknown as Session;
    const client = {
      removeLayerResources: vi.fn(),
      resize: vi.fn(),
      sliceRenderMultiPass: vi.fn(),
      cancelUnsubmittedFrameExpectations: vi.fn(),
    } as unknown as RenderClient;
    const canvas = {
      width: 400,
      height: 300,
      clientWidth: 400,
      clientHeight: 300,
    } as HTMLCanvasElement;
    const datasets = new Map([
      ["collection", { manifest: labeledManifest() }],
    ]);
    const loop = new RenderLoop({ session, datasets, client, canvas, mode: "slice" });

    try {
      loop.removeDataset("collection");

      expect(cancelDataset).toHaveBeenCalledWith("collection");
      const signal = new AbortController().signal;
      for (const imageId of [
        "collection:image:A",
        "collection:image:B",
        "collection:image:B:label:regions",
      ]) {
        await expect(contentSource.fetch({
          datasetId: "collection",
          imageId,
          chunkKey: "0/0/0/0/0/0",
          expectedResponseBytes: 8,
        }, signal)).rejects.toThrow(`No wire format registered for image ${imageId}`);
      }
    } finally {
      loop.stop();
      vi.unstubAllGlobals();
    }
  });
});
