import { describe, expect, it } from "vitest";
import type { SharedChunkPool } from "../viewIndirection.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { EvictionOrder } from "../evictionOrder.ts";
import { attachView, fakeDraw, layOut } from "../viewIndirectionFixtures.ts";
import { wantedEntryKey } from "../wantedChunks.ts";
import { wantedCountOf } from "./draws.ts";

const META: LodIndirectionMeta = { level: 0, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], levelDims: [32, 64, 64], offset: 0 };

function pool(): SharedChunkPool {
  return { datasetId: "ds", slots: new Map(), order: new EvictionOrder(), freeSlots: [], totalSlots: 4, views: new Map() };
}

const wanted = (byMember: Record<string, string[]>) =>
  new Map(Object.entries(byMember).map(([member, keys]) => [wantedEntryKey("detail", member), new Set(keys)] as const));

describe("wantedCountOf", () => {
  it("counts what the views want between them, and follows a replaced index or layout", () => {
    const shared = pool();
    const first = attachView(shared, new Map([["a", [META]]]), { draw: fakeDraw({ view: 0, wanted: wanted({ a: ["k1", "k2"] }) }) });
    const second = attachView(shared, new Map([["a", [META]]]), { draw: fakeDraw({ view: 1, wanted: wanted({ a: ["k2", "k3"] }) }) });
    expect(wantedCountOf(shared, "detail")).toBe(3);
    expect(wantedCountOf(shared, "coarse")).toBe(0);

    second.draw.wanted = wanted({ a: ["k2"], b: ["k9"] });
    expect(wantedCountOf(shared, "detail")).toBe(2);

    layOut(first, "b", [META]);
    expect(wantedCountOf(shared, "detail")).toBe(3);

    shared.views.delete(1);
    expect(wantedCountOf(shared, "detail")).toBe(2);
  });
});
