import { describe, expect, it } from "vitest";

import type { ChunkRequest } from "../../planning/index.ts";
import { WantedChunkCounts, wantedChunksFromPlan } from "./wanted.ts";

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
    mode: "slice",
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
    ]);

    expect([...wanted.values()]).toEqual([
      { memberId: "img:ch1", tier: "detail", chunkKeys: ["0/0/1/0/0/0", "0/0/1/0/0/1"] },
      { memberId: "img:ch1", tier: "coarse", chunkKeys: ["2/0/1/0/0/0"] },
    ]);
  });

  it("names the channel when one is shown alone too", () => {
    const wanted = wantedChunksFromPlan([req({})]);
    expect([...wanted.values()].map((e) => e.memberId)).toEqual(["img:ch0"]);
  });
});

describe("WantedChunkCounts", () => {
  it("names only the chunks that changed between two plans, and empties the members that left", () => {
    const prev = new WantedChunkCounts([
      req({ imageId: "a", chunkKey: "k1" }),
      req({ imageId: "a", chunkKey: "k2" }),
      req({ imageId: "b", chunkKey: "k1" }),
      req({ imageId: "c", chunkKey: "k1" }),
    ]);
    const next = new WantedChunkCounts([
      // Same chunks in another order: unchanged.
      req({ imageId: "a", chunkKey: "k2" }),
      req({ imageId: "a", chunkKey: "k1" }),
      req({ imageId: "b", chunkKey: "k3" }),
      req({ imageId: "d", chunkKey: "k1" }),
    ]);

    expect(prev.changesTo(next)).toEqual([
      { memberId: "b:ch0", tier: "detail", added: ["k3"], removed: ["k1"] },
      { memberId: "d:ch0", tier: "detail", added: ["k1"], removed: [] },
      { memberId: "c:ch0", tier: "detail", added: [], removed: ["k1"] },
    ]);
  });

  it("changes by a plan's delta what a diff of the two plans changes", () => {
    const k1 = req({ imageId: "a", chunkKey: "k1" });
    const k2 = req({ imageId: "a", chunkKey: "k2" });
    const k1Again = req({ imageId: "a", chunkKey: "k1", mode: "volume" });
    const b1 = req({ imageId: "b", chunkKey: "k1" });
    const prefetch = req({ imageId: "a", chunkKey: "k5", lane: "prefetch" });
    const before = [k1, k2, b1];
    const after = [k2, k1Again, prefetch];
    const counts = new WantedChunkCounts(before);

    // k1 leaves with one request and comes back with another, so the worker
    // keeps it; b's one chunk leaves; prefetch never reaches the worker.
    expect(counts.apply(after, { base: before, added: [k1Again, prefetch], removed: [k1, b1] })).toEqual([
      { memberId: "b:ch0", tier: "detail", added: [], removed: ["k1"] },
    ]);
    expect(new WantedChunkCounts(before).changesTo(new WantedChunkCounts(after))).toEqual([
      { memberId: "b:ch0", tier: "detail", added: [], removed: ["k1"] },
    ]);
  });

  it("refuses a delta on requests it did not count", () => {
    const counts = new WantedChunkCounts([req({})]);
    expect(counts.apply([], { base: [], added: [], removed: [] })).toBeNull();
  });
});
