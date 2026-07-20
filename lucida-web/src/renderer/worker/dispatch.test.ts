import { describe, expect, it, vi } from "vitest";

import type { WorkerCtx } from "../workerContext.ts";
import type { WorkerToMainMessage } from "../workerProtocol.ts";
import { createInitialState } from "./state.ts";
import { dispatchMessage, reportFramePresentedAfterGpuCompletion } from "./dispatch.ts";
import { makeChunkContract } from "../../test/fixtures.ts";

function makeCtx(): {
  ctx: WorkerCtx;
  posts: WorkerToMainMessage[];
  wantedSetPosts: number;
} {
  const posts: WorkerToMainMessage[] = [];
  const counters = { wantedSet: 0 };
  const ctx = {
    device: { limits: {} },
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
      datasetId: "ds-0",
      memberId: "img-0:ch1",
      chunks: [{ data: new ArrayBuffer(8), contract: makeChunkContract({ channel: 1 }), x: 0, y: 0, z: 0, key: "0/0/1/0/0/0" }],
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
      epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        datasetId: "ds-0",
        memberId: "img-0:ch1",
        tier: "detail",
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
      datasetId: "ds-0",
      memberId: "img-0",
      chunks: [{ data: new ArrayBuffer(8), contract: makeChunkContract(), x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
      level: 0,
      t: 0,
      c: 0,
      levelWidth: 1,
      levelHeight: 1,
      levelDepth: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        datasetId: "ds-0",
        memberId: "img-0",
        tier: "detail",
        keys: ["0/0/0/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("does not route coarse chunk uploads through the detail pool fallback", async () => {
    const { ctx, posts } = makeCtx();
    ctx.state.memberToPool.set("img-0", "detail-pool");
    ctx.state.memberTierToPool.set("img-0|detail", "detail-pool");
    ctx.state.volumeAtlases.set("detail-pool", {
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      entityMetas: new Map(),
    } as never);

    await dispatchMessage(ctx, {
      type: "volumeChunkData",
      datasetId: "ds-0",
      tier: "coarse",
      memberId: "img-0",
      chunks: [{ data: new ArrayBuffer(8), contract: makeChunkContract(), x: 0, y: 0, z: 0, key: "2/0/0/0/0/0" }],
      level: 2,
      t: 0,
      c: 0,
      levelWidth: 1,
      levelHeight: 1,
      levelDepth: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        datasetId: "ds-0",
        memberId: "img-0",
        tier: "coarse",
        keys: ["2/0/0/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
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
      epochs: { content: 1, layout: 1, view: 1, selection: 2, request: 1 },
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
      removedImageIds: [],
      upserts: [],
      activeSetOrder: [],
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
    });

    expect(posts).toEqual([]);
    expect(ctx.state.coldStateByDataset.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
    expect(harness.wantedSetPosts).toBe(1);
  });
});

describe("worker render-surface admission", () => {
  it("ignores invalid resize messages and accepts a later valid size", async () => {
    const { ctx } = makeCtx();
    const canvas = { width: 64, height: 64 };
    Object.assign(ctx, {
      device: { limits: { maxTextureDimension2D: 512 } },
      context: { canvas },
    });

    await dispatchMessage(ctx, { type: "resize", width: 0, height: 100 });
    await dispatchMessage(ctx, { type: "resize", width: Number.NaN, height: 100 });
    await dispatchMessage(ctx, { type: "resize", width: 513, height: 100 });
    expect(canvas).toEqual({ width: 64, height: 64 });

    await dispatchMessage(ctx, { type: "resize", width: 127.6, height: 95.5 });
    expect(canvas).toEqual({ width: 128, height: 96 });
  });

  it("does not touch GPU state or acknowledge invalid slice and volume frames", async () => {
    const { ctx, posts } = makeCtx();
    const onSubmittedWorkDone = vi.fn(() => Promise.resolve());
    Object.assign(ctx, {
      device: {
        limits: { maxTextureDimension2D: 512 },
        queue: { onSubmittedWorkDone },
      },
    });
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    await dispatchMessage(ctx, {
      type: "sliceRenderMultiPass",
      frameId: 1,
      epochs,
      layers: [],
      zoom: 1,
      cx: 0,
      cy: 0,
      canvasW: 0,
      canvasH: 200,
    });
    await dispatchMessage(ctx, {
      type: "volumeRenderMultiPass",
      frameId: 2,
      epochs,
      layers: [],
      invViewProj: new Float32Array(16),
      eye: new Float32Array(3),
      canvasW: 320,
      canvasH: 200,
      fullW: 320,
      fullH: Number.POSITIVE_INFINITY,
    });

    expect(onSubmittedWorkDone).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });
});

describe("worker frame completion handshake", () => {
  it("does not acknowledge a slice frame whose aggregate key is missing", async () => {
    const { ctx, posts } = makeCtx();

    await dispatchMessage(ctx, {
      type: "sliceRenderMultiPass",
      frameId: 19,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
      zoom: 1,
      cx: 0,
      cy: 0,
      canvasW: 100,
      canvasH: 100,
      layers: [{
        datasetId: "img-0",
        entityIndex: 0,
        blendMode: "alpha",
        dataW: 2,
        dataH: 1,
        aggregate: {
          poolMemberId: "img-0",
          count: 2,
          quads: new ArrayBuffer(0),
          cacheKey: "missing-key",
          cacheOwnerKey: "ds-0|single",
          ownerDatasetId: "ds-0",
        },
      }],
    });

    expect(posts).toEqual([{
      type: "aggregateCacheMiss",
      frameId: 19,
      cacheKey: "missing-key",
      cacheOwnerKey: "ds-0|single",
      ownerDatasetId: "ds-0",
    }]);
    expect(posts.some((message) => message.type === "framePresented")).toBe(false);
  });

  it("does not acknowledge a frame until submitted GPU work completes", async () => {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const posts: WorkerToMainMessage[] = [];
    const ctx = {
      device: { queue: { onSubmittedWorkDone: vi.fn(() => completion) } },
      post: (message: WorkerToMainMessage) => posts.push(message),
    } as unknown as WorkerCtx;

    reportFramePresentedAfterGpuCompletion(ctx, 17);
    expect(posts).toEqual([]);

    resolveCompletion();
    await completion;
    await Promise.resolve();
    expect(posts).toEqual([{
      type: "framePresented",
      frameId: 17,
      contentPresented: false,
    }]);
  });

  it("reports GPU completion failure instead of claiming presentation", async () => {
    const completion = Promise.reject(new Error("device lost"));
    const posts: WorkerToMainMessage[] = [];
    const ctx = {
      device: { queue: { onSubmittedWorkDone: vi.fn(() => completion) } },
      post: (message: WorkerToMainMessage) => posts.push(message),
    } as unknown as WorkerCtx;

    reportFramePresentedAfterGpuCompletion(ctx, 18);
    await completion.catch(() => {});
    await Promise.resolve();
    expect(posts).toEqual([{ type: "error", message: "device lost" }]);
  });
});
