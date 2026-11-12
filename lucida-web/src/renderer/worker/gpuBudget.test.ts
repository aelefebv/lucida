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
import { getOrCreateLabelSlicePool, getOrCreateSlicePool, holdSliceSlot, shrinkSliceAtlas } from "../slice/atlas.ts";
import { handleLabelVolumeChunkData } from "../volume/upload.ts";
import { handleMinimapUploadOverviewChunks, MINIMAP_OVERVIEW_SHARE, removeMinimapResources } from "../minimapHandlers.ts";
import { wantedEntryKey } from "../wantedChunks.ts";
import { createInitialState, type ViewDraw } from "./state.ts";
import { attachView, fakeDraw, viewOf } from "../viewIndirectionFixtures.ts";
import {
  releaseAllViewResources,
  releaseViewsBut,
  trimViewLayerTargets,
  viewFrameTarget,
  viewLayerTargets,
} from "./viewResources.ts";
import { GpuRoom, grantGrowth, handleGpuOutOfMemory, measureGpuCapacity, measureGpuMemory } from "./gpuBudget.ts";
import { wantNothingOf } from "../coldState/apply.ts";

const MIB = 1024 * 1024;
const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 };

function makeCtx(gpuTotalBytes = 1536 * MIB) {
  const posts: WorkerToMainMessage[] = [];
  const copies: Array<{ from?: GPUOrigin3D; to?: GPUOrigin3D; size: number[] }> = [];
  const resource = () => ({ createView: () => ({}), destroy: vi.fn() });
  const texture = (desc: GPUTextureDescriptor) => {
    const [width, height] = desc.size as number[];
    return { ...resource(), width, height, format: desc.format };
  };
  const device = {
    createTexture: vi.fn(texture),
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
    format: "bgra8unorm",
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
/** The draw of "ds1" in view 0, which every test pool is drawn through. */
function testDraw(ctx: WorkerCtx): ViewDraw {
  let draw = ctx.state.draws.get("ds1|0");
  if (!draw) {
    draw = fakeDraw();
    ctx.state.draws.set("ds1|0", draw);
  }
  return draw;
}

function heldPool(
  ctx: WorkerCtx,
  poolKey: string,
  member: string,
  layers: number,
  draw: ViewDraw = testDraw(ctx),
): { atlas: AtlasState; keys: string[] } {
  const atlas = getOrCreateVolumePool(ctx, poolKey, draw.datasetId, 32, 32, 32, 0, "u16");
  // Whole layers, its first full.
  atlas.rowsY = atlas.slotsY;
  atlas.slotsZ = layers;
  atlas.totalSlots = atlas.slotsX * atlas.slotsY * atlas.slotsZ;
  const gridZ = Math.ceil(atlas.totalSlots / 64);
  const view = attachView(atlas, new Map([[member, [{ level: 0, gridDims: [gridZ, 8, 8], chunkDims: [32, 32, 32], levelDims: [gridZ * 32, 256, 256], offset: 0 }]]]), { draw });
  const keys: string[] = [];
  for (let slot = 0; slot < atlas.totalSlots; slot++) {
    const key = `0/0/0/${Math.floor(slot / 64)}/${Math.floor(slot / 8) % 8}/${slot % 8}`;
    atlas.slots.set(`${member}|${key}`, slot);
    view.slotGridIdx[slot] = slot;
    view.indirectionData[slot] = slot;
    keys.push(key);
  }
  atlas.freeSlots = [];
  ctx.state.memberToDataset.set(member, draw.datasetId);
  return { atlas, keys };
}

function want(ctx: WorkerCtx, member: string, keys: string[], draw: ViewDraw = testDraw(ctx)): void {
  draw.wanted = new Map([...draw.wanted, [wantedEntryKey("detail", member), new Set(keys)]]);
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
      expect(viewOf(b.atlas).indirectionData[viewOf(b.atlas).slotGridIdx[slot]]).toBe(slot);
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
      type: "chunkResidency", memberId: "label", viewMode: "volume", tier: "detail", change: "refused", keys: ["0/0/0/0/0/0"], reason: "atlas-policy",
    });
  });
});

describe("a dataset no view plans", () => {
  it("wants none of its chunks: its pools keep them while nothing needs the room, and give them back first", () => {
    const { ctx, posts } = makeCtx();
    const shown = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const hiddenDraw = fakeDraw({ datasetId: "ds2" });
    ctx.state.draws.set("ds2|0", hiddenDraw);
    const hidden = heldPool(ctx, "ds2:ch0:32x32x32:detail", "imgB", 2, hiddenDraw);
    want(ctx, "imgA", shown.keys);
    want(ctx, "imgB", hidden.keys, hiddenDraw);
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;
    // While the other dataset wants every chunk it holds, nothing gives way.
    expect(grantGrowth(ctx, shown.atlas, volumeLayerBytes(shown.atlas), 1, true)).toBe(0);

    wantNothingOf(ctx, "ds2");
    expect(hiddenDraw.cold.wantedChunks).toEqual([]);
    expect(hidden.atlas.slots.size).toBe(128);
    expect(lost(posts)).toEqual([]);

    expect(grantGrowth(ctx, shown.atlas, volumeLayerBytes(shown.atlas), 1, true)).toBe(1);
    expect(hidden.atlas.slotsZ).toBe(1);
    expect(lost(posts).flatMap((m) => m.keys)).toHaveLength(64);
    expect(lost(posts).every((m) => m.memberId === "imgB" && m.reason === "evicted")).toBe(true);
  });

  /**
   * ds1 on screen: a pool wanting all it holds, and one wanting two chunks
   * of its four layers. ds2 holds a label volume pool of one layer's bytes,
   * with one chunk in it, and the total is spent.
   */
  function withHiddenLabel() {
    const made = makeCtx();
    const { ctx } = made;
    const shown = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const fallback = heldPool(ctx, "ds1:ch1:32x32x32:detail", "imgB", 4);
    want(ctx, "imgA", shown.keys);
    want(ctx, "imgB", [fallback.keys[200], fallback.keys[250]]);
    ctx.state.draws.set("ds2|0", fakeDraw({ datasetId: "ds2" }));
    handleLabelVolumeChunkData(ctx, {
      type: "labelVolumeChunkData",
      epochs: EPOCHS,
      memberId: "label",
      datasetId: "ds2",
      chunks: [{ data: new Uint32Array(64 * 64 * 64).buffer, dataType: "uint32", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
      level: 0, t: 0, c: 0,
      levelWidth: 128, levelHeight: 128, levelDepth: 64, chunkX: 64, chunkY: 64, chunkZ: 64,
    });
    const label = [...ctx.state.labelVolumePools.values()][0];
    expect(measureGpuMemory(ctx.state).labelBytes).toBeGreaterThanOrEqual(volumeLayerBytes(shown.atlas));
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;
    made.posts.length = 0;
    return { ...made, shown, fallback, label };
  }

  it("keeps its label pools while nothing needs the room, and leaves them out of what admission counts as taken", () => {
    const { ctx, posts, label } = withHiddenLabel();
    const takenBefore = measureGpuCapacity(ctx).reservedBytes;

    wantNothingOf(ctx, "ds2");

    expect([...ctx.state.labelVolumePools.values()]).toEqual([label]);
    expect(lost(posts)).toEqual([]);
    expect(measureGpuCapacity(ctx).reservedBytes).toBe(takenBefore - measureGpuMemory(ctx.state).labelBytes);
  });

  it("gives its label pools up whole, before the fallback of a dataset on screen", () => {
    const { ctx, posts, shown, fallback, label } = withHiddenLabel();
    wantNothingOf(ctx, "ds2");

    expect(grantGrowth(ctx, shown.atlas, volumeLayerBytes(shown.atlas), 1, true)).toBe(1);

    expect(ctx.state.labelVolumePools.size).toBe(0);
    expect(vi.mocked(label.texture.destroy)).toHaveBeenCalled();
    expect(lost(posts)).toEqual([expect.objectContaining({ memberId: "label", keys: ["0/0/0/0/0/0"], reason: "evicted" })]);
    expect(fallback.atlas.slotsZ).toBe(4);
    expect(measureGpuMemory(ctx.state).labelBytes).toBe(0);
  });

  it("but a planned dataset's label pool stays, and the fallback goes", () => {
    const { ctx, shown, fallback, label } = withHiddenLabel();

    expect(grantGrowth(ctx, shown.atlas, volumeLayerBytes(shown.atlas), 1, true)).toBe(1);

    expect([...ctx.state.labelVolumePools.values()]).toEqual([label]);
    expect(fallback.atlas.slotsZ).toBe(3);
  });

  it("gives up a label slice pool whole too, and takes the rest from the fallback", () => {
    const { ctx, posts } = makeCtx();
    const shown = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const fallback = heldPool(ctx, "ds1:ch1:32x32x32:detail", "imgB", 4);
    want(ctx, "imgA", shown.keys);
    want(ctx, "imgB", [fallback.keys[200], fallback.keys[250]]);
    ctx.state.draws.set("ds2|0", fakeDraw({ datasetId: "ds2" }));
    // A quarter of a layer's bytes, so a layer of fallback goes after it.
    const label = getOrCreateLabelSlicePool(ctx, "label", "ds2", 0, 3, 512, 512, 256, 256)!;
    label.keys.set(0, "0/0/0/0/0");
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;
    wantNothingOf(ctx, "ds2");

    expect(grantGrowth(ctx, shown.atlas, volumeLayerBytes(shown.atlas), 1, true)).toBe(1);

    expect(ctx.state.labelSlicePools.size).toBe(0);
    expect(lost(posts)).toContainEqual(expect.objectContaining({
      memberId: "label", viewMode: "slice", keys: ["0/0/0/0/0"], reason: "evicted", cut: { axis: "z", plane: 3 },
    }));
    expect(fallback.atlas.slotsZ).toBe(3);
  });

  it("goes before the fallback of a dataset on screen, its chunk pools too", () => {
    const { ctx, posts } = makeCtx();
    const shown = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    // Three layers of fallback on screen against two held by a hidden dataset.
    const fallback = heldPool(ctx, "ds1:ch1:32x32x32:detail", "imgB", 4);
    const hiddenDraw = fakeDraw({ datasetId: "ds2" });
    ctx.state.draws.set("ds2|0", hiddenDraw);
    const hidden = heldPool(ctx, "ds2:ch0:32x32x32:detail", "imgC", 3, hiddenDraw);
    want(ctx, "imgA", shown.keys);
    want(ctx, "imgB", fallback.keys.slice(0, 2));
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;
    wantNothingOf(ctx, "ds2");

    expect(grantGrowth(ctx, shown.atlas, volumeLayerBytes(shown.atlas), 1, true)).toBe(1);

    expect(hidden.atlas.slotsZ).toBe(2);
    expect(fallback.atlas.slotsZ).toBe(4);
    expect(lost(posts).every((m) => m.memberId === "imgC")).toBe(true);
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

  it("reads one delivery's room again after each growth or reclaim", () => {
    const { ctx } = makeCtx();
    const a = heldPool(ctx, "ds1:ch0:32x32x32:detail", "imgA", 1);
    const b = heldPool(ctx, "ds1:ch1:32x32x32:detail", "imgB", 2);
    want(ctx, "imgA", a.keys);
    want(ctx, "imgB", b.keys.slice(0, 1));
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes + volumeLayerBytes(a.atlas);
    const room = new GpuRoom(ctx.state);
    const grow = (reclaim: boolean) => growVolumePoolWithin(ctx, "ds1:ch0:32x32x32:detail", a.atlas, reclaim, room);

    expect(grow(false)).toBe(true);
    expect(grow(false)).toBe(false);
    expect(grow(true)).toBe(true);
    expect(grow(false)).toBe(false);

    expect([a.atlas.slotsZ, b.atlas.slotsZ]).toEqual([3, 1]);
    expect(room.bytes).toBe(0);
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
  it("count each view's render targets and kept frame, and stop counting what a view frees", () => {
    const { ctx } = makeCtx();
    const targetBytes = () => measureGpuMemory(ctx.state).targetBytes;
    viewLayerTargets(ctx, 0, 2, 100, 50);
    expect(targetBytes()).toBe(2 * 100 * 50 * 8);
    trimViewLayerTargets(ctx, 0, 1);
    expect(targetBytes()).toBe(100 * 50 * 8);
    // A view that covers part of the canvas keeps its frame, four bytes a texel.
    viewLayerTargets(ctx, 1, 1, 40, 50);
    viewFrameTarget(ctx, 1, 40, 50);
    expect(targetBytes()).toBe(100 * 50 * 8 + 40 * 50 * 8 + 40 * 50 * 4);
    releaseViewsBut(ctx, new Set([0]));
    expect(targetBytes()).toBe(100 * 50 * 8);
    releaseAllViewResources(ctx);
    expect(targetBytes()).toBe(0);
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

describe("a slice pool that shrinks", () => {
  it("keeps the planes it holds of each chunk in step with its slots", () => {
    const { ctx } = makeCtx();
    const atlas = getOrCreateSlicePool(ctx, "ds1:ch0:32x32:detail", "ds1", 32, 32, 0, "u16");
    atlas.slotsY = 2;
    atlas.totalSlots = atlas.slotsX * 2;
    atlas.freeSlots = [];
    // Two planes of one chunk, one of them in the row that goes.
    const row = atlas.slotsX;
    holdSliceSlot(atlas, "imgA", "0/0/0/0/0/0", 3, 0);
    holdSliceSlot(atlas, "imgA", "0/0/0/0/0/0", 9, row);
    holdSliceSlot(atlas, "imgA", "0/0/0/0/0/1", 3, row + 1);

    const dropped = shrinkSliceAtlas(ctx.device, atlas, 1, ["imgA|0/0/0/0/0/0|9", "imgA|0/0/0/0/0/0|3"]);

    expect(dropped).toEqual(["imgA|0/0/0/0/0/1|3"]);
    const planes = atlas.planesByChunk.get("imgA|0/0/0/0/0/0")!;
    expect([...planes.keys()].sort((a, b) => a - b)).toEqual([3, 9]);
    for (const [plane, slot] of planes) {
      expect(slot).toBeLessThan(row);
      expect(atlas.slots.get(`imgA|0/0/0/0/0/0|${plane}`)).toBe(slot);
    }
    expect(atlas.planesByChunk.has("imgA|0/0/0/0/0/1")).toBe(false);
  });
});

describe("each view's indirection over a pool", () => {
  it("counts against the GPU total, once per view, and goes with the view", () => {
    const { ctx } = makeCtx();
    const atlas = getOrCreateVolumePool(ctx, "ds1:ch0:32x32x32:detail", "ds1", 32, 32, 32, 0, "u16");
    const metas = new Map([["imgA", [{ level: 0, gridDims: [2, 8, 8] as [number, number, number], chunkDims: [32, 32, 32] as [number, number, number], levelDims: [64, 256, 256] as [number, number, number], offset: 0 }]]]);
    attachView(atlas, metas, { draw: fakeDraw({ view: 0 }) });
    const one = measureGpuMemory(ctx.state);
    expect(one.indirectionBytes).toBe(128 * 4);

    attachView(atlas, metas, { draw: fakeDraw({ view: 1 }) });
    const two = measureGpuMemory(ctx.state);
    expect(two.indirectionBytes).toBe(2 * 128 * 4);
    expect(two.chunkBytes - one.chunkBytes).toBe(128 * 4);
    expect(two.bytes - one.bytes).toBe(128 * 4);

    atlas.views.delete(1);
    expect(measureGpuMemory(ctx.state)).toEqual(one);
  });
});
