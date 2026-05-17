/**
 * Suite C — chunk-upload eviction policy + multi-member demux.
 *
 * Exercises `handleVolumeChunkData` / `handleSliceChunkData` against
 * mock-device atlases via the shared `chunkDistSq` / `findFarthestSlot`
 * / `remapIndirection` kernels.
 *
 * Invariants pinned:
 *  - Eviction picks the farthest cached chunk from the per-entity ray-hit
 *    reference (volume) or per-entity camera-UV reference (slice).
 *  - Multi-member demux: when a pool holds chunks from members A and B,
 *    evicting A's chunk during an upload for B emits a `chunksEvicted`
 *    keyed by **A's** memberId — not B's. The orchestrator's per-member
 *    delivery tracking depends on this.
 *  - Incoming chunks farther than the farthest cached are rejected and
 *    reported as `skipped` (NOT as evictions).
 *  - Stale-epoch batches report every chunk as re-eligible `keys`, not
 *    `skipped`, so they clear optimistic sent state without rejection.
 *  - Empty `chunks: []` is a no-op; no posts.
 *  - Slice mode: chunks with `z !== targetChunkZ` are re-eligible keys
 *    (Z-slice retargeting), not residency rejections.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  handleVolumeChunkData,
  type LodIndirectionMeta,
} from "./volume/index.ts";
import {
  getOrCreateSlicePool,
  handleSliceChunkData,
} from "./slice/index.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { createInitialState } from "./worker/state.ts";
import type {
  Chunk,
  SliceChunkDataMessage,
  VolumeChunkDataMessage,
  WorkerToMainMessage,
} from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";

// ---------------------------------------------------------------------------
// Mock device + ctx
// ---------------------------------------------------------------------------

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
    queue: { writeBuffer, writeTexture } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

interface TestCtx {
  ctx: WorkerCtx;
  posts: WorkerToMainMessage[];
  postWantedSetCalls: number;
}

function makeMockCtx(): TestCtx {
  const posts: WorkerToMainMessage[] = [];
  let postWantedSetCalls = 0;
  const ctx = {
    device: makeMockDevice(),
    state: createInitialState(),
    post(msg: WorkerToMainMessage) { posts.push(msg); },
    postWantedSet() { postWantedSetCalls++; },
  } as unknown as WorkerCtx;
  return {
    ctx,
    posts,
    get postWantedSetCalls() { return postWantedSetCalls; },
  } as TestCtx;
}

function epochs(): SceneEpochs {
  return { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 };
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
    memberId,
    chunks,
    level: 0,
    z: 0,
    t: 0,
    c: 0,
    levelWidth: 128,
    levelHeight: 128,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 4,
    fullResDepth: 64,
    levelDepth: 64,
    fullResZ: 0,
    ...overrides,
  };
}

/**
 * Build LOD metas for a single member at level 0 sized to fit the
 * given grid. Returns metas suitable for assigning to `atlas.entityMetas`.
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

// Every atlas / eviction Map lives on `ctx.state` via `RendererState`.
// Each test creates its own ctx via `makeMockCtx`, so no cross-test
// cleanup is required. `beforeEach` is retained as a hook surface in
// case future tests need to re-spy mocks.
beforeEach(() => {});

// ---------------------------------------------------------------------------
// Volume eviction
// ---------------------------------------------------------------------------

describe("handleVolumeChunkData — eviction policy", () => {
  it("evicts farthest-from-rayHit chunk; reports chunksEvicted keyed by A", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";

    // Allocate the pool then narrow it to a single slot so the next
    // upload must evict.
    const atlas = getOrCreateVolumePool(ctx, poolKey, 32, 32, 32, 0, 0);
    atlas.entityMetas.set(memberA, [makeVolumeMeta(2, 4, 4)]);
    atlas.indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
    atlas.freeSlots = [0]; // exactly one free slot

    // Member A is interested in the upper-left corner (rayHit near 0,0,0).
    applyViewHotState(ctx, {
      type: "viewHotState",
      epochs: epochs(),
      datasetId: poolKey,
      rayHitsByEntity: [[memberA, [0.0, 0.0, 0.0]]],
    });

    // First upload: a chunk at (3,3,1) — far from rayHit. Fills the slot.
    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [makeChunk(0, 0, 0, 1, 3, 3)]), epochs(), poolKey, memberA);
    expect(atlas.slots.size).toBe(1);

    // Second upload: a chunk at (0,0,0) — much closer to rayHit.
    // Pool full → the (3,3,1) chunk must be evicted to make room.
    posts.length = 0;
    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [makeChunk(0, 0, 0, 0, 0, 0)]), epochs(), poolKey, memberA);

    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    // Exactly one eviction post + one (empty) skipped post, both keyed by A.
    const withKeys = evictions.find(e => e.keys.length > 0);
    expect(withKeys).toBeDefined();
    expect(withKeys!.memberId).toBe(memberA);
    expect(withKeys!.keys).toEqual([chunkKey(0, 0, 0, 1, 3, 3)]);
  });

  it("multi-member demux: B's upload evicts A's chunk → eviction is keyed by A, not B", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";
    const memberB = "imgB";

    const atlas = getOrCreateVolumePool(ctx, poolKey, 32, 32, 32, 0, 0);
    // Two members share the pool; each owns its own LOD section.
    atlas.entityMetas.set(memberA, [makeVolumeMeta(2, 4, 4)]);
    atlas.entityMetas.set(memberB, [{ ...makeVolumeMeta(2, 4, 4), offset: 2 * 4 * 4 }]);
    atlas.indirectionData = new Uint32Array(2 * 4 * 4 * 2).fill(0xFFFFFFFF);
    atlas.freeSlots = [0];

    // A's ray-hit far from its chunk; B's near its chunk → A's cached
    // chunk should be the farthest and thus the eviction target.
    applyViewHotState(ctx, {
      type: "viewHotState",
      epochs: epochs(),
      datasetId: poolKey,
      rayHitsByEntity: [
        [memberA, [0.0, 0.0, 0.0]],
        [memberB, [0.0, 0.0, 0.0]],
      ],
    });

    // Seed: A uploads a chunk far from A's rayHit.
    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [makeChunk(0, 0, 0, 1, 3, 3)]), epochs(), poolKey, memberA);
    expect(atlas.slots.size).toBe(1);

    // Now B uploads a chunk close to B's rayHit. Pool full → must evict.
    posts.length = 0;
    handleVolumeChunkData(ctx, makeVolumeMsg(memberB, [makeChunk(0, 0, 0, 0, 0, 0)]), epochs(), poolKey, memberB);

    const evictions = (posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>)
      .filter(e => e.keys.length > 0);
    expect(evictions.length).toBe(1);
    // Demux invariant: report is keyed by the OWNER of the evicted
    // chunk (A), not the uploader (B).
    expect(evictions[0].memberId).toBe(memberA);
    expect(evictions[0].keys).toEqual([chunkKey(0, 0, 0, 1, 3, 3)]);
  });

  it("incoming chunk farther than farthest cached → rejected and reported as skipped", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";

    const atlas = getOrCreateVolumePool(ctx, poolKey, 32, 32, 32, 0, 0);
    atlas.entityMetas.set(memberA, [makeVolumeMeta(2, 4, 4)]);
    atlas.indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);
    atlas.freeSlots = [0];

    applyViewHotState(ctx, {
      type: "viewHotState",
      epochs: epochs(),
      datasetId: poolKey,
      rayHitsByEntity: [[memberA, [0.0, 0.0, 0.0]]],
    });

    // Seed: a near chunk fills the only slot.
    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [makeChunk(0, 0, 0, 0, 0, 0)]), epochs(), poolKey, memberA);
    expect(atlas.slots.size).toBe(1);

    // Now an upload arrives that is farther than what's cached → reject.
    posts.length = 0;
    const farChunk = makeChunk(0, 0, 0, 1, 3, 3);
    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [farChunk]), epochs(), poolKey, memberA);

    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    const skipped = evictions.find(e => (e.skipped?.length ?? 0) > 0);
    expect(skipped).toBeDefined();
    expect(skipped!.memberId).toBe(memberA);
    expect(skipped!.skipped).toEqual([farChunk.key]);
    expect(skipped!.keys).toEqual([]);
    // The cached chunk is still in the slot.
    expect(atlas.slots.size).toBe(1);
  });

  it("stale-epoch batch → entire batch reported as re-eligible, no work done", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";

    const atlas = getOrCreateVolumePool(ctx, poolKey, 32, 32, 32, 0, 0);
    atlas.entityMetas.set(memberA, [makeVolumeMeta(2, 4, 4)]);
    atlas.indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);

    // Current epoch.content is 5; the batch carries content=1 → stale.
    const currentEpochs: SceneEpochs = { content: 5, layout: 1, view: 1, selection: 1, asset: 0, request: 0 };
    const batchEpochs: SceneEpochs = { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 };
    const chunks = [makeChunk(0, 0, 0, 0, 0, 0), makeChunk(0, 0, 0, 0, 0, 1)];

    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, chunks, { epochs: batchEpochs }), currentEpochs, poolKey, memberA);

    expect(atlas.slots.size).toBe(0);
    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    expect(evictions.length).toBe(1);
    expect(evictions[0].memberId).toBe(memberA);
    expect(evictions[0].keys).toEqual(chunks.map(c => c.key));
    expect(evictions[0].skipped).toEqual([]);
  });

  it("empty chunks array → no posts, no work", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";

    const atlas = getOrCreateVolumePool(ctx, poolKey, 32, 32, 32, 0, 0);
    atlas.entityMetas.set(memberA, [makeVolumeMeta(2, 4, 4)]);
    atlas.indirectionData = new Uint32Array(2 * 4 * 4).fill(0xFFFFFFFF);

    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, []), epochs(), poolKey, memberA);

    expect(posts.length).toBe(0);
    expect(ctx.state.volumeAtlases.get(poolKey)?.slots.size).toBe(0);
  });

  it("missing volume atlas → batch reported as re-eligible", () => {
    const { ctx, posts } = makeMockCtx();
    const memberA = "imgA";
    const chunk = makeChunk(0, 0, 0, 0, 0, 0);

    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [chunk]), epochs(), "missing-pool", memberA);

    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    expect(evictions).toHaveLength(1);
    expect(evictions[0].memberId).toBe(memberA);
    expect(evictions[0].keys).toEqual([chunk.key]);
    expect(evictions[0].skipped).toEqual([]);
  });

  it("missing volume entity metadata → batch reported as re-eligible", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";
    const chunk = makeChunk(0, 0, 0, 0, 0, 0);

    getOrCreateVolumePool(ctx, poolKey, 32, 32, 32, 0, 0);
    handleVolumeChunkData(ctx, makeVolumeMsg(memberA, [chunk]), epochs(), poolKey, memberA);

    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    expect(evictions).toHaveLength(1);
    expect(evictions[0].memberId).toBe(memberA);
    expect(evictions[0].keys).toEqual([chunk.key]);
    expect(evictions[0].skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice Z-retargeting
// ---------------------------------------------------------------------------

describe("handleSliceChunkData — Z-slice retargeting", () => {
  it("upload for Z=0 when currentZ targets Z=1 → chunks with z !== targetChunkZ re-eligible", () => {
    const { ctx, posts } = makeMockCtx();
    const poolKey = "ds1";
    const memberA = "imgA";

    // Pool's z bookkeeping is irrelevant for the handler's Z-filter
    // decision — the handler recomputes targetChunkZ from
    // `fullResZ / fullResDepth → levelZ / chunkZ`. Set up so target=1.
    const atlas = getOrCreateSlicePool(ctx, poolKey, 32, 32, 0, 0, 0);
    atlas.entityMetas.set(memberA, [makeSliceMeta(4, 4)]);
    atlas.indirectionData = new Uint32Array(4 * 4).fill(0xFFFFFFFF);

    // fullResDepth=64, levelDepth=64, fullResZ=4, chunkZ=4 →
    // levelZ = floor(4/63 * 63) = 4, targetChunkZ = floor(4/4) = 1.
    const chunkAtZ0 = makeSliceChunk(0, 0, 0, 0, 0, 0); // wrong Z
    const chunkAtZ1 = makeSliceChunk(0, 0, 0, 1, 0, 0); // right Z

    handleSliceChunkData(ctx, makeSliceMsg(memberA, [chunkAtZ0, chunkAtZ1], { fullResZ: 4 }), epochs(), poolKey, memberA);

    // Only the Z=1 chunk landed in the atlas; Z=0 was filtered before
    // slot allocation.
    expect(atlas.slots.size).toBe(1);
    const [[compositeKey]] = [...atlas.slots.entries()];
    expect(compositeKey).toBe(`${memberA}|${chunkAtZ1.key}`);
    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    expect(evictions).toHaveLength(1);
    expect(evictions[0].memberId).toBe(memberA);
    expect(evictions[0].keys).toEqual([chunkAtZ0.key]);
    expect(evictions[0].skipped).toEqual([]);
  });

  it("missing slice atlas → batch reported as re-eligible", () => {
    const { ctx, posts } = makeMockCtx();
    const memberA = "imgA";
    const chunk = makeSliceChunk(0, 0, 0, 0, 0, 0);

    handleSliceChunkData(ctx, makeSliceMsg(memberA, [chunk]), epochs(), "missing-pool", memberA);

    const evictions = posts.filter(m => m.type === "chunksEvicted") as Array<Extract<WorkerToMainMessage, { type: "chunksEvicted" }>>;
    expect(evictions).toHaveLength(1);
    expect(evictions[0].memberId).toBe(memberA);
    expect(evictions[0].keys).toEqual([chunk.key]);
    expect(evictions[0].skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Eviction kernel unit tests
//
// These directly exercise the shared kernel from renderer/eviction.ts —
// 2D vs 3D distance, prefer-stale-slot, and farthest-mapped fallback.
// ---------------------------------------------------------------------------

import { chunkDistSq, findFarthestSlot } from "./eviction.ts";

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

describe("eviction kernel — findFarthestSlot", () => {
  it("prefers a stale slot (slotGridIdx[idx] < 0) over any mapped slot", () => {
    // Two slots: slot 0 mapped (gridIdx >= 0), slot 1 stale (gridIdx < 0).
    const slots = new Map<string, number>([
      [`memA|0/0/0/0/0/0`, 0],
      [`memA|0/0/0/0/0/1`, 1],
    ]);
    const slotGridIdx = new Int32Array([0, -1]);
    const entityMetas = new Map<string, LodIndirectionMeta[]>([
      ["memA", [makeVolumeMeta(2, 4, 4)]],
    ]);
    const result = findFarthestSlot({
      slots,
      slotGridIdx,
      entityMetas,
      cameraFor: () => [0.5, 0.5, 0.5] as [number, number, number],
      is3D: true,
    });
    expect(result.key).toBe(`memA|0/0/0/0/0/1`);
    expect(result.dist).toBe(Infinity);
  });

  it("missing entityMeta → slot treated as stale (returned with Infinity)", () => {
    const slots = new Map<string, number>([
      [`memGone|0/0/0/0/0/0`, 0],
    ]);
    const slotGridIdx = new Int32Array([0]);
    const entityMetas = new Map<string, LodIndirectionMeta[]>();
    const result = findFarthestSlot({
      slots,
      slotGridIdx,
      entityMetas,
      cameraFor: () => [0.5, 0.5, 0.5] as [number, number, number],
      is3D: true,
    });
    expect(result.key).toBe(`memGone|0/0/0/0/0/0`);
    expect(result.dist).toBe(Infinity);
  });

  it("no stale slots → picks the farthest mapped slot from cameraFor", () => {
    // 3D: chunks at grid (0,0,0) and (1,3,3). Camera at corner (0,0,0)
    // → (1,3,3) is farther.
    const slots = new Map<string, number>([
      [`memA|0/0/0/0/0/0`, 0],
      [`memA|0/0/0/1/3/3`, 1],
    ]);
    const slotGridIdx = new Int32Array([0, 1]);
    const entityMetas = new Map<string, LodIndirectionMeta[]>([
      ["memA", [makeVolumeMeta(2, 4, 4)]],
    ]);
    const result = findFarthestSlot({
      slots,
      slotGridIdx,
      entityMetas,
      cameraFor: () => [0.0, 0.0, 0.0] as [number, number, number],
      is3D: true,
    });
    expect(result.key).toBe(`memA|0/0/0/1/3/3`);
    expect(result.dist).toBeGreaterThan(0);
  });

  it("2D mode (is3D=false): Z is stripped from distance computation", () => {
    // Two chunks differing only in Z; in 2D they should tie on distance.
    const slots = new Map<string, number>([
      [`memA|0/0/0/0/2/2`, 0],
      [`memA|0/0/0/1/2/2`, 1],
    ]);
    const slotGridIdx = new Int32Array([0, 1]);
    const entityMetas = new Map<string, LodIndirectionMeta[]>([
      ["memA", [makeSliceMeta(4, 4)]],
    ]);
    const result = findFarthestSlot({
      slots,
      slotGridIdx,
      entityMetas,
      cameraFor: () => [0.0, 0.0] as [number, number],
      is3D: false,
    });
    // First mapped key (slot 0) wins because the loop uses strict-greater;
    // both distances are equal in 2D mode.
    expect(result.key).toBe(`memA|0/0/0/0/2/2`);
  });
});
