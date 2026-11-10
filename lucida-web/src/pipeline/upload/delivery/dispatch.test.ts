/**
 * Tests for `dispatchChunkDelivery`: given a delivery and its level meta, the
 * right client method is called with the right positional arguments and the
 * bytes it carries. Counter accounting lives at the caller.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReadyChunkDelivery } from "../../fetch/index.ts";
import type { RenderClient } from "../../../renderer/renderClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { dispatchChunkDelivery } from "./dispatch.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import type { ImageSpec } from "../../../manifestTypes.ts";

const EPOCHS: SceneEpochs = {
  content: 1,
  layout: 1,
  view: 1,
  selection: 1,
  request: 1,
};

const PLANE = 256 * 256;

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

/** A level-0 chunk two planes deep, each plane filled with its index plus one. */
function twoPlaneChunk(): ArrayBuffer {
  const samples = new Uint16Array(2 * PLANE);
  samples.fill(1, 0, PLANE);
  samples.fill(2, PLANE);
  return samples.buffer;
}

function makeChunkDelivery(
  overrides: Partial<ReadyChunkDelivery> = {},
): ReadyChunkDelivery {
  return {
    entityId: "tile-0",
    imageId: "img-0",
    level: 0,
    t: 0,
    c: 0,
    z: 1,
    y: 2,
    x: 3,
    chunkKey: "0/0/0/1/2/3",
    data: twoPlaneChunk(),
    dataType: "uint16",
    epochs: EPOCHS,
    lane: "detail",
    residencyTier: "detail",
    mode: "slice",
    ...overrides,
  };
}

/**
 * A client whose `sliceChunkData` transfers each plane, as the real post
 * does, so a plane reads empty afterwards. `posted` keeps a copy of each.
 */
function makeMockClient(): {
  client: RenderClient;
  sliceChunkData: ReturnType<typeof vi.fn>;
  volumeChunkData: ReturnType<typeof vi.fn>;
  posted: ArrayBuffer[];
} {
  const posted: ArrayBuffer[] = [];
  const sliceChunkData = vi.fn((_memberId: string, chunks: { data: ArrayBuffer }[]) => {
    for (const chunk of chunks) posted.push(chunk.data.slice(0));
    structuredClone(chunks.map((chunk) => chunk.data), { transfer: chunks.map((chunk) => chunk.data) });
  });
  const volumeChunkData = vi.fn();
  return {
    client: {
      sliceChunkData,
      volumeChunkData,
    } as unknown as RenderClient,
    sliceChunkData,
    volumeChunkData,
    posted,
  };
}

describe("dispatchChunkDelivery", () => {
  it("sends the slice view only the plane its Z maps to, copied out of the cache's chunk", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery();
    const { client, sliceChunkData, volumeChunkData, posted } = makeMockClient();

    // Level 0 is as deep as full resolution, so z 3 is plane 1 of chunk 1.
    const sent = dispatchChunkDelivery(client, delivery, meta, "slice", { axis: "z", index: 3 }, EPOCHS);

    expect(volumeChunkData).not.toHaveBeenCalled();
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    const call = sliceChunkData.mock.calls[0];
    // Positional layout:
    // (workerMemberId, [chunkData], level, z, t, c,
    //  levelWidth, levelHeight, chunkX, chunkY, chunkZ,
    //  fullResDepth, levelDepth, fullResZ, epochs, tier)
    expect(call[0]).toBe("img-0:ch0");
    expect(call[1]).toHaveLength(1);
    expect(call[1][0]).toMatchObject({ dataType: "uint16", x: 3, y: 2, z: 1, key: "0/0/0/1/2/3" });
    expect(posted[0].byteLength).toBe(PLANE * 2);
    expect(new Uint16Array(posted[0]).every((v) => v === 2)).toBe(true);
    // The cache keeps its whole chunk for the next delivery.
    expect(delivery.data.byteLength).toBe(2 * PLANE * 2);
    expect(call[2]).toBe(0); // level
    expect(call[3]).toBe(3); // sliceZ argument
    expect(call[4]).toBe(0); // t
    expect(call[5]).toBe(0); // c
    expect(call[6]).toBe(1024); // levelWidth
    expect(call[7]).toBe(1024); // levelHeight
    expect(call[8]).toBe(256); // chunkX
    expect(call[9]).toBe(256); // chunkY
    expect(call[10]).toBe(2); // chunkZ
    expect(call[11]).toBe(4); // fullResDepth
    expect(call[12]).toBe(4); // levelDepth
    expect(call[13]).toBe(3); // fullResZ === sliceZ
    expect(call[14]).toBe(EPOCHS);
    expect(call[15]).toBe("detail");
    expect(sent).toEqual({ memberId: "img-0:ch0", bytes: PLANE * 2 });
  });

  it("maps a full-resolution Z onto a level downsampled along Z", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ level: 1, data: new Uint16Array(PLANE).fill(5).buffer });
    const { client, sliceChunkData } = makeMockClient();

    // Level 1 is 2 planes deep: z 3 lands on its plane 1, chunk 1.
    const sent = dispatchChunkDelivery(client, delivery, meta, "slice", { axis: "z", index: 3 }, EPOCHS);

    expect(sent).toEqual({ memberId: "img-0:ch0", bytes: PLANE * 2 });
    expect(sliceChunkData.mock.calls[0][12]).toBe(2); // levelDepth
  });

  it("posts nothing for a chunk that does not hold the plane", () => {
    const meta = makeMeta();
    const { client, sliceChunkData } = makeMockClient();

    // z 1 is in chunk 0; the delivery is chunk 1.
    expect(dispatchChunkDelivery(client, makeChunkDelivery(), meta, "slice", { axis: "z", index: 1 }, EPOCHS)).toBe("other-plane");
    expect(sliceChunkData).not.toHaveBeenCalled();
  });

  it("posts nothing for a chunk too short to hold the plane", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ data: new ArrayBuffer(PLANE * 2) });
    const { client, sliceChunkData } = makeMockClient();

    expect(dispatchChunkDelivery(client, delivery, meta, "slice", { axis: "z", index: 3 }, EPOCHS)).toBe("no-meta");
    expect(sliceChunkData).not.toHaveBeenCalled();
  });

  it("cuts the plane out of a delivery that holds some planes of the chunk", () => {
    const meta = makeMeta();
    // Plane 1 of chunk 1 alone, filled with 7.
    const delivery = makeChunkDelivery({ data: new Uint16Array(PLANE).fill(7).buffer, planes: [1, 2] });
    const { client, posted } = makeMockClient();

    expect(dispatchChunkDelivery(client, delivery, meta, "slice", { axis: "z", index: 3 }, EPOCHS)).toEqual({
      memberId: "img-0:ch0",
      bytes: PLANE * 2,
    });
    expect(new Uint16Array(posted[0]).every((v) => v === 7)).toBe(true);
  });

  it("posts nothing from planes that leave out the one the view draws", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ data: new Uint16Array(PLANE).buffer, planes: [0, 1] });
    const { client, sliceChunkData, volumeChunkData } = makeMockClient();

    // z 3 is plane 1 of chunk 1, which the delivery does not hold.
    expect(dispatchChunkDelivery(client, delivery, meta, "slice", { axis: "z", index: 3 }, EPOCHS)).toBe("other-plane");
    // Nor are planes a chunk to the volume view.
    expect(dispatchChunkDelivery(client, delivery, meta, "volume", null, EPOCHS)).toBe("other-plane");
    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(volumeChunkData).not.toHaveBeenCalled();
  });

  it("sends the volume view the whole chunk", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery();
    const { client, sliceChunkData, volumeChunkData } = makeMockClient();

    const sent = dispatchChunkDelivery(client, delivery, meta, "volume", null, EPOCHS);

    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(volumeChunkData).toHaveBeenCalledTimes(1);
    const call = volumeChunkData.mock.calls[0];
    // (workerMemberId, [chunkData], level, t, c,
    //  levelWidth, levelHeight, levelDepth,
    //  chunkX, chunkY, chunkZ, epochs, tier)
    expect(call[0]).toBe("img-0:ch0");
    expect(call[1][0].data).toBe(delivery.data);
    expect(call[2]).toBe(0); // level
    expect(call[3]).toBe(0); // t
    expect(call[4]).toBe(0); // c
    expect(call[5]).toBe(1024); // levelWidth
    expect(call[6]).toBe(1024); // levelHeight
    expect(call[7]).toBe(4);    // levelDepth
    expect(call[8]).toBe(256);  // chunkX
    expect(call[9]).toBe(256);  // chunkY
    expect(call[10]).toBe(2);   // chunkZ
    expect(call[11]).toBe(EPOCHS);
    expect(sent).toEqual({ memberId: "img-0:ch0", bytes: delivery.data.byteLength });
  });

  it("missing level meta posts nothing (defensive — caller should pre-filter)", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ level: 99 });
    const { client, sliceChunkData, volumeChunkData } = makeMockClient();

    expect(dispatchChunkDelivery(client, delivery, meta, "slice", { axis: "z", index: 0 }, EPOCHS)).toBe("no-meta");

    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(volumeChunkData).not.toHaveBeenCalled();
  });

  it("names each channel its own worker member", () => {
    const meta = makeMeta();
    const delivery = makeChunkDelivery({ c: 2 });
    const { client, volumeChunkData } = makeMockClient();

    dispatchChunkDelivery(client, delivery, meta, "volume", null, EPOCHS);

    expect(volumeChunkData.mock.calls[0][0]).toBe("img-0:ch2");
    expect(volumeChunkData.mock.calls[0][4]).toBe(2); // c
  });

  it("cuts a side view's plane along Y or X out of every row it crosses, laid out across and down", () => {
    const meta = makeMeta();
    // Two Z planes of 256 x 256: each sample holds 1000 z + y, or 1000 z + x.
    const rows = new Uint16Array(2 * PLANE);
    const columns = new Uint16Array(2 * PLANE);
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          rows[(z * 256 + y) * 256 + x] = 1000 * z + y;
          columns[(z * 256 + y) * 256 + x] = 1000 * z + x;
        }
      }
    }

    // An XZ cut at Y 517 is row 5 of the chunk at grid y 2.
    const xz = makeMockClient();
    const sent = dispatchChunkDelivery(
      xz.client, makeChunkDelivery({ data: rows.buffer }), meta, "slice", { axis: "y", index: 517 }, EPOCHS,
    );
    expect(sent).toEqual({ memberId: "img-0:ch0", bytes: 2 * 256 * 2 });
    const plane = new Uint16Array(xz.posted[0]);
    expect([plane[0], plane[255], plane[256], plane[511]]).toEqual([5, 5, 1005, 1005]);
    const args = xz.sliceChunkData.mock.calls[0];
    // The chunk's place and the level's geometry across, down and along the cut.
    expect(args[1][0]).toMatchObject({ x: 3, y: 1, z: 2, key: "0/0/0/1/2/3" });
    expect(args.slice(6, 14)).toEqual([1024, 4, 256, 2, 256, 1024, 1024, 517]);

    // A YZ cut at X 770 is column 2 of the chunk at grid x 3: Y across.
    const yz = makeMockClient();
    dispatchChunkDelivery(
      yz.client, makeChunkDelivery({ data: columns.buffer }), meta, "slice", { axis: "x", index: 770 }, EPOCHS,
    );
    const side = new Uint16Array(yz.posted[0]);
    expect([side[0], side[255], side[256]]).toEqual([2, 2, 1002]);
    expect(yz.sliceChunkData.mock.calls[0][1][0]).toMatchObject({ x: 2, y: 1, z: 3 });

    // A plane in another chunk along the cut is not this chunk's to send.
    const other = makeMockClient();
    expect(dispatchChunkDelivery(
      other.client, makeChunkDelivery(), meta, "slice", { axis: "y", index: 100 }, EPOCHS,
    )).toBe("other-plane");
  });

  it("cuts a side view's plane from rows it fetched, and refuses planes along another axis", () => {
    const meta = makeMeta();
    // Rows 4 to 6 of the chunk, two Z planes each: row r holds 1000 z + r.
    const band = new Uint16Array(2 * 2 * 256);
    for (let z = 0; z < 2; z++) {
      for (let r = 0; r < 2; r++) band.fill(1000 * z + 4 + r, (z * 2 + r) * 256, (z * 2 + r + 1) * 256);
    }
    const held = makeMockClient();
    dispatchChunkDelivery(
      held.client,
      makeChunkDelivery({ data: band.buffer, planes: [4, 6], planeAxis: "y" }),
      meta, "slice", { axis: "y", index: 517 }, EPOCHS,
    );
    const plane = new Uint16Array(held.posted[0]);
    expect([plane[0], plane[256]]).toEqual([5, 1005]);

    const zPlanes = makeMockClient();
    expect(dispatchChunkDelivery(
      zPlanes.client, makeChunkDelivery({ data: band.buffer, planes: [0, 1] }),
      meta, "slice", { axis: "y", index: 517 }, EPOCHS,
    )).toBe("other-plane");
  });
});
