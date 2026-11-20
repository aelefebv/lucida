import { describe, expect, it } from "vitest";

import { indexWantedChunks, patchWantedChunks, patchWantedIndex } from "./wantedChunks.ts";

describe("the wanted-chunk index", () => {
  const retained = [
    { memberId: "a", tier: "detail" as const, chunkKeys: ["k1", "k4"] },
    { memberId: "b", tier: "detail" as const, chunkKeys: ["k1"] },
    { memberId: "a", tier: "coarse" as const, chunkKeys: ["k9"] },
  ];
  const changes = [
    { memberId: "a", tier: "detail" as const, added: ["k2"], removed: ["k1"] },
    { memberId: "b", tier: "detail" as const, added: [], removed: ["k1"] },
    { memberId: "c", tier: "detail" as const, added: ["k3"], removed: [] },
  ];

  it("patches an index with a delta's changes, replacing only the sets that changed", () => {
    const index = indexWantedChunks(retained);
    const patched = patchWantedIndex(index, changes);
    expect(patched).not.toBe(index);
    expect([...patched.get("detail|a")!]).toEqual(["k4", "k2"]);
    expect(patched.has("detail|b")).toBe(false);
    expect([...patched.get("detail|c")!]).toEqual(["k3"]);
    expect(patched.get("coarse|a")).toBe(index.get("coarse|a"));
  });

  it("patches a retained list from the patched index: a changed entry takes its keys, and an emptied one drops", () => {
    const patched = patchWantedIndex(indexWantedChunks(retained), changes);
    expect(patchWantedChunks(retained, changes, patched)).toEqual([
      { memberId: "a", tier: "detail", chunkKeys: ["k4", "k2"] },
      { memberId: "a", tier: "coarse", chunkKeys: ["k9"] },
      { memberId: "c", tier: "detail", chunkKeys: ["k3"] },
    ]);
  });
});
