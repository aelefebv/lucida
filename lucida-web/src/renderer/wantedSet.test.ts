import { describe, it, expect } from "vitest";
import {
  computeWantedSet,
  type AtlasLevelMeta,
  type AtlasSnapshot,
  type ProxyAtlasSnapshot,
  type SourcePoolResolver,
} from "./wantedSet.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  MissingChunk,
  MissingProxy,
  ColdStateTileEntry,
} from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { VisibleRegion } from "../pipeline/viewport.ts";

/** Type-narrowing helper: only chunk-kind entries from a wanted-set. */
function chunks(missing: Array<MissingChunk | MissingProxy>): MissingChunk[] {
  return missing.filter((m): m is MissingChunk => m.kind === "chunk");
}

/** Type-narrowing helper: only proxy-kind entries from a wanted-set. */
function proxies(missing: Array<MissingChunk | MissingProxy>): MissingProxy[] {
  return missing.filter((m): m is MissingProxy => m.kind === "proxy");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpochs(): SceneEpochs {
  return {
    content: 1,
    layout: 1,
    view: 1,
    selection: 1,
    asset: 0,
    request: 1,
  };
}

function makeVisibleRegion(
  overrides?: Partial<VisibleRegion>,
): VisibleRegion {
  return {
    xyBoundsVox: [0, 0, 256, 256],
    zRangeVox: [0, 64],
    effectiveZoom: 1,
    sortCenterVox: null,
    frustumPlanes: null,
    ...overrides,
  };
}

/**
 * Fixture builder for `ColdStateActiveEntry`. The type is a
 * discriminated union (`kind: "tile" | "group-as-proxy"`); this helper
 * inspects `overrides.mode` to pick the right variant so existing call
 * sites keep working unchanged (`mode: "group-as-proxy"` with
 * `imageId: ""` yields the group-as-proxy variant).
 */
type WantedSetEntryOverrides = Partial<Omit<ColdStateTileEntry, "kind" | "mode">> & {
  mode?: ColdStateActiveEntry["mode"];
};
function makeActiveEntry(
  overrides?: WantedSetEntryOverrides,
): ColdStateActiveEntry {
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app). See #438.
  const identity = new Float32Array(16) as Float32Array<ArrayBuffer>;
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  const base = {
    entityId: overrides?.entityId ?? "entity-0",
    levels: overrides?.levels ?? [
      {
        level: 0,
        chunkShape: [32, 32, 32] as [number, number, number], // [Z, Y, X]
        gridShape: [2, 4, 4] as [number, number, number], // 64 deep, 128 high, 128 wide
        levelDims: [64, 128, 128] as [number, number, number],
      },
    ],
    proxyKind: overrides?.proxyKind,
    proxyAvailable: overrides?.proxyAvailable ?? false,
    groupProxyAvailable: overrides?.groupProxyAvailable ?? false,
    modelMatrix: overrides?.modelMatrix ?? identity,
    invModelMatrix: overrides?.invModelMatrix ?? identity,
    displayStateByChannel: overrides?.displayStateByChannel ?? {
      0: {
        contrastMin: 0,
        contrastMax: 1,
        gamma: 1,
        opacity: 1,
        colormapName: "gray",
        channelMask: 1,
      },
    },
  };
  // Default to `tiles-with-detail` so existing tests keep their
  // chunk-only expectations when no mode override is provided.
  const mode = overrides?.mode ?? "tiles-with-detail";
  if (mode === "group-as-proxy") {
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
    imageId: overrides?.imageId ?? "img",
    mode,
    detailLevels: overrides?.detailLevels ?? [0],
    coarseLevel: overrides?.coarseLevel ?? null,
    parentGroupId: overrides?.parentGroupId ?? null,
  };
}

function makeColdState(
  overrides?: Partial<ColdStateMessage>,
): ColdStateMessage {
  const visibleChannels = overrides?.visibleChannels ?? [0];
  return {
    type: "coldState",
    epochs: makeEpochs(),
    datasetId: "ds-0",
    currentT: 0,
    currentZ: 0,
    multiChannel: overrides?.multiChannel ?? visibleChannels.length > 1,
    visibleChannels,
    visibleRegion: makeVisibleRegion(),
    activeSet: [makeActiveEntry()],
    viewMode: "volume",
    ...overrides,
  };
}

/** Shared volume pool atlas with one entity. Slot keys are composite "memberId|chunkKey". */
function makeVolumePool(
  memberId: string,
  sectionMetas: AtlasLevelMeta[],
  slots?: Map<string, number>,
): AtlasSnapshot {
  return {
    slots: slots ?? new Map(),
    entityMetas: new Map([[memberId, sectionMetas]]),
  };
}

/** Build composite slot key for shared volume pool. */
function vk(memberId: string, chunkKey: string): string {
  return `${memberId}|${chunkKey}`;
}

/**
 * Resolver over an atlas map: a member's section for `level` lives in
 * whichever pool holds a section meta at that level for it (the worker's
 * `memberSourcePools` routing, derived from the fixture pools).
 */
function poolsFromAtlases(atlases: Map<string, AtlasSnapshot>): SourcePoolResolver {
  return (memberId, _tier, level) => {
    for (const [poolKey, atlas] of atlases) {
      if (atlas.entityMetas?.get(memberId)?.some((m) => m.level === level)) return poolKey;
    }
    return undefined;
  };
}

/** Resolver from explicit (member, tier) → pool routes, every level of the tier in that pool. */
function tierPool(entries: Array<[memberId: string, tier: ResidencyTier, poolKey: string]>): SourcePoolResolver {
  const routes = new Map(entries.map(([memberId, tier, poolKey]) => [`${memberId}|${tier}`, poolKey]));
  return (memberId, tier) => routes.get(`${memberId}|${tier}`);
}

/** Resolver for a worker that has allocated no sections at all. */
const noPools: SourcePoolResolver = () => undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeWantedSet", () => {
  it("empty atlas -> all visible chunks missing", () => {
    // Visible region covers [0,0,64,64] -> 2x2 in XY, zRangeVox [0,32] -> 1 in Z
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 64, 64],
        zRangeVox: [0, 32],
      }),
    });
    // Shared pool keyed by datasetId, with "img" as the only entity
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    expect(result.missing).toHaveLength(4); // 2x2x1 = 4 chunks
    // Verify chunk keys follow the correct format
    for (const entry of chunks(result.missing)) {
      expect(entry.entityId).toBe("entity-0");
      expect(entry.memberId).toBe("img");
      expect(entry.c).toBe(0);
      expect(entry.chunkKey).toMatch(/^0\/0\/0\/\d+\/\d+\/\d+$/);
    }
  });

  it("full atlas -> empty wanted-set", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 64, 64],
        zRangeVox: [0, 32],
      }),
    });
    // Pre-populate shared pool with all expected chunks (composite keys)
    const slots = new Map<string, number>();
    slots.set(vk("img", "0/0/0/0/0/0"), 0);
    slots.set(vk("img", "0/0/0/0/0/1"), 1);
    slots.set(vk("img", "0/0/0/0/1/0"), 2);
    slots.set(vk("img", "0/0/0/0/1/1"), 3);
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ], slots);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    expect(result.missing).toHaveLength(0);
  });

  it("partial atlas -> only missing chunks reported", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 64, 64],
        zRangeVox: [0, 32],
      }),
    });
    // 2 of 4 chunks present
    const slots = new Map<string, number>();
    slots.set(vk("img", "0/0/0/0/0/0"), 0);
    slots.set(vk("img", "0/0/0/0/1/1"), 1);
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ], slots);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    expect(result.missing).toHaveLength(2);
    const keys = chunks(result.missing).map((m) => m.chunkKey).sort();
    expect(keys).toEqual(["0/0/0/0/0/1", "0/0/0/0/1/0"]);
  });

  it("spatial culling - only visible region chunks", () => {
    // Grid is 4x4, but visible region only covers first 2x2
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 64, 64], // 64/32=2 chunks in each axis
        zRangeVox: [0, 32],
      }),
    });
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    // Should be 2x2x1 = 4, not 4x4x2 = 32
    expect(result.missing).toHaveLength(4);
    // Verify no chunk index exceeds the visible bounds
    for (const entry of chunks(result.missing)) {
      const parts = entry.chunkKey.split("/").map(Number);
      const [, , , iz, iy, ix] = parts;
      expect(ix).toBeLessThan(2);
      expect(iy).toBeLessThan(2);
      expect(iz).toBeLessThan(1);
    }
  });

  it("multi-channel - per-channel pool keying", () => {
    const coldState = makeColdState({
      visibleChannels: [0, 2],
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32], // 1x1 in XY
        zRangeVox: [0, 32], // 1 in Z
      }),
    });
    // Separate shared pools for each channel: poolKey = "ds-0:chN"
    const ch0Pool = makeVolumePool("img:ch0", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const ch2Pool = makeVolumePool("img:ch2", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch0", ch0Pool],
      ["ds-0:ch2", ch2Pool],
    ]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    // 1 chunk per channel, 2 channels = 2 missing
    expect(result.missing).toHaveLength(2);

    const keys = chunks(result.missing).map((m) => m.chunkKey).sort();
    // channel 0 and channel 2
    expect(keys).toEqual(["0/0/0/0/0/0", "0/0/2/0/0/0"]);
    expect(chunks(result.missing).map((m) => m.memberId).sort()).toEqual([
      "img:ch0",
      "img:ch2",
    ]);
  });

  it("multi-channel mode with one visible channel still uses channel-qualified member ids", () => {
    const coldState = makeColdState({
      multiChannel: true,
      visibleChannels: [2],
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
    });
    const ch2Pool = makeVolumePool("img:ch2", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch2", ch2Pool],
    ]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    expect(chunks(result.missing)).toEqual([
      expect.objectContaining({
        memberId: "img:ch2",
        c: 2,
        chunkKey: "0/0/2/0/0/0",
      }),
    ]);
  });

  it("slice mode - only current Z slice", () => {
    const coldState = makeColdState({
      viewMode: "slice",
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 64, 64],
        zRangeVox: [0, 64], // full Z range in visible region (ignored for slice)
      }),
    });
    // Slice now uses shared pools too. Pool keyed by datasetId+chunkdims, with "img" as the only entity.
    const atlas: AtlasSnapshot = {
      slots: new Map(),
      entityMetas: new Map([
        ["img", [{ level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 }]],
      ]),
      z: 10,
    };
    const sliceAtlases = new Map([["ds-0:32x32", atlas]]);

    const result = computeWantedSet(coldState, new Map(), sliceAtlases, poolsFromAtlases(sliceAtlases));

    // Only Z chunk 0 (containing slice z=10), 2x2 in XY = 4 chunks
    expect(result.missing).toHaveLength(4);
    for (const entry of chunks(result.missing)) {
      const parts = entry.chunkKey.split("/").map(Number);
      expect(parts[3]).toBe(0); // z chunk index
    }
  });

  it("source-backed detail/coarse wanted-set uses separate tier pools", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0],
          coarseLevel: 2,
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 2, chunkShape: [32, 64, 64], gridShape: [2, 2, 2], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    const detailAtlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const coarseAtlas = makeVolumePool("img", [
      { level: 2, gridDims: [2, 2, 2], chunkDims: [32, 64, 64], offset: 0 },
    ]);
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:32x32x32:detail", detailAtlas],
      ["ds-0:64x64x32:coarse", coarseAtlas],
    ]);

    const result = computeWantedSet(
      coldState,
      volumeAtlases,
      new Map(),
      tierPool([
        ["img", "detail", "ds-0:32x32x32:detail"],
        ["img", "coarse", "ds-0:64x64x32:coarse"],
      ]),
    );

    expect(chunks(result.missing)).toEqual([
      expect.objectContaining({ tier: "detail", chunkKey: "0/0/0/0/0/0" }),
      expect.objectContaining({ tier: "coarse", chunkKey: "2/0/0/0/0/0" }),
    ]);
  });

  it("same-level detail/coarse wanted-set keeps the coarse tier missing independently", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [1],
          coarseLevel: 1,
          levels: [
            { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    const chunkKey = "1/0/0/0/0/0";
    const detailAtlas = makeVolumePool("img", [
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ], new Map([[vk("img", chunkKey), 0]]));
    const coarseAtlas = makeVolumePool("img", [
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:32x32x32:detail", detailAtlas],
      ["ds-0:32x32x32:coarse", coarseAtlas],
    ]);

    const result = computeWantedSet(
      coldState,
      volumeAtlases,
      new Map(),
      tierPool([
        ["img", "detail", "ds-0:32x32x32:detail"],
        ["img", "coarse", "ds-0:32x32x32:coarse"],
      ]),
    );

    expect(chunks(result.missing)).toEqual([
      expect.objectContaining({ tier: "coarse", chunkKey }),
    ]);
  });

  it("applies independent render radii to detail and coarse wanted-set lanes", () => {
    const coldState = makeColdState({
      renderRadiusView: { detail: 0.26, coarse: 0 },
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [0, 1],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0],
          coarseLevel: 1,
          levels: [
            { level: 0, chunkShape: [1, 256, 256], gridShape: [1, 4, 4], levelDims: [1, 1024, 1024] },
            { level: 1, chunkShape: [1, 256, 256], gridShape: [1, 2, 2], levelDims: [1, 512, 512] },
          ],
        }),
      ],
    });
    const detailAtlas = makeVolumePool("img", [
      { level: 0, gridDims: [1, 4, 4], chunkDims: [1, 256, 256], offset: 0 },
    ]);
    const coarseAtlas = makeVolumePool("img", [
      { level: 1, gridDims: [1, 2, 2], chunkDims: [1, 256, 256], offset: 0 },
    ]);
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:256x256x1:detail", detailAtlas],
      ["ds-0:256x256x1:coarse", coarseAtlas],
    ]);

    const result = computeWantedSet(
      coldState,
      volumeAtlases,
      new Map(),
      tierPool([
        ["img", "detail", "ds-0:256x256x1:detail"],
        ["img", "coarse", "ds-0:256x256x1:coarse"],
      ]),
    );

    const detail = chunks(result.missing).filter((m) => m.tier === "detail");
    const coarse = chunks(result.missing).filter((m) => m.tier === "coarse");
    expect(detail.map((m) => m.chunkKey).sort()).toEqual([
      "0/0/0/0/1/1",
      "0/0/0/0/1/2",
      "0/0/0/0/2/1",
      "0/0/0/0/2/2",
    ]);
    expect(detail.every((m) => m.datasetId === "ds-0")).toBe(true);
    expect(coarse.map((m) => m.chunkKey).sort()).toEqual([
      "1/0/0/0/0/0",
      "1/0/0/0/0/1",
      "1/0/0/0/1/0",
      "1/0/0/0/1/1",
    ]);
  });

  it("slice mode maps full-res Z independently for detail and coarse tier chunk shapes", () => {
    const coldState = makeColdState({
      viewMode: "slice",
      activeSet: [
        makeActiveEntry({
          detailLevels: [0],
          coarseLevel: 2,
          levels: [
            { level: 0, chunkShape: [8, 32, 32], gridShape: [4, 4, 4], levelDims: [32, 128, 128] },
            { level: 2, chunkShape: [16, 64, 64], gridShape: [2, 2, 2], levelDims: [32, 128, 128] },
          ],
        }),
      ],
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
    });
    const detailAtlas: AtlasSnapshot = {
      slots: new Map(),
      entityMetas: new Map([["img", [{ level: 0, gridDims: [4, 4, 4], chunkDims: [8, 32, 32], offset: 0 }]]]),
      z: 18,
    };
    const coarseAtlas: AtlasSnapshot = {
      slots: new Map(),
      entityMetas: new Map([["img", [{ level: 2, gridDims: [2, 2, 2], chunkDims: [16, 64, 64], offset: 0 }]]]),
      z: 18,
    };
    const sliceAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:32x32:detail", detailAtlas],
      ["ds-0:64x64:coarse", coarseAtlas],
    ]);

    const result = computeWantedSet(
      coldState,
      new Map(),
      sliceAtlases,
      tierPool([
        ["img", "detail", "ds-0:32x32:detail"],
        ["img", "coarse", "ds-0:64x64:coarse"],
      ]),
    );

    expect(chunks(result.missing).map((m) => [m.tier, m.chunkKey]).sort()).toEqual([
      ["coarse", "2/0/0/1/0/0"],
      ["detail", "0/0/0/2/0/0"],
    ]);
  });

  it("no active set -> empty wanted-set", () => {
    const coldState = makeColdState({ activeSet: [] });
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ])]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    expect(result.missing).toHaveLength(0);
  });

  it("entity with no matching atlas -> skipped", () => {
    const coldState = makeColdState();
    // No atlas for "ds-0" — both maps are empty
    const result = computeWantedSet(coldState, new Map(), new Map(), noPools);

    expect(result.missing).toHaveLength(0);
  });

  it("multi-level wanted-set: missing chunks across levels 0, 1, 2", () => {
    // Visible region covers 1x1 in XY, 1 in Z at each level
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0, 1, 2],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 2, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    // Pool covers all 3 LODs for "img"; has some LOD 0, some LOD 1, no LOD 2
    const slots = new Map<string, number>();
    slots.set(vk("img", "0/0/0/0/0/0"), 0); // LOD 0 present
    slots.set(vk("img", "1/0/0/0/0/0"), 1); // LOD 1 present
    // LOD 2: nothing present
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 32 },
      { level: 2, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 64 },
    ], slots);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    // LOD 0 chunk "0/0/0/0/0/0" present, LOD 1 chunk "1/0/0/0/0/0" present, LOD 2 missing => 1 missing
    expect(result.missing).toHaveLength(1);
    const onlyChunks = chunks(result.missing);
    expect(onlyChunks).toHaveLength(1);
    expect(onlyChunks[0].chunkKey).toBe("2/0/0/0/0/0");
  });

  it("asks only for the levels in detailLevels, not the levels between them", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0, 2],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 2, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 32 },
      { level: 2, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 64 },
    ]);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    const keys = chunks(result.missing).map((m) => m.chunkKey).sort();
    expect(keys).toEqual(["0/0/0/0/0/0", "2/0/0/0/0/0"]);
  });

  it("never requests the coarser sections the worker keeps under the target", () => {
    // The worker allocates sections for the target (0) and the coarser
    // levels 1 and 2 so their resident chunks stay mapped, but planning
    // only asks for `detailLevels`: the wanted set names level 0 alone.
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [1, 8, 8], levelDims: [32, 256, 256] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [1, 4, 4], levelDims: [32, 128, 128] },
            { level: 2, chunkShape: [32, 32, 32], gridShape: [1, 2, 2], levelDims: [32, 64, 64] },
          ],
        }),
      ],
    });
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [1, 8, 8], chunkDims: [32, 32, 32], offset: 0 },
      { level: 1, gridDims: [1, 4, 4], chunkDims: [32, 32, 32], offset: 64 },
      { level: 2, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], offset: 80 },
    ]);
    const volumeAtlases = new Map([["ds-0:32x32x32:detail", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    const keys = chunks(result.missing).map((m) => m.chunkKey);
    expect(keys).toHaveLength(64);
    expect(keys.every((k) => k.startsWith("0/"))).toBe(true);
  });

  it("routes each requested level to its own pool when chunk shapes differ", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 64, 64],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0, 1],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [1, 2, 2], levelDims: [32, 64, 64] },
            { level: 1, chunkShape: [32, 16, 16], gridShape: [1, 2, 2], levelDims: [32, 32, 32] },
          ],
        }),
      ],
    });
    const finePool = makeVolumePool("img", [
      { level: 0, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const smallChunkPool = makeVolumePool("img", [
      { level: 1, gridDims: [1, 2, 2], chunkDims: [32, 16, 16], offset: 0 },
    ], new Map([[vk("img", "1/0/0/0/0/0"), 3]]));
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:32x32x32:detail", finePool],
      ["ds-0:16x16x32:detail", smallChunkPool],
    ]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    const keys = chunks(result.missing).map((m) => m.chunkKey).sort();
    // Level 0: all four cells missing from the fine pool. Level 1: one of
    // its four cells is resident in the small-chunk pool.
    expect(keys.filter((k) => k.startsWith("0/"))).toHaveLength(4);
    expect(keys.filter((k) => k.startsWith("1/"))).toEqual([
      "1/0/0/0/0/1",
      "1/0/0/0/1/0",
      "1/0/0/0/1/1",
    ]);
  });

  it("levels absent from the pool's entity metas are skipped", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0, 1, 2],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 2, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    // Pool's entityMeta for "img" only covers level 1 (chunk dims don't match across levels)
    const atlas = makeVolumePool("img", [
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    // Only level 1 is in entityMetas, so only level 1 chunks appear in wanted-set
    expect(result.missing).toHaveLength(1);
    const onlyChunks = chunks(result.missing);
    expect(onlyChunks).toHaveLength(1);
    expect(onlyChunks[0].chunkKey).toMatch(/^1\//);
  });

  it("coarser levels have smaller grids: fewer chunks in wanted-set", () => {
    // Large visible region to cover full grids
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevels: [0, 1],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [1, 8, 8], levelDims: [32, 256, 256] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [1, 4, 4], levelDims: [32, 128, 128] },
          ],
        }),
      ],
    });
    const atlas = makeVolumePool("img", [
      { level: 0, gridDims: [1, 8, 8], chunkDims: [32, 32, 32], offset: 0 },
      { level: 1, gridDims: [1, 4, 4], chunkDims: [32, 32, 32], offset: 64 },
    ]);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases));

    // LOD 0: 8x8x1 = 64 chunks, LOD 1: 4x4x1 = 16 chunks => 80 total
    const allChunks = chunks(result.missing);
    const lod0 = allChunks.filter((m) => m.chunkKey.startsWith("0/"));
    const lod1 = allChunks.filter((m) => m.chunkKey.startsWith("1/"));
    expect(lod0).toHaveLength(64);
    expect(lod1).toHaveLength(16);
    expect(result.missing).toHaveLength(80);
  });

  // -------------------------------------------------------------------------
  // proxy wanted-set
  // -------------------------------------------------------------------------

  describe("proxy wanted-set", () => {
    /** Helper: pool snapshot with the given resident slot keys. */
    function makeProxyPool(
      kind: "GroupProxy3D" | "TileProxy3D",
      keys: string[],
    ): ProxyAtlasSnapshot {
      const slots = new Map<string, number>();
      keys.forEach((k, i) => slots.set(k, i));
      return { kind, slots };
    }

    it("group-as-proxy + no resident proxy -> emits MissingProxy { GroupProxy3D }", () => {
      const coldState = makeColdState({
        activeSet: [
          makeActiveEntry({
            entityId: "group-1",
            imageId: "",
            mode: "group-as-proxy",
            proxyKind: "GroupProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), noPools, new Map());

      const ps = proxies(result.missing);
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({
        kind: "proxy",
        entityId: "group-1",
        proxyKind: "GroupProxy3D",
        t: 0,
        c: 0,
      });
      // No chunks for group-as-proxy.
      expect(chunks(result.missing)).toHaveLength(0);
    });

    it("group-as-proxy + resident proxy -> empty wanted-set", () => {
      const coldState = makeColdState({
        activeSet: [
          makeActiveEntry({
            entityId: "group-1",
            imageId: "",
            mode: "group-as-proxy",
            proxyKind: "GroupProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
          }),
        ],
      });
      const proxyAtlases = new Map<string, ProxyAtlasSnapshot>([
        ["any-pool", makeProxyPool("GroupProxy3D", ["group-1|0|0"])],
      ]);
      const result = computeWantedSet(coldState, new Map(), new Map(), noPools, proxyAtlases);
      expect(result.missing).toHaveLength(0);
    });

    it("tiles-with-detail + present tile-proxy -> no proxy ask, chunk wanted-set unchanged", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "tile-1",
            imageId: "img",
            mode: "tiles-with-detail",
            proxyKind: "TileProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: false,
          }),
        ],
      });
      const atlas = makeVolumePool("img", [
        { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      ]);
      const volumeAtlases = new Map([["ds-0", atlas]]);
      const proxyAtlases = new Map<string, ProxyAtlasSnapshot>([
        ["pool-A", makeProxyPool("TileProxy3D", ["tile-1|0|0"])],
      ]);
      const result = computeWantedSet(
        coldState,
        volumeAtlases,
        new Map(),
        poolsFromAtlases(volumeAtlases),
        proxyAtlases,
      );
      // 1 chunk should be missing (visible region 1x1x1), no proxy asks
      expect(proxies(result.missing)).toHaveLength(0);
      expect(chunks(result.missing)).toHaveLength(1);
    });

    it("tiles-with-detail + missing advertised tile-proxy -> emits MissingProxy { TileProxy3D }", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "tile-1",
            imageId: "img",
            mode: "tiles-with-detail",
            proxyKind: "TileProxy3D",
            proxyAvailable: true,
          }),
        ],
      });
      const atlas = makeVolumePool("img", [
        { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      ]);
      const volumeAtlases = new Map([["ds-0", atlas]]);
      const result = computeWantedSet(
        coldState,
        volumeAtlases,
        new Map(),
        poolsFromAtlases(volumeAtlases),
        new Map(),
      );
      const ps = proxies(result.missing);
      expect(ps).toHaveLength(1);
      expect(ps[0].entityId).toBe("tile-1");
      expect(ps[0].proxyKind).toBe("TileProxy3D");
    });

    it("desiredProxyKeys=[] suppresses otherwise-missing proxy asks", () => {
      const coldState = makeColdState({
        desiredProxyKeys: [],
        activeSet: [
          makeActiveEntry({
            entityId: "group-1",
            imageId: "",
            mode: "group-as-proxy",
            proxyKind: "GroupProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), noPools, new Map());
      expect(result.missing).toHaveLength(0);
    });

    it("desiredProxyKeys gates tile and parent-group proxy asks independently", () => {
      const coldState = makeColdState({
        desiredProxyKeys: ["ds-0|group-1|GroupProxy3D|0|0"],
        activeSet: [
          makeActiveEntry({
            entityId: "tile-1",
            imageId: "img",
            mode: "tiles-with-proxy-fallback",
            proxyKind: "TileProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
            parentGroupId: "group-1",
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), noPools, new Map());
      const ps = proxies(result.missing);
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({
        entityId: "group-1",
        proxyKind: "GroupProxy3D",
      });
    });

    it("tiles-with-detail + proxyAvailable=false -> no MissingProxy", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "tile-1",
            imageId: "img",
            mode: "tiles-with-detail",
            // Catalog says no proxy exists — don't ask for one.
            proxyKind: "TileProxy3D",
            proxyAvailable: false,
          }),
        ],
      });
      const atlas = makeVolumePool("img", [
        { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      ]);
      const volumeAtlases = new Map([["ds-0", atlas]]);
      const result = computeWantedSet(
        coldState,
        volumeAtlases,
        new Map(),
        poolsFromAtlases(volumeAtlases),
        new Map(),
      );
      expect(proxies(result.missing)).toHaveLength(0);
    });

    it("tiles-with-proxy-fallback emits both tile-proxy and parent-group-proxy (deduped per group)", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "tile-A",
            imageId: "imgA",
            mode: "tiles-with-proxy-fallback",
            proxyKind: "TileProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
            parentGroupId: "group-1",
          }),
          makeActiveEntry({
            entityId: "tile-B",
            imageId: "imgB",
            mode: "tiles-with-proxy-fallback",
            proxyKind: "TileProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
            parentGroupId: "group-1",
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), noPools, new Map());
      const ps = proxies(result.missing);
      // 2 tile proxies + 1 deduped group proxy = 3
      const tileProxies = ps.filter((p) => p.proxyKind === "TileProxy3D");
      const groupProxies = ps.filter((p) => p.proxyKind === "GroupProxy3D");
      expect(tileProxies.map((p) => p.entityId).sort()).toEqual(["tile-A", "tile-B"]);
      expect(groupProxies).toHaveLength(1);
      expect(groupProxies[0].entityId).toBe("group-1");
    });

    it("mixed modes: group-as-proxy + tiles-with-detail -> both reported correctly", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "group-X",
            imageId: "",
            mode: "group-as-proxy",
            proxyKind: "GroupProxy3D",
            proxyAvailable: true,
            groupProxyAvailable: true,
          }),
          makeActiveEntry({
            entityId: "tile-Y",
            imageId: "imgY",
            mode: "tiles-with-detail",
            proxyKind: "TileProxy3D",
            proxyAvailable: true,
          }),
        ],
      });
      const atlas = makeVolumePool("imgY", [
        { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      ]);
      const volumeAtlases = new Map([["ds-0", atlas]]);
      const result = computeWantedSet(
        coldState,
        volumeAtlases,
        new Map(),
        poolsFromAtlases(volumeAtlases),
        new Map(),
      );
      const ps = proxies(result.missing);
      const groupMissing = ps.filter((p) => p.proxyKind === "GroupProxy3D" && p.entityId === "group-X");
      const tileMissing = ps.filter((p) => p.proxyKind === "TileProxy3D" && p.entityId === "tile-Y");
      expect(groupMissing).toHaveLength(1);
      expect(tileMissing).toHaveLength(1);
      // Tile-Y also has chunk wanted-set entries.
      expect(chunks(result.missing).length).toBeGreaterThan(0);
    });
  });
});
