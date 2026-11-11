import { describe, expect, it } from "vitest";

import { LaneRequests } from "./emit.ts";
import type { ChunkRequest } from "./types.ts";

function request(x: number, band: number): ChunkRequest {
  return {
    datasetId: "ds",
    entityId: "entity",
    imageId: "image",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x,
    lane: "detail",
    tier: "detail",
    mode: "slice",
    priority: band,
    chunkKey: `0/0/0/0/0/${x}`,
  };
}

describe("LaneRequests", () => {
  it("orders a band by its keys", () => {
    const lanes = new LaneRequests();
    lanes.push(request(0, 1), 3);
    lanes.push(request(1, 1), 1);
    lanes.push(request(2, 1), 2);
    expect(lanes.finish().map((r) => r.x)).toEqual([1, 2, 0]);
  });

  it("puts a leading view's requests before the rest of each band, whatever their keys", () => {
    const lanes = new LaneRequests();
    // The first view's chunks are nearer its focus than the second's.
    lanes.push(request(0, 1), 1);
    lanes.push(request(1, 1), 2);
    const from = lanes.count;
    lanes.push(request(2, 1), 9);
    lanes.push(request(3, 1), 8);
    lanes.push(request(4, 2), 9);
    lanes.lead(from);
    const ordered = lanes.finish();
    expect(ordered.map((r) => r.x)).toEqual([3, 2, 0, 1, 4]);
    // The band keeps to its span, wholly below the next band.
    for (const req of ordered.slice(0, 4)) {
      expect(req.priority).toBeGreaterThanOrEqual(1);
      expect(req.priority).toBeLessThanOrEqual(1.5);
    }
  });
});
