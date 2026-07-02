/**
 * Tests for `dispatchChunk` + `dispatchProxy`.
 *
 * Both helpers thinly wrap RenderClient methods; the test surface is
 * "given a delivery + meta, the right client method is called with the
 * right positional arguments." No counter accounting / tracker writes
 * happen here — those live at the caller (the run*Pass helpers).
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ReadyChunkDelivery,
  ReadyProxyDelivery,
} from "../../fetch/index.ts";
import type { RenderClient } from "../../../renderer/renderClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { dispatchChunk, dispatchProxy } from "./dispatch.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import type { ImageSpec } from "../../../manifestTypes.ts";

const EPOCHS: SceneEpochs = {
  content: 1,
  layout: 1,
  view: 1,
  selection: 1,
  asset: 0,
  request: 1,
};

function makeImage(): ImageSpec {
  return {
    image_id: "img-0",
    owner: "img-0",
    multiscale: {
      axes: [],
      data_type: "uint16",
      levels: [
        {
          level_index: 0,
          shape: [1, 1, 4, 1024, 1024],
          chunk_shape: [1, 1, 2, 256, 256],
          grid_shape: [1, 1, 2, 4, 4],
          scale: [1, 1, 1, 1, 1],
        },
        {
          level_index: 1,
          shape: [1, 1, 2, 512, 512],
          chunk_shape: [1, 1, 1, 256, 256],
          grid_shape: [1, 1, 2, 2, 2],
          scale: [1, 1, 2, 2, 2],
        },
      ],
    },
  };
}

function makeMeta(): ManifestEntry {
  const image = makeImage();
  return {
    datasetId: "ds1",
    manifest: {
      dataset_id: "ds1",
      name: "ds1",
      kind: "Single",
      entities: [],
      transforms: [],
      images: [image],
      source_layouts: [],
      default_layout_id: null,
    } as unknown as ManifestEntry["manifest"],
    image,
    levels: image.multiscale.levels,
  };
}

function makeChunkDelivery(
  overrides: Partial<ReadyChunkDelivery> = {},
): ReadyChunkDelivery {
  return {
    kind: "chunk",
    entityId: "field-0",
    imageId: "img-0",
    level: 1,
    t: 0,
    c: 0,
    z: 1,
    y: 2,
    x: 3,
    chunkKey: "1/0/0/1/2/3",
    data: new ArrayBuffer(128),
    dataType: "uint16",
    epochs: EPOCHS,
    lane: "detail",
    ...overrides,
  };
}

function makeProxyDelivery(
  overrides: Partial<ReadyProxyDelivery> = {},
): ReadyProxyDelivery {
  return {
    kind: "proxy",
    datasetId: "ds1",
    entityId: "field-0",
    imageId: "img-0",
    proxyKind: "FieldProxy3D",
    t: 0,
    c: 0,
    header: {
      algorithmVersion: 1,
      sourceContentHash: new Uint8Array(32),
      dims: [4, 4, 4],
      dtype: "u16",
    },
    data: new ArrayBuffer(256),
    epochs: EPOCHS,
    ...overrides,
  };
}

function makeMockClient(): {
  client: RenderClient;
  sliceChunkData: ReturnType<typeof vi.fn>;
  volumeChunkData: ReturnType<typeof vi.fn>;
  proxyAssetData: ReturnType<typeof vi.fn>;
} {
  const sliceChunkData = vi.fn();
  const volumeChunkData = vi.fn();
  const proxyAssetData = vi.fn();
  return {
    client: {
      sliceChunkData,
      volumeChunkData,
      proxyAssetData,
    } as unknown as RenderClient,
    sliceChunkData,
    volumeChunkData,
    proxyAssetData,
  };
}

// ---------------------------------------------------------------------------
// dispatchChunk
// ---------------------------------------------------------------------------

describe("dispatchChunk", () => {
  it("slice mode calls sliceChunkData with derived level / chunk shape", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ level: 1 });
    const { client, sliceChunkData, volumeChunkData } = makeMockClient();

    dispatchChunk(client, delivery, meta, "slice", "img-0", 7, EPOCHS);

    expect(volumeChunkData).not.toHaveBeenCalled();
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    const call = sliceChunkData.mock.calls[0];
    // Positional layout:
    // (workerMemberId, [chunkData], level, z, t, c,
    //  levelWidth, levelHeight, chunkX, chunkY, chunkZ,
    //  fullResDepth, levelDepth, fullResZ, epochs)
    expect(call[0]).toBe("img-0");
    expect(call[1]).toHaveLength(1);
    expect(call[1][0]).toEqual({
      data: delivery.data,
      dataType: delivery.dataType,
      x: 3, y: 2, z: 1,
      key: "1/0/0/1/2/3",
    });
    expect(call[2]).toBe(1); // level
    expect(call[3]).toBe(7); // sliceZ argument
    expect(call[4]).toBe(0); // t
    expect(call[5]).toBe(0); // c
    // Level 1 shape = [1,1,2,512,512]; width=512, height=512
    expect(call[6]).toBe(512);
    expect(call[7]).toBe(512);
    // Level 1 chunk_shape = [1,1,1,256,256]; chunkX=256, chunkY=256, chunkZ=1
    expect(call[8]).toBe(256);
    expect(call[9]).toBe(256);
    expect(call[10]).toBe(1);
    // fullResDepth = level 0 shape[Z] = 4
    expect(call[11]).toBe(4);
    // levelDepth = level 1 shape[Z] = 2
    expect(call[12]).toBe(2);
    expect(call[13]).toBe(7); // fullResZ === sliceZ
    expect(call[14]).toBe(EPOCHS);
  });

  it("volume mode calls volumeChunkData with the right positional args", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ level: 0 });
    const { client, sliceChunkData, volumeChunkData } = makeMockClient();

    dispatchChunk(client, delivery, meta, "volume", "img-0", null, EPOCHS);

    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(volumeChunkData).toHaveBeenCalledTimes(1);
    const call = volumeChunkData.mock.calls[0];
    // (workerMemberId, [chunkData], level, t, c,
    //  levelWidth, levelHeight, levelDepth,
    //  chunkX, chunkY, chunkZ, epochs)
    expect(call[0]).toBe("img-0");
    expect(call[2]).toBe(0); // level
    expect(call[3]).toBe(0); // t
    expect(call[4]).toBe(0); // c
    // Level 0 shape = [1,1,4,1024,1024]
    expect(call[5]).toBe(1024); // levelWidth
    expect(call[6]).toBe(1024); // levelHeight
    expect(call[7]).toBe(4);    // levelDepth
    // Level 0 chunk_shape = [1,1,2,256,256]
    expect(call[8]).toBe(256);  // chunkX
    expect(call[9]).toBe(256);  // chunkY
    expect(call[10]).toBe(2);   // chunkZ
    expect(call[11]).toBe(EPOCHS);
  });

  it("missing level meta is a no-op (defensive — caller should pre-filter)", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ level: 99 });
    const { client, sliceChunkData, volumeChunkData } = makeMockClient();

    dispatchChunk(client, delivery, meta, "slice", "img-0", 0, EPOCHS);

    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(volumeChunkData).not.toHaveBeenCalled();
  });

  it("multi-channel composite workerMemberId is passed through verbatim", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ c: 2 });
    const { client, volumeChunkData } = makeMockClient();

    dispatchChunk(client, delivery, meta, "volume", "img-0:ch2", null, EPOCHS);

    expect(volumeChunkData.mock.calls[0][0]).toBe("img-0:ch2");
    expect(volumeChunkData.mock.calls[0][4]).toBe(2); // c
  });
});

// ---------------------------------------------------------------------------
// dispatchProxy
// ---------------------------------------------------------------------------

describe("dispatchProxy", () => {
  it("calls proxyAssetData with destructured delivery fields", () => {
    const delivery = makeProxyDelivery();
    const { client, proxyAssetData } = makeMockClient();

    dispatchProxy(client, delivery, EPOCHS);

    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(proxyAssetData).toHaveBeenCalledWith(
      "ds1",
      "field-0",
      "img-0",
      "FieldProxy3D",
      0,
      0,
      [4, 4, 4],
      delivery.data,
      EPOCHS,
    );
  });

  it("forwards WellProxy3D kind as-is", () => {
    const delivery = makeProxyDelivery({ proxyKind: "WellProxy3D", entityId: "well-1" });
    const { client, proxyAssetData } = makeMockClient();

    dispatchProxy(client, delivery, EPOCHS);

    expect(proxyAssetData.mock.calls[0][1]).toBe("well-1");
    expect(proxyAssetData.mock.calls[0][3]).toBe("WellProxy3D");
  });
});
