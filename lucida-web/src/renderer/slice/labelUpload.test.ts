import { describe, it, expect, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02 };

import type { WorkerCtx } from "../workerContext.ts";
import type { LabelSliceChunkDataMessage } from "../workerProtocol.ts";
import { createInitialState } from "../worker/state.ts";
import { handleLabelSliceChunkData } from "./upload.ts";

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
  return { device, state: createInitialState() } as unknown as WorkerCtx;
}

/** A pre-sliced 2x2 Z-plane message (the delivery path extracts one plane). */
function labelPlaneMsg(plane: Uint32Array): LabelSliceChunkDataMessage {
  return {
    type: "labelSliceChunkData",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    memberId: "img-0:label:region-b",
    chunks: [{ data: plane.buffer as ArrayBuffer, dataType: "Uint32", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
    level: 0,
    t: 0,
    c: 0,
    levelWidth: 2,
    levelHeight: 2,
    chunkX: 2,
    chunkY: 2,
  };
}

describe("handleLabelSliceChunkData", () => {
  it("writes a pre-sliced uint32 plane to a per-member pool without truncating ids", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    const plane = new Uint32Array([0, 92801, 92801 + 65536, 4_294_967_295]);

    handleLabelSliceChunkData(ctx, labelPlaneMsg(plane));

    expect(ctx.state.labelSlicePools.has("img-0:label:region-b")).toBe(true);
    const pool = ctx.state.labelSlicePools.get("img-0:label:region-b")!;
    expect(pool.width).toBe(2);
    expect(pool.height).toBe(2);

    expect(writes).toHaveLength(1);
    const written = new Uint32Array(writes[0].buffer);
    expect(written[0]).toBe(0);
    expect(written[1]).toBe(92801); // full 32-bit id survives
  });

  it("reuses the pool IN PLACE across Z steps (never blanks)", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Z=5 plane, then Z=6 plane — same dims, different ids.
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    const poolAfterZ5 = ctx.state.labelSlicePools.get("img-0:label:region-b");
    const textureZ5 = poolAfterZ5?.texture;

    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([5, 6, 7, 8])));
    const poolAfterZ6 = ctx.state.labelSlicePools.get("img-0:label:region-b");

    // Same pool + same texture object: overwritten in place, not destroyed
    // + recreated (which would blank the overlay mid-scrub).
    expect(poolAfterZ6).toBe(poolAfterZ5);
    expect(poolAfterZ6!.texture).toBe(textureZ5);
    expect(writes).toHaveLength(2);
    // The second (new-Z) plane was written.
    expect(new Uint32Array(writes[1].buffer)[0]).toBe(5);
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
    const pool = ctx.state.labelSlicePools.get("img-0:label:region-b")!;
    expect(pool.width).toBeLessThanOrEqual(64);
    expect(pool.height).toBeLessThanOrEqual(64);
    expect(writes).toHaveLength(1);
  });

  it("drops a stale-epoch delivery so it can't overwrite the pool with an old T/Z", () => {
    const writes: WriteTextureCall[] = [];
    const ctx = makeCtx(writes);
    // Worker has advanced to selection epoch 5; the delivery is from epoch 1.
    ctx.state.currentEpochs = { content: 1, layout: 1, view: 1, selection: 5, asset: 0, request: 1 };
    handleLabelSliceChunkData(ctx, labelPlaneMsg(new Uint32Array([1, 2, 3, 4])));
    expect(writes).toHaveLength(0);
    expect(ctx.state.labelSlicePools.has("img-0:label:region-b")).toBe(false);
  });
});
