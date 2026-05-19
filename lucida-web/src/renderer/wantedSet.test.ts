import { describe, it, expect } from "vitest";
import {
  computeWantedSet,
  type AtlasSnapshot,
  type ProxyAtlasSnapshot,
} from "./wantedSet.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  MissingChunk,
  MissingProxy,
} from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
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
 * discriminated union (`kind: "field" | "well-as-proxy"`); this helper
 * inspects `overrides.mode` to pick the right variant so existing call
 * sites keep working unchanged (`mode: "well-as-proxy"` with
 * `imageId: ""` yields the well-as-proxy variant).
 */
type WantedSetEntryOverrides = Partial<Omit<ColdStateActiveEntry, "kind">>;
function makeActiveEntry(
  overrides?: WantedSetEntryOverrides,
): ColdStateActiveEntry {
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app). See #438.
  const identity = new Float32Array(16) as Float32Array<ArrayBuffer>;
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  const base = {
    entityId: overrides?.entityId ?? "entity-0",
    targetLod: overrides?.targetLod ?? 0,
    detailOwnedLodRange: overrides?.detailOwnedLodRange ?? [0, 0] as [number, number],
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
    wellProxyAvailable: overrides?.wellProxyAvailable ?? false,
    detailLevel: overrides?.detailLevel,
    coarseLevel: overrides?.coarseLevel,
    wantedLodLevels: overrides?.wantedLodLevels,
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
  // Default to `fields-with-detail` so existing tests keep their
  // chunk-only expectations when no mode override is provided.
  const mode = overrides?.mode ?? "fields-with-detail";
  if (mode === "well-as-proxy") {
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
    imageId: overrides?.imageId ?? "img",
    mode,
    parentWellId: overrides?.parentWellId ?? null,
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
  lodMetas: AtlasSnapshot["lodMetas"],
  slots?: Map<string, number>,
): AtlasSnapshot {
  return {
    slots: slots ?? new Map(),
    entityMetas: new Map([[memberId, lodMetas!]]),
  };
}

/** Build composite slot key for shared volume pool. */
function vk(memberId: string, chunkKey: string): string {
  return `${memberId}|${chunkKey}`;
}

/** Build memberToPool map from a volumeAtlases map (each entity goes to its pool). */
function buildMemberToPool(volumeAtlases: Map<string, AtlasSnapshot>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [poolKey, atlas] of volumeAtlases) {
    if (!atlas.entityMetas) continue;
    for (const memberId of atlas.entityMetas.keys()) {
      m.set(memberId, poolKey);
    }
  }
  return m;
}

function tierPool(entries: Array<[memberId: string, tier: "detail" | "coarse", poolKey: string]>): Map<string, string> {
  return new Map(entries.map(([memberId, tier, poolKey]) => [`${memberId}|${tier}`, poolKey]));
}

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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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
    const memberToPool = new Map([["img", "ds-0:32x32"]]);

    const result = computeWantedSet(coldState, new Map(), sliceAtlases, memberToPool);

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
          detailLevel: 0,
          coarseLevel: 2,
          wantedLodLevels: [0, 2],
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

  it("applies independent render radii to detail and coarse wanted-set lanes", () => {
    const coldState = makeColdState({
      renderRadiusView: { detail: 0.26, coarse: 0 },
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [0, 1],
      }),
      activeSet: [
        makeActiveEntry({
          detailLevel: 0,
          coarseLevel: 1,
          wantedLodLevels: [0, 1],
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
    expect(coarse).toHaveLength(0);
  });

  it("slice mode maps full-res Z independently for detail and coarse tier chunk shapes", () => {
    const coldState = makeColdState({
      viewMode: "slice",
      activeSet: [
        makeActiveEntry({
          detailLevel: 0,
          coarseLevel: 2,
          wantedLodLevels: [0, 2],
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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

    expect(result.missing).toHaveLength(0);
  });

  it("entity with no matching atlas -> skipped", () => {
    const coldState = makeColdState();
    // No atlas for "ds-0" — both maps are empty
    const result = computeWantedSet(coldState, new Map(), new Map());

    expect(result.missing).toHaveLength(0);
  });

  it("multi-LOD wanted-set: missing chunks across LODs 0, 1, 2", () => {
    // Visible region covers 1x1 in XY, 1 in Z at each LOD
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailOwnedLodRange: [0, 2],
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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

    // LOD 0 chunk "0/0/0/0/0/0" present, LOD 1 chunk "1/0/0/0/0/0" present, LOD 2 missing => 1 missing
    expect(result.missing).toHaveLength(1);
    const onlyChunks = chunks(result.missing);
    expect(onlyChunks).toHaveLength(1);
    expect(onlyChunks[0].chunkKey).toBe("2/0/0/0/0/0");
  });

  it("wantedLodLevels limits multi-LOD wanted-set to selected detail/coarse levels", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailOwnedLodRange: [0, 2],
          wantedLodLevels: [0, 2],
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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

    const keys = chunks(result.missing).map((m) => m.chunkKey).sort();
    expect(keys).toEqual(["0/0/0/0/0/0", "2/0/0/0/0/0"]);
  });

  it("single-LOD fallback: only target LOD in wanted-set", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 32, 32],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailOwnedLodRange: [0, 2],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 2, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    // Pool's entityMeta for "img" only covers LOD 1 (chunk dims don't match across LODs)
    const atlas = makeVolumePool("img", [
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ]);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

    // Only LOD 1 is in entityMetas, so only LOD 1 chunks appear in wanted-set
    expect(result.missing).toHaveLength(1);
    const onlyChunks = chunks(result.missing);
    expect(onlyChunks).toHaveLength(1);
    expect(onlyChunks[0].chunkKey).toMatch(/^1\//);
  });

  it("coarser LODs have smaller grids: fewer chunks in wanted-set", () => {
    // Large visible region to cover full grids
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 32],
      }),
      activeSet: [
        makeActiveEntry({
          detailOwnedLodRange: [0, 1],
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

    const result = computeWantedSet(coldState, volumeAtlases, new Map(), buildMemberToPool(volumeAtlases));

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
      kind: "WellProxy3D" | "FieldProxy3D",
      keys: string[],
    ): ProxyAtlasSnapshot {
      const slots = new Map<string, number>();
      keys.forEach((k, i) => slots.set(k, i));
      return { kind, slots };
    }

    it("well-as-proxy + no resident proxy -> emits MissingProxy { WellProxy3D }", () => {
      const coldState = makeColdState({
        activeSet: [
          makeActiveEntry({
            entityId: "well-1",
            imageId: "",
            mode: "well-as-proxy",
            proxyKind: "WellProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), new Map(), new Map());

      const ps = proxies(result.missing);
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({
        kind: "proxy",
        entityId: "well-1",
        proxyKind: "WellProxy3D",
        t: 0,
        c: 0,
      });
      // No chunks for well-as-proxy.
      expect(chunks(result.missing)).toHaveLength(0);
    });

    it("well-as-proxy + resident proxy -> empty wanted-set", () => {
      const coldState = makeColdState({
        activeSet: [
          makeActiveEntry({
            entityId: "well-1",
            imageId: "",
            mode: "well-as-proxy",
            proxyKind: "WellProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
          }),
        ],
      });
      const proxyAtlases = new Map<string, ProxyAtlasSnapshot>([
        ["any-pool", makeProxyPool("WellProxy3D", ["well-1|0|0"])],
      ]);
      const result = computeWantedSet(coldState, new Map(), new Map(), new Map(), proxyAtlases);
      expect(result.missing).toHaveLength(0);
    });

    it("fields-with-detail + present field-proxy -> no proxy ask, chunk wanted-set unchanged", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "field-1",
            imageId: "img",
            mode: "fields-with-detail",
            proxyKind: "FieldProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: false,
          }),
        ],
      });
      const atlas = makeVolumePool("img", [
        { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      ]);
      const volumeAtlases = new Map([["ds-0", atlas]]);
      const proxyAtlases = new Map<string, ProxyAtlasSnapshot>([
        ["pool-A", makeProxyPool("FieldProxy3D", ["field-1|0|0"])],
      ]);
      const result = computeWantedSet(
        coldState,
        volumeAtlases,
        new Map(),
        buildMemberToPool(volumeAtlases),
        proxyAtlases,
      );
      // 1 chunk should be missing (visible region 1x1x1), no proxy asks
      expect(proxies(result.missing)).toHaveLength(0);
      expect(chunks(result.missing)).toHaveLength(1);
    });

    it("fields-with-detail + missing advertised field-proxy -> emits MissingProxy { FieldProxy3D }", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "field-1",
            imageId: "img",
            mode: "fields-with-detail",
            proxyKind: "FieldProxy3D",
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
        buildMemberToPool(volumeAtlases),
        new Map(),
      );
      const ps = proxies(result.missing);
      expect(ps).toHaveLength(1);
      expect(ps[0].entityId).toBe("field-1");
      expect(ps[0].proxyKind).toBe("FieldProxy3D");
    });

    it("desiredProxyKeys=[] suppresses otherwise-missing proxy asks", () => {
      const coldState = makeColdState({
        desiredProxyKeys: [],
        activeSet: [
          makeActiveEntry({
            entityId: "well-1",
            imageId: "",
            mode: "well-as-proxy",
            proxyKind: "WellProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), new Map(), new Map());
      expect(result.missing).toHaveLength(0);
    });

    it("desiredProxyKeys gates field and parent-well proxy asks independently", () => {
      const coldState = makeColdState({
        desiredProxyKeys: ["ds-0|well-1|WellProxy3D|0|0"],
        activeSet: [
          makeActiveEntry({
            entityId: "field-1",
            imageId: "img",
            mode: "fields-with-proxy-fallback",
            proxyKind: "FieldProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
            parentWellId: "well-1",
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), new Map(), new Map());
      const ps = proxies(result.missing);
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({
        entityId: "well-1",
        proxyKind: "WellProxy3D",
      });
    });

    it("fields-with-detail + proxyAvailable=false -> no MissingProxy", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "field-1",
            imageId: "img",
            mode: "fields-with-detail",
            // Catalog says no proxy exists — don't ask for one.
            proxyKind: "FieldProxy3D",
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
        buildMemberToPool(volumeAtlases),
        new Map(),
      );
      expect(proxies(result.missing)).toHaveLength(0);
    });

    it("fields-with-proxy-fallback emits both field-proxy and parent-well-proxy (deduped per well)", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "field-A",
            imageId: "imgA",
            mode: "fields-with-proxy-fallback",
            proxyKind: "FieldProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
            parentWellId: "well-1",
          }),
          makeActiveEntry({
            entityId: "field-B",
            imageId: "imgB",
            mode: "fields-with-proxy-fallback",
            proxyKind: "FieldProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
            parentWellId: "well-1",
          }),
        ],
      });
      const result = computeWantedSet(coldState, new Map(), new Map(), new Map(), new Map());
      const ps = proxies(result.missing);
      // 2 field proxies + 1 deduped well proxy = 3
      const fieldProxies = ps.filter((p) => p.proxyKind === "FieldProxy3D");
      const wellProxies = ps.filter((p) => p.proxyKind === "WellProxy3D");
      expect(fieldProxies.map((p) => p.entityId).sort()).toEqual(["field-A", "field-B"]);
      expect(wellProxies).toHaveLength(1);
      expect(wellProxies[0].entityId).toBe("well-1");
    });

    it("mixed modes: well-as-proxy + fields-with-detail -> both reported correctly", () => {
      const coldState = makeColdState({
        visibleRegion: makeVisibleRegion({
          xyBoundsVox: [0, 0, 32, 32],
          zRangeVox: [0, 32],
        }),
        activeSet: [
          makeActiveEntry({
            entityId: "well-X",
            imageId: "",
            mode: "well-as-proxy",
            proxyKind: "WellProxy3D",
            proxyAvailable: true,
            wellProxyAvailable: true,
          }),
          makeActiveEntry({
            entityId: "field-Y",
            imageId: "imgY",
            mode: "fields-with-detail",
            proxyKind: "FieldProxy3D",
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
        buildMemberToPool(volumeAtlases),
        new Map(),
      );
      const ps = proxies(result.missing);
      const wellMissing = ps.filter((p) => p.proxyKind === "WellProxy3D" && p.entityId === "well-X");
      const fieldMissing = ps.filter((p) => p.proxyKind === "FieldProxy3D" && p.entityId === "field-Y");
      expect(wellMissing).toHaveLength(1);
      expect(fieldMissing).toHaveLength(1);
      // Field-Y also has chunk wanted-set entries.
      expect(chunks(result.missing).length).toBeGreaterThan(0);
    });
  });
});
