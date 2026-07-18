import { describe, expect, it } from "vitest";

import type { SliceAggregateParams } from "./workerProtocol.ts";

describe("SliceAggregateParams cache identity", () => {
  it("requires cached aggregates to carry their complete owner identity", () => {
    const uncached: SliceAggregateParams = {
      poolMemberId: "img-0",
      count: 1,
      quads: new ArrayBuffer(32),
    };
    const cached: SliceAggregateParams = {
      poolMemberId: "img-0",
      count: 1,
      quads: new ArrayBuffer(32),
      cacheKey: "aggregate-1",
      cacheOwnerKey: "ds-0|single",
      ownerDatasetId: "ds-0",
    };
    // @ts-expect-error A cache key without both ownership fields is invalid.
    const incomplete: SliceAggregateParams = {
      poolMemberId: "img-0",
      count: 1,
      quads: new ArrayBuffer(32),
      cacheKey: "aggregate-1",
    };

    expect(uncached.cacheKey).toBeUndefined();
    expect(cached.cacheOwnerKey).toBe("ds-0|single");
    expect(incomplete.cacheKey).toBe("aggregate-1");
  });
});
