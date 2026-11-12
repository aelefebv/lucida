/**
 * Chunk admission, eviction and the residency report, through
 * `handleVolumeChunkData` / `handleSliceChunkData` on mock-device atlases,
 * and the eviction kernel on its own.
 *
 * The worker writes only chunks the planner wants, and answers every chunk
 * it is sent, held or refused. Evicting member A's chunk during an upload
 * for B reports A's chunk lost, because the page mirrors residency per
 * member. Slots the planner does not want go before any it does. A wanted
 * chunk no nearer than the farthest wanted resident is refused, so two
 * chunks at one distance never trade a slot. A T/C scrub still refreshes
 * without a pan, because the remap leaves the old selection's slots unsampled.
 */

import { describe, it, expect, vi } from "vitest";

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

import {
  applyViewHotState,
  getOrCreateVolumePool,
  growVolumeAtlas,
  handleVolumeChunkData,
  volumeRows,
  remapIndirection,
  type AtlasState,
  type LodIndirectionMeta,
} from "./volume/index.ts";
import {
  getOrCreateSlicePool,
  handleSliceChunkData,
  remapSliceIndirection,
} from "./slice/index.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { createInitialState } from "./worker/state.ts";
import { measureGpuMemory } from "./worker/gpuBudget.ts";
import { growViewSlots } from "./viewIndirection.ts";
import type {
  Chunk,
  ChunkResidencyChange,
  ChunkResidencyMessage,
  SliceChunkDataMessage,
  VolumeChunkDataMessage,
  WorkerToMainMessage,
} from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { wantedEntryKey } from "./wantedChunks.ts";
import { chunkDistSq, findEvictionSlot, mayEvict, type EvictionView } from "./eviction.ts";
import type { ViewDraw } from "./worker/state.ts";
import type { SliceAtlasState } from "./slice/atlas.ts";
import { setCameraUVForMember } from "./slice/eviction.ts";
import { attachView, fakeDraw, layOut, viewOf } from "./viewIndirectionFixtures.ts";

// Mock device + ctx

function makeMockDevice(): GPUDevice {
  const createBuffer = vi.fn((desc: GPUBufferDescriptor) => ({
    size: desc.size,
    usage: desc.usage,
    destroyed: false,
    destroy() { this.destroyed = true; },
  }));
  const createTexture = vi.fn((_desc: GPUTextureDescriptor) => ({
    destroyed: false,
    destroy() { this.destroyed = true; },
    createView: vi.fn(() => ({})),
  }));
  const writeBuffer = vi.fn();
  const writeTexture = vi.fn();
  return {
    createBuffer,
    createTexture,
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve(null)),
    queue: { writeBuffer, writeTexture } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

function makeMockCtx(): { ctx: WorkerCtx; posts: WorkerToMainMessage[] } {
  const posts: WorkerToMainMessage[] = [];
  const ctx = {
    device: makeMockDevice(),
    state: createInitialState(),
    post(msg: WorkerToMainMessage) { posts.push(msg); },
    postWantedSet() {},
  } as unknown as WorkerCtx;
  return { ctx, posts };
}

/** The one view's draw of "ds1" each test's pools are drawn through, as a cold state would set it up. */
function testDraw(ctx: WorkerCtx): ViewDraw {
  let draw = ctx.state.draws.get("ds1|0");
  if (!draw) {
    draw = fakeDraw();
    ctx.state.draws.set("ds1|0", draw);
  }
  return draw;
}

/** `atlas` with the test's view drawing from it. */
function withView<A extends AtlasState | SliceAtlasState>(ctx: WorkerCtx, atlas: A): A {
  if (!atlas.views.has(0)) attachView(atlas, new Map(), { draw: testDraw(ctx), entries: 1 });
  return atlas;
}

/** Add chunks to the view's wanted set, as a cold state from the planner would: in a new index. */
function want(ctx: WorkerCtx, memberId: string, keys: string[], tier: ResidencyTier = "detail"): void {
  ctx.state.memberToDataset.set(memberId, "ds1");
  const draw = testDraw(ctx);
  const entry = wantedEntryKey(tier, memberId);
  draw.wanted = new Map([...draw.wanted, [entry, new Set([...(draw.wanted.get(entry) ?? []), ...keys])]]);
}

/** The residency reports posted, optionally of one kind. */
function reports(posts: WorkerToMainMessage[], change?: ChunkResidencyChange): ChunkResidencyMessage[] {
  return posts.filter((m): m is ChunkResidencyMessage =>
    m.type === "chunkResidency" && (change === undefined || m.change === change));
}

function epochs(): SceneEpochs {
  return { content: 1, layout: 1, view: 1, selection: 1, request: 0 };
}

function chunkKey(level: number, t: number, c: number, z: number, y: number, x: number): string {
  return `${level}/${t}/${c}/${z}/${y}/${x}`;
}

function makeChunk(level: number, t: number, c: number, z: number, y: number, x: number, chunkX = 32, chunkY = 32, chunkZ = 32): Chunk {
  // Provide a uint16 payload sized for the chunk's voxel volume.
  const data = new Uint16Array(chunkX * chunkY * chunkZ);
  data.fill(100);
  return {
    data: data.buffer,
    dataType: "uint16",
    x, y, z,
    key: chunkKey(level, t, c, z, y, x),
  };
}

function makeSliceChunk(level: number, t: number, c: number, z: number, y: number, x: number, chunkX = 32, chunkY = 32, chunkZ = 4): Chunk {
  // Slice chunks carry a Z-stack of 2D slices; the handler picks one
  // by `localZ` and writes only that slice into the atlas.
  const data = new Uint16Array(chunkX * chunkY * chunkZ);
  data.fill(100);
  return {
    data: data.buffer,
    dataType: "uint16",
    x, y, z,
    key: chunkKey(level, t, c, z, y, x),
  };
}

function makeVolumeMsg(memberId: string, chunks: Chunk[], overrides?: Partial<VolumeChunkDataMessage>): VolumeChunkDataMessage {
  return {
    type: "volumeChunkData",
    epochs: epochs(),
    tier: "detail",
    memberId,
    chunks,
    level: 0,
    t: 0,
    c: 0,
    levelWidth: 128,
    levelHeight: 128,
    levelDepth: 64,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 32,
    ...overrides,
  };
}

function makeSliceMsg(memberId: string, chunks: Chunk[], overrides?: Partial<SliceChunkDataMessage>): SliceChunkDataMessage {
  return {
    type: "sliceChunkData",
    epochs: epochs(),
    tier: "detail",
    memberId,
    chunks,
    level: 0,
    t: 0,
    c: 0,
    levelWidth: 128,
    levelHeight: 128,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 4,
    fullResDepth: 64,
    levelDepth: 64,
    plane: 0,
    ...overrides,
  };
}

/**
 * Build LOD metas for a single member at level 0 sized to fit the
 * given grid. Returns metas suitable for assigning to `viewOf(atlas).entityMetas`.
 */
function makeVolumeMeta(gridZ: number, gridY: number, gridX: number, chunkDims: [number, number, number] = [32, 32, 32], levelDims: [number, number, number] = [64, 128, 128]): LodIndirectionMeta {
  return {
    level: 0,
    gridDims: [gridZ, gridY, gridX],
    chunkDims,
    levelDims,
    offset: 0,
  };
}

function makeSliceMeta(gridY: number, gridX: number): LodIndirectionMeta {
  return {
    level: 0,
    gridDims: [1, gridY, gridX],
    chunkDims: [4, 32, 32],
    levelDims: [64, 128, 128],
    offset: 0,
  };
}

/** A one-slot level-0 volume pool for member A, its camera reference at `rayHit`. */
function oneSlotVolume(ctx: WorkerCtx, rayHit: [number, number, number]): AtlasState {
  const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
  layOut(viewOf(atlas), "imgA", [makeVolumeMeta(2, 4, 4)]);
  viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
  atlas.freeSlots = [0];
  applyViewHotState(ctx, {
    type: "viewHotState",
    epochs: epochs(),
    datasetId: "ds1",
    view: 0,
    rayHitsByEntity: [["imgA", rayHit]],
  });
  return atlas;
}

// Volume pool growth

describe("volume pool growth", () => {
  /** A ctx whose device records texture sizes and copies. */
  function makeGrowthCtx(gpuTotalBytes?: number) {
    const testCtx = makeMockCtx();
    const device = testCtx.ctx.device as unknown as {
      createCommandEncoder: () => unknown;
      queue: { submit: (cmds: unknown[]) => void };
    };
    const copies: number[][] = [];
    device.createCommandEncoder = () => ({
      copyTextureToTexture: (_src: unknown, _dst: unknown, size: number[]) => copies.push(size),
      finish: () => ({}),
    });
    device.queue.submit = () => {};
    if (gpuTotalBytes !== undefined) testCtx.ctx.state.gpuTotalBytes = gpuTotalBytes;
    return { ...testCtx, copies };
  }

  function textureSizes(ctx: WorkerCtx): number[][] {
    const create = ctx.device.createTexture as unknown as { mock: { calls: [GPUTextureDescriptor][] } };
    return create.mock.calls.map(([desc]) => [...(desc.size as number[])]);
  }

  /** Mark every slot the pool has as holding a chunk, as a long session would. */
  function fill(atlas: AtlasState): void {
    while (atlas.freeSlots.length > 0) {
      const slot = atlas.freeSlots.pop()!;
      atlas.slots.set(`filler:${slot}`, slot);
      viewOf(atlas).slotGridIdx[slot] = -1;
    }
  }

  it("allocates one row of its cap's slot grid, not the whole cap", () => {
    const { ctx } = makeGrowthCtx();
    // 32³ r16uint chunks under the device's 256 MiB largest buffer: 4096
    // slots, in layers of 8×8 as deep as the texture allows.
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    expect([atlas.slotsX, atlas.slotsY, atlas.slotsZ, atlas.maxSlotsZ]).toEqual([8, 8, 1, 64]);
    expect([atlas.rowsY, atlas.totalSlots]).toEqual([1, 8]);
    expect(textureSizes(ctx)).toEqual([[256, 32, 32]]);
  });

  it("holds float samples as r32uint bits", () => {
    const { ctx } = makeGrowthCtx();
    // Four bytes a texel: half the u16 pool's slots under the same cap.
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "f32"));
    expect(atlas.slotsX * atlas.slotsY * atlas.maxSlotsZ).toBe(2048);
    const create = ctx.device.createTexture as unknown as { mock: { calls: [GPUTextureDescriptor][] } };
    expect(create.mock.calls.at(-1)![0].format).toBe("r32uint");
    layOut(viewOf(atlas), "imgA", [makeVolumeMeta(2, 4, 4)]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
    want(ctx, "imgA", [chunkKey(0, 0, 0, 0, 0, 0)]);

    const values = new Float32Array(32 * 32 * 32).fill(100);
    values[0] = -5;
    values[1] = 500.25;
    values[2] = Number.NaN;
    values[3] = Infinity;
    const chunk = { ...makeChunk(0, 0, 0, 0, 0, 0), data: values.buffer, dataType: "Float32" };
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "ds1", "imgA");

    const write = ctx.device.queue.writeTexture as unknown as { mock: { calls: unknown[][] } };
    const [, texels, layout] = write.mock.calls.at(-1)! as [unknown, ArrayBuffer, GPUTexelCopyBufferLayout];
    expect(Array.from(new Float32Array(texels, 0, 2))).toEqual([-5, 500.25]);
    expect(layout.bytesPerRow).toBe(32 * 4);
  });

  it("grows through its first layer a row past what the planner wants, copying the resident chunks in place", () => {
    const { ctx, posts, copies } = makeGrowthCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    layOut(viewOf(atlas), "imgA", [makeVolumeMeta(2, 4, 4)]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
    const firstTexture = atlas.texture as unknown as { destroyed: boolean };
    fill(atlas);
    want(ctx, "imgA", [chunkKey(0, 0, 0, 0, 0, 0)]);

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [makeChunk(0, 0, 0, 0, 0, 0)]), epochs(), "ds1", "imgA");

    // The planner wants one chunk, which a row holds, and a row more for a step.
    expect([atlas.rowsY, atlas.slotsZ]).toEqual([2, 1]);
    expect(atlas.totalSlots).toBe(16);
    expect(copies).toEqual([[256, 32, 32]]);
    expect(textureSizes(ctx).at(-1)).toEqual([256, 64, 32]);
    expect(firstTexture.destroyed).toBe(true);
    // The chunk took a new slot and nothing was evicted for it.
    const slot = atlas.slots.get("imgA|0/0/0/0/0/0");
    expect(slot).toBeGreaterThanOrEqual(8);
    expect(viewOf(atlas).indirectionData[0]).toBe(slot);
    expect(reports(posts, "lost")).toEqual([]);
  });

  it("grows from its first row straight to the layers the planner wants, in one copy", () => {
    const { ctx, copies } = makeGrowthCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    layOut(viewOf(atlas), "imgA", [makeVolumeMeta(2, 4, 4)]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
    fill(atlas);
    // More than a layer of 8×8 wants two layers, which the first row grows to at once.
    want(ctx, "imgA", Array.from({ length: 70 }, (_, i) => chunkKey(0, 0, 0, i, 0, 0)));

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [makeChunk(0, 0, 0, 0, 0, 0)]), epochs(), "ds1", "imgA");

    expect([atlas.rowsY, atlas.slotsZ]).toEqual([8, 2]);
    expect(atlas.totalSlots).toBe(128);
    expect(copies).toEqual([[256, 32, 32]]);
  });

  it("grows to its cap's grid and no further", () => {
    // 64 MiB of 32³ chunks: 1024 slots, in layers of 4×4.
    const { ctx, copies } = makeGrowthCtx(64 * 1024 * 1024);
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    expect([atlas.slotsX, atlas.slotsY, atlas.maxSlotsZ]).toEqual([4, 4, 64]);
    // Doubling its rows: through its first layer's four, then whole layers.
    const grown: Array<[number, number]> = [];
    while (growVolumeAtlas(ctx.device, atlas, volumeRows(atlas) * 2)) grown.push([atlas.rowsY, atlas.slotsZ]);
    expect(grown).toEqual([[2, 1], [4, 1], [4, 2], [4, 4], [4, 8], [4, 16], [4, 32], [4, 64]]);
    expect(atlas.totalSlots).toBe(1024);
    expect(copies).toHaveLength(8);
    expect(growVolumeAtlas(ctx.device, atlas, volumeRows(atlas) * 2)).toBe(false);
  });

  /** Hold the chunk at each grid cell of `imgA`'s 5×4×4 section in slot order, mapped, through a full first layer. */
  function holdLayer(atlas: AtlasState): string[] {
    // A layer's worth of rows, as a pool grown through its first layer holds.
    atlas.rowsY = atlas.slotsY;
    atlas.totalSlots = atlas.slotsX * atlas.slotsY;
    growViewSlots(atlas, atlas.totalSlots);
    layOut(viewOf(atlas), "imgA", [makeVolumeMeta(5, 4, 4)]);
    viewOf(atlas).indirectionData = new Uint32Array(5 * 4 * 4).fill(0xFFFFFFFF);
    const keys: string[] = [];
    for (let slot = 0; slot < atlas.totalSlots; slot++) {
      const key = chunkKey(0, 0, 0, Math.floor(slot / 16), Math.floor(slot / 4) % 4, slot % 4);
      atlas.slots.set(`imgA|${key}`, slot);
      viewOf(atlas).slotGridIdx[slot] = slot;
      viewOf(atlas).indirectionData[slot] = slot;
      keys.push(key);
    }
    atlas.freeSlots = [];
    return keys;
  }

  it("takes a slot the planner doesn't want rather than grow past the GPU total", () => {
    const { ctx, posts, copies } = makeGrowthCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    const held = holdLayer(atlas);
    // The total holds this one layer and nothing more.
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;
    const incoming = makeChunk(0, 0, 0, 4, 0, 0);
    want(ctx, "imgA", [...held.slice(1), incoming.key]);

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [incoming], { levelDepth: 160 }), epochs(), "ds1", "imgA");

    expect(atlas.slotsZ).toBe(1);
    expect(copies).toEqual([]);
    expect(atlas.slots.get(`imgA|${incoming.key}`)).toBe(0);
    expect(reports(posts, "lost").map((r) => [r.reason, r.keys])).toEqual([["evicted", [held[0]]]]);
  });

  it("grows while the total has room even when it could evict", () => {
    const { ctx, posts, copies } = makeGrowthCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    const held = holdLayer(atlas);
    const incoming = makeChunk(0, 0, 0, 4, 0, 0);
    want(ctx, "imgA", [incoming.key]);

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [incoming], { levelDepth: 160 }), epochs(), "ds1", "imgA");

    // Fallback the planner no longer wants stays resident while there is room.
    expect(atlas.slotsZ).toBe(2);
    expect(copies).toHaveLength(1);
    expect(held.every((key) => atlas.slots.has(`imgA|${key}`))).toBe(true);
    expect(reports(posts, "lost")).toEqual([]);
  });
});

// Volume admission and eviction

describe("handleVolumeChunkData — admission, eviction and the residency report", () => {
  it("acknowledges a written chunk as held", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0, 0, 0]);
    const chunk = makeChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [chunk.key]);

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "ds1", "imgA");

    expect(atlas.slots.has(`imgA|${chunk.key}`)).toBe(true);
    expect(reports(posts)).toEqual([
      { type: "chunkResidency", memberId: "imgA", viewMode: "volume", tier: "detail", change: "held", keys: [chunk.key], reason: undefined },
    ]);
  });

  it("acknowledges a chunk it already holds as held, without writing it again", () => {
    const { ctx, posts } = makeMockCtx();
    oneSlotVolume(ctx, [0, 0, 0]);
    const chunk = makeChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [chunk.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "ds1", "imgA");
    const writes = (ctx.device.queue.writeTexture as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    posts.length = 0;

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "ds1", "imgA");

    expect(reports(posts).map((r) => [r.change, r.keys])).toEqual([["held", [chunk.key]]]);
    expect((ctx.device.queue.writeTexture as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(writes);
  });

  it("refuses a chunk the planner does not want, even into a free slot", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0, 0, 0]);
    const chunk = makeChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [chunkKey(0, 0, 0, 1, 1, 1)]);

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "ds1", "imgA");

    expect(atlas.slots.size).toBe(0);
    expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([["refused", "unwanted", [chunk.key]]]);
  });

  it("evicts the farthest wanted chunk for a nearer wanted one, and reports it lost", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0, 0, 0]);
    const far = makeChunk(0, 0, 0, 1, 3, 3);
    const near = makeChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [far.key, near.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [far]), epochs(), "ds1", "imgA");
    posts.length = 0;

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [near]), epochs(), "ds1", "imgA");

    expect([...atlas.slots.keys()]).toEqual([`imgA|${near.key}`]);
    expect(reports(posts).map((r) => [r.memberId, r.change, r.reason, r.keys])).toEqual([
      ["imgA", "held", undefined, [near.key]],
      ["imgA", "lost", "evicted", [far.key]],
    ]);
  });

  it("multi-member demux: B's upload evicts A's chunk → the loss is keyed by A, not B", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    // Two members share the pool; each owns its own LOD section.
    layOut(viewOf(atlas), "imgA", [makeVolumeMeta(2, 4, 4)]);
    layOut(viewOf(atlas), "imgB", [{ ...makeVolumeMeta(2, 4, 4), offset: 2 * 4 * 4 }]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4 * 2).fill(0xFFFFFFFF);
    atlas.freeSlots = [0];
    applyViewHotState(ctx, {
      type: "viewHotState",
      epochs: epochs(),
      datasetId: "ds1",
      view: 0,
      rayHitsByEntity: [["imgA", [0, 0, 0]], ["imgB", [0, 0, 0]]],
    });
    const farA = makeChunk(0, 0, 0, 1, 3, 3);
    const nearB = makeChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [farA.key]);
    want(ctx, "imgB", [nearB.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [farA]), epochs(), "ds1", "imgA");
    posts.length = 0;

    handleVolumeChunkData(ctx, makeVolumeMsg("imgB", [nearB]), epochs(), "ds1", "imgB");

    // Reported under the owner of the evicted chunk, not the uploader.
    expect(reports(posts, "lost").map((r) => [r.memberId, r.keys])).toEqual([["imgA", [farA.key]]]);
    expect(reports(posts, "held").map((r) => [r.memberId, r.keys])).toEqual([["imgB", [nearB.key]]]);
  });

  it("refuses a wanted chunk farther than every wanted resident, and keeps the resident", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0, 0, 0]);
    const near = makeChunk(0, 0, 0, 0, 0, 0);
    const far = makeChunk(0, 0, 0, 1, 3, 3);
    want(ctx, "imgA", [near.key, far.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [near]), epochs(), "ds1", "imgA");
    posts.length = 0;

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [far]), epochs(), "ds1", "imgA");

    expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([["refused", "atlas-policy", [far.key]]]);
    expect([...atlas.slots.keys()]).toEqual([`imgA|${near.key}`]);
  });

  it("an equal-distance chunk never displaces a wanted resident: it is refused, and the resident stays", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0.5, 0.5, 0.5]);
    // Columns 1 and 2 mirror each other about the ray hit.
    const left = makeChunk(0, 0, 0, 0, 1, 1);
    const right = makeChunk(0, 0, 0, 0, 1, 2);
    want(ctx, "imgA", [left.key, right.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [left]), epochs(), "ds1", "imgA");

    for (let round = 0; round < 3; round++) {
      posts.length = 0;
      handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [right]), epochs(), "ds1", "imgA");
      expect(reports(posts).map((r) => [r.change, r.keys])).toEqual([["refused", [right.key]]]);
      expect([...atlas.slots.keys()]).toEqual([`imgA|${left.key}`]);
    }
  });

  it("a resident the planner no longer wants goes before any wanted one, even a farther one", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    layOut(viewOf(atlas), "imgA", [makeVolumeMeta(2, 4, 4)]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
    atlas.freeSlots = [1, 0];
    applyViewHotState(ctx, { type: "viewHotState", epochs: epochs(), datasetId: "ds1", view: 0, rayHitsByEntity: [["imgA", [0, 0, 0]]] });
    const nearOld = makeChunk(0, 0, 0, 0, 0, 0);
    const farWanted = makeChunk(0, 0, 0, 1, 3, 3);
    const incoming = makeChunk(0, 0, 0, 1, 3, 2);
    want(ctx, "imgA", [nearOld.key, farWanted.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [nearOld, farWanted]), epochs(), "ds1", "imgA");

    // A new plan wants the far chunk and the incoming one, not the near one.
    testDraw(ctx).wanted = new Map();
    want(ctx, "imgA", [farWanted.key, incoming.key]);
    posts.length = 0;
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [incoming]), epochs(), "ds1", "imgA");

    expect([...atlas.slots.keys()].sort()).toEqual([`imgA|${incoming.key}`, `imgA|${farWanted.key}`].sort());
    expect(reports(posts, "lost").map((r) => r.keys)).toEqual([[nearOld.key]]);
  });

  it.each([
    { scrub: "T", next: makeChunk(0, 1, 0, 0, 0, 0), t: 1, c: 0 },
    { scrub: "C", next: makeChunk(0, 0, 1, 0, 0, 0), t: 0, c: 1 },
  ])("a $scrub scrub on a full atlas replaces the old selection's chunk at the same position", ({ next, t, c }) => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0, 0, 0]);
    const old = makeChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [old.key, next.key]);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [old]), epochs(), "ds1", "imgA");
    expect(atlas.slots.has(`imgA|${old.key}`)).toBe(true);

    // The cold state at the new selection unmaps the old chunk, so it is
    // never sampled and goes ahead of the incoming chunk at its position.
    remapIndirection(atlas, viewOf(atlas), t, c);
    posts.length = 0;
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [next], { t, c }), epochs(), "ds1", "imgA");

    expect([...atlas.slots.keys()]).toEqual([`imgA|${next.key}`]);
    expect(reports(posts).map((r) => [r.change, r.keys])).toEqual([
      ["held", [next.key]],
      ["lost", [old.key]],
    ]);
  });

  it("refuses a stale-epoch batch whole, doing no work", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = oneSlotVolume(ctx, [0, 0, 0]);
    // Current epoch.content is 5; the batch carries content=1 → stale.
    const currentEpochs: SceneEpochs = { content: 5, layout: 1, view: 1, selection: 1, request: 0 };
    const batchEpochs: SceneEpochs = { content: 1, layout: 1, view: 1, selection: 1, request: 0 };
    const chunks = [makeChunk(0, 0, 0, 0, 0, 0), makeChunk(0, 0, 0, 0, 0, 1)];

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", chunks, { epochs: batchEpochs }), currentEpochs, "ds1", "imgA");

    expect(atlas.slots.size).toBe(0);
    expect(reports(posts).map((r) => [r.memberId, r.change, r.reason, r.keys])).toEqual([
      ["imgA", "refused", "stale", chunks.map((c) => c.key)],
    ]);
  });

  it("empty chunks array → no posts, no work", () => {
    const { ctx, posts } = makeMockCtx();
    oneSlotVolume(ctx, [0, 0, 0]);
    posts.length = 0;

    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", []), epochs(), "ds1", "imgA");

    expect(posts.length).toBe(0);
    expect(ctx.state.volumeAtlases.get("ds1")?.slots.size).toBe(0);
  });

  it("refuses a batch with no atlas, or no section for its member", () => {
    const { ctx, posts } = makeMockCtx();
    const chunk = makeChunk(0, 0, 0, 0, 0, 0);
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "missing-pool", "imgA");
    withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [chunk]), epochs(), "ds1", "imgA");

    expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([
      ["refused", "missing-pool", [chunk.key]],
      ["refused", "missing-entity-meta", [chunk.key]],
    ]);
  });

  it("after the target moves coarser, the slots never sampled go first, the greatest key among them", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = withView(ctx, getOrCreateVolumePool(ctx, "ds1", "ds1", 32, 32, 32, 0, "u16"));
    const level0 = makeVolumeMeta(2, 4, 4);
    const level1: LodIndirectionMeta = {
      level: 1, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], levelDims: [32, 64, 64], offset: 2 * 4 * 4,
    };
    layOut(viewOf(atlas), "imgA", [level0, level1]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 4 * 4 + 2 * 2).fill(0xFFFFFFFF);
    atlas.freeSlots = [2, 1, 0];
    testDraw(ctx).targetLevels = new Map([["imgA", 0]]);
    applyViewHotState(ctx, { type: "viewHotState", epochs: epochs(), datasetId: "ds1", view: 0, rayHitsByEntity: [["imgA", [0, 0, 0]]] });
    const level1Msg = (chunks: Chunk[], t = 0) =>
      makeVolumeMsg("imgA", chunks, { level: 1, t, levelWidth: 64, levelHeight: 64, levelDepth: 32 });
    const otherT = makeChunk(1, 1, 0, 0, 0, 0);
    const finer = makeChunk(0, 0, 0, 0, 0, 0);
    const far = makeChunk(1, 0, 0, 0, 1, 1);
    const incoming = makeChunk(1, 0, 0, 0, 0, 1);
    want(ctx, "imgA", [otherT.key, finer.key, far.key, incoming.key]);

    // Residents: a level-1 chunk at t=1 (unmapped at view T 0), the level-0
    // chunk at the ray hit, and a far level-1 chunk.
    handleVolumeChunkData(ctx, level1Msg([otherT], 1), epochs(), "ds1", "imgA");
    handleVolumeChunkData(ctx, makeVolumeMsg("imgA", [finer]), epochs(), "ds1", "imgA");
    handleVolumeChunkData(ctx, level1Msg([far]), epochs(), "ds1", "imgA");
    expect(atlas.slots.size).toBe(3);

    // The target moves to level 1: level 0 loses its section and the remap
    // unmaps its chunk, as a cold state would.
    layOut(viewOf(atlas), "imgA", [{ ...level1, offset: 0 }]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 2).fill(0xFFFFFFFF);
    remapIndirection(atlas, viewOf(atlas), 0, 0);
    testDraw(ctx).targetLevels = new Map([["imgA", 1]]);
    expect(viewOf(atlas).slotGridIdx[atlas.slots.get(`imgA|${finer.key}`)!]).toBe(-1);

    posts.length = 0;
    handleVolumeChunkData(ctx, level1Msg([incoming]), epochs(), "ds1", "imgA");

    expect(reports(posts, "lost").map((r) => r.keys)).toEqual([[otherT.key]]);
    expect([...atlas.slots.keys()].sort()).toEqual([`imgA|${finer.key}`, `imgA|${incoming.key}`, `imgA|${far.key}`].sort());
  });
});

// Slice admission and Z retargeting

describe("handleSliceChunkData — admission, eviction and Z retargeting", () => {
  /** Member A's slot key for `key` cut at level plane `plane`. */
  const sk = (key: string, plane = 0) => ["imgA", key, plane].join("|");

  /** A level-0 slice pool for member A over a 4 × 4 grid, drawn by a view cutting at full-res `z`. */
  function slicePool(ctx: WorkerCtx, z = 0) {
    testDraw(ctx).cold.currentZ = z;
    const atlas = withView(ctx, getOrCreateSlicePool(ctx, "ds1", "ds1", 32, 32, 0, "u16"));
    layOut(viewOf(atlas), "imgA", [makeSliceMeta(4, 4)]);
    viewOf(atlas).indirectionData = new Uint32Array(4 * 4).fill(0xFFFFFFFF);
    return atlas;
  }

  it("refuses a wanted chunk that does not hold the plane the sender's Z maps to", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = slicePool(ctx);
    // Plane 4 with chunkZ=4 is in chunk 1 along Z.
    const chunkAtZ0 = makeSliceChunk(0, 0, 0, 0, 0, 0);
    const chunkAtZ1 = makeSliceChunk(0, 0, 0, 1, 0, 0);
    want(ctx, "imgA", [chunkAtZ0.key, chunkAtZ1.key]);

    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunkAtZ0, chunkAtZ1], { plane: 4 }), epochs(), "ds1", "imgA");

    expect([...atlas.slots.keys()]).toEqual([sk(chunkAtZ1.key, 4)]);
    expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([
      ["held", undefined, [chunkAtZ1.key]],
      ["refused", "wrong-slice", [chunkAtZ0.key]],
    ]);
  });

  it.each([
    { cut: "along another axis", overrides: { sliceAxis: "y" as const } },
    { cut: "for other chunk dims", overrides: { chunkY: 64 } },
  ])("refuses a plane cut $cut than the pool it is routed to, and writes nothing", ({ overrides }) => {
    const { ctx, posts } = makeMockCtx();
    const atlas = slicePool(ctx);
    const write = vi.spyOn(ctx.device.queue, "writeTexture");
    const chunk = makeSliceChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [chunk.key]);

    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk], overrides), epochs(), "ds1", "imgA");

    expect(atlas.slots.size).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([
      ["refused", "wrong-slice", [chunk.key]],
    ]);
  });

  it("an equal-distance slice chunk never displaces a wanted resident: it is refused, and the resident stays", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = slicePool(ctx);
    atlas.freeSlots = [0];
    setCameraUVForMember(ctx.state, 0, "imgA", [0.5, 0.5]);
    // Columns 1 and 2 mirror each other about the camera.
    const left = makeSliceChunk(0, 0, 0, 0, 1, 1);
    const right = makeSliceChunk(0, 0, 0, 0, 1, 2);
    want(ctx, "imgA", [left.key, right.key]);
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [left]), epochs(), "ds1", "imgA");

    for (let round = 0; round < 3; round++) {
      posts.length = 0;
      handleSliceChunkData(ctx, makeSliceMsg("imgA", [right]), epochs(), "ds1", "imgA");
      expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([["refused", "atlas-policy", [right.key]]]);
      expect([...atlas.slots.keys()]).toEqual([sk(left.key)]);
    }
  });

  it.each([
    { scrub: "T", next: makeSliceChunk(0, 1, 0, 0, 0, 0), t: 1, c: 0 },
    { scrub: "C", next: makeSliceChunk(0, 0, 1, 0, 0, 0), t: 0, c: 1 },
  ])("a $scrub scrub on a full slice atlas replaces the old selection's chunk at the same position", ({ next, t, c }) => {
    const { ctx, posts } = makeMockCtx();
    const atlas = slicePool(ctx);
    atlas.freeSlots = [0];
    const old = makeSliceChunk(0, 0, 0, 0, 0, 0);
    want(ctx, "imgA", [old.key, next.key]);
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [old]), epochs(), "ds1", "imgA");
    expect(atlas.slots.has(sk(old.key))).toBe(true);

    remapSliceIndirection(atlas, viewOf(atlas), t, c, 0);
    posts.length = 0;
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [next], { t, c }), epochs(), "ds1", "imgA");

    expect([...atlas.slots.keys()]).toEqual([sk(next.key)]);
    expect(reports(posts).map((r) => [r.change, r.keys])).toEqual([
      ["held", [next.key]],
      ["lost", [old.key]],
    ]);
  });

  it("a Z step inside one chunk never draws the old plane, and the re-sent chunk is re-cut in place", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = slicePool(ctx, 4);
    // Planes 4 and 5 are both in chunk 1 along Z (chunks are 4 planes deep).
    const chunk = makeSliceChunk(0, 0, 0, 1, 0, 0);
    want(ctx, "imgA", [chunk.key]);
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk], { plane: 4 }), epochs(), "ds1", "imgA");
    const slot = atlas.slots.get(sk(chunk.key, 4))!;
    expect(viewOf(atlas).indirectionData[0]).toBe(slot);

    // The cold state at Z 5 keeps plane 4 resident but must not show it.
    testDraw(ctx).cold.currentZ = 5;
    remapSliceIndirection(atlas, viewOf(atlas), 0, 0, 5);
    expect(atlas.slots.has(sk(chunk.key, 4))).toBe(true);
    expect(viewOf(atlas).indirectionData[0]).toBe(0xFFFFFFFF);

    const writeCount = () => (ctx.device.queue.writeTexture as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const writes = writeCount();
    posts.length = 0;
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk], { plane: 5 }), epochs(), "ds1", "imgA");
    expect([...atlas.slots]).toEqual([[sk(chunk.key, 5), slot]]);
    expect(viewOf(atlas).indirectionData[0]).toBe(slot);
    expect(writeCount()).toBe(writes + 1);
    // Plane 4 is handed back, so a view that cuts it again is sent it.
    expect(reports(posts).map((r) => [r.change, r.keys, r.cut?.plane])).toEqual([
      ["held", [chunk.key], 5],
      ["lost", [chunk.key], 4],
    ]);

    // The same plane again is already resident: held, and nothing written.
    posts.length = 0;
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk], { plane: 5 }), epochs(), "ds1", "imgA");
    expect(writeCount()).toBe(writes + 1);
    expect(reports(posts).map((r) => [r.change, r.keys])).toEqual([["held", [chunk.key]]]);
  });

  it("keeps a plane the pool still draws, and gives another plane of the chunk a slot of its own", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = slicePool(ctx, 4);
    const chunk = makeSliceChunk(0, 0, 0, 1, 0, 0);
    want(ctx, "imgA", [chunk.key]);
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk], { plane: 4 }), epochs(), "ds1", "imgA");
    const drawn = atlas.slots.get(sk(chunk.key, 4))!;

    // Plane 5 of the same chunk, cut ahead of a cold state that still draws plane 4.
    posts.length = 0;
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk], { plane: 5 }), epochs(), "ds1", "imgA");

    const other = atlas.slots.get(sk(chunk.key, 5))!;
    expect(other).not.toBe(drawn);
    expect(atlas.slots.get(sk(chunk.key, 4))).toBe(drawn);
    expect(viewOf(atlas).indirectionData[0]).toBe(drawn);
    expect([...atlas.planesByChunk.get(`imgA|${chunk.key}`)!]).toEqual([[4, drawn], [5, other]]);
    expect(reports(posts).map((r) => [r.change, r.keys])).toEqual([["held", [chunk.key]]]);
  });

  it("refuses a batch with no slice atlas", () => {
    const { ctx, posts } = makeMockCtx();
    const chunk = makeSliceChunk(0, 0, 0, 0, 0, 0);

    handleSliceChunkData(ctx, makeSliceMsg("imgA", [chunk]), epochs(), "missing-pool", "imgA");

    expect(reports(posts).map((r) => [r.change, r.reason, r.keys])).toEqual([["refused", "missing-pool", [chunk.key]]]);
  });

  it("after the target moves coarser, the planes never sampled go first, the greatest key among them", () => {
    const { ctx, posts } = makeMockCtx();
    const atlas = withView(ctx, getOrCreateSlicePool(ctx, "ds1", "ds1", 32, 32, 0, "u16"));
    const level0 = makeSliceMeta(4, 4);
    const level1: LodIndirectionMeta = {
      level: 1, gridDims: [1, 2, 2], chunkDims: [4, 32, 32], levelDims: [64, 64, 64], offset: 4 * 4,
    };
    layOut(viewOf(atlas), "imgA", [level0, level1]);
    viewOf(atlas).indirectionData = new Uint32Array(4 * 4 + 2 * 2).fill(0xFFFFFFFF);
    atlas.freeSlots = [2, 1, 0];
    testDraw(ctx).targetLevels = new Map([["imgA", 0]]);
    setCameraUVForMember(ctx.state, 0, "imgA", [0.0, 0.0]);
    const level1Msg = (chunks: Chunk[], t = 0) =>
      makeSliceMsg("imgA", chunks, { level: 1, t, levelWidth: 64, levelHeight: 64 });
    const otherT = makeSliceChunk(1, 1, 0, 0, 0, 0);
    const finer = makeSliceChunk(0, 0, 0, 0, 0, 0);
    const far = makeSliceChunk(1, 0, 0, 0, 1, 1);
    const incoming = makeSliceChunk(1, 0, 0, 0, 0, 1);
    want(ctx, "imgA", [otherT.key, finer.key, far.key, incoming.key]);

    handleSliceChunkData(ctx, level1Msg([otherT], 1), epochs(), "ds1", "imgA");
    handleSliceChunkData(ctx, makeSliceMsg("imgA", [finer]), epochs(), "ds1", "imgA");
    handleSliceChunkData(ctx, level1Msg([far]), epochs(), "ds1", "imgA");
    expect(atlas.slots.size).toBe(3);

    layOut(viewOf(atlas), "imgA", [{ ...level1, offset: 0 }]);
    viewOf(atlas).indirectionData = new Uint32Array(2 * 2).fill(0xFFFFFFFF);
    remapSliceIndirection(atlas, viewOf(atlas), 0, 0, 0);
    testDraw(ctx).targetLevels = new Map([["imgA", 1]]);
    expect(viewOf(atlas).slotGridIdx[atlas.slots.get(sk(finer.key))!]).toBe(-1);

    posts.length = 0;
    handleSliceChunkData(ctx, level1Msg([incoming]), epochs(), "ds1", "imgA");

    expect(reports(posts, "lost").map((r) => r.keys)).toEqual([[otherT.key]]);
    expect([...atlas.slots.keys()].sort()).toEqual([sk(finer.key), sk(incoming.key), sk(far.key)].sort());
  });
});

// The eviction kernel on its own

describe("eviction kernel — chunkDistSq", () => {
  it("2D distance: cz=null strips Z entirely", () => {
    const meta = makeSliceMeta(4, 4);
    // Chunk at grid (1,1) with chunkDims [4,32,32] and levelDims
    // [64,128,128] → center at ((1+0.5)*32/128, (1+0.5)*32/128) =
    // (0.375, 0.375).
    const d = chunkDistSq(meta, 1, 1, null, [0.375, 0.375]);
    expect(d).toBeCloseTo(0, 6);
  });

  it("3D distance: includes the Z term", () => {
    const meta = makeVolumeMeta(2, 4, 4);
    // Chunk at grid (1,1,1) with chunkDims [32,32,32] and levelDims
    // [64,128,128] → center at ((1+0.5)*32/128, *, *) for Y/X and
    // ((1+0.5)*32/64) for Z = 0.75. So center is (0.375, 0.375, 0.75).
    const d3 = chunkDistSq(meta, 1, 1, 1, [0.375, 0.375, 0.75]);
    expect(d3).toBeCloseTo(0, 6);

    // Asymmetry check: moving the Z reference changes the distance.
    const dShift = chunkDistSq(meta, 1, 1, 1, [0.375, 0.375, 0.0]);
    expect(dShift).toBeGreaterThan(0);
  });
});

describe("eviction kernel — findEvictionSlot", () => {
  const level2: LodIndirectionMeta = {
    level: 2, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], levelDims: [32, 64, 64], offset: 0,
  };
  const level3: LodIndirectionMeta = {
    level: 3, gridDims: [1, 1, 1], chunkDims: [32, 32, 32], levelDims: [32, 32, 32], offset: 4,
  };
  const corner = () => [0.0, 0.0, 0.0] as [number, number, number];
  const all = () => true;

  type PickOptions = Partial<Omit<EvictionView, "slotGridIdx">> & { is3D?: boolean };

  /** One view of a pool, mapping slot i to `gridIdx[i]`. */
  function view(gridIdx: number[], overrides: Partial<Omit<EvictionView, "slotGridIdx">> = {}): EvictionView {
    return {
      slotGridIdx: new Int32Array(gridIdx),
      entityMetas: new Map([["memA", [makeVolumeMeta(2, 4, 4)]]]),
      cameraFor: corner,
      targetLevelFor: () => 0,
      isWanted: all,
      sources: [],
      ...overrides,
    };
  }

  /** Pick from slots in the order given, slot i at index i, as one view maps them. */
  function pick(keys: string[], gridIdx: number[], { is3D = true, ...overrides }: PickOptions = {}) {
    return findEvictionSlot({
      slots: new Map(keys.map((key, i) => [key, i])),
      views: [view(gridIdx, overrides)],
      is3D,
    });
  }

  it("holds nothing to evict in an empty pool", () => {
    expect(pick([], [])).toBeNull();
  });

  it("takes an unmapped slot before any mapped one", () => {
    expect(pick([`memA|0/0/0/0/0/0`, `memA|0/0/0/0/0/1`], [0, -1])).toEqual({
      key: `memA|0/0/0/0/0/1`, class: "unsampled", dist: Infinity,
    });
  });

  it("counts a slot whose member has no section as never sampled", () => {
    expect(pick([`memGone|0/0/0/0/0/0`], [0])).toEqual({
      key: `memGone|0/0/0/0/0/0`, class: "unsampled", dist: Infinity,
    });
  });

  it("among wanted chunks, takes the farthest from the camera reference", () => {
    const result = pick([`memA|0/0/0/0/0/0`, `memA|0/0/0/1/3/3`], [0, 1])!;
    expect(result.key).toBe(`memA|0/0/0/1/3/3`);
    expect(result.class).toBe("wanted");
    expect(result.dist).toBeGreaterThan(0);
  });

  it("drops Z from the distance in 2D, and breaks the tie by key", () => {
    const result = pick([`memA|0/0/0/0/2/2`, `memA|0/0/0/1/2/2`], [0, 1], {
      entityMetas: new Map([["memA", [makeSliceMeta(4, 4)]]]),
      cameraFor: () => [0.0, 0.0] as [number, number],
      is3D: false,
    })!;
    expect(result.key).toBe(`memA|0/0/0/1/2/2`);
  });

  it("breaks a distance tie by key, whatever order the chunks arrived in", () => {
    const left = `memA|0/0/0/0/1/1`;
    const right = `memA|0/0/0/0/1/2`;
    const options: PickOptions = {
      entityMetas: new Map([["memA", [makeSliceMeta(4, 4)]]]),
      // Columns 1 and 2 of the 4 × 4 grid mirror each other about the camera.
      cameraFor: () => [0.5, 0.5] as [number, number],
      is3D: false,
    };
    expect(pick([left, right], [0, 1], options)!.key).toBe(right);
    expect(pick([right, left], [0, 1], options)!.key).toBe(right);
  });

  it("takes any chunk finer than the target, or unmapped, before a mapped one, the greatest key first whatever the slot order", () => {
    const keys = [
      `memA|2/1/0/0/0/0`, // target level, another timepoint: unmapped
      `memA|5/0/0/0/0/0`, // coarser than every resident level: unmapped
      `memA|2/0/0/0/1/1`, // target level, mapped, far corner
      `memA|0/0/0/0/0/0`, // finer than the target
    ];
    const options: PickOptions = {
      entityMetas: new Map([["memA", [level2]]]),
      targetLevelFor: () => 2,
    };
    expect(pick(keys, [-1, -1, 3, -1], options)).toEqual({ key: `memA|5/0/0/0/0/0`, class: "unsampled", dist: Infinity });
    expect(pick([...keys].reverse(), [-1, 3, -1, -1], options)).toEqual({ key: `memA|5/0/0/0/0/0`, class: "unsampled", dist: Infinity });
  });

  it("counts a chunk finer than the target as never sampled, even while still mapped", () => {
    const options: PickOptions = {
      entityMetas: new Map([["memA", [level2, { ...level2, level: 1 }]]]),
      targetLevelFor: () => 2,
    };
    expect(pick([`memA|2/0/0/0/1/1`, `memA|1/0/0/0/0/0`], [3, 0], options)).toEqual({
      key: `memA|1/0/0/0/0/0`, class: "unsampled", dist: Infinity,
    });
  });

  it("takes a mapped chunk the planner no longer wants before any wanted one, the farthest first", () => {
    // From the corner: the level-2 chunk at (0,0) is 0.375 away, the level-3
    // chunk 0.75, the level-2 chunk at (1,1) 1.375 (squared, normalized).
    const options: PickOptions = {
      entityMetas: new Map([["memA", [level2, level3]]]),
      targetLevelFor: () => 2,
      isWanted: (_member, chunkKey) => chunkKey.startsWith("2/"),
    };
    const fallback = pick([`memA|2/0/0/0/0/0`, `memA|3/0/0/0/0/0`, `memA|2/0/0/0/1/1`], [0, 4, 3], options)!;
    expect(fallback.key).toBe(`memA|3/0/0/0/0/0`);
    expect(fallback.class).toBe("unwanted");
    expect(fallback.dist).toBeCloseTo(0.75, 6);

    // With nothing unwanted, the farthest wanted chunk, whatever its level.
    const wanted = pick([`memA|2/0/0/0/0/0`, `memA|3/0/0/0/0/0`, `memA|2/0/0/0/1/1`], [0, 4, 3], { ...options, isWanted: all })!;
    expect(wanted.key).toBe(`memA|2/0/0/0/1/1`);
    expect(wanted.class).toBe("wanted");
    expect(wanted.dist).toBeCloseTo(1.375, 6);
  });

  it("classes a slot by the views that sample it: unsampled only when none does, wanted when one that maps it wants it", () => {
    const keys = [`memA|0/0/0/0/0/0`, `memA|0/0/0/1/3/3`];
    const slots = new Map(keys.map((key, i) => [key, i]));
    const near = view([0, -1], { isWanted: () => false });
    const far = view([-1, 1], { isWanted: () => false });
    // Each slot is mapped by one view, and neither view wants it.
    expect(findEvictionSlot({ slots, views: [near, far], is3D: true })).toMatchObject({ key: keys[1], class: "unwanted" });
    // A view that wants the far chunk but does not map it leaves it unwanted.
    const wantsAll = view([0, -1]);
    expect(findEvictionSlot({ slots, views: [wantsAll, far], is3D: true })).toMatchObject({ key: keys[1], class: "unwanted" });
    // The far chunk is wanted by the view that maps it, so the near one goes first.
    expect(findEvictionSlot({ slots, views: [near, view([-1, 1])], is3D: true })).toMatchObject({ key: keys[0], class: "unwanted" });
  });

  it("measures a slot from the nearest camera of a view that samples it", () => {
    const key = `memA|0/0/0/1/3/3`;
    const atCorner = view([0]);
    const atChunk = view([0], { cameraFor: () => [0.875, 0.875, 0.75] as [number, number, number] });
    const alone = findEvictionSlot({ slots: new Map([[key, 0]]), views: [atCorner], is3D: true })!;
    const both = findEvictionSlot({ slots: new Map([[key, 0]]), views: [atCorner, atChunk], is3D: true })!;
    expect(alone.dist).toBeGreaterThan(0);
    expect(both.dist).toBeCloseTo(0, 6);
  });

  it("lets a wanted chunk take an unwanted slot at any distance, and a wanted slot only when strictly nearer", () => {
    expect(mayEvict({ key: "k", class: "unsampled", dist: Infinity }, () => 10)).toBe(true);
    expect(mayEvict({ key: "k", class: "unwanted", dist: 0.1 }, () => 10)).toBe(true);
    expect(mayEvict({ key: "k", class: "wanted", dist: 0.5 }, () => 0.4)).toBe(true);
    expect(mayEvict({ key: "k", class: "wanted", dist: 0.5 }, () => 0.5)).toBe(false);
  });
});
