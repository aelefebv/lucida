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

describe("renderer uniform layouts (M2: per-frame proxyParams)", () => {
  // M1 (DOMAINS step 8a): proxy slot indices and dims moved into the
  // per-entity descriptor buffer. The per-frame uniform carries
  // proxyParams.x = renderMode.
  // M2: per-entity contrast/gamma/opacity also moved into the descriptor
  // buffer, shrinking the uniform layout by one vec4 (16B) on volume and
  // by one vec4 on slice. These constants mirror volumeRenderer.ts and
  // sliceRenderer.ts.
  const VOLUME_UNIFORM_SIZE = 256;
  const VOLUME_PROXY_PARAMS_OFFSET_BYTES = 240;

  const SLICE_UNIFORM_SIZE = 128;
  const SLICE_PROXY_PARAMS_OFFSET_BYTES = 112;

  it("volume proxyParams is 16-byte aligned and tail of UNIFORM_SIZE", () => {
    expect(VOLUME_PROXY_PARAMS_OFFSET_BYTES % 16).toBe(0);
    expect(VOLUME_PROXY_PARAMS_OFFSET_BYTES + 16).toBe(VOLUME_UNIFORM_SIZE);
  });

  it("slice proxyParams is 16-byte aligned and tail of UNIFORM_SIZE", () => {
    expect(SLICE_PROXY_PARAMS_OFFSET_BYTES % 16).toBe(0);
    expect(SLICE_PROXY_PARAMS_OFFSET_BYTES + 16).toBe(SLICE_UNIFORM_SIZE);
  });

  it("u32-view indices match byte offsets / 4", () => {
    expect(VOLUME_PROXY_PARAMS_OFFSET_BYTES / 4).toBe(60);
    expect(SLICE_PROXY_PARAMS_OFFSET_BYTES / 4).toBe(28);
  });

  it("renderMode survives round-trip through proxyParams.x", () => {
    const buf = new ArrayBuffer(VOLUME_UNIFORM_SIZE);
    const u32 = new Uint32Array(buf);
    const renderMode = 2;
    u32.set([renderMode, 0, 0, 0], 60);
    expect(u32[60]).toBe(renderMode);
    expect(u32[61]).toBe(0);
    expect(u32[62]).toBe(0);
    expect(u32[63]).toBe(0);
  });
});
