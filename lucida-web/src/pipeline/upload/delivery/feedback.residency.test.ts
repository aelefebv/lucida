import { describe, expect, it, vi } from "vitest";

import type { CpuCache } from "../../fetch/index.ts";
import { WorkerFeedback } from "./feedback.ts";

function makeCpuCache(): CpuCache {
  return {
    markChunkEvicted: vi.fn(),
    markChunkMissing: vi.fn(),
    markProxyMissing: vi.fn(),
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
        tier: "detail",
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
      "detail",
    );
    expect(cpuCache.markProxyMissing).not.toHaveBeenCalled();
  });

  it("keeps proxy missing feedback on the proxy sent-state path", () => {
    const feedback = new WorkerFeedback();
    const cpuCache = makeCpuCache();

    feedback.handleWantedSetDelta("ds-0", [
      {
        kind: "proxy",
        datasetId: "ds-0",
        entityId: "tile-0",
        proxyKind: "TileProxy3D",
        t: 1,
        c: 3,
      },
    ], cpuCache);

    expect(cpuCache.markProxyMissing).toHaveBeenCalledWith(
      "ds-0|tile-0|TileProxy3D|1|3",
    );
    expect(cpuCache.markChunkMissing).not.toHaveBeenCalled();
  });
});
