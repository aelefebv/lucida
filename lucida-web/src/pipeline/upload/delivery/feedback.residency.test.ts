import { describe, expect, it, vi } from "vitest";

import type { CpuCache } from "../../fetch/index.ts";
import { WorkerFeedback } from "./feedback.ts";

function makeCpuCache(): CpuCache {
  return {
    markChunkEvicted: vi.fn(),
    markChunkMissing: vi.fn(),
  } as unknown as CpuCache;
}

describe("WorkerFeedback residency reconciliation", () => {
  it("clears chunk sent state from missing chunk wanted-set entries", () => {
    const feedback = new WorkerFeedback();
    const cpuCache = makeCpuCache();

    feedback.handleWantedSetDelta("ds-0", [
      {
        kind: "chunk",
        datasetId: "ds-0",
        entityId: "tile-0",
        memberId: "img-0:ch2",
        c: 2,
        chunkKey: "0/0/2/0/0/0",
      },
    ], cpuCache);

    expect(cpuCache.markChunkMissing).toHaveBeenCalledWith(
      "img-0",
      2,
      "0/0/2/0/0/0",
    );
  });
});
