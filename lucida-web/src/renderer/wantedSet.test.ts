import { describe, expect, it } from "vitest";
import { makeColdEntry, makeColdMessage } from "./testFixtures.ts";
import {
  computeWantedSet,
  type AtlasSnapshot,
  type AtlasLodMeta,
} from "./wantedSet.ts";

function entry(overrides: Parameters<typeof makeColdEntry>[0] = {
  entityId: "entity-a",
  imageId: "image-a",
}) {
  return makeColdEntry({
    ...overrides,
    entityId: overrides.entityId ?? "entity-a",
    imageId: overrides.imageId ?? "image-a",
    detailLevel: overrides.detailLevel ?? 0,
    coarseLevel: "coarseLevel" in overrides ? overrides.coarseLevel ?? null : null,
    wantedLodLevels: overrides.wantedLodLevels ?? [0],
    levels: overrides.levels ?? [
      {
        level: 0,
        chunkShape: [32, 32, 32],
        gridShape: [2, 4, 4],
        levelDims: [64, 128, 128],
      },
    ],
  });
}

function cold(
  overrides: Parameters<typeof makeColdMessage>[1] = {},
  activeSet = [entry()],
) {
  return makeColdMessage(activeSet, {
    datasetId: "ds-0",
    visibleRegion: {
      xyBoundsVox: [0, 0, 64, 64],
      zRangeVox: [0, 32],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    ...overrides,
  });
}

function atlas(
  memberId: string,
  lodMetas: AtlasLodMeta[],
  slots: string[] = [],
  z?: number,
): AtlasSnapshot {
  return {
    z,
    slots: new Map(slots.map((key, index) => [key, index])),
    entityMetas: new Map([[memberId, lodMetas]]),
  };
}

function slot(memberId: string, chunkKey: string): string {
  return `${memberId}|${chunkKey}`;
}

function routing(...entries: Array<[memberId: string, tier: "detail" | "coarse", pool: string]>) {
  return new Map(entries.map(([memberId, tier, pool]) => [`${memberId}|${tier}`, pool]));
}

const DETAIL_META: AtlasLodMeta = {
  level: 0,
  gridDims: [2, 4, 4],
  chunkDims: [32, 32, 32],
  offset: 0,
};

describe("computeWantedSet", () => {
  it("reports every visible chunk missing from an empty volume atlas", () => {
    const pools = new Map([["detail", atlas("image-a", [DETAIL_META])]]);
    const result = computeWantedSet(
      cold(),
      pools,
      new Map(),
      routing(["image-a", "detail", "detail"]),
    );

    expect(result.missing).toHaveLength(4);
    expect(result.missing.every((missing) => missing.kind === "chunk")).toBe(true);
    expect(result.missing.map((missing) => missing.chunkKey).sort()).toEqual([
      "0/0/0/0/0/0",
      "0/0/0/0/0/1",
      "0/0/0/0/1/0",
      "0/0/0/0/1/1",
    ]);
    expect(result.missing.every((missing) => missing.tier === "detail")).toBe(true);
  });

  it("returns an empty result when every visible chunk is resident", () => {
    const resident = [
      "0/0/0/0/0/0",
      "0/0/0/0/0/1",
      "0/0/0/0/1/0",
      "0/0/0/0/1/1",
    ].map((key) => slot("image-a", key));
    const pools = new Map([["detail", atlas("image-a", [DETAIL_META], resident)]]);
    expect(computeWantedSet(
      cold(),
      pools,
      new Map(),
      routing(["image-a", "detail", "detail"]),
    ).missing).toEqual([]);
  });

  it("reports only the non-resident subset", () => {
    const pools = new Map([[
      "detail",
      atlas("image-a", [DETAIL_META], [
        slot("image-a", "0/0/0/0/0/0"),
        slot("image-a", "0/0/0/0/1/1"),
      ]),
    ]]);
    const missing = computeWantedSet(
      cold(),
      pools,
      new Map(),
      routing(["image-a", "detail", "detail"]),
    ).missing;
    expect(missing.map((entry) => entry.chunkKey).sort()).toEqual([
      "0/0/0/0/0/1",
      "0/0/0/0/1/0",
    ]);
  });

  it("clips demand to the visible region in entity-local coordinates", () => {
    const active = entry({
      entityId: "entity-a",
      imageId: "image-a",
      layoutPositionVox: [64, 32],
    });
    const state = cold({
      visibleRegion: {
        xyBoundsVox: [64, 32, 96, 64],
        zRangeVox: [0, 32],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
    }, [active]);
    const pools = new Map([["detail", atlas("image-a", [DETAIL_META])]]);
    const result = computeWantedSet(
      state,
      pools,
      new Map(),
      routing(["image-a", "detail", "detail"]),
    );
    expect(result.missing.map((missing) => missing.chunkKey)).toEqual([
      "0/0/0/0/0/0",
    ]);
  });

  it("uses channel-qualified member and pool identities in composite mode", () => {
    const state = cold({ multiChannel: true, visibleChannels: [0, 2] });
    const pools = new Map([
      ["detail-0", atlas("image-a:ch0", [DETAIL_META])],
      ["detail-2", atlas("image-a:ch2", [DETAIL_META])],
    ]);
    const result = computeWantedSet(
      state,
      pools,
      new Map(),
      routing(
        ["image-a:ch0", "detail", "detail-0"],
        ["image-a:ch2", "detail", "detail-2"],
      ),
    );

    expect(result.missing).toHaveLength(8);
    expect(new Set(result.missing.map((missing) => missing.memberId)))
      .toEqual(new Set(["image-a:ch0", "image-a:ch2"]));
    expect(new Set(result.missing.map((missing) => missing.c))).toEqual(new Set([0, 2]));
  });

  it("retains channel-qualified identity when composite mode has one visible channel", () => {
    const state = cold({ multiChannel: true, visibleChannels: [2] });
    const pools = new Map([["detail-2", atlas("image-a:ch2", [DETAIL_META])]]);
    const result = computeWantedSet(
      state,
      pools,
      new Map(),
      routing(["image-a:ch2", "detail", "detail-2"]),
    );
    expect(result.missing.every((missing) => missing.memberId === "image-a:ch2")).toBe(true);
    expect(result.missing.every((missing) => missing.c === 2)).toBe(true);
  });

  it("requests only the atlas's current Z chunk in slice mode", () => {
    const state = cold({ viewMode: "slice" });
    const slices = new Map([["detail", atlas("image-a", [DETAIL_META], [], 40)]]);
    const result = computeWantedSet(
      state,
      new Map(),
      slices,
      routing(["image-a", "detail", "detail"]),
    );
    expect(result.missing).toHaveLength(4);
    expect(result.missing.every((missing) => missing.chunkKey.split("/")[3] === "1"))
      .toBe(true);
  });

  it("tracks detail and coarse residency in independent tier pools", () => {
    const active = entry({
      entityId: "entity-a",
      imageId: "image-a",
      detailLevel: 0,
      coarseLevel: 2,
      wantedLodLevels: [0, 2],
      levels: [
        { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
        { level: 2, chunkShape: [32, 64, 64], gridShape: [2, 1, 1], levelDims: [64, 64, 64] },
      ],
    });
    const pools = new Map([
      ["detail", atlas("image-a", [{ ...DETAIL_META, level: 0 }])],
      ["coarse", atlas("image-a", [{ level: 2, gridDims: [2, 1, 1], chunkDims: [32, 64, 64], offset: 0 }])],
    ]);
    const result = computeWantedSet(
      cold({}, [active]),
      pools,
      new Map(),
      routing(
        ["image-a", "detail", "detail"],
        ["image-a", "coarse", "coarse"],
      ),
    );
    expect(result.missing.filter((missing) => missing.tier === "detail")).toHaveLength(4);
    expect(result.missing.filter((missing) => missing.tier === "coarse")).toHaveLength(1);
  });

  it("keeps same-level detail and coarse slots independent", () => {
    const active = entry({
      entityId: "entity-a",
      imageId: "image-a",
      detailLevel: 0,
      coarseLevel: 0,
      wantedLodLevels: [0],
      levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 1, 1], levelDims: [64, 64, 64] }],
    });
    const meta = { level: 0, gridDims: [2, 1, 1], chunkDims: [32, 64, 64], offset: 0 } as AtlasLodMeta;
    const residentKey = slot("image-a", "0/0/0/0/0/0");
    const pools = new Map([
      ["detail", atlas("image-a", [meta], [residentKey])],
      ["coarse", atlas("image-a", [meta])],
    ]);
    const result = computeWantedSet(
      cold({}, [active]),
      pools,
      new Map(),
      routing(
        ["image-a", "detail", "detail"],
        ["image-a", "coarse", "coarse"],
      ),
    );
    expect(result.missing).toEqual([
      expect.objectContaining({ tier: "coarse", chunkKey: "0/0/0/0/0/0" }),
    ]);
  });

  it("returns no demand without active entries or without a routed atlas", () => {
    expect(computeWantedSet(cold({}, []), new Map(), new Map(), new Map()).missing)
      .toEqual([]);
    expect(computeWantedSet(cold(), new Map(), new Map(), new Map()).missing)
      .toEqual([]);
  });

  it("preserves the current timepoint in every key", () => {
    const pools = new Map([["detail", atlas("image-a", [DETAIL_META])]]);
    const result = computeWantedSet(
      cold({ currentT: 7 }),
      pools,
      new Map(),
      routing(["image-a", "detail", "detail"]),
    );
    expect(result.missing.every((missing) => missing.chunkKey.split("/")[1] === "7"))
      .toBe(true);
  });
});
