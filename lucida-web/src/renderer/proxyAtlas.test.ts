/**
 * Pure-TS tests for the proxy atlas data structure. We mock the
 * `GPUDevice.createTexture` call (the only GPU touch in `proxyAtlas.ts`)
 * because vitest doesn't have a WebGPU implementation; everything else
 * (slot allocation, LRU, lookups, pool keying) is plain TypeScript.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Polyfill the WebGPU usage flags into the test global so
// `proxyAtlas.createProxyAtlas` doesn't throw a ReferenceError when it
// references `GPUTextureUsage.*`. The numeric values mirror the spec.
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
  lookupProxySlot,
  touchProxySlot,
  proxyPoolKey,
  proxySlotKey,
  proxySlotOrigin,
  type ProxyAtlasState,
} from "./proxyAtlas.ts";

// ---------------------------------------------------------------------------
// Mock GPU device
// ---------------------------------------------------------------------------

interface MockTexture {
  destroyed: boolean;
  destroy: () => void;
  size: [number, number, number];
}

function makeMockDevice(maxDim = 2048): GPUDevice {
  const createTexture = vi.fn((desc: GPUTextureDescriptor): MockTexture => {
    const size = desc.size as number[];
    const w = size[0];
    const h = size[1];
    const d = size[2];
    const tex: MockTexture = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      size: [w, h, d],
    };
    return tex;
  });

  return {
    limits: { maxTextureDimension3D: maxDim } as unknown as GPUSupportedLimits,
    createTexture,
    queue: { writeTexture: vi.fn() } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxyAtlas", () => {
  let device: GPUDevice;

  beforeEach(() => {
    device = makeMockDevice();
  });

  describe("createProxyAtlas", () => {
    it("creates pool with capacity slots and 1-D-along-X texture layout", () => {
      const atlas = createProxyAtlas(device, "FieldProxy3D", [16, 32, 64], 0, 4);
      expect(atlas.capacity).toBe(4);
      expect(atlas.slots.size).toBe(0);
      expect(atlas.freeSlots).toHaveLength(4);
      expect(atlas.touchOrder).toHaveLength(0);
      expect(atlas.kind).toBe("FieldProxy3D");
      expect(atlas.channel).toBe(0);
      expect(atlas.slotDims).toEqual([16, 32, 64]);
      // Texture should be sized 1-D along X
      expect((atlas.texture as unknown as MockTexture).size).toEqual([64 * 4, 32, 16]);
    });

    it("clamps capacity to fit under maxTextureDimension3D", () => {
      // limit=2048, slotX=512, requested capacity=16 → 512*16=8192 > 2048, clamp to 4
      const lowLimitDevice = makeMockDevice(2048);
      const atlas = createProxyAtlas(lowLimitDevice, "WellProxy3D", [8, 8, 512], 0, 16);
      expect(atlas.capacity).toBe(4);
      expect(atlas.freeSlots).toHaveLength(4);
    });
  });

  describe("allocateProxySlot", () => {
    let atlas: ProxyAtlasState;
    beforeEach(() => {
      atlas = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 0, 3);
    });

    it("returns 0 on first allocation in empty atlas; slots map updated", () => {
      const slot = allocateProxySlot(atlas, "k1");
      // freeSlots stack is built [cap-1 ... 0] then pop -> 0 first.
      expect(slot).toBe(0);
      expect(atlas.slots.get("k1")).toBe(0);
      expect(atlas.touchOrder).toEqual(["k1"]);
      expect(atlas.freeSlots).toHaveLength(2);
    });

    it("subsequent allocations consume free slots until capacity", () => {
      const s1 = allocateProxySlot(atlas, "k1");
      const s2 = allocateProxySlot(atlas, "k2");
      const s3 = allocateProxySlot(atlas, "k3");
      expect(new Set([s1, s2, s3])).toEqual(new Set([0, 1, 2]));
      expect(atlas.slots.size).toBe(3);
      expect(atlas.freeSlots).toHaveLength(0);
      expect(atlas.touchOrder).toEqual(["k1", "k2", "k3"]);
    });

    it("filling capacity then allocating new key evicts oldest (touchOrder head)", () => {
      const s1 = allocateProxySlot(atlas, "k1");
      const s2 = allocateProxySlot(atlas, "k2");
      const s3 = allocateProxySlot(atlas, "k3");
      // pool full: capacity=3, slots={k1, k2, k3}
      const s4 = allocateProxySlot(atlas, "k4");
      // k1 was oldest -> evicted; its slot index reused for k4
      expect(s4).toBe(s1);
      expect(atlas.slots.has("k1")).toBe(false);
      expect(atlas.slots.has("k4")).toBe(true);
      expect(atlas.slots.get("k4")).toBe(s1);
      expect(atlas.touchOrder).toEqual(["k2", "k3", "k4"]);
      // Suppress unused-variable warning when only s2/s3 are needed for setup.
      void s2; void s3;
    });

    it("allocate of existing key returns same slot AND moves it to end of touchOrder", () => {
      allocateProxySlot(atlas, "k1");
      allocateProxySlot(atlas, "k2");
      allocateProxySlot(atlas, "k3");
      const reused = allocateProxySlot(atlas, "k1");
      expect(reused).toBe(atlas.slots.get("k1"));
      // k1 is now the most-recently-used
      expect(atlas.touchOrder).toEqual(["k2", "k3", "k1"]);
    });

    it("after touch, oldest entry is the new eviction victim", () => {
      const s1 = allocateProxySlot(atlas, "k1");
      const s2 = allocateProxySlot(atlas, "k2");
      const s3 = allocateProxySlot(atlas, "k3");
      // Touch k1 -> k2 becomes oldest
      touchProxySlot(atlas, "k1");
      const s4 = allocateProxySlot(atlas, "k4");
      expect(s4).toBe(s2); // k2's slot reused
      expect(atlas.slots.has("k2")).toBe(false);
      expect(atlas.slots.has("k1")).toBe(true);
      expect(atlas.touchOrder).toEqual(["k3", "k1", "k4"]);
      void s1; void s3;
    });
  });

  describe("lookupProxySlot", () => {
    it("returns slot index for resident key, undefined otherwise", () => {
      const atlas = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 0, 4);
      const s = allocateProxySlot(atlas, "alpha");
      expect(lookupProxySlot(atlas, "alpha")).toBe(s);
      expect(lookupProxySlot(atlas, "missing")).toBeUndefined();
    });

    it("does not affect LRU touch order", () => {
      const atlas = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 0, 3);
      allocateProxySlot(atlas, "k1");
      allocateProxySlot(atlas, "k2");
      lookupProxySlot(atlas, "k1");
      expect(atlas.touchOrder).toEqual(["k1", "k2"]);
    });
  });

  describe("touchProxySlot", () => {
    it("moves resident key to end of touchOrder", () => {
      const atlas = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 0, 3);
      allocateProxySlot(atlas, "k1");
      allocateProxySlot(atlas, "k2");
      allocateProxySlot(atlas, "k3");
      touchProxySlot(atlas, "k1");
      expect(atlas.touchOrder).toEqual(["k2", "k3", "k1"]);
    });

    it("is a no-op for missing key", () => {
      const atlas = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 0, 3);
      allocateProxySlot(atlas, "k1");
      touchProxySlot(atlas, "missing");
      expect(atlas.touchOrder).toEqual(["k1"]);
    });
  });

  describe("proxySlotOrigin", () => {
    it("returns [slotIndex * X, 0, 0]", () => {
      const atlas = createProxyAtlas(device, "FieldProxy3D", [16, 32, 64], 0, 4);
      expect(proxySlotOrigin(atlas, 0)).toEqual([0, 0, 0]);
      expect(proxySlotOrigin(atlas, 1)).toEqual([64, 0, 0]);
      expect(proxySlotOrigin(atlas, 3)).toEqual([192, 0, 0]);
    });
  });

  describe("proxyPoolKey", () => {
    it("encodes datasetId, kind, dims, channel into a stable key", () => {
      expect(proxyPoolKey("ds-A", "FieldProxy3D", [16, 32, 64], 0)).toBe(
        "ds-A|proxy|FieldProxy3D|64x32x16|ch0",
      );
      expect(proxyPoolKey("ds-A", "WellProxy3D", [16, 32, 64], 2)).toBe(
        "ds-A|proxy|WellProxy3D|64x32x16|ch2",
      );
    });
  });

  describe("proxySlotKey", () => {
    it("composes (entityId, t, c)", () => {
      expect(proxySlotKey("e", 0, 1)).toBe("e|0|1");
      expect(proxySlotKey("entity-9", 7, 3)).toBe("entity-9|7|3");
    });
  });

  describe("multi-pool independence", () => {
    it("different (kind, channel) -> independent pools, no slot collisions", () => {
      const fieldCh0 = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 0, 2);
      const wellCh0 = createProxyAtlas(device, "WellProxy3D", [8, 8, 8], 0, 2);
      const fieldCh1 = createProxyAtlas(device, "FieldProxy3D", [8, 8, 8], 1, 2);

      // Same composite key in three pools — each gets its own slot.
      const key = proxySlotKey("entity-X", 0, 0);
      const s1 = allocateProxySlot(fieldCh0, key);
      const s2 = allocateProxySlot(wellCh0, key);
      const s3 = allocateProxySlot(fieldCh1, key);

      expect(fieldCh0.slots.get(key)).toBe(s1);
      expect(wellCh0.slots.get(key)).toBe(s2);
      expect(fieldCh1.slots.get(key)).toBe(s3);

      // Filling pool A doesn't affect B or C.
      allocateProxySlot(fieldCh0, "other-1");
      allocateProxySlot(fieldCh0, "other-2"); // evicts the oldest in fieldCh0
      // wellCh0 still has the original key.
      expect(wellCh0.slots.get(key)).toBe(s2);
      expect(fieldCh1.slots.get(key)).toBe(s3);
    });
  });
});
