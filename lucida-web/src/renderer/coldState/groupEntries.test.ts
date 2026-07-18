import { describe, expect, it } from "vitest";
import { makeColdEntry, makeColdMessage } from "../testFixtures.ts";
import { groupEntriesByPool } from "./groupEntries.ts";

describe("groupEntriesByPool", () => {
  it("coalesces entries with the same chunk shape into one volume pool", () => {
    const cold = makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeColdEntry({
        entityId: "b",
        imageId: "image-b",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);

    const groups = groupEntriesByPool(cold, "volume");
    expect([...groups.keys()]).toEqual(["ds-1:64x64x32:detail"]);
    expect(groups.values().next().value?.entries.map((entry) => entry.memberId))
      .toEqual(["image-a", "image-b"]);
  });

  it("partitions mismatched chunk shapes", () => {
    const cold = makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeColdEntry({
        entityId: "b",
        imageId: "image-b",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);

    expect([...groupEntriesByPool(cold, "volume").keys()].sort()).toEqual([
      "ds-1:32x32x16:detail",
      "ds-1:64x64x32:detail",
    ]);
  });

  it("creates independent detail and coarse pools", () => {
    const cold = makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        detailLevel: 0,
        coarseLevel: 2,
        wantedLodLevels: [0, 2],
        levels: [
          { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
          { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
        ],
      }),
    ]);

    const groups = groupEntriesByPool(cold, "volume");
    expect([...groups.keys()].sort()).toEqual([
      "ds-1:128x128x8:coarse",
      "ds-1:64x64x32:detail",
    ]);
    expect(groups.get("ds-1:128x128x8:coarse")?.entries[0]).toMatchObject({
      memberId: "image-a",
      tier: "coarse",
      level: 2,
    });
  });

  it("retains explicit multi-channel identity even with one visible channel", () => {
    const cold = makeColdMessage(
      [makeColdEntry({ entityId: "a", imageId: "image-a" })],
      { multiChannel: true, visibleChannels: [2] },
    );
    const groups = groupEntriesByPool(cold, "volume");
    expect([...groups.keys()]).toEqual(["ds-1:ch2:64x64x1:detail"]);
    expect(groups.values().next().value?.entries[0].memberId).toBe("image-a:ch2");
  });

  it("drops depth from slice pool keys while preserving source depth metadata", () => {
    const cold = makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        levels: [{ level: 0, chunkShape: [8, 128, 64], gridShape: [4, 2, 4], levelDims: [32, 256, 256] }],
      }),
    ], { viewMode: "slice" });
    const groups = groupEntriesByPool(cold, "slice");
    const group = groups.get("ds-1:64x128:detail");
    expect(group?.chunkDims).toEqual([1, 128, 64]);
  });

  it("skips a tier whose requested source level is absent", () => {
    const cold = makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        detailLevel: 3,
        wantedLodLevels: [3],
        levels: [],
      }),
    ]);
    expect(groupEntriesByPool(cold, "volume").size).toBe(0);
  });
});
