/**
 * Unit tests for `groupEntriesByPool`. Pure-function tests — no GPU.
 *
 * Locks the partition matrix the worker's previous inline code
 * implemented: shared chunk dims → one group; mismatched chunk dims →
 * multiple groups; multi-channel → channel suffix on the pool key;
 * `well-as-proxy` (no matching target level) → skipped from groups.
 */

import { describe, it, expect } from "vitest";
import { groupEntriesByPool } from "./groupEntries.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
} from "../workerProtocol.ts";

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
    wellProxyAvailable: opts.wellProxyAvailable ?? false,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
  if (opts.mode === "well-as-proxy") {
    return {
      ...base,
      kind: "well-as-proxy",
      mode: "well-as-proxy",
      parentWellId: null,
    };
  }
  return {
    ...base,
    kind: "field",
    imageId: opts.imageId,
    mode: opts.mode,
    parentWellId: opts.parentWellId ?? null,
  };
}

function makeCold(
  activeSet: ColdStateActiveEntry[],
  visibleChannels: number[] = [0],
  viewMode: "slice" | "volume" = "volume",
  multiChannel = visibleChannels.length > 1,
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
    datasetId: "ds1",
    currentT: 0,
    currentZ: 0,
    multiChannel,
    visibleChannels,
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    activeSet,
    viewMode,
  };
}

describe("groupEntriesByPool — volume", () => {
  it("two entries with same chunk dims → one pool group", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "fields-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "fields-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    const groups = groupEntriesByPool(cold, "volume");
    expect(groups.size).toBe(1);
    const [g] = groups.values();
    expect(g.poolKey).toBe("ds1:64x64x32");
    expect(g.channel).toBe(0);
    expect(g.chunkDims).toEqual([32, 64, 64]);
    expect(g.entries.map(e => e.memberId)).toEqual(["imgA", "imgB"]);
  });

  it("two entries with different chunk dims → two pool groups", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "fields-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "fields-with-detail",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);
    const groups = groupEntriesByPool(cold, "volume");
    expect(groups.size).toBe(2);
    expect(Array.from(groups.keys()).sort()).toEqual(["ds1:32x32x16", "ds1:64x64x32"]);
  });

  it("multi-channel → channel-suffixed pool keys + ch-suffixed memberIds", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA", mode: "fields-with-detail",
          levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
        }),
      ],
      [0, 2],
    );
    const groups = groupEntriesByPool(cold, "volume");
    expect(groups.size).toBe(2);
    expect(groups.get("ds1:ch0:64x64x32")?.entries[0].memberId).toBe("imgA:ch0");
    expect(groups.get("ds1:ch2:64x64x32")?.entries[0].memberId).toBe("imgA:ch2");
  });

  it("multi-channel mode with one visible channel still uses channel-suffixed keys", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA", mode: "fields-with-detail",
          levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
        }),
      ],
      [2],
      "volume",
      true,
    );

    const groups = groupEntriesByPool(cold, "volume");

    expect(Array.from(groups.keys())).toEqual(["ds1:ch2:64x64x32"]);
    expect(groups.get("ds1:ch2:64x64x32")?.entries[0].memberId).toBe("imgA:ch2");
  });

  it("well-as-proxy entry (empty levels) is skipped", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "wellA", imageId: "", mode: "well-as-proxy",
        levels: [], detailOwnedLodRange: [0, 0],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "fields-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    const groups = groupEntriesByPool(cold, "volume");
    expect(groups.size).toBe(1);
    expect(groups.get("ds1:64x64x32")?.entries.map(e => e.memberId)).toEqual(["imgB"]);
  });
});

describe("groupEntriesByPool — slice", () => {
  it("slice mode drops Z from pool key, sets dims Z to 1", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA", mode: "fields-with-detail",
          levels: [{ level: 0, chunkShape: [16, 128, 128], gridShape: [4, 2, 2], levelDims: [64, 256, 256] }],
        }),
      ],
      [0],
      "slice",
    );
    const groups = groupEntriesByPool(cold, "slice");
    expect(groups.size).toBe(1);
    const [g] = groups.values();
    expect(g.poolKey).toBe("ds1:128x128");
    expect(g.chunkDims).toEqual([1, 128, 128]);
  });

  it("multi-channel slice → channel-suffixed keys", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA", mode: "fields-with-detail",
          levels: [{ level: 0, chunkShape: [16, 128, 128], gridShape: [4, 2, 2], levelDims: [64, 256, 256] }],
        }),
      ],
      [0, 1],
      "slice",
    );
    const groups = groupEntriesByPool(cold, "slice");
    expect(groups.size).toBe(2);
    expect(groups.get("ds1:ch0:128x128")?.entries[0].memberId).toBe("imgA:ch0");
    expect(groups.get("ds1:ch1:128x128")?.entries[0].memberId).toBe("imgA:ch1");
  });
});
