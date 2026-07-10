import { describe, it, expect, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02 };

import type { WorkerCtx } from "../workerContext.ts";
import type { LabelVolumeChunkDataMessage } from "../workerProtocol.ts";
import type { Chunk } from "../workerProtocol.ts";
import { createInitialState } from "../worker/state.ts";
import { VOLUME_ATLAS_BUDGET } from "../workerProtocol.ts";
import { handleLabelVolumeChunkData } from "./upload.ts";
import { computeLabelVolumeSizing } from "./atlas.ts";
import { destroyAllVolumeResources, removeVolumeResources } from "./index.ts";

const SENTINEL = 0xffffffff;

interface WriteTextureCall {
  origin: [number, number, number] | undefined;
  buffer: ArrayBuffer;
  bytesPerRow: number;
  rowsPerImage: number | undefined;
  size: number[];
}

interface BufferWriteCall {
  buffer: unknown;
  data: Uint32Array;
}

function makeCtx(
  writes: WriteTextureCall[],
  maxDim = 2048,
  textureSizes: number[][] = [],
  bufferWrites: BufferWriteCall[] = [],
): WorkerCtx {
  const device = {
    limits: { maxTextureDimension3D: maxDim },
    createTexture: vi.fn((desc: { size: number[] }) => {
      textureSizes.push(desc.size);
      return { destroy: vi.fn(), createView: vi.fn(() => ({})) };
    }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    queue: {
      writeBuffer: vi.fn((buffer: unknown, _offset: number, data: ArrayBufferView) => {
        bufferWrites.push({ buffer, data: new Uint32Array((data as Uint32Array).slice()) });
      }),
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

interface Dims {
  levelWidth: number; levelHeight: number; levelDepth: number;
  chunkX: number; chunkY: number; chunkZ: number;
}

function mkChunk(ids: Uint32Array, x: number, y: number, z: number): Chunk {
  return {
    data: ids.buffer as ArrayBuffer,
    dataType: "Uint32",
    x, y, z,
    key: `0/0/0/${z}/${y}/${x}`,
  } as Chunk;
}

/** A message with one or more WHOLE 3D chunks for one label overlay member. */
function labelVolumeMsg(chunks: Chunk[], dims: Dims): LabelVolumeChunkDataMessage {
  return {
    type: "labelVolumeChunkData",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    memberId: "img-0:label:region-b",
    datasetId: "ds-0",
    chunks,
    level: 0,
    t: 0,
    c: 0,
    ...dims,
  };
}

const DIMS_2 = { levelWidth: 2, levelHeight: 2, levelDepth: 2, chunkX: 2, chunkY: 2, chunkZ: 2 };
const DIMS_4 = { levelWidth: 4, levelHeight: 4, levelDepth: 4, chunkX: 2, chunkY: 2, chunkZ: 2 };

describe("handleLabelVolumeChunkData", () => {
  it("writes a WHOLE uint32 3D chunk to a bricked pool without truncating ids", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // 2x2x2 = 8 ids, including two past the 16-bit range.
    const ids = new Uint32Array([0, 92801, 92801 + 65536, 4_294_967_295, 5, 6, 7, 8]);

    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(ids, 0, 0, 0)], DIMS_2));

    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(true);
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    // Level extent (for the descriptor / ray mapping).
    expect(pool.width).toBe(2);
    expect(pool.height).toBe(2);
    expect(pool.depth).toBe(2);
    // Single-cell grid → one brick.
    expect([pool.gridX, pool.gridY, pool.gridZ]).toEqual([1, 1, 1]);
    expect([pool.chunkX, pool.chunkY, pool.chunkZ]).toEqual([2, 2, 2]);

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

    // The single cell's indirection entry names its slot.
    expect(pool.indirectionData.length).toBe(1);
    expect(pool.indirectionData[0]).toBe(0);
  });

  it("reuses the pool IN PLACE across T steps (never blanks)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2));
    const poolAfterT0 = ctx.state.labelVolumePools.get("img-0:label:region-b");
    const textureT0 = poolAfterT0?.texture;

    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([9, 10, 11, 12, 13, 14, 15, 16]), 0, 0, 0)], DIMS_2));
    const poolAfterT1 = ctx.state.labelVolumePools.get("img-0:label:region-b");

    // Same pool + same texture object: overwritten in place, not destroyed +
    // recreated (which would blank the overlay mid-scrub).
    expect(poolAfterT1).toBe(poolAfterT0);
    expect(poolAfterT1!.texture).toBe(textureT0);
    expect(writes).toHaveLength(2);
    expect(new Uint32Array(writes[1].buffer)[0]).toBe(9);
    // The cell reuses its own slot on the scrub (no eviction churn).
    expect(poolAfterT1!.indirectionData[0]).toBe(0);
  });

  it("routes each chunk to a distinct slot via its indirection entry", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // A 4x4x4 volume in 2³ chunks → a 2×2×2 = 8-cell grid.
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(
      [
        mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0),
        mkChunk(new Uint32Array([9, 10, 11, 12, 13, 14, 15, 16]), 1, 1, 1),
      ],
      DIMS_4,
    ));
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    expect([pool.gridX, pool.gridY, pool.gridZ]).toEqual([2, 2, 2]);
    expect(pool.indirectionData.length).toBe(8);

    // Cell (0,0,0) → gridIdx 0; cell (1,1,1) → gridIdx 7.
    const slot0 = pool.indirectionData[0];
    const slot7 = pool.indirectionData[7];
    expect(slot0).not.toBe(SENTINEL);
    expect(slot7).not.toBe(SENTINEL);
    // Distinct chunks land in distinct slots — a shared slot would alias ids.
    expect(slot0).not.toBe(slot7);
    // Every cell NOT delivered stays sentinel (absent).
    for (const gi of [1, 2, 3, 4, 5, 6]) {
      expect(pool.indirectionData[gi]).toBe(SENTINEL);
    }

    // Each write lands at its slot's origin (NOT the chunk's grid offset).
    expect(writes).toHaveLength(2);
    const originForSlot = (s: number): [number, number, number] => [
      (s % pool.slotsX) * pool.chunkX,
      (Math.floor(s / pool.slotsX) % pool.slotsY) * pool.chunkY,
      Math.floor(s / (pool.slotsX * pool.slotsY)) * pool.chunkZ,
    ];
    expect(writes[0].origin).toEqual(originForSlot(slot0));
    expect(writes[1].origin).toEqual(originForSlot(slot7));
  });

  it("keeps a within-budget level's whole chunk grid resident (no sentinels)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Deliver every cell of the 2×2×2 grid.
    const chunks: Chunk[] = [];
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++)
          chunks.push(mkChunk(new Uint32Array(8).fill(1), x, y, z));
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(chunks, DIMS_4));

    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    expect(pool.indirectionData.length).toBe(8);
    // All 8 cells resident, each in a distinct slot, no eviction.
    const resident = new Set<number>();
    for (let gi = 0; gi < 8; gi++) {
      const slot = pool.indirectionData[gi];
      expect(slot).not.toBe(SENTINEL);
      resident.add(slot);
    }
    expect(resident.size).toBe(8);
    expect(writes).toHaveLength(8);
  });

  it("sizes the atlas so no axis exceeds the device's max 3D dimension", () => {
    const writes: WriteTextureCall[] = [];
    const textureSizes: number[][] = [];
    const ctx = makeCtx(writes, 64, textureSizes); // tiny device limit
    // A 128³ volume in 2³ chunks (a 64³ = 262144-cell grid) on a 64-limited
    // device: the slot grid repacks so every atlas axis stays <= 64.
    handleLabelVolumeChunkData(ctx, labelVolumeMsg(
      [mkChunk(new Uint32Array(2 * 2 * 2), 40, 0, 0)],
      { levelWidth: 128, levelHeight: 128, levelDepth: 128, chunkX: 2, chunkY: 2, chunkZ: 2 },
    ));
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    // Atlas texture: every axis within the device limit.
    expect(textureSizes).toHaveLength(1);
    for (const axis of textureSizes[0]) expect(axis).toBeLessThanOrEqual(64);
    // Slot grid dims agree with the created texture.
    expect(pool.slotsX * pool.chunkX).toBeLessThanOrEqual(64);
    expect(pool.slotsY * pool.chunkY).toBeLessThanOrEqual(64);
    expect(pool.slotsZ * pool.chunkZ).toBeLessThanOrEqual(64);
    // The (in-grid) chunk was placed in a slot (bricking, unlike a monolithic
    // texture, has room for a cell far from the origin).
    expect(writes).toHaveLength(1);
  });

  it("stamps the owning dataset id on the pool (so removal can free it)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2));
    expect(ctx.state.labelVolumePools.get("img-0:label:region-b")!.datasetId).toBe("ds-0");
  });

  it("drops a stale-epoch delivery so it can't overwrite the pool with an old T", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Worker has advanced to selection epoch 5; the delivery is from epoch 1.
    ctx.state.currentEpochs = { content: 1, layout: 1, view: 1, selection: 5, asset: 0, request: 1 };
    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2));
    expect(writes).toHaveLength(0);
    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(false);
  });

  it("skips the label (no throw, no pool) when the atlas can't be allocated", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Simulate an allocation failure (out-of-budget device).
    (ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("out of memory");
    });
    expect(() => handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2))).not.toThrow();
    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe("label volume pool cleanup on dataset removal", () => {
  it("frees the label pool keyed by image id when its DATASET is removed", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2));
    const pool = ctx.state.labelVolumePools.get("img-0:label:region-b")!;
    const destroyed = pool.texture.destroy as unknown as ReturnType<typeof vi.fn>;

    // removeLayerResources passes the DATASET id ("ds-0"), which is NOT the
    // pool's key ("img-0:label:region-b") — the leak was the lookup missing here.
    removeVolumeResources(ctx, "ds-0");

    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(false);
    expect(destroyed).toHaveBeenCalled(); // the (large) 3D atlas is freed
  });

  it("does NOT free a label pool belonging to a different dataset", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2));
    removeVolumeResources(ctx, "some-other-dataset");
    expect(ctx.state.labelVolumePools.has("img-0:label:region-b")).toBe(true);
  });

  it("destroyAllVolumeResources frees every label volume pool", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelVolumeChunkData(ctx, labelVolumeMsg([mkChunk(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), 0, 0, 0)], DIMS_2));
    destroyAllVolumeResources(ctx);
    expect(ctx.state.labelVolumePools.size).toBe(0);
  });
});

describe("computeLabelVolumeSizing", () => {
  it("sizes the atlas to the WHOLE grid for an eligible level whose PADDED bricks bust the byte budget", () => {
    // A real downsampled level: the chunk shape does not evenly divide the
    // extent (the norm), so padding the boundary bricks pushes the PADDED total
    // (gridCellCount * paddedChunkBytes) over the 512 MB budget while the TRUE
    // (unpadded) volume still fits it. Sizing the atlas on padded bytes would
    // leave fewer slots than grid cells, evicting delivered bricks and punching
    // transparent holes where real data exists — the atlas must hold the whole
    // grid instead.
    const w = 1088, h = 1024, d = 120, chunk = 128, maxDim = 2048;
    const s = computeLabelVolumeSizing(w, h, d, chunk, chunk, chunk, maxDim);

    // The TRUE volume fits the budget (this is why the level is eligible)...
    expect(w * h * d * 4).toBeLessThanOrEqual(VOLUME_ATLAS_BUDGET);
    // ...but the PADDED bricks would exceed it — so a byte-budget clamp on the
    // padded total would under-provision the atlas.
    const paddedBytes = s.gridCellCount * s.chunkX * s.chunkY * s.chunkZ * 4;
    expect(paddedBytes).toBeGreaterThan(VOLUME_ATLAS_BUDGET);

    // Residency invariant: capacity is the whole grid, never clamped to bytes.
    expect(s.capacity).toBe(s.gridCellCount);
    // A slot for every grid cell -> no eviction -> no holes.
    expect(s.totalSlots).toBeGreaterThanOrEqual(s.gridCellCount);
    // Still within the device 3D texture limit on every axis.
    for (const axis of s.textureSize) expect(axis).toBeLessThanOrEqual(maxDim);
  });

  it("holds the whole grid for an anisotropic level whose chunks don't divide the extent", () => {
    // 768x640x48 in 128x128x16 chunks: none of the axes divide evenly, so every
    // boundary brick is padded. The whole 6x5x3 grid must still stay resident.
    const s = computeLabelVolumeSizing(768, 640, 48, 128, 128, 16, 2048);
    expect([s.gridX, s.gridY, s.gridZ]).toEqual([6, 5, 3]);
    expect(s.gridCellCount).toBe(90);
    expect(s.capacity).toBe(90);
    expect(s.totalSlots).toBeGreaterThanOrEqual(90);
    for (const axis of s.textureSize) expect(axis).toBeLessThanOrEqual(2048);
  });

  it("clamps a coarse declared chunk to the level extent (one cell, one slot)", () => {
    // A small level with a chunk_shape larger than the extent collapses to a
    // single in-bounds brick — never an oversized slot a monolithic texture
    // would reject.
    const s = computeLabelVolumeSizing(64, 48, 10, 128, 128, 128, 2048);
    expect([s.chunkX, s.chunkY, s.chunkZ]).toEqual([64, 48, 10]);
    expect([s.gridX, s.gridY, s.gridZ]).toEqual([1, 1, 1]);
    expect(s.gridCellCount).toBe(1);
    expect(s.capacity).toBe(1);
    expect(s.totalSlots).toBeGreaterThanOrEqual(1);
    expect(s.textureSize).toEqual([64, 48, 10]);
  });
});
