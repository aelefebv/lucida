/**
 * The one GPU budget: what counts against it, and what happens when it is
 * reached, on a mock device that records texture copies.
 */

import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 };

import type { WorkerCtx } from "../workerContext.ts";
import type { ChunkResidencyMessage, WorkerToMainMessage } from "../workerProtocol.ts";
import { getOrCreateVolumePool, growVolumePoolWithin, volumeLayerBytes, type AtlasState } from "../volume/atlas.ts";
import { handleLabelVolumeChunkData } from "../volume/upload.ts";
import { handleMinimapUploadOverviewChunks, MINIMAP_OVERVIEW_SHARE, removeMinimapResources } from "../minimapHandlers.ts";
import { wantedEntryKey } from "../wantedChunks.ts";
import { createInitialState } from "./state.ts";
import { ensureOffscreenPool, trimOffscreenPool } from "./resources.ts";
import { grantGrowth, handleGpuOutOfMemory, measureGpuMemory } from "./gpuBudget.ts";

const MIB = 1024 * 1024;
const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 };

function makeCtx(gpuTotalBytes = 1536 * MIB) {
  const posts: WorkerToMainMessage[] = [];
  const copies: Array<{ from?: GPUOrigin3D; to?: GPUOrigin3D; size: number[] }> = [];
  const resource = () => ({ createView: () => ({}), destroy: vi.fn() });
  const device = {
    createTexture: vi.fn(resource),
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: vi.fn() }),
    createCommandEncoder: () => ({
      copyTextureToTexture: (src: GPUTexelCopyTextureInfo, dst: GPUTexelCopyTextureInfo, size: number[]) =>
        copies.push({ from: src.origin, to: dst.origin, size }),
      finish: () => ({}),
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: () => Promise.resolve(null),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
  const ctx = {
    device,
    state: createInitialState(gpuTotalBytes),
    post: (msg: WorkerToMainMessage) => posts.push(msg),
    postWantedSet: vi.fn(),
  } as unknown as WorkerCtx;
  return { ctx, posts, copies };
}

/**
 * A volume pool of `layers` layers whose every slot holds `member`'s chunk at
 * the grid cell of the same index, mapped so the shader samples it.
 */
function heldPool(ctx: WorkerCtx, poolKey: string, member: string, layers: number): { atlas: AtlasState; keys: string[] } {
  const atlas = getOrCreateVolumePool(ctx, poolKey, "ds1", 32, 32, 32, 0, 0, "u16");
  while (atlas.slotsZ < layers) {
    atlas.slotsZ++;
    atlas.totalSlots = atlas.slotsX * atlas.slotsY * atlas.slotsZ;
  }
  atlas.slotGridIdx = new Int32Array(atlas.totalSlots);
  const gridZ = Math.ceil(atlas.totalSlots / 64);
  atlas.entityMetas.set(member, [{ level: 0, gridDims: [gridZ, 8, 8], chunkDims: [32, 32, 32], levelDims: [gridZ * 32, 256, 256], offset: 0 }]);
  atlas.indirectionData = new Uint32Array(gridZ * 64).fill(0xFFFFFFFF);
  const keys: string[] = [];
  for (let slot = 0; slot < atlas.totalSlots; slot++) {
    const key = `0/0/0/${Math.floor(slot / 64)}/${Math.floor(slot / 8) % 8}/${slot % 8}`;
    atlas.slots.set(`${member}|${key}`, slot);
    atlas.slotGridIdx[slot] = slot;
    atlas.indirectionData[slot] = slot;
    keys.push(key);
  }
  atlas.freeSlots = [];
  ctx.state.memberToDataset.set(member, "ds1");
  return { atlas, keys };
}

function want(ctx: WorkerCtx, member: string, keys: string[]): void {
  const index = new Map(ctx.state.wantedByDataset.get("ds1") ?? []);
  index.set(wantedEntryKey("detail", member), new Set(keys));
  ctx.state.wantedByDataset.set("ds1", index);
}

function lost(posts: WorkerToMainMessage[]): ChunkResidencyMessage[] {
  return posts.filter((m): m is ChunkResidencyMessage => m.type === "chunkResidency" && m.change === "lost");
}

describe("when the GPU total is reached", () => {
  it("a pool holding only wanted chunks grows by taking back another pool's unwanted layers", () => {
    const { ctx, posts, copies } = makeCtx();
    const a = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const b = heldPool(ctx, "ds1:ch1:32x32x32:detail", "imgB", 4);
    want(ctx, "imgA", a.keys);
    // B wants two chunks, both in its top layer.
    const wantedB = [b.keys[200], b.keys[250]];
    want(ctx, "imgB", wantedB);
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;

    const steps = grantGrowth(ctx, a.atlas, volumeLayerBytes(a.atlas), 1, true);

    expect(steps).toBe(1);
    expect(b.atlas.slotsZ).toBe(3);
    expect(b.atlas.totalSlots).toBe(192);
    // B's wanted chunks moved under the new capacity, texels and entries both.
    for (const key of wantedB) {
      const slot = b.atlas.slots.get(`imgB|${key}`)!;
      expect(slot).toBeLessThan(192);
      expect(b.atlas.indirectionData[b.atlas.slotGridIdx[slot]]).toBe(slot);
    }
    // Only chunks kept from the dropped layer are copied one by one.
    const moved = copies.filter((copy) => copy.from);
    expect(moved.length).toBeGreaterThanOrEqual(2);
    expect(moved.every((copy) => (copy.from as GPUOrigin3DDict).z! >= 3 * 32)).toBe(true);
    // What B gave up went to make room, so the page hears it as evicted.
    const dropped = lost(posts).flatMap((m) => m.keys);
    expect(dropped).toHaveLength(64);
    expect(dropped.some((key) => wantedB.includes(key))).toBe(false);
    expect(lost(posts).every((m) => m.memberId === "imgB" && m.reason === "evicted")).toBe(true);
    expect(measureGpuMemory(ctx.state).bytes + volumeLayerBytes(a.atlas)).toBeLessThanOrEqual(ctx.state.gpuTotalBytes);
  });

  it("refuses the growth when no other pool holds anything the planner doesn't want", () => {
    const { ctx } = makeCtx();
    const a = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const b = heldPool(ctx, "ds1:ch1:32x32x32:detail", "imgB", 2);
    want(ctx, "imgA", a.keys);
    want(ctx, "imgB", b.keys);
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;

    expect(grantGrowth(ctx, a.atlas, volumeLayerBytes(a.atlas), 1, true)).toBe(0);
    expect(b.atlas.slotsZ).toBe(2);
  });

  it("refuses a label pool the total has no room for, and its chunks with it", () => {
    const { ctx, posts } = makeCtx(1 * MIB);
    handleLabelVolumeChunkData(ctx, {
      type: "labelVolumeChunkData",
      epochs: EPOCHS,
      memberId: "label",
      datasetId: "ds1",
      chunks: [{ data: new Uint32Array(64 * 64 * 64).buffer, dataType: "uint32", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
      level: 0, t: 0, c: 0,
      levelWidth: 64, levelHeight: 64, levelDepth: 64, chunkX: 64, chunkY: 64, chunkZ: 64,
    });

    expect(ctx.state.labelVolumePools.size).toBe(0);
    expect(posts).toContainEqual({
      type: "chunkResidency", memberId: "label", tier: "detail", change: "refused", keys: ["0/0/0/0/0/0"], reason: "atlas-policy",
    });
  });
});

describe("a full pool", () => {
  it("grows straight to the layers that hold every chunk the planner wants", () => {
    const { ctx, copies } = makeCtx();
    const { atlas, keys } = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const layer = atlas.slotsX * atlas.slotsY;
    const wanted = Array.from({ length: layer * 5 }, (_, i) => `0/0/0/${Math.floor(i / 64)}/${Math.floor(i / 8) % 8}/${i % 8}`);
    want(ctx, "imgA", wanted);
    copies.length = 0;

    expect(growVolumePoolWithin(ctx, "ds1:ch0:32x32x32:detail", atlas, false)).toBe(true);

    expect(atlas.slotsZ).toBe(5);
    expect(copies).toHaveLength(1);
    expect(atlas.slots.size).toBe(keys.length);
    // Zeroing a new pool by a clear needs a render attachment's usage.
    const usage = vi.mocked(ctx.device.createTexture).mock.calls.at(-1)![0].usage;
    expect(usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
  });

  it("doubles when what the planner wants already fits", () => {
    const { ctx } = makeCtx();
    const { atlas, keys } = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 2);
    want(ctx, "imgA", keys.slice(0, 10));

    expect(growVolumePoolWithin(ctx, "ds1:ch0:32x32x32:detail", atlas, false)).toBe(true);

    expect(atlas.slotsZ).toBe(4);
  });
});

describe("running out of memory", () => {
  it("halves the total, and the pools give back what it no longer covers", () => {
    const { ctx } = makeCtx();
    // 60 layers of 4 MiB, of which the planner wants one layer's chunks.
    const b = heldPool(ctx, "ds1:32x32x32:detail", "imgB", 60);
    want(ctx, "imgB", b.keys.slice(0, 64));
    ctx.state.gpuTotalBytes = 400 * MIB;

    // Still above the floor, so the caller may try again.
    expect(handleGpuOutOfMemory(ctx)).toBe(true);

    expect(ctx.state.gpuTotalBytes).toBe(200 * MIB);
    expect(measureGpuMemory(ctx.state).bytes).toBeLessThanOrEqual(200 * MIB);
    expect(b.keys.slice(0, 64).every((key) => b.atlas.slots.has(`imgB|${key}`))).toBe(true);
  });

  it("reports at the floor that trying again would not help", () => {
    const { ctx } = makeCtx(192 * MIB);
    expect(handleGpuOutOfMemory(ctx)).toBe(false);
    expect(ctx.state.gpuTotalBytes).toBe(192 * MIB);
  });
});

describe("holders outside the pools", () => {
  it("count the viewport's render targets, and stop counting the ones a frame frees", () => {
    const { ctx } = makeCtx();
    ensureOffscreenPool(ctx, 2, 100, 50);
    expect(measureGpuMemory(ctx.state).targetBytes).toBe(2 * 100 * 50 * 8);
    trimOffscreenPool(1);
    expect(measureGpuMemory(ctx.state).targetBytes).toBe(100 * 50 * 8);
    trimOffscreenPool(0);
  });

  it("leave a minimap overview out once the overviews' share is spent, until its selection changes", () => {
    // One overview is its 1 MiB texture and a one-cell indirection, and the
    // share is exactly that.
    const overview = 512 * 512 * 2 * 2 + 4;
    const { ctx } = makeCtx(overview / MINIMAP_OVERVIEW_SHARE);
    const upload = (memberId: string, t: number) => handleMinimapUploadOverviewChunks(ctx, {
      type: "minimapUploadOverviewChunksForLayer",
      datasetId: memberId,
      imageId: memberId,
      level: 0,
      t, c: 0,
      levelWidth: 512, levelHeight: 512, levelDepth: 2,
      chunkX: 512, chunkY: 512, chunkZ: 2,
      sampleFormat: "u16",
      chunks: [],
    });
    upload("m0", 0);
    upload("m1", 0);

    expect(measureGpuMemory(ctx.state)).toMatchObject({ minimapBytes: overview, overviewsRefused: 1 });
    removeMinimapResources(ctx, "m0");
    upload("m1", 0);
    // Taking it now would draw only the chunks that arrive from here on.
    expect(measureGpuMemory(ctx.state).minimapBytes).toBe(0);
    upload("m1", 1);
    expect(measureGpuMemory(ctx.state)).toMatchObject({ minimapBytes: overview, overviewsRefused: 0 });
    removeMinimapResources(ctx, "m1");
  });
});
