import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decompress } from "fzstd";

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ProbeResultMessage,
  SliceRenderMultiPassMessage,
  VolumeRenderMultiPassMessage,
  WorkerToMainMessage,
} from "../workerProtocol.ts";
import type { LabelSlicePool, SliceAtlasState } from "../slice/atlas.ts";
import { labelCellKey } from "../slice/atlas.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { AtlasState, LabelVolumePool, LodIndirectionMeta } from "../volume/atlas.ts";
import { INDIRECTION_FAILED, INDIRECTION_MISS } from "../remap.ts";
import { identityIndirection } from "../failedCells.ts";
import { createInitialState } from "./state.ts";
import { dispatchMessage } from "./dispatch.ts";

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

// The read-back names these, and node has neither.
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { MAP_READ: 0x01, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 0x01 };
const FIXTURES = resolve(process.cwd(), "../fixtures/ome-zarr");

/** One stored chunk of a committed fixture, decompressed: little-endian uint16 samples. */
function fixtureChunk(path: string): Uint16Array {
  const bytes = decompress(new Uint8Array(readFileSync(resolve(FIXTURES, path))));
  return new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** A slice pool of 8x8-sample slots whose texture is a CPU array the fake device copies from. */
interface FakePool extends SliceAtlasState {
  texels: Uint16Array;
}

function fakePool(datasetId: string, chunk: number, cells: number): FakePool {
  const slotsX = 4;
  const slotsY = 4;
  const texels = new Uint16Array(slotsX * chunk * slotsY * chunk);
  return {
    datasetId,
    texture: { texels, width: slotsX * chunk, height: slotsY * chunk } as unknown as GPUTexture,
    texels,
    format: "u16",
    indirectionBuf: {} as GPUBuffer,
    indirectionData: new Uint32Array(cells).fill(INDIRECTION_MISS),
    slots: new Map(),
    slotGridIdx: new Int32Array(slotsX * slotsY).fill(-1),
    freeSlots: [],
    totalSlots: slotsX * slotsY,
    chunkX: chunk,
    chunkY: chunk,
    slotsX,
    slotsY,
    maxSlotsY: slotsY,
    entityMetas: new Map(),
    entityZInfo: new Map(),
    z: 0,
    axis: "z",
    t: 0,
    c: 0,
    slotLevelZ: new Int32Array(slotsX * slotsY).fill(0),
    indirectionDirty: false,
  };
}

/** Make `plane` (chunk x chunk samples) resident in `slot`, at indirection `cell`. */
function hold(pool: FakePool, slot: number, cell: number, plane: ArrayLike<number>): void {
  const chunk = pool.chunkX;
  const width = pool.slotsX * chunk;
  const sx = (slot % pool.slotsX) * chunk;
  const sy = Math.floor(slot / pool.slotsX) * chunk;
  for (let y = 0; y < chunk; y++) {
    for (let x = 0; x < chunk; x++) pool.texels[(sy + y) * width + sx + x] = plane[y * chunk + x];
  }
  pool.indirectionData[cell] = slot;
}

interface Level {
  level: number;
  /** `[height, width]` in samples. */
  dims: [number, number];
  pool: FakePool;
}

/**
 * A worker that drew one 2D image, `width` samples wide, in one channel at
 * zoom 1 about its center, on a canvas as big as the image, with the given
 * resident levels finest first. Its device copies texels out of the fake
 * pools' arrays.
 */
function drewImage(levels: Level[], fullDims: [number, number], chunk: number) {
  const memberId = "img:ch0";
  const state = createInitialState();
  state.memberToDataset.set(memberId, "ds");
  const metas: LodIndirectionMeta[] = levels.map(({ level, dims }) => ({
    level,
    levelDims: [1, dims[0], dims[1]],
    chunkDims: [1, chunk, chunk],
    gridDims: [1, Math.ceil(dims[0] / chunk), Math.ceil(dims[1] / chunk)],
    offset: 0,
  }));
  levels.forEach(({ pool }, i) => {
    pool.entityMetas.set(memberId, [metas[i]]);
    state.sliceAtlases.set(`pool${i}`, pool);
  });
  state.currentSourcesByDataset.set("ds", new Map([[
    memberId,
    metas.map((meta, i) => ({ tier: "detail" as const, poolKey: `pool${i}`, meta })),
  ]]));
  const entry: ColdStateActiveEntry = {
    entityId: "entity",
    imageId: "img",
    levels: levels.map(({ level, dims }) => ({
      level,
      chunkShape: [1, chunk, chunk],
      gridShape: [1, Math.ceil(dims[0] / chunk), Math.ceil(dims[1] / chunk)],
      levelDims: [1, dims[0], dims[1]],
    })),
    detailLevels: [levels[0].level],
    coarseLevel: null,
    modelMatrix: new Float32Array(16),
    invModelMatrix: new Float32Array(16),
    displayStateByChannel: {},
  };
  const cold = {
    type: "coldState",
    datasetId: "ds",
    currentT: 0,
    currentZ: 0,
    visibleChannels: [0],
    activeSet: [entry],
  } as unknown as ColdStateMessage;
  state.coldStateByDataset.set("ds", cold);
  const [height, width] = fullDims;
  const frame: SliceRenderMultiPassMessage = {
    type: "sliceRenderMultiPass",
    epochs: EPOCHS,
    layers: [{ datasetId: memberId, dataW: width, dataH: height, blendMode: "additive", entityIndex: 0 }],
    zoom: 1,
    cx: width / 2,
    cy: height / 2,
    view: 0,
    canvasW: width,
    canvasH: height,
    rect: [0, 0, width, height],
  };
  state.lastFrames.set(frame.view, frame);
  const descriptor = {
    memberByIndex: [memberId],
    sourceBindingByMember: new Map([[memberId, { levelPoolKeys: levels.map((_, i) => `pool${i}`), coarsePoolKey: null }]]),
  } as unknown as EntityDescriptorIndex;

  const { ctx, posts, copies, settle } = fakeWorker(state, (id) => (id === "ds" ? descriptor : null));

  /** Probe the canvas at a sample's center and hand back the reply once the copy maps. */
  const probeSample = async (x: number, y: number): Promise<ProbeResultMessage> => {
    posts.length = 0;
    copies.length = 0;
    await dispatchMessage(ctx, { type: "probe", id: 1, x: (x + 0.5) / width, y: (y + 0.5) / height });
    return settle();
  };
  return { ctx, posts, probeSample, state };
}

/** A texture the fake device copies out of: a CPU array of texels, row-major per plane. */
interface FakeTexture {
  texels: Uint16Array | Uint32Array;
  width: number;
  height: number;
}

/** A worker over `state` whose device copies texels out of fake textures' arrays. */
function fakeWorker(state: ReturnType<typeof createInitialState>, descriptorOf: (id: string) => EntityDescriptorIndex | null) {
  const posts: WorkerToMainMessage[] = [];
  let mapped: () => void = () => {};
  const copies: Array<{ texture: FakeTexture; x: number; y: number; z: number; offset: number }> = [];
  const ctx = {
    state,
    device: {
      createBuffer: ({ size }: { size: number }) => {
        const bytes = new ArrayBuffer(size);
        return {
          mapAsync: () => new Promise<void>((resolve) => {
            mapped = () => {
              const view = new DataView(bytes);
              for (const { texture, x, y, z, offset } of copies) {
                const texel = texture.texels[(z * texture.height + y) * texture.width + x];
                if (texture.texels instanceof Uint32Array) view.setUint32(offset, texel, true);
                else view.setUint16(offset, texel, true);
              }
              resolve();
            };
          }),
          getMappedRange: () => bytes,
          unmap: vi.fn(),
          destroy: vi.fn(),
        };
      },
      createCommandEncoder: () => ({
        copyTextureToBuffer: (
          src: { texture: FakeTexture; origin: { x: number; y: number; z: number } },
          dst: { offset: number },
        ) => copies.push({ texture: src.texture, x: src.origin.x, y: src.origin.y, z: src.origin.z, offset: dst.offset }),
        finish: () => ({}),
      }),
      queue: { submit: vi.fn() },
    },
    post: (msg: WorkerToMainMessage) => posts.push(msg),
    lookupEntityDescriptor: descriptorOf,
  } as unknown as WorkerCtx;
  /** Map the read-back, if one went out, and hand back the reply. */
  const settle = async (): Promise<ProbeResultMessage> => {
    mapped();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    return posts[0] as ProbeResultMessage;
  };
  return { ctx, posts, copies, settle };
}

describe("the worker's pixel probe", () => {
  it("reads the fixture's own sample under the point from the texel the shader draws", async () => {
    // twin-unsharded: 40x40 in 8x8 chunks; channel 0's chunk at grid (y 1, x 2).
    const plane = fixtureChunk("twin-unsharded.ome.zarr/0/c/0/1/2");
    const pool = fakePool("ds", 8, 25);
    hold(pool, 6, 1 * 5 + 2, plane);
    const { probeSample } = drewImage([{ level: 0, dims: [40, 40], pool }], [40, 40], 8);

    for (const [x, y] of [[19, 12], [16, 8], [23, 15]]) {
      const reply = await probeSample(x, y);
      expect(reply.samples).toEqual([{
        datasetId: "ds",
        entityId: "entity",
        channel: 0,
        position: [x, y, 0],
        state: "value",
        level: 0,
        value: plane[(y - 8) * 8 + (x - 16)],
      }]);
    }
  });

  it("says a coarser level answered until the target level's chunk is resident", async () => {
    // level-index: every sample at level L is L. Level 0 is 64x64 and level 1
    // is 32x32, both in 16x16 chunks.
    const level0 = fixtureChunk("level-index.ome.zarr/0/c/0/0/0").subarray(0, 16 * 16);
    const level1 = fixtureChunk("level-index.ome.zarr/1/c/0/0/0").subarray(0, 16 * 16);
    const fine = fakePool("ds", 16, 16);
    const coarser = fakePool("ds", 16, 4);
    hold(coarser, 0, 0, level1);
    const { probeSample } = drewImage(
      [{ level: 0, dims: [64, 64], pool: fine }, { level: 1, dims: [32, 32], pool: coarser }],
      [64, 64],
      16,
    );

    expect((await probeSample(5, 9)).samples[0]).toMatchObject({ state: "value", level: 1, value: 1, position: [5, 9, 0] });
    hold(fine, 3, 0, level0);
    expect((await probeSample(5, 9)).samples[0]).toMatchObject({ state: "value", level: 0, value: 0 });
    // A neighboring chunk of the target is still missing there, so level 1 serves it.
    expect((await probeSample(20, 9)).samples[0]).toMatchObject({ state: "value", level: 1, value: 1 });
  });

  it("names a point nothing is resident under, without a read-back", async () => {
    const { posts, ctx } = drewImage([{ level: 0, dims: [40, 40], pool: fakePool("ds", 8, 25) }], [40, 40], 8);
    await dispatchMessage(ctx, { type: "probe", id: 4, x: 0.5, y: 0.5 });
    expect(posts).toEqual([{
      type: "probeResult",
      id: 4,
      samples: [{ datasetId: "ds", entityId: "entity", channel: 0, position: [20, 20, 0], state: "missing" }],
    }]);
  });

  it("returns before the read-back maps, so the frames behind it never wait", async () => {
    const pool = fakePool("ds", 8, 25);
    hold(pool, 0, 0, new Uint16Array(64));
    const { ctx, posts } = drewImage([{ level: 0, dims: [40, 40], pool }], [40, 40], 8);
    await dispatchMessage(ctx, { type: "probe", id: 2, x: 0.01, y: 0.01 });
    expect(posts).toEqual([]);
  });

  it("reads a label overlay's id from its plane, and says when a cell holds none yet", async () => {
    const pool = fakePool("ds", 8, 25);
    hold(pool, 0, 0, new Uint16Array(64).fill(7));
    const { ctx, posts, state, probeSample } = drewImage([{ level: 0, dims: [40, 40], pool }], [40, 40], 8);
    // A label over the same 40x40 extent in 8x8 chunks, its plane written in place.
    const texels = new Uint32Array(40 * 40);
    const label: LabelSlicePool = {
      texture: { texels, width: 40, height: 40 } as unknown as GPUTexture,
      indirectionBuf: {} as GPUBuffer,
      indirection: identityIndirection(25),
      markedFailed: new Set(),
      chunkX: 8,
      chunkY: 8,
      grid: { x: 5, y: 5, z: 1 },
      keys: new Map(),
      planes: new Map(),
      datasetId: "ds",
      width: 40,
      height: 40,
    };
    texels[12 * 40 + 19] = 92801;
    label.planes.set(labelCellKey(2, 1), 0);
    label.planes.set(labelCellKey(0, 0), 0);
    label.indirection[4] = INDIRECTION_FAILED;
    state.labelSlicePools.set("img:label:regions", label);
    const frame = [...state.lastFrames.values()][0] as SliceRenderMultiPassMessage;
    frame.layers.push({
      datasetId: "img:label:regions",
      dataW: 40,
      dataH: 40,
      blendMode: "alpha",
      entityIndex: 0,
      entityId: "entity",
      isLabel: true,
    });

    const labelSample = { datasetId: "ds", entityId: "entity", labelImageId: "img:label:regions" };
    expect((await probeSample(19, 12)).samples[1]).toEqual({ ...labelSample, position: [19, 12, 0], state: "value", value: 92801 });
    // Background reads as id 0, not as nothing.
    expect((await probeSample(3, 3)).samples[1]).toEqual({ ...labelSample, position: [3, 3, 0], state: "value", value: 0 });

    // A cell never written draws nothing, so it is not loaded rather than background.
    posts.length = 0;
    await dispatchMessage(ctx, { type: "probe", id: 5, x: 30.5 / 40, y: 30.5 / 40 });
    expect((posts[0] as ProbeResultMessage).samples[1]).toEqual({ ...labelSample, position: [30, 30, 0], state: "missing" });
    // A cell whose chunk failed for good says so.
    posts.length = 0;
    await dispatchMessage(ctx, { type: "probe", id: 6, x: 35.5 / 40, y: 3.5 / 40 });
    expect((posts[0] as ProbeResultMessage).samples[1]).toEqual({ ...labelSample, position: [35, 3, 0], state: "failed" });
  });

  it("answers with nothing before any frame is drawn", async () => {
    const posts: WorkerToMainMessage[] = [];
    const ctx = { state: createInitialState(), post: (msg: WorkerToMainMessage) => posts.push(msg) } as unknown as WorkerCtx;
    await dispatchMessage(ctx, { type: "probe", id: 3, x: 0.5, y: 0.5 });
    expect(posts).toEqual([{ type: "probeResult", id: 3, samples: [] }]);
  });
});

/**
 * A worker that drew one 16x16x16 volume in 8x8x8 bricks, all resident, seen
 * down +Z by a camera whose NDC is world space. Every sample holds 10 except
 * the plane at sample depth 9, which holds 600.
 */
function drewVolume(renderMode: "translucent" | "max_intensity", window: { contrastMin: number; contrastMax: number }) {
  const memberId = "vol:ch0";
  const state = createInitialState();
  state.memberToDataset.set(memberId, "ds");
  const side = 16;
  const meta: LodIndirectionMeta = { level: 0, levelDims: [side, side, side], chunkDims: [8, 8, 8], gridDims: [2, 2, 2], offset: 0 };
  // A 2x2x2 slot grid with brick (x, y, z) in slot x + 2y + 4z, so texel = sample.
  const texels = new Uint16Array(side ** 3).fill(10);
  texels.fill(600, 9 * side * side, 10 * side * side);
  const pool = {
    datasetId: "ds",
    texture: { texels, width: side, height: side } as unknown as GPUTexture,
    format: "u16",
    indirectionData: Uint32Array.from({ length: 8 }, (_, i) => i),
    slotsX: 2,
    slotsY: 2,
    slotsZ: 2,
    entityMetas: new Map([[memberId, [meta]]]),
  } as unknown as AtlasState;
  state.volumeAtlases.set("pool", pool);
  state.currentSourcesByDataset.set("ds", new Map([[memberId, [{ tier: "detail" as const, poolKey: "pool", meta }]]]));
  const entry: ColdStateActiveEntry = {
    entityId: "entity",
    imageId: "vol",
    levels: [{ level: 0, chunkShape: [8, 8, 8], gridShape: [2, 2, 2], levelDims: [side, side, side] }],
    detailLevels: [0],
    coarseLevel: null,
    modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, -0.5, -0.5, 1]),
    // World to the cube's local [0,1]^3: shift by a half.
    invModelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.5, 0.5, 1]),
    displayStateByChannel: { 0: { ...window, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 } },
  };
  state.coldStateByDataset.set("ds", {
    type: "coldState",
    datasetId: "ds",
    currentT: 0,
    currentZ: 0,
    visibleChannels: [0],
    activeSet: [entry],
    sampleFormat: "u16",
  } as unknown as ColdStateMessage);
  state.lastFrames.set(0, {
    type: "volumeRenderMultiPass",
    epochs: EPOCHS,
    layers: [{ datasetId: memberId, blendMode: "alpha", renderMode, entityIndex: 0 }],
    invViewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    eye: new Float32Array([0, 0, -1]),
    camForward: new Float32Array([0, 0, 1]),
    view: 0,
    canvasW: 100,
    canvasH: 100,
    rect: [0, 0, 100, 100],
    fullW: 100,
    fullH: 100,
  });
  const descriptor = {
    memberByIndex: [memberId],
    sourceBindingByMember: new Map([[memberId, { levelPoolKeys: ["pool"], coarsePoolKey: null }]]),
  } as unknown as EntityDescriptorIndex;
  return fakeWorker(state, (id) => (id === "ds" ? descriptor : null));
}

describe("the worker's pixel probe in 3D with no clip plane", () => {
  const center = { type: "probe" as const, id: 1, x: 0.5, y: 0.5 };
  const sample = { datasetId: "ds", entityId: "entity", channel: 0 };

  it("names the first sample a translucent pixel draws, with its depth, reading each texel once", async () => {
    const { ctx, copies, settle } = drewVolume("translucent", { contrastMin: 100, contrastMax: 1100 });
    await dispatchMessage(ctx, center);
    // The march reads 25 samples along the ray, through 16 distinct texels.
    expect(copies).toHaveLength(16);
    const reply = await settle();
    // 10 is below the window, so the plane of 600 at depth 9 is the first drawn.
    expect(reply.samples).toEqual([{ ...sample, position: [8, 8, 9], state: "value", value: 600, level: 0, along: "first" }]);
  });

  it("names a MIP pixel's brightest sample", async () => {
    const { ctx, settle } = drewVolume("max_intensity", { contrastMin: 0, contrastMax: 1000 });
    await dispatchMessage(ctx, center);
    const reply = await settle();
    expect(reply.samples).toEqual([{ ...sample, position: [8, 8, 9], state: "value", value: 600, level: 0, along: "brightest" }]);
  });

  it("says nothing drew where the whole ray is below the window", async () => {
    const { ctx, settle } = drewVolume("translucent", { contrastMin: 1000, contrastMax: 2000 });
    await dispatchMessage(ctx, center);
    expect((await settle()).samples).toEqual([{ ...sample, state: "none", along: "first" }]);
  });
});

describe("the worker's pixel probe of a 3D label overlay", () => {
  it("reads the channels on the clip plane's cut face, and the label's first id behind it", async () => {
    const { ctx, settle } = drewVolume("translucent", { contrastMin: 0, contrastMax: 1000 });
    // A label over the same cube: background, except id 5 on the plane at sample depth 12.
    const side = 16;
    const texels = new Uint32Array(side ** 3);
    texels.fill(5, 12 * side * side, 13 * side * side);
    const label = {
      datasetId: "ds",
      texture: { texels, width: side, height: side } as unknown as GPUTexture,
      indirectionData: Uint32Array.from({ length: 8 }, (_, i) => i),
      slotsX: 2, slotsY: 2, slotsZ: 2,
      gridX: 2, gridY: 2, gridZ: 2,
      chunkX: 8, chunkY: 8, chunkZ: 8,
      width: side, height: side, depth: side,
    } as unknown as LabelVolumePool;
    ctx.state.labelVolumePools.set("vol:label:regions", label);
    const frame = [...ctx.state.lastFrames.values()][0] as VolumeRenderMultiPassMessage;
    const entry = ctx.state.coldStateByDataset.get("ds")!.activeSet[0];
    frame.layers.push({
      datasetId: "vol:label:regions",
      blendMode: "alpha",
      renderMode: "translucent",
      entityIndex: 0,
      entityId: "entity",
      isLabel: true,
      modelMatrix: entry.modelMatrix,
      invModelMatrix: entry.invModelMatrix,
    });
    // The plane 0.9 ahead of the eye cuts the cube at local depth 0.4: sample 6, background there.
    frame.clipDistance = 0.9;
    frame.clipMode = 0;

    await dispatchMessage(ctx, { type: "probe", id: 1, x: 0.5, y: 0.5 });
    const reply = await settle();
    expect(reply.samples).toEqual([
      { datasetId: "ds", entityId: "entity", channel: 0, position: [8, 8, 6], state: "value", value: 10, level: 0 },
      {
        datasetId: "ds",
        entityId: "entity",
        labelImageId: "vol:label:regions",
        position: [8, 8, 12],
        state: "value",
        value: 5,
        along: "first",
      },
    ]);
  });
});
