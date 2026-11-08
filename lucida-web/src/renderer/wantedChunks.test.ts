import { describe, expect, it } from "vitest";

import { createInitialState } from "./worker/state.ts";
import { indexWantedChunks, patchWantedChunks, wantedChunksFor } from "./wantedChunks.ts";

describe("the wanted-chunk index", () => {
  it("looks a member's chunks up per tier, through the member's dataset", () => {
    const state = createInitialState();
    state.memberToDataset.set("img", "ds");
    state.wantedByDataset.set("ds", indexWantedChunks([
      { memberId: "img", tier: "detail", chunkKeys: ["0/0/0/0/0/0"] },
      { memberId: "img", tier: "coarse", chunkKeys: ["2/0/0/0/0/0"] },
    ]));

    expect(wantedChunksFor(state, "img", "detail")?.has("0/0/0/0/0/0")).toBe(true);
    expect(wantedChunksFor(state, "img", "detail")?.has("2/0/0/0/0/0")).toBe(false);
    expect(wantedChunksFor(state, "img", "coarse")?.has("2/0/0/0/0/0")).toBe(true);
    expect(wantedChunksFor(state, "other", "detail")).toBeUndefined();
  });

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
