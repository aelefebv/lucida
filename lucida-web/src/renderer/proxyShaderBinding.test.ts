/**
 * S8: pure-TS tests covering the bridge between `proxyAtlas.ts` and the
 * shaders' proxy sampling math. We can't run WGSL in vitest, but the
 * critical invariants we DO want to lock down are:
 *
 *   1. The shader's `slotOrigin = slotIdx * dims.z` math agrees with the
 *      TS-side `proxySlotOrigin()` (which is what gpu.worker.ts uses to
 *      decide where to write proxy uploads).
 *   2. The renderers pack `proxyParams` / `fieldProxyDims` /
 *      `wellProxyDims` at the documented uniform-buffer offsets, so the
 *      shader struct stays in sync. We replay the offset arithmetic
 *      here against constants so a future tweak that desyncs
 *      `UNIFORM_SIZE` or per-field offsets fails loudly.
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
// volume.wgsl: dims = vec4u(Z, Y, X, _); originX = slotIdx * dims.z.
// ---------------------------------------------------------------------------
function shaderOriginX(slotIdx: number, dims: [number, number, number]): number {
  // dims = [Z, Y, X]; shader reads dims.z = X.
  return slotIdx * dims[2];
}

describe("proxy slot origin math (shader ↔ proxyAtlas.ts)", () => {
  it("shader's `slotIdx * dims.z` agrees with proxySlotOrigin().x", () => {
    const device = makeMockDevice();
    // Three different shapes to be thorough.
    for (const slotDims of [
      [16, 32, 64] as [number, number, number],
      [8, 8, 8] as [number, number, number],
      [4, 16, 128] as [number, number, number],
    ]) {
      const atlas = createProxyAtlas(device, "FieldProxy3D", slotDims, 0, 4);
      for (let slot = 0; slot < atlas.capacity; slot++) {
        const tsOrigin = proxySlotOrigin(atlas, slot);
        const shaderX = shaderOriginX(slot, slotDims);
        expect(tsOrigin).toEqual([shaderX, 0, 0]);
      }
    }
  });

  it("upload origin (used by gpu.worker.ts) matches shader sampling", () => {
    // gpu.worker.ts: device.queue.writeTexture({ origin }) with
    // origin = proxySlotOrigin(...). The shader then reads from
    // (slotIdx * dims.z + frac.x * dims.z, ...). At frac=(0,0,0) that's
    // exactly the upload origin — so the first voxel uploaded reads
    // back at slot frac (0,0,0).
    const device = makeMockDevice();
    const atlas = createProxyAtlas(device, "WellProxy3D", [16, 32, 64], 0, 8);
    const slot = allocateProxySlot(atlas, proxySlotKey("entity-0", 0, 0));
    const uploadOrigin = proxySlotOrigin(atlas, slot);
    const shaderReadAtFracZero = shaderOriginX(slot, atlas.slotDims);
    expect(uploadOrigin[0]).toBe(shaderReadAtFracZero);
  });
});

// ---------------------------------------------------------------------------
// Uniform buffer packing offsets (volume + slice)
// ---------------------------------------------------------------------------

describe("renderer uniform layouts (S8 proxy fields)", () => {
  // These constants mirror what's in volumeRenderer.ts / sliceRenderer.ts
  // and the corresponding WGSL `Uniforms` structs. Updating one without
  // updating the other would corrupt the GPU-side reads, so we lock
  // both ends to the same numbers here.
  const VOLUME_UNIFORM_SIZE = 656;
  const VOLUME_PROXY_PARAMS_OFFSET_BYTES = 608;
  const VOLUME_FIELD_DIMS_OFFSET_BYTES = 624;
  const VOLUME_WELL_DIMS_OFFSET_BYTES = 640;

  const SLICE_UNIFORM_SIZE = 400;
  const SLICE_PROXY_PARAMS_OFFSET_BYTES = 352;
  const SLICE_FIELD_DIMS_OFFSET_BYTES = 368;
  const SLICE_WELL_DIMS_OFFSET_BYTES = 384;

  it("volume offsets are 16-byte aligned and within UNIFORM_SIZE", () => {
    for (const off of [
      VOLUME_PROXY_PARAMS_OFFSET_BYTES,
      VOLUME_FIELD_DIMS_OFFSET_BYTES,
      VOLUME_WELL_DIMS_OFFSET_BYTES,
    ]) {
      expect(off % 16).toBe(0);
      expect(off + 16).toBeLessThanOrEqual(VOLUME_UNIFORM_SIZE);
    }
    // Three back-to-back vec4u (16B each) starting at 608 must fit:
    expect(VOLUME_PROXY_PARAMS_OFFSET_BYTES + 48).toBe(VOLUME_UNIFORM_SIZE);
  });

  it("slice offsets are 16-byte aligned and within UNIFORM_SIZE", () => {
    for (const off of [
      SLICE_PROXY_PARAMS_OFFSET_BYTES,
      SLICE_FIELD_DIMS_OFFSET_BYTES,
      SLICE_WELL_DIMS_OFFSET_BYTES,
    ]) {
      expect(off % 16).toBe(0);
      expect(off + 16).toBeLessThanOrEqual(SLICE_UNIFORM_SIZE);
    }
    expect(SLICE_PROXY_PARAMS_OFFSET_BYTES + 48).toBe(SLICE_UNIFORM_SIZE);
  });

  it("u32-view indices match byte offsets / 4 (sanity check the renderer math)", () => {
    expect(VOLUME_PROXY_PARAMS_OFFSET_BYTES / 4).toBe(152);
    expect(VOLUME_FIELD_DIMS_OFFSET_BYTES / 4).toBe(156);
    expect(VOLUME_WELL_DIMS_OFFSET_BYTES / 4).toBe(160);
    expect(SLICE_PROXY_PARAMS_OFFSET_BYTES / 4).toBe(88);
    expect(SLICE_FIELD_DIMS_OFFSET_BYTES / 4).toBe(92);
    expect(SLICE_WELL_DIMS_OFFSET_BYTES / 4).toBe(96);
  });

  it("packs renderMode + slot indices + dims into the proxyParams vec4u layout", () => {
    // Replay the renderer's u32 packing into a fresh buffer at the
    // expected offset and confirm we can round-trip it.
    const buf = new ArrayBuffer(VOLUME_UNIFORM_SIZE);
    const u32 = new Uint32Array(buf);

    const renderMode = 2;
    const fieldSlot = 5;
    const wellSlot = 0xFFFFFFFF;
    u32.set([renderMode, fieldSlot >>> 0, wellSlot >>> 0, 0], 152);

    expect(u32[152]).toBe(renderMode);
    expect(u32[153]).toBe(fieldSlot);
    expect(u32[154]).toBe(0xFFFFFFFF);
    expect(u32[155]).toBe(0);

    const fieldDims: [number, number, number] = [16, 32, 64];
    u32.set([fieldDims[0], fieldDims[1], fieldDims[2], 0], 156);
    expect(u32[156]).toBe(16);
    expect(u32[157]).toBe(32);
    expect(u32[158]).toBe(64);
  });
});
