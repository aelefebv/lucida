import { describe, it, expect, vi, beforeEach } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02 };

import type { WorkerCtx } from "../workerContext.ts";
import type { LabelSliceChunkDataMessage } from "../workerProtocol.ts";
import { createInitialState } from "../worker/state.ts";
import { handleLabelSliceChunkData } from "./upload.ts";
import { destroyAllSliceResources, removeSliceResources } from "./index.ts";
import { resetLabelSliceAllocWarnings } from "./atlas.ts";
import { clearGpuErrorReports } from "../worker/gpuErrors.ts";
import { labelSlicePoolKey } from "../labelPools.ts";

const MEMBER = "img-0:label:region-b";
/** The pool of the label's plane 0 at T 0, where `labelPlaneMsg` writes by default. */
const KEY = labelSlicePoolKey(MEMBER, 0, 0);
const CUT = { axis: "z", plane: 0 } as const;

interface WriteTextureCall {
  origin: [number, number, number] | undefined;
  buffer: ArrayBuffer;
  bytesPerRow: number;
  size: number[];
}

function makeCtx(writes: WriteTextureCall[], maxDim = 8192): WorkerCtx {
  const device = {
    limits: { maxTextureDimension2D: maxDim },
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve(null)),
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(
        (dest: { origin?: [number, number, number] }, buffer: ArrayBuffer, layout: { bytesPerRow: number }, size: number[]) => {
          writes.push({ origin: dest.origin, buffer, bytesPerRow: layout.bytesPerRow, size });
        },
      ),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
  return { device, state: createInitialState(), post: vi.fn() } as unknown as WorkerCtx;
}

/** A pre-sliced 2x2 Z-plane message (the delivery path extracts one plane), cut at `z`. */
function labelPlaneMsg(plane: Uint32Array, z = 0): LabelSliceChunkDataMessage {
  return {
    type: "labelSliceChunkData",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    memberId: MEMBER,
    datasetId: "ds-0",
    chunks: [{ data: plane.buffer as ArrayBuffer, dataType: "Uint32", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
    level: 0,
    t: 0,
    c: 0,
    levelWidth: 2,
    levelHeight: 2,
    chunkX: 2,
    chunkY: 2,
    plane: z,
  };
}

beforeEach(() => {
  resetLabelSliceAllocWarnings();
});

describe("handleLabelSliceChunkData", () => {
  it("writes a pre-sliced uint32 plane to a per-member pool without truncating ids", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    const plane = new Uint32Array([0, 92801, 92801 + 65536, 4_294_967_295]);

    handleLabelSliceChunkData(ctx, labelPlaneMsg(plane));

    expect(ctx.state.labelSlicePools.has(KEY)).toBe(true);
    const pool = ctx.state.labelSlicePools.get(KEY)!;
    expect(pool.width).toBe(2);
    expect(pool.height).toBe(2);

    expect(writes).toHaveLength(1);
    const written = new Uint32Array(writes[0].buffer);
    expect(written[0]).toBe(0);
    expect(written[1]).toBe(92801); // full 32-bit id survives
  });

  it("writes each plane into the pool of its own form", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    const first = ctx.state.labelSlicePools.get(KEY)!;
    const texture = first.texture;

    // The same form again overwrites its pool in place.
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([5, 6, 7, 8])));
    expect(ctx.state.labelSlicePools.get(KEY)).toBe(first);
    expect(first.texture).toBe(texture);
    expect(new Uint32Array(writes[1].buffer)[0]).toBe(5);

    // Another plane, as a second view cuts it, has a pool of its own.
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([9, 9, 9, 9]), 6));
    const other = ctx.state.labelSlicePools.get(labelSlicePoolKey(MEMBER, 0, 6))!;
    expect(other).not.toBe(first);
    expect(other.texture).not.toBe(texture);
    expect([...ctx.state.labelSlicePools.keys()].sort()).toEqual([KEY, labelSlicePoolKey(MEMBER, 0, 6)]);
  });

  it("reports each chunk it writes held, and the one a rewrite of its cell replaces lost", () => {
    const ctx = makeCtx([]);
    const post = ctx.post as unknown as ReturnType<typeof vi.fn>;

    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array(4)));
    // The next timepoint's chunk lands in the same cell.
    const next = labelPlaneMsg(new Uint32Array(4));
    next.chunks[0].key = "0/1/0/0/0/0";
    handleLabelSliceChunkData(ctx, next);

    const report = { type: "chunkResidency", memberId: MEMBER, viewMode: "slice", tier: "detail", cut: CUT };
    expect(post.mock.calls.map(([msg]) => msg)).toEqual([
      { ...report, change: "held", keys: ["0/0/0/0/0/0"], reason: undefined },
      { ...report, change: "held", keys: ["0/1/0/0/0/0"], reason: undefined },
      { ...report, change: "lost", keys: ["0/0/0/0/0/0"], reason: "replaced" },
    ]);
  });

  it("clamps the pool texture to the device's max 2D dimension", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes, 64); // tiny device limit
    // A 128x128 plane on a 64px-limited device: pool must clamp, and the
    // write is clamped to the resident texture (no out-of-bounds throw).
    handleLabelSliceChunkData(ctx, {
      ...labelPlaneMsg(new Uint32Array(128 * 128)),
      levelWidth: 128,
      levelHeight: 128,
      chunkX: 128,
      chunkY: 128,
    });
    const pool = ctx.state.labelSlicePools.get(KEY)!;
    expect(pool.width).toBeLessThanOrEqual(64);
    expect(pool.height).toBeLessThanOrEqual(64);
    expect(writes).toHaveLength(1);
  });

  it("stamps the owning dataset id on the pool (so removal can free it)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    expect(ctx.state.labelSlicePools.get(KEY)!.datasetId).toBe("ds-0");
  });

  it("drops a stale-epoch delivery so it can't overwrite the pool with an old T/Z", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Worker has advanced to selection epoch 5; the delivery is from epoch 1.
    ctx.state.currentEpochs = { content: 1, layout: 1, view: 1, selection: 5, request: 1 };
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    expect(writes).toHaveLength(0);
    expect(ctx.state.labelSlicePools.has(KEY)).toBe(false);
  });

  it("skips the label (no throw, no pool) when the texture can't be allocated", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Simulate an allocation failure (out-of-budget device).
    (ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("out of memory");
    });
    expect(() => handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])))).not.toThrow();
    expect(ctx.state.labelSlicePools.has(KEY)).toBe(false);
    expect(writes).toHaveLength(0);
    // Refused, so the page does not count the plane as resident.
    expect(ctx.post).toHaveBeenCalledWith({
      type: "chunkResidency",
      memberId: MEMBER,
      viewMode: "slice",
      tier: "detail",
      change: "refused",
      keys: ["0/0/0/0/0/0"],
      reason: "atlas-policy",
      cut: CUT,
    });
  });

  it("refuses a size the device ran out of memory on, without allocating again", async () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    const outOfMemory = { message: "out of memory" } as GPUError;
    (ctx.device.popErrorScope as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve(outOfMemory),
    );
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    expect(ctx.state.labelSlicePools.has(KEY)).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.state.labelSlicePools.has(KEY)).toBe(false);
    expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({ type: "gpuError", kind: "out-of-memory" }));

    const allocations = (ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    expect((ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(allocations);
    expect(ctx.post).toHaveBeenLastCalledWith(expect.objectContaining({ change: "refused", keys: ["0/0/0/0/0/0"] }));
    clearGpuErrorReports(ctx);
  });

  it("destroys the created texture (no orphan) when the indirection buffer alloc fails", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // The texture allocates fine, but the indirection buffer alloc throws —
    // the partial-alloc path must free the already-created texture rather
    // than leaking it on the GPU.
    const textureDestroy = vi.fn();
    (ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      destroy: textureDestroy,
      createView: vi.fn(() => ({})),
    }));
    (ctx.device.createBuffer as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("out of memory");
    });

    expect(() => handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])))).not.toThrow();
    expect(ctx.state.labelSlicePools.has(KEY)).toBe(false);
    expect(writes).toHaveLength(0);
    expect(textureDestroy).toHaveBeenCalled();
  });
});

describe("label slice pool cleanup on dataset removal", () => {
  it("frees the label pool keyed by image id when its DATASET is removed", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    const pool = ctx.state.labelSlicePools.get(KEY)!;
    const destroyed = pool.texture.destroy as unknown as ReturnType<typeof vi.fn>;

    // removeLayerResources passes the dataset id ("ds-0"), which is not in
    // the pool's key.
    removeSliceResources(ctx, "ds-0");

    expect(ctx.state.labelSlicePools.has(KEY)).toBe(false);
    expect(destroyed).toHaveBeenCalled(); // the label texture is freed
  });

  it("does NOT free a label pool belonging to a different dataset", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    removeSliceResources(ctx, "some-other-dataset");
    expect(ctx.state.labelSlicePools.has(KEY)).toBe(true);
  });

  it("destroyAllSliceResources frees every label slice pool", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    destroyAllSliceResources(ctx);
    expect(ctx.state.labelSlicePools.size).toBe(0);
  });
});
