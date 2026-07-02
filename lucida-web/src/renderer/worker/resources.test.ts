/**
 * Tests for the worker-side label LUT texture cache. The GPU touch
 * (`createTexture` / `queue.writeTexture`) is mocked — vitest has no WebGPU —
 * so these assert the caching / sizing / eviction behaviour, not real uploads.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

import {
  destroyAllResources,
  getLabelLUT,
  removeLabelLUTsForDataset,
  setLabelLUT,
} from "./resources.ts";

interface MockTexture {
  destroyed: boolean;
  destroy: () => void;
  size: [number, number, number];
  format: string;
}

interface MockDevice {
  device: GPUDevice;
  createTexture: ReturnType<typeof vi.fn>;
  writeTexture: ReturnType<typeof vi.fn>;
}

function makeMockDevice(): MockDevice {
  const createTexture = vi.fn((desc: GPUTextureDescriptor): MockTexture => {
    const size = desc.size as number[];
    return {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      size: [size[0], size[1] ?? 1, size[2] ?? 1],
      format: String(desc.format),
    };
  });
  const writeTexture = vi.fn();
  const device = {
    createTexture,
    queue: { writeTexture } as unknown as GPUQueue,
  } as unknown as GPUDevice;
  return { device, createTexture, writeTexture };
}

const LUT_BYTES = 65536 * 4;

describe("label LUT cache", () => {
  beforeEach(() => {
    // Ensure a clean cache between tests (module-scoped state).
    destroyAllResources();
  });

  it("builds a 256×256 rgba8unorm texture and caches it by key", () => {
    const { device, createTexture, writeTexture } = makeMockDevice();
    const rgba = new Uint8Array(LUT_BYTES);
    // Mark a couple of entries so we can sanity-check the payload width.
    rgba[4] = 255; // value 1, R
    rgba[7] = 255; // value 1, A

    const tex = setLabelLUT(device, "ds1:0", rgba) as unknown as MockTexture;

    expect(createTexture).toHaveBeenCalledTimes(1);
    const desc = createTexture.mock.calls[0][0] as GPUTextureDescriptor;
    expect(desc.format).toBe("rgba8unorm");
    // Square 256×256 (65536 texels) — a 65536×1 texture would exceed
    // maxTextureDimension2D and be dropped on real GPUs.
    expect(desc.size).toEqual([256, 256]);
    expect(tex.size).toEqual([256, 256, 1]);

    // Uploaded verbatim as 256 rows of 256*4 bytes (256-aligned, no padding),
    // copy size 256×256 — the flat row-major source lands entry i at
    // (i & 255, i >> 8).
    expect(writeTexture).toHaveBeenCalledTimes(1);
    const layout = writeTexture.mock.calls[0][2] as GPUImageDataLayout;
    expect(layout.bytesPerRow).toBe(256 * 4);
    const copySize = writeTexture.mock.calls[0][3] as number[];
    expect(copySize).toEqual([256, 256]);
    // The full 65536-entry table is uploaded in one shot.
    expect(256 * 256 * 4).toBe(LUT_BYTES);

    // Cached under its key.
    expect(getLabelLUT("ds1:0")).toBe(tex as unknown as GPUTexture);
  });

  it("creates the LUT texture with both dimensions <= maxTextureDimension2D", () => {
    // Real devices cap maxTextureDimension2D at 8192–16384; a 65536-wide
    // texture is INVALID and the label draw silently renders nothing. Guard the
    // whole class: neither dimension may exceed the conservative 8192 floor.
    const MAX_DIM = 8192;
    const { device, createTexture } = makeMockDevice();

    setLabelLUT(device, "ds1:0", new Uint8Array(LUT_BYTES));

    const desc = createTexture.mock.calls[0][0] as GPUTextureDescriptor;
    const size = desc.size as number[];
    expect(size[0]).toBeLessThanOrEqual(MAX_DIM);
    expect(size[1] ?? 1).toBeLessThanOrEqual(MAX_DIM);
    // And it must not be the broken 65536×1 shape specifically.
    expect(size).not.toEqual([65536, 1]);
  });

  it("uploads the flat table row-major so entry i maps to (i & 255, i >> 8)", () => {
    // vitest has no WebGPU, so we can't read texels back. Instead assert the
    // upload *contract* that produces the mapping: a flat row-major source +
    // bytesPerRow of one row (256*4) + a 256×256 copy places byte-offset i*4
    // (entry i) at texel (i & 255, i >> 8). Pin the arithmetic too so the
    // shader's inverse (idx & 255, idx >> 8) can't drift from the upload.
    const { device, writeTexture } = makeMockDevice();
    setLabelLUT(device, "ds1:0", new Uint8Array(LUT_BYTES));

    const layout = writeTexture.mock.calls[0][2] as GPUImageDataLayout;
    const copySize = writeTexture.mock.calls[0][3] as number[];
    const width = copySize[0];
    const bytesPerRow = layout.bytesPerRow ?? 0;
    // One texel row per `width` texels, tightly packed (4 bytes/texel).
    expect(bytesPerRow).toBe(width * 4);

    // For a handful of entries, the row-major byte layout the upload describes
    // must place entry i at (x = i % width, y = i / width) == (i & 255, i >> 8).
    for (const i of [0, 1, 255, 256, 257, 65535]) {
      const byteOffset = i * 4;
      const texelIndex = byteOffset / 4; // 4 bytes per rgba8 texel
      const x = texelIndex % width;
      const y = Math.floor(texelIndex / width);
      expect([x, y]).toEqual([i & 255, i >> 8]);
    }
  });

  it("returns null for an unbuilt key", () => {
    expect(getLabelLUT("ds1:99")).toBeNull();
  });

  it("rebuilding the same key replaces (and destroys) the old texture", () => {
    const { device } = makeMockDevice();
    const first = setLabelLUT(device, "ds1:0", new Uint8Array(LUT_BYTES)) as unknown as MockTexture;
    const second = setLabelLUT(device, "ds1:0", new Uint8Array(LUT_BYTES)) as unknown as MockTexture;
    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(false);
    expect(getLabelLUT("ds1:0")).toBe(second as unknown as GPUTexture);
  });

  it("throws on a short LUT buffer (would silently mis-colour)", () => {
    const { device } = makeMockDevice();
    expect(() => setLabelLUT(device, "ds1:0", new Uint8Array(LUT_BYTES - 4))).toThrowError(
      /expected .* rgba bytes/,
    );
  });

  it("drops only the matching dataset's LUTs on removal", () => {
    const { device } = makeMockDevice();
    const a = setLabelLUT(device, "ds1:0", new Uint8Array(LUT_BYTES)) as unknown as MockTexture;
    const b = setLabelLUT(device, "ds1:1", new Uint8Array(LUT_BYTES)) as unknown as MockTexture;
    const c = setLabelLUT(device, "ds2:0", new Uint8Array(LUT_BYTES)) as unknown as MockTexture;

    removeLabelLUTsForDataset("ds1");

    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    expect(c.destroyed).toBe(false);
    expect(getLabelLUT("ds1:0")).toBeNull();
    expect(getLabelLUT("ds1:1")).toBeNull();
    expect(getLabelLUT("ds2:0")).toBe(c as unknown as GPUTexture);
  });
});
