import { describe, expect, it } from "vitest";

import { patchWantedChunks } from "./wantedChunks.ts";

describe("the wanted-chunk index", () => {
  it("patches a retained list: a replacement takes its entry's place, and an empty one drops it", () => {
    const retained = [
      { memberId: "a", tier: "detail" as const, chunkKeys: ["k1"] },
      { memberId: "b", tier: "detail" as const, chunkKeys: ["k1"] },
      { memberId: "a", tier: "coarse" as const, chunkKeys: ["k9"] },
    ];

    expect(patchWantedChunks(retained, [
      { memberId: "a", tier: "detail", chunkKeys: ["k2"] },
      { memberId: "b", tier: "detail", chunkKeys: [] },
      { memberId: "c", tier: "detail", chunkKeys: ["k3"] },
    ])).toEqual([
      { memberId: "a", tier: "detail", chunkKeys: ["k2"] },
      { memberId: "a", tier: "coarse", chunkKeys: ["k9"] },
      { memberId: "c", tier: "detail", chunkKeys: ["k3"] },
    ]);
  });
});
