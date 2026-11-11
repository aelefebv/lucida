/**
 * GPU pool lifetime, through the worker dispatcher on a mock device that
 * counts live textures and buffers: removing a dataset frees what it owned, a
 * cold state frees the pools it no longer routes to, and a reopened dataset
 * starts from empty pools.
 */

import { describe, expect, it } from "vitest";

import type { WorkerCtx } from "../workerContext.ts";

import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  GpuCapacityMessage,
  GpuMemoryMessage,
  LabelSliceChunkDataMessage,
  SliceChunkDataMessage,
  VolumeChunkDataMessage,
  WorkerToMainMessage,
} from "../workerProtocol.ts";

import { getOrCreateLabelSlicePool } from "../slice/index.ts";
import { getOrCreateLabelVolumePool } from "../volume/index.ts";
import type { SliceAtlasState } from "../slice/index.ts";
import { UNTIMED } from "../passTiming.ts";
import { labelSlicePoolKey } from "../labelPools.ts";
import { createInitialState } from "./state.ts";
import { drawOf } from "./draws.ts";
import { dispatchMessage } from "./dispatch.ts";
import { measureGpuMemory } from "./gpuBudget.ts";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 };

interface MockResource { destroyed: boolean; destroy(): void }
type MockTexture = MockResource & Pick<GPUTexture, "width" | "height" | "depthOrArrayLayers" | "format">;
type MockBuffer = MockResource & { size: number };

/** A device that keeps every texture and buffer it hands out, so a test can count the live ones. */
function trackingDevice() {
  const textures: MockTexture[] = [];
  const buffers: MockBuffer[] = [];
  const device = {
    createTexture(desc: GPUTextureDescriptor): MockTexture {
      const [width, height = 1, depthOrArrayLayers = 1] = desc.size as number[];
      const texture = {
        width, height, depthOrArrayLayers, format: desc.format,
        destroyed: false,
        destroy() { this.destroyed = true; },
      };
      textures.push(texture);
      return texture;
    },
    createBuffer(desc: GPUBufferDescriptor): MockBuffer {
      const buffer = { size: desc.size, destroyed: false, destroy() { this.destroyed = true; } };
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: () => ({ copyTextureToTexture() {}, finish: () => ({}) }),
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
  } as unknown as GPUDevice;
  return {
    device,
    live: () => ({
      textures: textures.filter((t) => !t.destroyed).length,
      buffers: buffers.filter((b) => !b.destroyed).length,
    }),
  };
}

function makeCtx(device: GPUDevice): { ctx: WorkerCtx; posts: WorkerToMainMessage[] } {
  const posts: WorkerToMainMessage[] = [];
  const ctx: WorkerCtx = {
    device,
    context: {} as GPUCanvasContext,
    format: "bgra8unorm",
    state: createInitialState(),
    passTimer: UNTIMED,
    getSliceRenderer: () => ({} as never),
    getVolumeRenderer: () => ({} as never),
    getCompositor: () => ({} as never),
    getCursorRenderer: () => ({} as never),
    getViewLander: () => ({} as never),
    ensureOffscreenPool: () => [],
    getOrCreateLUT: () => ({} as GPUTexture),
    post: (msg) => { posts.push(msg); },
    postWantedSet: () => {},
    lookupEntityDescriptor: () => null,
  };
  return { ctx, posts };
}

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 0 };

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

const display = { contrastMin: 0, contrastMax: 1, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 };

type Levels = ColdStateActiveEntry["levels"];

/** Four levels of 32³ chunks, then two of 16³, so zooming in leaves the 16³ shape unused. */
const TWO_SHAPES: Levels = [
  { level: 0, chunkShape: [32, 32, 32], gridShape: [4, 8, 8], levelDims: [128, 256, 256] },
  { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
  { level: 2, chunkShape: [32, 32, 32], gridShape: [1, 2, 2], levelDims: [32, 64, 64] },
  { level: 3, chunkShape: [32, 32, 32], gridShape: [1, 1, 1], levelDims: [16, 32, 32] },
  { level: 4, chunkShape: [16, 16, 16], gridShape: [1, 1, 1], levelDims: [8, 16, 16] },
  { level: 5, chunkShape: [16, 16, 16], gridShape: [1, 1, 1], levelDims: [4, 8, 8] },
];

function tile(entityId: string, target: number, coarseLevel: number | null = 5): ColdStateActiveEntry {
  return {
    entityId,
    imageId: entityId,
    levels: TWO_SHAPES,
    detailLevels: [target],
    coarseLevel,
    modelMatrix: identity(),
    invModelMatrix: identity(),
    displayStateByChannel: { 0: display, 1: display, 2: display },
  };
}

function cold(datasetId: string, opts: Partial<ColdStateMessage> = {}): ColdStateMessage {
  const visibleChannels = opts.visibleChannels ?? [0];
  return {
    type: "coldState",
    labels: [],
    epochs: EPOCHS,
    datasetId,
    currentT: 0,
    currentZ: 0,
    visibleChannels,
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 128],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    // The planner wants the one chunk `chunkAt` delivers, in every channel.
    wantedChunks: visibleChannels.map((c) => ({
      memberId: `${datasetId}-img:ch${c}`,
      tier: "detail" as const,
      chunkKeys: ["2/0/0/0/0/0"],
    })),
    activeSet: [tile(`${datasetId}-img`, 2)],
    view: 0,
    viewMode: "volume",
    drawnViews: [opts.view ?? 0],
    sampleFormat: "u16",
    ...opts,
  };
}

/** One 32³ chunk at level 2, grid cell (0,0,0). */
function chunkAt(memberId: string): VolumeChunkDataMessage {
  return {
    type: "volumeChunkData",
    epochs: EPOCHS,
    tier: "detail",
    memberId,
    chunks: [{ data: new Uint16Array(32 * 32 * 32).fill(7).buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: "2/0/0/0/0/0" }],
    level: 2,
    t: 0,
    c: 0,
    levelWidth: 64,
    levelHeight: 64,
    levelDepth: 32,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 32,
  };
}

/** Plane `plane` of level 2's one chunk along Z, at T `t`. */
function planeAt(memberId: string, plane: number, t = 0): SliceChunkDataMessage {
  return {
    type: "sliceChunkData",
    epochs: EPOCHS,
    tier: "detail",
    memberId,
    chunks: [{ data: new Uint16Array(32 * 32).fill(7).buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: `2/${t}/0/0/0/0` }],
    level: 2,
    t,
    c: 0,
    levelWidth: 64,
    levelHeight: 64,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 32,
    fullResDepth: 128,
    levelDepth: 32,
    plane,
  };
}

/** The views whose indirection over `pool` maps `slot`. */
function viewsMapping(pool: { views: Map<number, { slotGridIdx: Int32Array }> }, slot: number): number[] {
  return [...pool.views].filter(([, view]) => view.slotGridIdx[slot] >= 0).map(([id]) => id).sort();
}

function poolKeysOf(ctx: WorkerCtx, datasetId: string): string[] {
  return [...ctx.state.volumeAtlases, ...ctx.state.sliceAtlases]
    .filter(([, pool]) => pool.datasetId === datasetId)
    .map(([key]) => key)
    .sort();
}

describe("a dataset no view plans", () => {
  it("keeps its pools and the chunks they hold, wanting none of them", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1"));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch0"));
    const pool = ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!;
    posts.length = 0;

    await dispatchMessage(ctx, { type: "datasetUnplanned", datasetId: "ds1" });

    expect(pool.slots.size).toBe(1);
    expect(drawOf(ctx.state, "ds1", 0)!.wanted.size).toBe(0);
    expect(posts).toEqual([]);
  });
});

describe("removing a dataset", () => {
  it("destroys every texture and buffer it allocated, and leaves another dataset's alone", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);

    await dispatchMessage(ctx, cold("other"));
    const otherPools = poolKeysOf(ctx, "other").map((key) => ctx.state.volumeAtlases.get(key)!);
    const baseline = gpu.live();

    await dispatchMessage(ctx, cold("ds1", { visibleChannels: [0, 1] }));
    await dispatchMessage(ctx, chunkAt(`ds1-img:ch0`));
    expect(ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!.slots.size).toBe(1);
    getOrCreateLabelSlicePool(ctx, "label", "ds1", 0, 0, 64, 64, 32, 32);
    getOrCreateLabelVolumePool(ctx, "label", "ds1", 0, 64, 64, 32, 32, 32, 32);
    expect(gpu.live().textures).toBeGreaterThan(baseline.textures);

    await dispatchMessage(ctx, { type: "removeLayerResources", datasetId: "ds1" });

    expect(gpu.live()).toEqual(baseline);
    expect(poolKeysOf(ctx, "ds1")).toEqual([]);
    expect(ctx.state.labelSlicePools.size).toBe(0);
    expect(ctx.state.labelVolumePools.size).toBe(0);
    expect(poolKeysOf(ctx, "other").map((key) => ctx.state.volumeAtlases.get(key))).toEqual(otherPools);
  });

  it("leaves the dataset's pools when the id names one of its members", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1", { visibleChannels: [0, 1] }));
    const before = gpu.live();

    await dispatchMessage(ctx, { type: "removeLayerResources", datasetId: "ds1-img:ch0" });

    expect(gpu.live()).toEqual(before);
  });

  it("starts a reopened dataset from empty pools", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1"));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch0"));
    const poolKey = "ds1:ch0:32x32x32:detail";
    const first = ctx.state.volumeAtlases.get(poolKey)!;
    expect(first.slots.size).toBe(1);

    await dispatchMessage(ctx, { type: "removeLayerResources", datasetId: "ds1" });
    await dispatchMessage(ctx, cold("ds1"));

    const reopened = ctx.state.volumeAtlases.get(poolKey)!;
    expect(reopened).not.toBe(first);
    expect(reopened.slots.size).toBe(0);
  });
});

describe("a cold state frees the pools it no longer routes to", () => {
  it("frees a hidden channel's pools and keeps the others with their chunks", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1", { visibleChannels: [0, 1, 2] }));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch0"));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch1"));
    const ch0 = ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!;
    const ch1 = ctx.state.volumeAtlases.get("ds1:ch1:32x32x32:detail")!;
    const before = gpu.live();
    posts.length = 0;

    await dispatchMessage(ctx, cold("ds1", { visibleChannels: [0, 2] }));

    expect(poolKeysOf(ctx, "ds1").some((key) => key.includes(":ch1:"))).toBe(false);
    expect((ch1.texture as unknown as MockTexture).destroyed).toBe(true);
    // Channel 1 held a detail pool per chunk shape and a coarse pool.
    expect(gpu.live().textures).toBe(before.textures - 3);
    expect(ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")).toBe(ch0);
    expect(ch0.slots.size).toBe(1);
    // The page hears what went with the freed pool, so it sends it again when the channel returns.
    expect(posts.filter((m) => m.type === "chunkResidency")).toEqual([
      { type: "chunkResidency", memberId: "ds1-img:ch1", viewMode: "volume", tier: "detail", change: "lost", keys: ["2/0/0/0/0/0"], reason: "freed" },
    ]);
  });

  it("frees the other view mode's pools on a switch between volume and slice", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1"));
    const volumeTextures = [...ctx.state.volumeAtlases.values()].map((pool) => pool.texture as unknown as MockTexture);
    expect(volumeTextures.length).toBeGreaterThan(0);

    await dispatchMessage(ctx, cold("ds1", { viewMode: "slice" }));
    expect(ctx.state.volumeAtlases.size).toBe(0);
    expect(volumeTextures.every((texture) => texture.destroyed)).toBe(true);
    const sliceTextures = [...ctx.state.sliceAtlases.values()].map((pool) => pool.texture as unknown as MockTexture);
    expect(sliceTextures.length).toBeGreaterThan(0);

    await dispatchMessage(ctx, cold("ds1"));
    expect(ctx.state.sliceAtlases.size).toBe(0);
    expect(sliceTextures.every((texture) => texture.destroyed)).toBe(true);
  });

  it("keeps a dataset's slice and volume pools while views of both modes draw it, and frees a mode's once none does", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    // View 0 draws the dataset in 3D and view 1 in 2D.
    await dispatchMessage(ctx, cold("ds1", { view: 0, drawnViews: [0, 1] }));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch0"));
    await dispatchMessage(ctx, cold("ds1", { view: 1, viewMode: "slice", drawnViews: [0, 1] }));
    const volumePools = [...ctx.state.volumeAtlases.values()];
    expect(volumePools.length).toBeGreaterThan(0);
    expect(ctx.state.sliceAtlases.size).toBeGreaterThan(0);
    expect(ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!.slots.size).toBe(1);
    // Each view routes its own uploads and keeps its own cold state.
    expect(drawOf(ctx.state, "ds1", 0)?.routes.get("ds1-img:ch0")?.get("detail:2")).toBe("ds1:ch0:32x32x32:detail");
    expect(drawOf(ctx.state, "ds1", 1)?.routes.get("ds1-img:ch0")?.get("detail:2")).toBe("ds1:ch0:32x32:detail");
    expect([...ctx.state.draws.keys()].sort()).toEqual(["ds1|0", "ds1|1"]);

    // Another volume cold state leaves the slice pools be.
    const slicePools = [...ctx.state.sliceAtlases.values()];
    await dispatchMessage(ctx, cold("ds1", { view: 0, drawnViews: [0, 1] }));
    expect([...ctx.state.sliceAtlases.values()]).toEqual(slicePools);
    posts.length = 0;

    // The volume view goes: its pools and what laid them out go too, and the
    // page hears their chunks went.
    await dispatchMessage(ctx, cold("ds1", { view: 1, viewMode: "slice", drawnViews: [1] }));
    expect(ctx.state.volumeAtlases.size).toBe(0);
    expect(volumePools.every((pool) => (pool.texture as unknown as MockTexture).destroyed)).toBe(true);
    expect([...ctx.state.sliceAtlases.values()]).toEqual(slicePools);
    expect([...ctx.state.draws.keys()]).toEqual(["ds1|1"]);
    expect(posts.filter((m) => m.type === "chunkResidency")).toContainEqual(
      { type: "chunkResidency", memberId: "ds1-img:ch0", viewMode: "volume", tier: "detail", change: "lost", keys: ["2/0/0/0/0/0"], reason: "freed" },
    );
    // So does the view's level readout.
    expect(posts).toContainEqual({ type: "entityLevels", datasetId: "ds1", view: 0, entities: [] });
  });

  it("holds the chunks two views of one mode draw once, and keeps them until the last of the views goes", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1", { view: 0, drawnViews: [0, 1] }));
    await dispatchMessage(ctx, cold("ds1", { view: 1, drawnViews: [0, 1] }));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch0"));
    const pool = ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!;
    // One slot, mapped into each view's own indirection.
    expect(pool.slots.size).toBe(1);
    const slot = [...pool.slots.values()][0];
    expect([...pool.views.keys()].sort()).toEqual([0, 1]);
    for (const view of pool.views.values()) {
      expect(view.slotGridIdx[slot]).toBeGreaterThanOrEqual(0);
      expect(view.indirectionData[view.slotGridIdx[slot]]).toBe(slot);
    }
    expect(pool.views.get(0)!.indirectionBuf).not.toBe(pool.views.get(1)!.indirectionBuf);
    posts.length = 0;

    // View 1 stops drawing the dataset: its indirection goes, the slot stays.
    const leaving = pool.views.get(1)!.indirectionBuf as unknown as MockBuffer;
    await dispatchMessage(ctx, cold("ds1", { view: 0, drawnViews: [0] }));
    expect(ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")).toBe(pool);
    expect([...pool.views.keys()]).toEqual([0]);
    expect(leaving.destroyed).toBe(true);
    expect(pool.slots.size).toBe(1);
    expect(posts.filter((m) => m.type === "chunkResidency")).toEqual([]);
  });

  it("maps a brick into the views at its timepoint only, each holding its own slot", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    const atT = (t: number) => [{ memberId: "ds1-img:ch0", tier: "detail" as const, chunkKeys: [`2/${t}/0/0/0/0`] }];
    await dispatchMessage(ctx, cold("ds1", { view: 0, drawnViews: [0, 1] }));
    await dispatchMessage(ctx, cold("ds1", { view: 1, currentT: 1, wantedChunks: atT(1), drawnViews: [0, 1] }));
    await dispatchMessage(ctx, chunkAt("ds1-img:ch0"));
    await dispatchMessage(ctx, { ...chunkAt("ds1-img:ch0"), t: 1, chunks: [{ ...chunkAt("").chunks[0], key: "2/1/0/0/0/0" }] });

    const pool = ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!;
    expect(pool.slots.size).toBe(2);
    expect(viewsMapping(pool, pool.slots.get("ds1-img:ch0|2/0/0/0/0/0")!)).toEqual([0]);
    expect(viewsMapping(pool, pool.slots.get("ds1-img:ch0|2/1/0/0/0/0")!)).toEqual([1]);
  });

  it("keeps a plane another view draws when a view moves through the chunk, and re-cuts only its own", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    const slice = { viewMode: "slice" as const, drawnViews: [0, 1] };
    // Level 2 is 32 planes deep, a quarter of level 0: Z 4 cuts its plane 1, Z 20 its plane 5.
    await dispatchMessage(ctx, cold("ds1", { ...slice, view: 0, currentZ: 4 }));
    await dispatchMessage(ctx, cold("ds1", { ...slice, view: 1, currentZ: 20 }));
    await dispatchMessage(ctx, planeAt("ds1-img:ch0", 1));
    await dispatchMessage(ctx, planeAt("ds1-img:ch0", 5));

    const pool = ctx.state.sliceAtlases.get("ds1:ch0:32x32:detail")!;
    const first = pool.slots.get("ds1-img:ch0|2/0/0/0/0/0|1")!;
    const other = pool.slots.get("ds1-img:ch0|2/0/0/0/0/0|5")!;
    expect(pool.slots.size).toBe(2);
    expect(viewsMapping(pool, first)).toEqual([0]);
    expect(viewsMapping(pool, other)).toEqual([1]);

    // View 0 steps to Z 8, plane 2: it re-cuts its own plane's slot in place,
    // and view 1's plane stays.
    await dispatchMessage(ctx, cold("ds1", { ...slice, view: 0, currentZ: 8 }));
    await dispatchMessage(ctx, planeAt("ds1-img:ch0", 2));
    expect([...pool.slots].sort()).toEqual([
      ["ds1-img:ch0|2/0/0/0/0/0|2", first],
      ["ds1-img:ch0|2/0/0/0/0/0|5", other],
    ]);
    expect(viewsMapping(pool, first)).toEqual([0]);
    expect(viewsMapping(pool, other)).toEqual([1]);
  });

  it("frees a chunk shape that no resident level uses after a zoom", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    // Target 2 keeps levels 2 to 5 resident, across both chunk shapes.
    await dispatchMessage(ctx, cold("ds1", { activeSet: [tile("ds1-img", 2, null)] }));
    expect(poolKeysOf(ctx, "ds1")).toEqual(["ds1:ch0:16x16x16:detail", "ds1:ch0:32x32x32:detail"]);

    // Target 0 keeps levels 0 to 3, all 32³.
    await dispatchMessage(ctx, cold("ds1", { activeSet: [tile("ds1-img", 0, null)] }));
    expect(poolKeysOf(ctx, "ds1")).toEqual(["ds1:ch0:32x32x32:detail"]);
  });

  it("leaves another dataset's pools alone", async () => {
    const gpu = trackingDevice();
    const { ctx } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("other", { viewMode: "slice" }));
    const other = poolKeysOf(ctx, "other");

    await dispatchMessage(ctx, cold("ds1"));

    expect(poolKeysOf(ctx, "other")).toEqual(other);
  });
});

/** Plane `plane` of the label's one chunk at level 0, T 0. */
function labelPlane(plane: number): LabelSliceChunkDataMessage {
  return {
    type: "labelSliceChunkData",
    epochs: EPOCHS,
    memberId: "label",
    datasetId: "ds1",
    chunks: [{ data: new Uint32Array(32 * 32).buffer, dataType: "uint32", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
    level: 0, t: 0, c: 0,
    levelWidth: 64, levelHeight: 64, chunkX: 32, chunkY: 32, plane,
  };
}

/** A slice view `view` of ds1 drawing the label at plane `plane`, beside the views `drawnViews`. */
function sliceWithLabel(view: number, plane: number, drawnViews: number[] = [view]): ColdStateMessage {
  return cold("ds1", { viewMode: "slice", view, drawnViews, labels: [{ memberId: "label", t: 0, plane }] });
}

function residency(posts: unknown[]): unknown[] {
  return posts.filter((m) => (m as { type: string }).type === "chunkResidency");
}

describe("label pools live as long as a view draws their form", () => {
  it("frees the other mode's label pool on a switch and reports its chunks lost", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, sliceWithLabel(0, 0));
    await dispatchMessage(ctx, labelPlane(0));
    const labelTexture = ctx.state.labelSlicePools.get(labelSlicePoolKey("label", 0, 0))!.texture as unknown as MockTexture;
    const report = { type: "chunkResidency", memberId: "label", viewMode: "slice", tier: "detail", cut: { axis: "z", plane: 0 } };
    expect(residency(posts)).toContainEqual({ ...report, change: "held", keys: ["0/0/0/0/0/0"], reason: undefined });
    posts.length = 0;

    await dispatchMessage(ctx, cold("ds1"));

    expect(ctx.state.labelSlicePools.size).toBe(0);
    expect(labelTexture.destroyed).toBe(true);
    expect(residency(posts)).toContainEqual({ ...report, change: "lost", keys: ["0/0/0/0/0/0"], reason: "freed" });
  });

  it("gives each plane two views cut a label at its own pool, and frees one when both cut the same plane", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, sliceWithLabel(0, 1, [0, 1]));
    await dispatchMessage(ctx, sliceWithLabel(1, 5, [0, 1]));
    await dispatchMessage(ctx, labelPlane(1));
    await dispatchMessage(ctx, labelPlane(5));
    expect([...ctx.state.labelSlicePools.keys()].sort()).toEqual([
      labelSlicePoolKey("label", 0, 1), labelSlicePoolKey("label", 0, 5),
    ]);
    const kept = ctx.state.labelSlicePools.get(labelSlicePoolKey("label", 0, 1))!;
    const freed = ctx.state.labelSlicePools.get(labelSlicePoolKey("label", 0, 5))!.texture as unknown as MockTexture;
    posts.length = 0;

    await dispatchMessage(ctx, sliceWithLabel(1, 1, [0, 1]));

    expect([...ctx.state.labelSlicePools]).toEqual([[labelSlicePoolKey("label", 0, 1), kept]]);
    expect(freed.destroyed).toBe(true);
    expect(residency(posts)).toEqual([expect.objectContaining({ change: "lost", reason: "freed", cut: { axis: "z", plane: 5 } })]);
  });

  it("re-cuts a view's label pool in place when it moves to a plane no pool holds", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, sliceWithLabel(0, 1));
    await dispatchMessage(ctx, labelPlane(1));
    const pool = ctx.state.labelSlicePools.get(labelSlicePoolKey("label", 0, 1))!;
    posts.length = 0;

    await dispatchMessage(ctx, sliceWithLabel(0, 2));

    // The pool keeps its texels drawing until plane 2 lands, and hands back
    // plane 1's chunk so the page sends plane 2's.
    expect([...ctx.state.labelSlicePools]).toEqual([[labelSlicePoolKey("label", 0, 2), pool]]);
    expect((pool.texture as unknown as MockTexture).destroyed).toBe(false);
    expect(residency(posts)).toEqual([expect.objectContaining({
      change: "lost", keys: ["0/0/0/0/0/0"], reason: "replaced", cut: { axis: "z", plane: 1 },
    })]);
  });
});

describe("the GPU memory report", () => {
  it("counts every holder's bytes from its own geometry, and the chunk slots held", () => {
    const state = createInitialState(256 * 1024 * 1024);
    // Two views draw from the pool, each through an indirection of 16 cells.
    state.sliceAtlases.set("a", {
      slotsX: 4, slotsY: 2, chunkX: 64, chunkY: 32, format: "u16", totalSlots: 8,
      slots: new Map([["m|k", 0]]),
      views: new Map([[0, { indirectionData: new Uint32Array(16) }], [1, { indirectionData: new Uint32Array(16) }]]),
    } as unknown as SliceAtlasState);
    state.labelSlicePools.set("b", { width: 100, height: 50 } as never);


    expect(measureGpuMemory(state)).toEqual({
      budgetBytes: 256 * 1024 * 1024,
      bytes: 4 * 64 * 2 * 32 * 2 + 2 * 16 * 4 + 100 * 50 * 4,
      chunkBytes: 4 * 64 * 2 * 32 * 2 + 2 * 16 * 4,
      indirectionBytes: 2 * 16 * 4,
      labelBytes: 100 * 50 * 4,

      targetBytes: 0,
      minimapBytes: 0,
      atlases: 2,
      slotsHeld: 1,
      slots: 8,
      overviewsRefused: 0,
    });
  });

  it("is posted when it changes and falls back when a dataset is removed", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    const reports = () => posts.filter((m): m is GpuMemoryMessage => m.type === "gpuMemory");

    await dispatchMessage(ctx, cold("ds1", { visibleChannels: [0, 1] }));
    await dispatchMessage(ctx, cold("ds1", { visibleChannels: [0, 1] }));
    expect(reports()).toHaveLength(1);
    expect(reports()[0].atlases).toBe(6);
    expect(reports()[0].bytes).toBe(measureGpuMemory(ctx.state).bytes);

    await dispatchMessage(ctx, { type: "removeLayerResources", datasetId: "ds1" });
    expect(reports().at(-1)).toMatchObject({ type: "gpuMemory", atlases: 0, bytes: 0, slots: 0 });
  });

  it("posts each chunk pool's capacity for admission, and what the other holders take of the total", async () => {
    const gpu = trackingDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1"));
    const capacity = posts.filter((m): m is GpuCapacityMessage => m.type === "gpuCapacity").at(-1)!;

    expect(capacity.budgetBytes).toBe(ctx.state.gpuTotalBytes);
    expect(capacity.reservedBytes).toBe(0);
    const detail = capacity.pools.find((pool) => pool.poolKey === "ds1:ch0:32x32x32:detail")!;
    expect(detail).toMatchObject({ datasetId: "ds1", tier: "detail", slotBytes: 32 * 32 * 32 * 2 });
    const atlas = ctx.state.volumeAtlases.get("ds1:ch0:32x32x32:detail")!;
    expect(detail.slots).toBe(atlas.totalSlots);
    expect(detail.maxSlots).toBe(atlas.slotsX * atlas.slotsY * atlas.maxSlotsZ);
  });
});
