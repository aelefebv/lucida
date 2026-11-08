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
  WorkerToMainMessage,
} from "../workerProtocol.ts";
import type { SliceAtlasState } from "../slice/atlas.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { INDIRECTION_MISS } from "../remap.ts";
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
    texture: { texels, width: slotsX * chunk } as unknown as GPUTexture,
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
    canvasW: width,
    canvasH: height,
  };
  state.lastFrame = frame;
  const descriptor = {
    memberByIndex: [memberId],
    sourceBindingByMember: new Map([[memberId, { levelPoolKeys: levels.map((_, i) => `pool${i}`), coarsePoolKey: null }]]),
  } as unknown as EntityDescriptorIndex;

  const posts: WorkerToMainMessage[] = [];
  let mapped: () => void = () => {};
  const copies: Array<{ texture: { texels: Uint16Array; width: number }; x: number; y: number; offset: number }> = [];
  const ctx = {
    state,
    device: {
      createBuffer: ({ size }: { size: number }) => {
        const bytes = new ArrayBuffer(size);
        return {
          mapAsync: () => new Promise<void>((resolve) => {
            mapped = () => {
              const view = new DataView(bytes);
              for (const { texture, x, y, offset } of copies) {
                view.setUint16(offset, texture.texels[y * texture.width + x], true);
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
          src: { texture: { texels: Uint16Array; width: number }; origin: { x: number; y: number } },
          dst: { offset: number },
        ) => copies.push({ texture: src.texture, x: src.origin.x, y: src.origin.y, offset: dst.offset }),
        finish: () => ({}),
      }),
      queue: { submit: vi.fn() },
    },
    post: (msg: WorkerToMainMessage) => posts.push(msg),
    lookupEntityDescriptor: (id: string) => (id === "ds" ? descriptor : null),
  } as unknown as WorkerCtx;

  /** Probe the canvas at a sample's center and hand back the reply once the copy maps. */
  const probeSample = async (x: number, y: number): Promise<ProbeResultMessage> => {
    posts.length = 0;
    copies.length = 0;
    await dispatchMessage(ctx, { type: "probe", id: 1, x: (x + 0.5) / width, y: (y + 0.5) / height });
    mapped();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    return posts[0] as ProbeResultMessage;
  };
  return { ctx, posts, probeSample };
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

  it("answers with nothing before any frame is drawn", async () => {
    const posts: WorkerToMainMessage[] = [];
    const ctx = { state: createInitialState(), post: (msg: WorkerToMainMessage) => posts.push(msg) } as unknown as WorkerCtx;
    await dispatchMessage(ctx, { type: "probe", id: 3, x: 0.5, y: 0.5 });
    expect(posts).toEqual([{ type: "probeResult", id: 3, samples: [] }]);
  });
});
