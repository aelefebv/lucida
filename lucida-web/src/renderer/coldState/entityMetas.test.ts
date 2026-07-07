/**
 * Unit tests for `computeEntityMetas`. Pure-function tests — no GPU.
 *
 * Locks the matrix: 3D arity (volume) vs 2D arity (slice); single LOD;
 * multi-LOD where all match; mixed where some LODs don't match the
 * pool's chunk dims; fallback to target LOD; threading of `startOffset`.
 */

import { describe, it, expect } from "vitest";
import { computeEntityMetas } from "./entityMetas.ts";
import type { ColdStateActiveEntry } from "../workerProtocol.ts";

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
  opts: Partial<Omit<ColdStateActiveEntry, "kind">> & {
    entityId: string;
    imageId: string;
    mode: ColdStateActiveEntry["mode"];
  },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    targetLod: opts.targetLod ?? 0,
    detailOwnedLodRange: opts.detailOwnedLodRange ?? [0, 0] as [number, number],
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
    ],
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    groupProxyAvailable: opts.groupProxyAvailable ?? false,
    detailLevel: opts.detailLevel,
    coarseLevel: opts.coarseLevel,
    wantedLodLevels: opts.wantedLodLevels,
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
    parentGroupId: opts.parentGroupId ?? null,
  };
}

describe("computeEntityMetas — volume (3D arity)", () => {
  it("single LOD that matches → one meta + nextOffset by gridX*gridY*gridZ", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [0, 0],
      levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
    });
    const { metas, nextOffset } = computeEntityMetas(entry, [32, 64, 64], 0, 3);
    expect(metas).toEqual([
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 64, 64], levelDims: [64, 256, 256], offset: 0 },
    ]);
    expect(nextOffset).toBe(2 * 4 * 4); // 32
  });

  it("multi-LOD all matching → sequential offsets", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [0, 1],
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [32, 64, 64], gridShape: [1, 2, 2], levelDims: [32, 128, 128] },
      ],
    });
    const { metas, nextOffset } = computeEntityMetas(entry, [32, 64, 64], 100, 3);
    expect(metas).toHaveLength(2);
    expect(metas[0].offset).toBe(100);
    expect(metas[1].offset).toBe(100 + 2 * 4 * 4); // 132
    expect(nextOffset).toBe(100 + 2 * 4 * 4 + 1 * 2 * 2); // 136
  });

  it("wantedLodLevels allocates only selected detail/coarse levels", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [0, 2],
      wantedLodLevels: [0, 2],
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [32, 64, 64], gridShape: [1, 2, 2], levelDims: [32, 128, 128] },
        { level: 2, chunkShape: [32, 64, 64], gridShape: [1, 1, 1], levelDims: [32, 64, 64] },
      ],
    });
    const { metas, nextOffset } = computeEntityMetas(entry, [32, 64, 64], 10, 3);
    expect(metas.map((m) => m.level)).toEqual([0, 2]);
    expect(metas[0].offset).toBe(10);
    expect(metas[1].offset).toBe(10 + 2 * 4 * 4);
    expect(nextOffset).toBe(10 + 2 * 4 * 4 + 1);
  });

  it("LODs with mismatched chunk dims are skipped", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [0, 1],
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }, // mismatched
      ],
    });
    const { metas } = computeEntityMetas(entry, [32, 64, 64], 0, 3);
    expect(metas).toHaveLength(1);
    expect(metas[0].level).toBe(0);
  });

  it("no matching LODs → fallback to target LOD with pool's chunk dims", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [1, 1],
      targetLod: 1,
      levels: [
        { level: 1, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] },
      ],
    });
    const { metas, nextOffset } = computeEntityMetas(entry, [32, 64, 64], 50, 3);
    expect(metas).toHaveLength(1);
    expect(metas[0].level).toBe(1);
    expect(metas[0].chunkDims).toEqual([32, 64, 64]); // pool dims, not the level's [16,32,32]
    expect(metas[0].gridDims).toEqual([4, 8, 8]);
    expect(metas[0].offset).toBe(50);
    expect(nextOffset).toBe(50 + 4 * 8 * 8);
  });
});

describe("computeEntityMetas — slice (2D arity)", () => {
  it("matches on chunkX/chunkY only; nextOffset by gridX*gridY", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [0, 0],
      levels: [{ level: 0, chunkShape: [8, 128, 128], gridShape: [4, 2, 2], levelDims: [32, 256, 256] }],
    });
    // poolChunkDims passed as [1, 128, 128] from groupEntriesByPool (slice).
    const { metas, nextOffset } = computeEntityMetas(entry, [1, 128, 128], 0, 2);
    expect(metas).toHaveLength(1);
    expect(metas[0].level).toBe(0);
    expect(metas[0].gridDims).toEqual([4, 2, 2]);
    expect(metas[0].chunkDims).toEqual([8, 128, 128]); // from level's actual chunkShape
    expect(nextOffset).toBe(2 * 2); // gridX * gridY = 4 (2D)
  });

  it("multi-LOD slice, all matching → sequential 2D offsets", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [0, 1],
      levels: [
        { level: 0, chunkShape: [8, 128, 128], gridShape: [4, 2, 2], levelDims: [32, 256, 256] },
        { level: 1, chunkShape: [8, 128, 128], gridShape: [2, 1, 1], levelDims: [16, 128, 128] },
      ],
    });
    const { metas, nextOffset } = computeEntityMetas(entry, [1, 128, 128], 0, 2);
    expect(metas).toHaveLength(2);
    expect(metas[0].offset).toBe(0);
    expect(metas[1].offset).toBe(2 * 2); // 4
    expect(nextOffset).toBe(2 * 2 + 1 * 1); // 5
  });

  it("slice fallback uses target level's own chunkDims (not the pool's [1,Y,X])", () => {
    const entry = makeEntry({
      entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
      detailOwnedLodRange: [1, 1],
      targetLod: 1,
      levels: [
        { level: 1, chunkShape: [4, 64, 64], gridShape: [8, 4, 4], levelDims: [32, 256, 256] },
      ],
    });
    // pool key was built with X/Y = 128/128 but target level is 64/64 — fallback path
    const { metas } = computeEntityMetas(entry, [1, 128, 128], 0, 2);
    expect(metas).toHaveLength(1);
    expect(metas[0].chunkDims).toEqual([4, 64, 64]); // target's own, NOT [1, 128, 128]
  });
});

describe("computeEntityMetas — degenerate inputs", () => {
  it("entry with empty levels[] → empty metas, nextOffset unchanged", () => {
    const entry = makeEntry({
      entityId: "groupA", imageId: "", mode: "group-as-proxy",
      detailOwnedLodRange: [0, 0],
      levels: [],
    });
    const { metas, nextOffset } = computeEntityMetas(entry, [32, 64, 64], 42, 3);
    expect(metas).toEqual([]);
    expect(nextOffset).toBe(42);
  });
});
