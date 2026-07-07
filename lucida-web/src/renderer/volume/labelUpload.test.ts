import { describe, it, expect, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02 };

import type { WorkerCtx } from "../workerContext.ts";
import type { LabelVolumeChunkDataMessage } from "../workerProtocol.ts";
import { createInitialState } from "../worker/state.ts";
import { handleLabelVolumeChunkData } from "./upload.ts";
import { destroyAllVolumeResources, removeVolumeResources } from "./index.ts";

interface WriteTextureCall {
  origin: [number, number, number] | undefined;
  buffer: ArrayBuffer;
  bytesPerRow: number;
  rowsPerImage: number | undefined;
  size: number[];
}

function makeCtx(writes: WriteTextureCall[], maxDim = 2048): WorkerCtx {
  const device = {
    limits: { maxTextureDimension3D: maxDim },
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(
        (
          dest: { origin?: [number, number, number] },
          buffer: ArrayBuffer,
          layout: { bytesPerRow: number; rowsPerImage?: number },
          size: number[],
        ) => {
          writes.push({
            origin: dest.origin,
            buffer,
            bytesPerRow: layout.bytesPerRow,
            rowsPerImage: layout.rowsPerImage,
            size,
          });
        },
      ),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
  return { device, state: createInitialState() } as unknown as WorkerCtx;
}

/** A single WHOLE 3D chunk message (the delivery path forwards the full chunk). */
function labelVolumeMsg(
  ids: Uint32Array,
  dims: { levelWidth: number; levelHeight: number; levelDepth: number; chunkX: number; chunkY: number; chunkZ: number },
  chunk: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): LabelVolumeChunkDataMessage {
  return {
    type: "labelVolumeChunkData",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    memberId: "img-0:label:region-b",
    datasetId: "ds-0",
    chunks: [{ data: ids.buffer as ArrayBuffer, dataType: "Uint32", x: chunk.x, y: chunk.y, z: chunk.z, key: `0/0/0/${chunk.z}/${chunk.y}/${chunk.x}` }],
    level: 0,
    t: 0,
    c: 0,
    ...dims,
  };
}

const DIMS_2 = { levelWidth: 2, levelHeight: 2, levelDepth: 2, chunkX: 2, chunkY: 2, chunkZ: 2 };

describe("handleLabelVolumeChunkData", () => {
  it("writes a WHOLE uint32 3D chunk to a per-member pool without truncating ids", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // 2x2x2 = 8 ids, including two past the 16-bit range.
    const ids = new Uint32Array([0, 92801, 92801 + 65536, 4_294_967_295, 5, 6, 7, 8]);

    handleLabelVolumeChunkData(ctx, labelVolumeMsg(ids, DIMS_2));

    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(true);
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    expect(pool.width).toBe(2);
    expect(pool.height).toBe(2);
    expect(pool.depth).toBe(2);

    expect(writes).toHaveLength(1);
    // 4 bytes/voxel (r32uint), full depth written in one call.
    expect(writes[0].bytesPerRow).toBe(2 * 4);
    expect(writes[0].rowsPerImage).toBe(2);
    expect(writes[0].size).toEqual([2, 2, 2]);
    expect(writes[0].origin).toEqual([0, 0, 0]);
    const written = new Uint32Array(writes[0].buffer);
    expect(written[1]).toBe(92801); // full 32-bit id survives
    expect(written[2]).toBe(92801 + 65536);
    expect(written[3]).toBe(4_294_967_295);
  });

  it("reuses the pool IN PLACE across T steps (never blanks)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2));
    const poolAfterT0 = ctx.state.labelVolumePools.get("img-0:label:region-b");
    const textureT0 = poolAfterT0?.texture;

    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([9, 10, 11, 12, 13, 14, 15, 16]), DIMS_2));
    const poolAfterT1 = ctx.state.labelVolumePools.get("img-0:label:region-b");

    // Same pool + same texture object: overwritten in place, not destroyed +
    // recreated (which would blank the overlay mid-scrub).
    expect(poolAfterT1).toBe(poolAfterT0);
    expect(poolAfterT1!.texture).toBe(textureT0);
    expect(writes).toHaveLength(2);
    expect(new Uint32Array(writes[1].buffer)[0]).toBe(9);
  });

  it("places a chunk at its (x, y, z) grid offset", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // A 4x4x4 volume in 2³ chunks; write the far (1,1,1) chunk.
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(
      new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]),
      { levelWidth: 4, levelHeight: 4, levelDepth: 4, chunkX: 2, chunkY: 2, chunkZ: 2 },
      { x: 1, y: 1, z: 1 },
    ));
    expect(writes).toHaveLength(1);
    expect(writes[0].origin).toEqual([2, 2, 2]); // chunk (1,1,1) * chunk dims (2,2,2)
    expect(writes[0].size).toEqual([2, 2, 2]);
  });

  it("clamps the pool texture to the device's max 3D dimension", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes, 64); // tiny device limit
    // A 128³ volume on a 64-limited device: the pool clamps, and a chunk
    // beyond the clamped extent is skipped (no out-of-bounds throw).
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(
      new Uint32Array(2 * 2 * 2),
      { levelWidth: 128, levelHeight: 128, levelDepth: 128, chunkX: 2, chunkY: 2, chunkZ: 2 },
      { x: 40, y: 0, z: 0 }, // xOff = 80 >= clamped width 64 → skipped
    ));
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    expect(pool.width).toBeLessThanOrEqual(64);
    expect(pool.height).toBeLessThanOrEqual(64);
    expect(pool.depth).toBeLessThanOrEqual(64);
    expect(writes).toHaveLength(0); // the out-of-range chunk was clamped out
  });

  it("stamps the owning dataset id on the pool (so removal can free it)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2));
    expect(ctx.state.labelVolumePools.get("img-0:label:region-b")!.datasetId).toBe("ds-0");
  });

  it("drops a stale-epoch delivery so it can't overwrite the pool with an old T", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Worker has advanced to selection epoch 5; the delivery is from epoch 1.
    ctx.state.currentEpochs = { content: 1, layout: 1, view: 1, selection: 5, asset: 0, request: 1 };
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2));
    expect(writes).toHaveLength(0);
    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(false);
  });

  it("skips the label (no throw, no pool) when the texture can't be allocated", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Simulate an allocation failure (out-of-budget device).
    (ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("out of memory");
    });
    expect(() => handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2))).not.toThrow();
    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe("label volume pool cleanup on dataset removal", () => {
  it("frees the label pool keyed by image id when its DATASET is removed", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2));
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    const destroyed = pool.texture.destroy as unknown as ReturnType<typeof vi.fn>;

    // removeLayerResources passes the DATASET id ("ds-0"), which is NOT the
    // pool's key ("img-0:label:region-b") — the leak was the lookup missing here.
    removeVolumeResources(ctx, "ds-0");

    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(false);
    expect(destroyed).toHaveBeenCalled(); // the (large) 3D texture is freed
  });

  it("does NOT free a label pool belonging to a different dataset", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2));
    removeVolumeResources(ctx, "some-other-dataset");
    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(true);
  });

  it("destroyAllVolumeResources frees every label volume pool", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), DIMS_2));
    destroyAllVolumeResources(ctx);
    expect(ctx.state.labelVolumePools.size).toBe(0);
  });
});
