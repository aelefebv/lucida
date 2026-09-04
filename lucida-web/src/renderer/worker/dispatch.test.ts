import { describe, expect, it } from "vitest";

import type { WorkerCtx } from "../workerContext.ts";
import type { WorkerToMainMessage } from "../workerProtocol.ts";
import { createInitialState } from "./state.ts";
import { dispatchMessage } from "./dispatch.ts";

function makeCtx(): {
  ctx: WorkerCtx;
  posts: WorkerToMainMessage[];
  wantedSetPosts: number;
} {
  const posts: WorkerToMainMessage[] = [];
  const counters = { wantedSet: 0 };
  const ctx = {
    state: createInitialState(),
    post(msg: WorkerToMainMessage) { posts.push(msg); },
    postWantedSet() { counters.wantedSet++; },
  } as unknown as WorkerCtx;
  return {
    ctx,
    posts,
    get wantedSetPosts() { return counters.wantedSet; },
  };
}

describe("worker dispatch upload feedback", () => {
  it("requeues slice chunks when no pool is registered for the member", async () => {
    const { ctx, posts } = makeCtx();

    await dispatchMessage(ctx, {
      type: "sliceChunkData",
      tier: "detail",
      memberId: "img-0:ch1",
      chunks: [{ data: new ArrayBuffer(8), dataType: "uint16", x: 0, y: 0, z: 0, key: "0/0/1/0/0/0" }],
      level: 0,
      z: 0,
      t: 0,
      c: 1,
      levelWidth: 1,
      levelHeight: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      fullResDepth: 1,
      levelDepth: 1,
      fullResZ: 0,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        memberId: "img-0:ch1",
        keys: ["0/0/1/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("requeues volume chunks when no pool is registered for the member", async () => {
    const { ctx, posts } = makeCtx();

    await dispatchMessage(ctx, {
      type: "volumeChunkData",
      tier: "detail",
      memberId: "img-0",
      chunks: [{ data: new ArrayBuffer(8), dataType: "uint16", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
      level: 0,
      t: 0,
      c: 0,
      levelWidth: 1,
      levelHeight: 1,
      levelDepth: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        memberId: "img-0",
        keys: ["0/0/0/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("does not route coarse chunk uploads through the detail pool fallback", async () => {
    const { ctx, posts } = makeCtx();
    ctx.state.memberSourcePools.set("img-0", new Map([["detail:2", "detail-pool"]]));
    ctx.state.volumeAtlases.set("detail-pool", {
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      entityMetas: new Map(),
    } as never);

    await dispatchMessage(ctx, {
      type: "volumeChunkData",
      tier: "coarse",
      memberId: "img-0",
      chunks: [{ data: new ArrayBuffer(8), dataType: "uint16", x: 0, y: 0, z: 0, key: "2/0/0/0/0/0" }],
      level: 2,
      t: 0,
      c: 0,
      levelWidth: 1,
      levelHeight: 1,
      levelDepth: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        memberId: "img-0",
        keys: ["2/0/0/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("routes a detail upload by its level, not just its tier", async () => {
    // Level 0 and level 2 of one member live in different detail pools
    // (their chunk shapes differ). A level-2 upload must reach level 2's
    // pool, and a level with no section is requeued as missing-pool.
    const { ctx, posts } = makeCtx();
    ctx.state.memberSourcePools.set("img-0", new Map([
      ["detail:0", "fine-pool"],
      ["detail:2", "small-chunk-pool"],
    ]));
    ctx.state.volumeAtlases.set("fine-pool", {
      chunkX: 32, chunkY: 32, chunkZ: 32,
      entityMetas: new Map([["img-0", [{ level: 0, gridDims: [1, 1, 1], chunkDims: [32, 32, 32], levelDims: [32, 32, 32], offset: 0 }]]]),
    } as never);
    const smallChunkPool = {
      chunkX: 8, chunkY: 8, chunkZ: 8,
      slots: new Map<string, number>(),
      slotGridIdx: new Int32Array(1).fill(-1),
      freeSlots: [0],
      totalSlots: 1,
      slotsX: 1, slotsY: 1, slotsZ: 1,
      indirectionData: new Uint32Array(1).fill(0xffffffff),
      indirectionBuf: {} as GPUBuffer,
      texture: {} as GPUTexture,
      entityMetas: new Map([["img-0", [{ level: 2, gridDims: [1, 1, 1], chunkDims: [8, 8, 8], levelDims: [8, 8, 8], offset: 0 }]]]),
      t: 0, c: 0,
      intensityMin: 65535, intensityMax: 0,
      indirectionDirty: false,
    };
    ctx.state.volumeAtlases.set("small-chunk-pool", smallChunkPool as never);
    (ctx as unknown as { device: unknown }).device = { queue: { writeTexture() {}, writeBuffer() {} } };

    const upload = (level: number, chunk: number) => dispatchMessage(ctx, {
      type: "volumeChunkData",
      tier: "detail",
      memberId: "img-0",
      chunks: [{ data: new Uint16Array(chunk * chunk * chunk).buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: `${level}/0/0/0/0/0` }],
      level,
      t: 0,
      c: 0,
      levelWidth: chunk,
      levelHeight: chunk,
      levelDepth: chunk,
      chunkX: chunk,
      chunkY: chunk,
      chunkZ: chunk,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    await upload(2, 8);
    expect(smallChunkPool.slots.has("img-0|2/0/0/0/0/0")).toBe(true);

    await upload(1, 16);
    // The first upload also posts an intensity-range update; only the
    // feedback messages matter here.
    expect(posts.filter((p) => p.type === "chunksEvicted")).toEqual([
      expect.objectContaining({ type: "chunksEvicted", memberId: "img-0", keys: ["1/0/0/0/0/0"], reason: "missing-pool" }),
    ]);
  });

  it("treats a selection scrub for an un-ingested dataset as a safe no-op", async () => {
    // A scrub patch can race ahead of the dataset's first full cold state
    // (nothing retained yet). It must not touch GPU state or throw — the
    // following full cold state carries the selection itself — but it still
    // posts the wanted set, matching the full cold-state path.
    const harness = makeCtx();
    const { ctx, posts } = harness;

    await dispatchMessage(ctx, {
      type: "coldStateSelection",
      datasetId: "ds-not-yet-ingested",
      currentT: 7,
      currentZ: 2,
      visibleRegion: {
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [2, 3],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      desiredProxyKeys: [],
      epochs: { content: 1, layout: 1, view: 1, selection: 2, asset: 0, request: 1 },
    });

    expect(posts).toEqual([]);
    expect(ctx.state.coldStateByDataset.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
    expect(harness.wantedSetPosts).toBe(1);
  });

  it("treats a view-move delta for an un-ingested dataset as a safe no-op", async () => {
    // A delta can race ahead of the dataset's first full cold state. It must not
    // touch GPU state or throw, but still posts the wanted set (matching the
    // full path).
    const harness = makeCtx();
    const { ctx, posts } = harness;

    await dispatchMessage(ctx, {
      type: "coldStateDelta",
      datasetId: "ds-not-yet-ingested",
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      desiredProxyKeys: [],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: [],
      epochs: { content: 1, layout: 1, view: 2, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([]);
    expect(ctx.state.coldStateByDataset.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
    expect(harness.wantedSetPosts).toBe(1);
  });
});
