/**
 * Unit tests for `computeEntityTierMeta`. Pure-function tests — no GPU.
 *
 * Locks the matrix: 3D arity (volume) vs 2D arity (slice); a level whose
 * chunk shape matches the pool; a level whose chunk shape does not; a
 * level the entry lacks; threading of `startOffset`.
 */

import { describe, it, expect } from "vitest";
import { computeEntityTierMeta } from "./entityMetas.ts";
import type { ColdStateActiveEntry, ColdStateTileEntry } from "../workerProtocol.ts";

function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function defaultDisplay(): ColdStateActiveEntry["displayStateByChannel"][number] {
  return {
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    colormapName: "gray",
    channelMask: 1,
  };
}

function makeEntry(
  opts: Partial<Omit<ColdStateTileEntry, "kind" | "mode">> & {
    entityId: string;
    imageId: string;
    mode: ColdStateActiveEntry["mode"];
  },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
    ],
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    groupProxyAvailable: opts.groupProxyAvailable ?? false,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
  if (opts.mode === "group-as-proxy") {
    return {
      ...base,
      kind: "group-as-proxy",
      mode: "group-as-proxy",
      parentGroupId: null,
    };
  }
  return {
    ...base,
    kind: "tile",
    imageId: opts.imageId,
    mode: opts.mode,
    detailLevels: opts.detailLevels ?? [0],
    coarseLevel: opts.coarseLevel ?? null,
    parentGroupId: opts.parentGroupId ?? null,
  };
}

describe("computeEntityTierMeta — volume (3D arity)", () => {
  it("level that matches → one meta + nextOffset by gridX*gridY*gridZ", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
    });
    const { meta, nextOffset } = computeEntityTierMeta(entry, 0, [32, 64, 64], 0, 3);
    expect(meta).toEqual(
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 64, 64], levelDims: [64, 256, 256], offset: 0 },
    );
    expect(nextOffset).toBe(2 * 4 * 4); // 32
  });

  it("threads startOffset into the meta and past its section", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [32, 64, 64], gridShape: [1, 2, 2], levelDims: [32, 128, 128] },
      ],
    });
    const first = computeEntityTierMeta(entry, 0, [32, 64, 64], 100, 3);
    const second = computeEntityTierMeta(entry, 1, [32, 64, 64], first.nextOffset, 3);
    expect(first.meta?.offset).toBe(100);
    expect(second.meta?.offset).toBe(100 + 2 * 4 * 4); // 132
    expect(second.nextOffset).toBe(100 + 2 * 4 * 4 + 1 * 2 * 2); // 136
  });

  it("a level whose chunk dims mismatch the pool → null meta, offset unchanged", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      levels: [
        { level: 1, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }, // mismatched
      ],
    });
    const { meta, nextOffset } = computeEntityTierMeta(entry, 1, [32, 64, 64], 50, 3);
    expect(meta).toBeNull();
    expect(nextOffset).toBe(50);
  });

  it("a level the entry lacks → null meta, offset unchanged", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
    });
    const { meta, nextOffset } = computeEntityTierMeta(entry, 2, [32, 64, 64], 7, 3);
    expect(meta).toBeNull();
    expect(nextOffset).toBe(7);
  });
});

describe("computeEntityTierMeta — slice (2D arity)", () => {
  it("matches on chunkX/chunkY only; nextOffset by gridX*gridY", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      levels: [{ level: 0, chunkShape: [8, 128, 128], gridShape: [4, 2, 2], levelDims: [32, 256, 256] }],
    });
    // poolChunkDims passed as [1, 128, 128] from groupEntriesByPool (slice).
    const { meta, nextOffset } = computeEntityTierMeta(entry, 0, [1, 128, 128], 0, 2);
    expect(meta).toMatchObject({
      level: 0,
      gridDims: [4, 2, 2],
      chunkDims: [8, 128, 128], // from level's actual chunkShape
    });
    expect(nextOffset).toBe(2 * 2); // gridX * gridY = 4 (2D)
  });

  it("a level whose X/Y chunk dims mismatch the slice pool → null meta", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      levels: [{ level: 1, chunkShape: [4, 64, 64], gridShape: [8, 4, 4], levelDims: [32, 256, 256] }],
    });
    const { meta, nextOffset } = computeEntityTierMeta(entry, 1, [1, 128, 128], 3, 2);
    expect(meta).toBeNull();
    expect(nextOffset).toBe(3);
  });
});

describe("computeEntityTierMeta — degenerate inputs", () => {
  it("entry with empty levels[] → null meta, nextOffset unchanged", () => {
    const entry = makeEntry({
      entityId: "groupA", imageId: "", mode: "group-as-proxy",
      levels: [],
    });
    const { meta, nextOffset } = computeEntityTierMeta(entry, 0, [32, 64, 64], 42, 3);
    expect(meta).toBeNull();
    expect(nextOffset).toBe(42);
  });
});
