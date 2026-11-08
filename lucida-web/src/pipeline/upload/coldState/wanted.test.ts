import { describe, expect, it } from "vitest";

import type { ChunkRequest } from "../../planning/index.ts";
import { diffWantedChunks, wantedChunksFromPlan } from "./wanted.ts";

function req(overrides: Partial<ChunkRequest>): ChunkRequest {
  return {
    datasetId: "ds",
    entityId: "e",
    imageId: "img",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    lane: "detail",
    tier: "detail",
    priority: 0,
    chunkKey: "0/0/0/0/0/0",
    ...overrides,
  };
}

describe("wantedChunksFromPlan", () => {
  it("wants the detail and coarse lanes under the delivery's member ids, and never prefetch or minimap", () => {
    const wanted = wantedChunksFromPlan([
      req({ chunkKey: "0/0/1/0/0/0", c: 1 }),
      req({ chunkKey: "0/0/1/0/0/1", c: 1, x: 1 }),
      req({ chunkKey: "2/0/1/0/0/0", c: 1, level: 2, lane: "coarse", tier: "coarse" }),
      req({ chunkKey: "0/1/1/0/0/0", c: 1, t: 1, lane: "prefetch" }),
      req({ chunkKey: "3/0/1/0/0/0", c: 1, level: 3, lane: "minimap", tier: "coarse" }),
    ], true);

    expect([...wanted.values()]).toEqual([
      { memberId: "img:ch1", tier: "detail", chunkKeys: ["0/0/1/0/0/0", "0/0/1/0/0/1"] },
      { memberId: "img:ch1", tier: "coarse", chunkKeys: ["2/0/1/0/0/0"] },
    ]);
  });

  it("uses the bare image id outside multi-channel mode", () => {
    const wanted = wantedChunksFromPlan([req({})], false);
    expect([...wanted.values()].map((e) => e.memberId)).toEqual(["img"]);
  });
});

describe("diffWantedChunks", () => {
  it("carries only the entries whose chunks changed, and empties the ones that left", () => {
    const prev = wantedChunksFromPlan([
      req({ imageId: "a", chunkKey: "k1" }),
      req({ imageId: "a", chunkKey: "k2" }),
      req({ imageId: "b", chunkKey: "k1" }),
      req({ imageId: "c", chunkKey: "k1" }),
    ], false);
    const next = wantedChunksFromPlan([
      // Same chunks in another order: unchanged.
      req({ imageId: "a", chunkKey: "k2" }),
      req({ imageId: "a", chunkKey: "k1" }),
      req({ imageId: "b", chunkKey: "k3" }),
      req({ imageId: "d", chunkKey: "k1" }),
    ], false);

    expect(diffWantedChunks(prev, next)).toEqual([
      { memberId: "b", tier: "detail", chunkKeys: ["k3"] },
      { memberId: "d", tier: "detail", chunkKeys: ["k1"] },
      { memberId: "c", tier: "detail", chunkKeys: [] },
    ]);
  });
});
