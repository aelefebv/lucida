import { describe, expect, it } from "vitest";

import type { WorkerCtx } from "../workerContext.ts";
import type { WorkerToMainMessage } from "../workerProtocol.ts";
import { createInitialState } from "./state.ts";
import { dispatchMessage } from "./dispatch.ts";

function makeCtx(): { ctx: WorkerCtx; posts: WorkerToMainMessage[] } {
  const posts: WorkerToMainMessage[] = [];
  const ctx = {
    state: createInitialState(),
    post(msg: WorkerToMainMessage) { posts.push(msg); },
  } as unknown as WorkerCtx;
  return { ctx, posts };
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
});
