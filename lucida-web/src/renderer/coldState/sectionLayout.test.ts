import { describe, expect, it } from "vitest";
import { layoutSections, relayMember, wantsRepack, type SectionRequest } from "./sectionLayout.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";

/** A section of `size` cells at `level`, in a grid one row tall. */
function request(memberId: string, level: number, size: number): SectionRequest {
  return {
    memberId,
    meta: { level, gridDims: [1, 1, size], chunkDims: [1, 64, 64], levelDims: [1, 64, 64 * size] },
    size,
  };
}

function offsets(metas: Map<string, LodIndirectionMeta[]>): Record<string, number[]> {
  return Object.fromEntries([...metas].map(([id, list]) => [id, list.map((m) => m.offset)]));
}

describe("layoutSections", () => {
  it("lays a first layout out end to end, in request order", () => {
    const layout = layoutSections(new Map(), [request("a", 0, 4), request("a", 1, 1), request("b", 0, 4)]);
    expect(offsets(layout.metas)).toEqual({ a: [0, 4], b: [5] });
    expect(layout.space.end).toBe(9);
    expect(layout.repacked).toBe(true);
    expect(layout.added).toBe(layout.metas);
  });

  it("keeps every section a member still lays out where it was, whatever the order", () => {
    const first = layoutSections(new Map(), [request("a", 0, 4), request("b", 0, 4), request("c", 0, 4)]);
    const next = layoutSections(first.metas, [request("c", 0, 4), request("a", 0, 4), request("b", 0, 4)]);
    expect(offsets(next.metas)).toEqual({ c: [8], a: [0], b: [4] });
    expect(next.metas.get("a")![0]).toBe(first.metas.get("a")![0]);
    expect(next.added.size).toBe(0);
    expect(next.removed).toEqual([]);
    expect(next.repacked).toBe(false);
  });

  it("frees a dropped section's cells and places a new one in the first gap that holds it", () => {
    const first = layoutSections(new Map(), [request("a", 0, 4), request("b", 0, 4), request("c", 0, 4)]);
    // b drops its finest level for its coarsest; a new member takes the rest of the gap.
    const next = layoutSections(first.metas, [request("a", 0, 4), request("b", 2, 1), request("c", 0, 4), request("d", 0, 3)]);
    expect(offsets(next.metas)).toEqual({ a: [0], b: [4], c: [8], d: [5] });
    expect(next.removed).toEqual([first.metas.get("b")![0]]);
    expect(offsets(next.added)).toEqual({ b: [4], d: [5] });
    expect(next.space.end).toBe(12);
  });

  it("puts a section no gap holds after the last", () => {
    const first = layoutSections(new Map(), [request("a", 0, 2), request("b", 0, 2)]);
    const next = layoutSections(first.metas, [request("a", 0, 2), request("b", 0, 2), request("c", 0, 3)]);
    expect(offsets(next.metas)).toEqual({ a: [0], b: [2], c: [4] });
    expect(next.space.end).toBe(7);
  });

  it("moves a section whose grid changed", () => {
    const first = layoutSections(new Map(), [request("a", 0, 2), request("b", 0, 2)]);
    const next = layoutSections(first.metas, [request("a", 0, 3), request("b", 0, 2)]);
    expect(offsets(next.metas)).toEqual({ a: [4], b: [2] });
    expect(next.removed).toEqual([first.metas.get("a")![0]]);
  });

  it("keeps small gaps, but lays everything out afresh once gaps leave most of a large indirection unused", () => {
    const small = Array.from({ length: 10 }, (_, i) => request(`m${i}`, 0, 4));
    const kept = layoutSections(layoutSections(new Map(), small).metas, [small[9]]);
    expect(kept.repacked).toBe(false);
    expect(offsets(kept.metas)).toEqual({ m9: [36] });

    const large = Array.from({ length: 10 }, (_, i) => request(`m${i}`, 0, 40_000));
    const first = layoutSections(new Map(), large);
    // Only the last member stays, at offset 360,000 of 400,000 cells.
    const next = layoutSections(first.metas, [large[9], request("x", 0, 40_000)]);
    expect(next.repacked).toBe(true);
    expect(offsets(next.metas)).toEqual({ m9: [0], x: [40_000] });
    expect(next.space.end).toBe(80_000);
    expect(next.removed).toHaveLength(10);
  });

  it("keeps the layout when nothing changed", () => {
    const requests = [request("a", 0, 4), request("a", 1, 1)];
    const first = layoutSections(new Map(), requests);
    const next = layoutSections(first.metas, requests);
    expect(next.placed).toEqual(first.placed);
    expect(next.placed.every((meta, i) => meta === first.placed[i])).toBe(true);
    expect(next.space.end).toBe(first.space.end);
  });
});

describe("relayMember", () => {
  it("frees what a member drops, joining gaps, and places what it gains in the first that holds it", () => {
    const first = layoutSections(new Map(), [request("a", 0, 4), request("b", 0, 4), request("c", 0, 4)]);
    const space = first.space;
    // b drops level 0 for level 2: its four cells free up, and one of them takes level 2.
    const b = relayMember(first.metas.get("b")!, [request("b", 2, 1)], space, 3);
    expect(b.removed).toEqual(first.metas.get("b"));
    expect(b.metas.map((m) => m.offset)).toEqual([4]);
    expect(space).toEqual({ free: [{ start: 5, size: 3 }], end: 12, used: 9 });
    // a drops everything: its four cells become a gap of their own, apart from the one at 5.
    relayMember(first.metas.get("a")!, [], space, 3);
    expect(space.free).toEqual([{ start: 0, size: 4 }, { start: 5, size: 3 }]);
    expect(space.used).toBe(5);
    // c keeps its section and gains one that only the end holds.
    const c = relayMember(first.metas.get("c")!, [request("c", 0, 4), request("c", 1, 5)], space, 3);
    expect(c.metas[0]).toBe(first.metas.get("c")![0]);
    expect(c.added.map((m) => m.offset)).toEqual([12]);
    expect(space.end).toBe(17);
    expect(wantsRepack(space)).toBe(false);
  });

  it("joins a freed stretch with the gaps on both sides", () => {
    const first = layoutSections(new Map(), ["a", "b", "c", "d"].map((id) => request(id, 0, 40_000)));
    const space = first.space;
    relayMember(first.metas.get("a")!, [], space, 3);
    relayMember(first.metas.get("c")!, [], space, 3);
    expect(wantsRepack(space)).toBe(false);
    relayMember(first.metas.get("b")!, [], space, 3);
    expect(space.free).toEqual([{ start: 0, size: 120_000 }]);
    expect(wantsRepack(space)).toBe(true);
  });
});
