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
});
