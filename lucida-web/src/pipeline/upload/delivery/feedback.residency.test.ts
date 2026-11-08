import { describe, expect, it, vi } from "vitest";

import type { CpuCache } from "../../fetch/index.ts";
import type { MissingChunk } from "../../../renderer/workerProtocol.ts";
import { WorkerFeedback } from "./feedback.ts";
import { ResendGuard } from "./resendGuard.ts";

function makeCpuCache(heldByMirror = false): CpuCache {
  return {
    markChunksHeld: vi.fn(),
    markChunksRefused: vi.fn(),
    markChunksLost: vi.fn(),
    markChunkMissing: vi.fn(() => heldByMirror),
  } as unknown as CpuCache;
}

const missingChunk: MissingChunk = {
  datasetId: "ds-0",
  tier: "detail",
  entityId: "tile-0",
  memberId: "img-0:ch2",
  c: 2,
  chunkKey: "0/0/2/0/0/0",
};

describe("WorkerFeedback residency reconciliation", () => {
  it("checks a missing chunk against the residency mirror, by image, channel and tier", () => {
    const feedback = new WorkerFeedback();
    const cpuCache = makeCpuCache();

    expect(feedback.handleWantedSetDelta("ds-0", [missingChunk], cpuCache)).toBe(false);

    expect(cpuCache.markChunkMissing).toHaveBeenCalledWith("img-0", 2, "0/0/2/0/0/0", "detail");
  });

  it("names a missing chunk the mirror held to the guard, with no reason the worker gave", () => {
    const guard = new ResendGuard();
    const noteMissing = vi.spyOn(guard, "noteMissing");
    const feedback = new WorkerFeedback(guard);

    expect(feedback.handleWantedSetDelta("ds-0", [missingChunk], makeCpuCache(true))).toBe(true);
    expect(noteMissing).toHaveBeenCalledWith("img-0", 2, "0/0/2/0/0/0");
  });

  it("tells the guard why each refused or lost chunk came back", () => {
    const guard = new ResendGuard();
    const noteReturned = vi.spyOn(guard, "noteReturned");
    const feedback = new WorkerFeedback(guard);
    const cpuCache = makeCpuCache();

    feedback.handleChunkResidency("img-0", "detail", "refused", ["a"], cpuCache, "unwanted");
    feedback.handleChunkResidency("img-0", "detail", "lost", ["b"], cpuCache, "evicted");
    feedback.handleChunkResidency("img-0", "detail", "held", ["c"], cpuCache);

    expect(noteReturned.mock.calls).toEqual([
      ["img-0", 0, "a", "unwanted"],
      ["img-0", 0, "b", "evicted"],
    ]);
  });
});
