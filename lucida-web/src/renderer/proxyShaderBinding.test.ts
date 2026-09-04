/**
 * Pure-TS tests covering the bridge between `proxyAtlas.ts` and the
 * shaders' proxy sampling math. We can't run WGSL in vitest, but the
 * critical invariants we DO want to lock down are:
 *
 *   1. The shader's 3-D slot-origin math agrees with the TS-side
 *      `proxySlotOrigin()` (which is what gpu.worker.ts uses to decide
 *      where to write proxy uploads).
 *
 * The renderers' per-frame `Uniforms` layouts are locked against the
 * shaders in `descriptor/layout.test.ts`.
 */

import { describe, it, expect } from "vitest";

// Polyfill GPUTextureUsage for `createProxyAtlas` in the no-GPU env.
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

import {
  createProxyAtlas,
  allocateProxySlot,
  proxySlotKey,
  proxySlotOrigin,
} from "./proxyAtlas.ts";

// ---------------------------------------------------------------------------
// Mock GPU device (mirrors proxyAtlas.test.ts)
// ---------------------------------------------------------------------------

interface MockTexture {
  destroyed: boolean;
  destroy: () => void;
  size: [number, number, number];
}

function makeMockDevice(maxDim = 2048): GPUDevice {
  const createTexture = (desc: GPUTextureDescriptor): MockTexture => {
    const size = desc.size as number[];
    return {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      size: [size[0], size[1], size[2]],
    };
  };
  return {
    limits: { maxTextureDimension3D: maxDim } as unknown as GPUSupportedLimits,
    createTexture,
    queue: { writeTexture: () => {} } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

// ---------------------------------------------------------------------------
// Shader-side slot-origin recomputation. Mirrors `sampleProxy()` in
// volume.wgsl: dims = vec4u(Z, Y, X, _); grid = textureDims / slotDims.
// ---------------------------------------------------------------------------
function shaderOrigin(
  slotIdx: number,
  dims: [number, number, number],
  textureSize: [number, number, number],
): [number, number, number] {
  const slotsX = Math.max(1, Math.floor(textureSize[0] / dims[2]));
  const slotsY = Math.max(1, Math.floor(textureSize[1] / dims[1]));
  const tileX = slotIdx % slotsX;
  const tileY = Math.floor(slotIdx / slotsX) % slotsY;
  const tileZ = Math.floor(slotIdx / (slotsX * slotsY));
  return [tileX * dims[2], tileY * dims[1], tileZ * dims[0]];
}

describe("proxy slot origin math (shader ↔ proxyAtlas.ts)", () => {
  it("shader's grid origin agrees with proxySlotOrigin()", () => {
    const device = makeMockDevice();
    // Three different shapes to be thorough.
    for (const slotDims of [
      [16, 32, 64] as [number, number, number],
      [8, 8, 8] as [number, number, number],
      [4, 16, 128] as [number, number, number],
    ]) {
      const atlas = createProxyAtlas(device, "TileProxy3D", slotDims, 0, 4);
      const textureSize = (atlas.texture as unknown as MockTexture).size;
      for (let slot = 0; slot < atlas.capacity; slot++) {
        const tsOrigin = proxySlotOrigin(atlas, slot);
        expect(tsOrigin).toEqual(shaderOrigin(slot, slotDims, textureSize));
      }
    }
  });

  it("upload origin (used by gpu.worker.ts) matches shader sampling", () => {
    // gpu.worker.ts: device.queue.writeTexture({ origin }) with
    // origin = proxySlotOrigin(...). The shader then reads from
    // (slot-origin + frac * dims). At frac=(0,0,0) that's exactly the
    // upload origin, so the first voxel uploaded reads back at slot frac
    // (0,0,0).
    const device = makeMockDevice();
    const atlas = createProxyAtlas(device, "GroupProxy3D", [16, 32, 64], 0, 8);
    const slot = allocateProxySlot(atlas, proxySlotKey("entity-0", 0, 0));
    const uploadOrigin = proxySlotOrigin(atlas, slot);
    const shaderReadAtFracZero = shaderOrigin(
      slot,
      atlas.slotDims,
      (atlas.texture as unknown as MockTexture).size,
    );
    expect(uploadOrigin).toEqual(shaderReadAtFracZero);
  });
});
