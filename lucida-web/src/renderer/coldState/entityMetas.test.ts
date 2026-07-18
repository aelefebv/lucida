import { describe, expect, it } from "vitest";
import { makeColdEntry } from "../testFixtures.ts";
import { computeEntityMetas, computeEntityTierMeta } from "./entityMetas.ts";

describe("computeEntityMetas", () => {
  it("allocates matching volume levels at sequential 3-D offsets", () => {
    const entry = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      detailOwnedLodRange: [0, 1],
      wantedLodLevels: [0, 1],
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [32, 64, 64], gridShape: [1, 2, 2], levelDims: [32, 128, 128] },
      ],
    });

    const result = computeEntityMetas(entry, [32, 64, 64], 100, 3);
    expect(result.metas.map((meta) => [meta.level, meta.offset])).toEqual([
      [0, 100],
      [1, 132],
    ]);
    expect(result.nextOffset).toBe(136);
  });

  it("uses only explicitly wanted levels", () => {
    const entry = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      detailOwnedLodRange: [0, 2],
      wantedLodLevels: [0, 2],
      levels: [0, 1, 2].map((level) => ({
        level,
        chunkShape: [1, 64, 64] as [number, number, number],
        gridShape: [1, 4 - level, 4 - level] as [number, number, number],
        levelDims: [1, 256, 256] as [number, number, number],
      })),
    });
    expect(computeEntityMetas(entry, [1, 64, 64], 0, 3).metas.map((meta) => meta.level))
      .toEqual([0, 2]);
  });

  it("skips mismatched levels when another level matches", () => {
    const entry = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      detailOwnedLodRange: [0, 1],
      wantedLodLevels: [0, 1],
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] },
      ],
    });
    expect(computeEntityMetas(entry, [32, 64, 64], 0, 3).metas.map((meta) => meta.level))
      .toEqual([0]);
  });

  it("falls back to target geometry when no requested level matches the pool", () => {
    const entry = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      targetLod: 1,
      detailLevel: 1,
      detailOwnedLodRange: [1, 1],
      wantedLodLevels: [1],
      levels: [
        { level: 1, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] },
      ],
    });
    const result = computeEntityMetas(entry, [32, 64, 64], 50, 3);
    expect(result.metas[0]).toMatchObject({
      level: 1,
      gridDims: [4, 8, 8],
      chunkDims: [32, 64, 64],
      offset: 50,
    });
    expect(result.nextOffset).toBe(306);
  });

  it("uses 2-D offset accounting for slice pools", () => {
    const entry = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      levels: [{ level: 0, chunkShape: [8, 128, 128], gridShape: [4, 2, 2], levelDims: [32, 256, 256] }],
    });
    const result = computeEntityMetas(entry, [1, 128, 128], 10, 2);
    expect(result.metas[0].chunkDims).toEqual([8, 128, 128]);
    expect(result.nextOffset).toBe(14);
  });

  it("keeps the offset unchanged when an entry has no levels", () => {
    const entry = makeColdEntry({ entityId: "a", imageId: "image-a", levels: [] });
    expect(computeEntityMetas(entry, [1, 64, 64], 17, 3))
      .toEqual({ metas: [], nextOffset: 17 });
  });
});

describe("computeEntityTierMeta", () => {
  it("returns exactly one requested tier and advances by its grid volume", () => {
    const entry = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      levels: [{ level: 2, chunkShape: [8, 16, 32], gridShape: [2, 3, 4], levelDims: [16, 48, 128] }],
    });
    const result = computeEntityTierMeta(entry, 2, [8, 16, 32], 5, 3);
    expect(result.meta).toMatchObject({ level: 2, offset: 5 });
    expect(result.nextOffset).toBe(29);
  });
});
