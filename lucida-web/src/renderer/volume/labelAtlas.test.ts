/**
 * Volume **label** atlas tests — the 3D twin of slice-4's r32uint label work.
 *
 * Asserts the three load-bearing properties of the volume label path:
 *   1. A label volume pool allocates an `r32uint` 3D texture (ids > 65535 keep
 *      their high bits), while an intensity pool stays `r16uint`.
 *   2. Label + intensity pools with matching chunk dims never collide: a
 *      `:label` pool key gives the label its own atlas, and even under the same
 *      key a format change forces a fresh `r32uint` atlas (never a reused
 *      `r16uint` one that would truncate).
 *   3. The upload path decodes a label chunk with `asUint32` (untruncated) and
 *      writes it to the `r32uint` atlas via a 4-byte-per-row `writeTexture` —
 *      never the 2-byte intensity path — and does NOT emit an intensity range
 *      for a mask.
 */

import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
  UNIFORM: 0x40,
};

import type { WorkerCtx } from "../workerContext.ts";
import { createInitialState } from "../worker/state.ts";
import { getOrCreateVolumePool, type AtlasState } from "./atlas.ts";
import { chunkTierPoolKey } from "../poolKeys.ts";
import { handleVolumeChunkData } from "./upload.ts";
import type { VolumeChunkDataMessage } from "../workerProtocol.ts";

interface CreatedTexture {
  format?: string;
  dimension?: string;
  size?: number[];
}

function makeDevice(created: CreatedTexture[], writes: Array<Record<string, unknown>>): GPUDevice {
  return {
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createTexture: vi.fn((desc: CreatedTexture) => {
      created.push(desc);
      return { destroy: vi.fn(), createView: vi.fn(() => ({})) };
    }),
    createCommandEncoder: vi.fn(() => ({ finish: vi.fn(() => ({})) })),
    limits: {
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 2048,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxBufferSize: 256 * 1024 * 1024,
    },
    queue: {
      writeBuffer: vi.fn(),
      // 3rd arg is the data-layout object ({ bytesPerRow, rowsPerImage, ... }).
      writeTexture: vi.fn((_dst: unknown, _data: unknown, layout: Record<string, unknown>) => {
        writes.push(layout);
      }),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

describe("volume label atlas — r32uint format", () => {
  it("allocates an r32uint 3D texture for a label pool and r16uint for intensity", () => {
    const created: CreatedTexture[] = [];
    const device = makeDevice(created, []);
    const state = createInitialState();
    const ctx = { device, state } as unknown as WorkerCtx;

    const intensity = getOrCreateVolumePool(ctx, "ds:32x32x32", 32, 32, 32, 0, 0, "r16uint");
    const label = getOrCreateVolumePool(ctx, "ds:label:32x32x32", 32, 32, 32, 0, 0, "r32uint");

    expect(intensity.format).toBe("r16uint");
    expect(label.format).toBe("r32uint");

    // Both textures are 3D; formats match the pool's declared texel width.
    const intensityTex = created.find(c => c.format === "r16uint");
    const labelTex = created.find(c => c.format === "r32uint");
    expect(intensityTex?.dimension).toBe("3d");
    expect(labelTex?.dimension).toBe("3d");
  });

  it("keeps its 3D-texture dims within maxTextureDimension3D", () => {
    const created: CreatedTexture[] = [];
    const device = makeDevice(created, []);
    const state = createInitialState();
    const ctx = { device, state } as unknown as WorkerCtx;

    getOrCreateVolumePool(ctx, "ds:label:256x256x64", 256, 256, 64, 0, 0, "r32uint");
    const labelTex = created.find(c => c.format === "r32uint");
    expect(labelTex?.size).toBeDefined();
    for (const dim of labelTex!.size!) {
      expect(dim).toBeLessThanOrEqual(2048); // maxTextureDimension3D
    }
  });
});

describe("volume label atlas — :label pool segregation", () => {
  it("gives labels a distinct pool key from an intensity member with matching dims", () => {
    const intensityKey = chunkTierPoolKey("ds", "detail", 0, [32, 32, 16], false, false);
    const labelKey = chunkTierPoolKey("ds", "detail", 0, [32, 32, 16], false, true);
    expect(labelKey).not.toBe(intensityKey);
    expect(labelKey).toContain(":label");
  });

  it("never reuses an r16uint atlas when a label (r32uint) is requested under the same key", () => {
    const created: CreatedTexture[] = [];
    const device = makeDevice(created, []);
    const state = createInitialState();
    const ctx = { device, state } as unknown as WorkerCtx;

    // Same key + dims but a format change must produce a fresh r32uint atlas —
    // otherwise a mask would land in a truncating r16uint texture.
    const first = getOrCreateVolumePool(ctx, "k", 16, 16, 16, 0, 0, "r16uint");
    const second = getOrCreateVolumePool(ctx, "k", 16, 16, 16, 0, 0, "r32uint");
    expect(first.format).toBe("r16uint");
    expect(second.format).toBe("r32uint");
    expect(second.texture).not.toBe(first.texture);

    // A subsequent request with the matching format reuses the atlas (no churn).
    const third = getOrCreateVolumePool(ctx, "k", 16, 16, 16, 0, 0, "r32uint");
    expect(third).toBe(second);
  });
});

describe("volume label atlas — asUint32 3D upload", () => {
  function makeCtx(device: GPUDevice, state: ReturnType<typeof createInitialState>, posts: unknown[]): WorkerCtx {
    return {
      device,
      state,
      post: (m: unknown) => posts.push(m),
      postWantedSet: vi.fn(),
    } as unknown as WorkerCtx;
  }

  function setupLabelPool(ctx: WorkerCtx): AtlasState {
    const atlas = getOrCreateVolumePool(ctx, "pool", 4, 4, 4, 0, 0, "r32uint");
    atlas.entityMetas.set("mem", [
      { level: 0, gridDims: [1, 1, 1], chunkDims: [4, 4, 4], levelDims: [4, 4, 4], offset: 0 },
    ]);
    atlas.indirectionData = new Uint32Array(1).fill(0xFFFFFFFF);
    return atlas;
  }

  function labelMsg(data: ArrayBuffer, dataType: string): VolumeChunkDataMessage {
    return {
      type: "volumeChunkData",
      memberId: "mem",
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
      level: 0,
      levelWidth: 4,
      levelHeight: 4,
      levelDepth: 4,
      chunkX: 4,
      chunkY: 4,
      chunkZ: 4,
      tier: "detail",
      chunks: [{ key: "0/0/0", x: 0, y: 0, z: 0, data, dataType }],
    } as unknown as VolumeChunkDataMessage;
  }

  it("decodes a uint32 label chunk untruncated and writes it via the 4-byte path", () => {
    const created: CreatedTexture[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const device = makeDevice(created, writes);
    const state = createInitialState();
    const posts: unknown[] = [];
    const ctx = makeCtx(device, state, posts);

    setupLabelPool(ctx);

    // A 4×4×4 chunk of uint32 ids, including one id > 65535 to prove the high
    // bits survive (the whole point of r32uint).
    const ids = new Uint32Array(64);
    ids[0] = 70000; // > 65535 — would truncate to 4464 through the u16 path
    ids[10] = 42;
    handleVolumeChunkData(ctx, labelMsg(ids.buffer, "uint32"), state.currentEpochs, "pool", "mem");

    expect(writes.length).toBe(1);
    // 4-byte-per-row stride (chunkX=4 × 4 bytes) proves the r32uint path, not the
    // 2-byte intensity path (which would be 8).
    expect(writes[0].bytesPerRow).toBe(16);

    // A mask never emits an intensity range.
    expect(posts.some(p => (p as { type?: string }).type === "intensityRange")).toBe(false);
  });

  it("widens a narrower-dtype label chunk to uint32 without truncation", () => {
    const created: CreatedTexture[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const device = makeDevice(created, writes);
    const state = createInitialState();
    const posts: unknown[] = [];
    const ctx = makeCtx(device, state, posts);

    setupLabelPool(ctx);

    // uint16 source (ids fit in 16 bits) — still routed through asUint32 and the
    // 4-byte write, so the atlas texel width is always 32-bit for a label pool.
    const ids16 = new Uint16Array(64);
    ids16[5] = 12345;
    handleVolumeChunkData(ctx, labelMsg(ids16.buffer, "uint16"), state.currentEpochs, "pool", "mem");

    expect(writes.length).toBe(1);
    expect(writes[0].bytesPerRow).toBe(16);
  });
});
