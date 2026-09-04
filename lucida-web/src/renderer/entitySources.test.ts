import { describe, expect, it } from "vitest";
import {
  detailTierLevels,
  selectEntitySources,
  targetLevelOf,
  type EntitySource,
} from "./entitySources.ts";
import { DESCRIPTOR_MAX_LEVEL_SOURCES } from "./descriptor/layout.ts";
import type { ColdStateActiveEntry, ColdStateTileEntry } from "./workerProtocol.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** A tile entry over a pyramid with `levelCount` halving levels. */
function tile(opts: {
  detailLevels: number[];
  coarseLevel?: number | null;
  levelCount?: number;
  levels?: ColdStateTileEntry["levels"];
}): ColdStateActiveEntry {
  const levelCount = opts.levelCount ?? 6;
  const levels = opts.levels ?? Array.from({ length: levelCount }, (_, level) => ({
    level,
    chunkShape: [1, 64, 64] as [number, number, number],
    gridShape: [1, 1 << (levelCount - 1 - level), 1 << (levelCount - 1 - level)] as [number, number, number],
    levelDims: [1, 64 << (levelCount - 1 - level), 64 << (levelCount - 1 - level)] as [number, number, number],
  }));
  return {
    kind: "tile",
    entityId: "e",
    imageId: "img",
    mode: "tiles-with-detail",
    detailLevels: opts.detailLevels,
    coarseLevel: opts.coarseLevel ?? null,
    levels,
    proxyAvailable: false,
    groupProxyAvailable: false,
    parentGroupId: null,
    modelMatrix: identity(),
    invModelMatrix: identity(),
    displayStateByChannel: {},
  };
}

function group(): ColdStateActiveEntry {
  return {
    kind: "group-as-proxy",
    entityId: "g",
    mode: "group-as-proxy",
    levels: [],
    proxyAvailable: true,
    groupProxyAvailable: true,
    parentGroupId: null,
    modelMatrix: identity(),
    invModelMatrix: identity(),
    displayStateByChannel: {},
  };
}

function source(tier: ResidencyTier, level: number, poolKey: string, offset = level * 100): EntitySource {
  return {
    tier,
    poolKey,
    meta: { level, gridDims: [1, 2, 2], chunkDims: [1, 64, 64], levelDims: [1, 128, 128], offset },
  };
}

describe("targetLevelOf", () => {
  it("is the first detail level of a tile entry", () => {
    expect(targetLevelOf(tile({ detailLevels: [2] }))).toBe(2);
  });

  it("is undefined for a group-as-proxy entry and for a tile with no detail levels", () => {
    expect(targetLevelOf(group())).toBeUndefined();
    expect(targetLevelOf(tile({ detailLevels: [] }))).toBeUndefined();
  });
});

describe("detailTierLevels", () => {
  it("holds the target and the next three coarser pyramid levels, finest first", () => {
    expect(detailTierLevels(tile({ detailLevels: [1], levelCount: 6 }))).toEqual([1, 2, 3, 4]);
  });

  it("never exceeds the resident-level bound", () => {
    expect(detailTierLevels(tile({ detailLevels: [0], levelCount: 9 }))).toHaveLength(DESCRIPTOR_MAX_LEVEL_SOURCES);
  });

  it("stops at the coarsest pyramid level", () => {
    expect(detailTierLevels(tile({ detailLevels: [4], levelCount: 6 }))).toEqual([4, 5]);
  });

  it("holds no level finer than the target", () => {
    expect(detailTierLevels(tile({ detailLevels: [3], levelCount: 4 }))).toEqual([3]);
  });

  it("orders by level even when the pyramid lists levels out of order", () => {
    const entry = tile({
      detailLevels: [0],
      levels: [2, 0, 1].map((level) => ({
        level,
        chunkShape: [1, 8, 8] as [number, number, number],
        gridShape: [1, 1, 1] as [number, number, number],
        levelDims: [1, 8, 8] as [number, number, number],
      })),
    });
    expect(detailTierLevels(entry)).toEqual([0, 1, 2]);
  });

  it("is empty for a group-as-proxy entry", () => {
    expect(detailTierLevels(group())).toEqual([]);
  });
});

describe("selectEntitySources", () => {
  it("names the detail sections at or coarser than the target, finest first, plus the coarse section", () => {
    const entry = tile({ detailLevels: [1], coarseLevel: 4 });
    const sources = [
      source("detail", 3, "pool-a"),
      source("detail", 1, "pool-a"),
      source("detail", 2, "pool-a"),
      source("coarse", 4, "pool-c"),
    ];
    const sel = selectEntitySources(entry, sources);
    expect(sel.levels.map((l) => l.source.meta.level)).toEqual([1, 2, 3]);
    expect(sel.levels.map((l) => l.poolIndex)).toEqual([0, 0, 0]);
    expect(sel.levelPoolKeys).toEqual(["pool-a"]);
    expect(sel.coarse?.meta.level).toBe(4);
    expect(sel.coarse?.poolKey).toBe("pool-c");
  });

  it("leaves out detail sections finer than the target", () => {
    const entry = tile({ detailLevels: [2] });
    const sel = selectEntitySources(entry, [
      source("detail", 0, "pool-a"),
      source("detail", 1, "pool-a"),
      source("detail", 2, "pool-a"),
      source("detail", 3, "pool-a"),
    ]);
    expect(sel.levels.map((l) => l.source.meta.level)).toEqual([2, 3]);
  });

  it("caps the level sources at the bound", () => {
    const entry = tile({ detailLevels: [0], levelCount: 8 });
    const sel = selectEntitySources(
      entry,
      [0, 1, 2, 3, 4, 5].map((level) => source("detail", level, "pool-a")),
    );
    expect(sel.levels).toHaveLength(DESCRIPTOR_MAX_LEVEL_SOURCES);
    expect(sel.levels.map((l) => l.source.meta.level)).toEqual([0, 1, 2, 3]);
  });

  it("gives each distinct pool a dense binding slot in finest-first order", () => {
    const entry = tile({ detailLevels: [0] });
    const sel = selectEntitySources(entry, [
      source("detail", 0, "pool-fine"),
      source("detail", 1, "pool-fine"),
      source("detail", 2, "pool-coarse-chunks"),
      source("detail", 3, "pool-fine"),
    ]);
    expect(sel.levelPoolKeys).toEqual(["pool-fine", "pool-coarse-chunks"]);
    expect(sel.levels.map((l) => l.poolIndex)).toEqual([0, 0, 1, 0]);
  });

  it("keeps the detail and coarse sections apart when they share a level", () => {
    const entry = tile({ detailLevels: [1], coarseLevel: 1 });
    const sel = selectEntitySources(entry, [
      source("detail", 1, "pool-d", 11),
      source("coarse", 1, "pool-c", 43),
    ]);
    expect(sel.levels).toHaveLength(1);
    expect(sel.levels[0].source.meta.offset).toBe(11);
    expect(sel.coarse?.meta.offset).toBe(43);
  });

  it("returns no sources for a group-as-proxy entry", () => {
    expect(selectEntitySources(group(), [source("detail", 0, "pool-a")])).toEqual({
      levels: [],
      levelPoolKeys: [],
      coarse: null,
    });
  });
});
