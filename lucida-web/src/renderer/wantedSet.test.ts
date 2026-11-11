import { describe, it, expect } from "vitest";
import {
  computeWantedSet,
  type AtlasLevelMeta,
  type AtlasSnapshot,
  type SourcePoolResolver,
} from "./wantedSet.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  MissingChunk,
} from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { VisibleRegion } from "../pipeline/viewport.ts";
import { indexWantedChunks, type WantedChunkIndex } from "./wantedChunks.ts";

function chunks(missing: MissingChunk[]): MissingChunk[] {
  return missing;
}

function makeEpochs(): SceneEpochs {
  return {
    content: 1,
    layout: 1,
    view: 1,
    selection: 1,
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

/** Fixture builder for `ColdStateActiveEntry`. */
function makeActiveEntry(
  overrides?: Partial<ColdStateActiveEntry>,
): ColdStateActiveEntry {
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app).
  const identity = new Float32Array(16) as Float32Array<ArrayBuffer>;
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  return {
    entityId: overrides?.entityId ?? "entity-0",
    imageId: overrides?.imageId ?? "img",
    detailLevels: overrides?.detailLevels ?? [0],
    coarseLevel: overrides?.coarseLevel ?? null,
    levels: overrides?.levels ?? [
      {
        level: 0,
        chunkShape: [32, 32, 32] as [number, number, number], // [Z, Y, X]
        gridShape: [2, 4, 4] as [number, number, number], // 64 deep, 128 high, 128 wide
        levelDims: [64, 128, 128] as [number, number, number],
      },
    ],
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
}

function makeColdState(
  overrides?: Partial<ColdStateMessage>,
): ColdStateMessage {
  const visibleChannels = overrides?.visibleChannels ?? [0];
  return {
    type: "coldState",
    labels: [],
    epochs: makeEpochs(),
    datasetId: "ds-0",
    currentT: 0,
    currentZ: 0,
    visibleChannels,
    visibleRegion: makeVisibleRegion(),
    wantedChunks: [],
    activeSet: [makeActiveEntry()],
    viewMode: "volume",
    view: 0,
    drawnViews: [0],
    sampleFormat: "u16",
    ...overrides,
  };
}

/** The planner's wanted chunks, per (member, tier). */
function wanted(...entries: Array<[memberId: string, tier: ResidencyTier, chunkKeys: string[]]>): WantedChunkIndex {
  return indexWantedChunks(entries.map(([memberId, tier, chunkKeys]) => ({ memberId, tier, chunkKeys })));
}

const NO_WANTED: WantedChunkIndex = new Map();

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
 * view's routes, derived from the fixture pools).
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

const LEVEL0_SECTION: AtlasLevelMeta = { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 };
const FOUR = ["0/0/0/0/0/0", "0/0/0/0/0/1", "0/0/0/0/1/0", "0/0/0/0/1/1"];

describe("computeWantedSet", () => {
  it("reports every wanted chunk the atlas lacks", () => {
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [LEVEL0_SECTION])]]);

    const result = computeWantedSet(
      makeColdState(), wanted(["img:ch0", "detail", FOUR]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing)).toEqual(FOUR.map((chunkKey) => ({
      datasetId: "ds-0", tier: "detail", entityId: "entity-0", memberId: "img:ch0", c: 0, chunkKey,
    })));
  });

  it("reports nothing once the atlas holds every wanted chunk", () => {
    const slots = new Map(FOUR.map((key, slot) => [vk("img:ch0", key), slot]));
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [LEVEL0_SECTION], slots)]]);

    const result = computeWantedSet(
      makeColdState(), wanted(["img:ch0", "detail", FOUR]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(result.missing).toHaveLength(0);
  });

  it("reports only the wanted chunks the atlas lacks", () => {
    const slots = new Map([[vk("img:ch0", FOUR[0]), 0], [vk("img:ch0", FOUR[3]), 1]]);
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [LEVEL0_SECTION], slots)]]);

    const result = computeWantedSet(
      makeColdState(), wanted(["img:ch0", "detail", FOUR]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing).map((m) => m.chunkKey)).toEqual([FOUR[1], FOUR[2]]);
  });

  it("wants only the planner's chunks, whatever the view geometry covers", () => {
    // The region covers the whole 4 × 4 × 2 grid; the planner wants two chunks.
    const coldState = makeColdState({ visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024] }) });
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [LEVEL0_SECTION])]]);

    const result = computeWantedSet(
      coldState, wanted(["img:ch0", "detail", ["0/0/0/1/3/3", "0/0/0/0/0/0"]]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing).map((m) => m.chunkKey)).toEqual(["0/0/0/1/3/3", "0/0/0/0/0/0"]);
  });

  it("ignores wanted chunks of a member outside the active set", () => {
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [LEVEL0_SECTION])]]);

    const result = computeWantedSet(
      makeColdState(), wanted(["other", "detail", FOUR]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(result.missing).toHaveLength(0);
  });

  it("multi-channel - per-channel members and pools", () => {
    const coldState = makeColdState({ visibleChannels: [0, 2] });
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch0", makeVolumePool("img:ch0", [LEVEL0_SECTION])],
      ["ds-0:ch2", makeVolumePool("img:ch2", [LEVEL0_SECTION])],
    ]);

    const result = computeWantedSet(
      coldState,
      wanted(["img:ch0", "detail", ["0/0/0/0/0/0"]], ["img:ch2", "detail", ["0/0/2/0/0/0"]]),
      volumeAtlases,
      new Map(),
      poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing).map((m) => [m.memberId, m.c, m.chunkKey])).toEqual([
      ["img:ch0", 0, "0/0/0/0/0/0"],
      ["img:ch2", 2, "0/0/2/0/0/0"],
    ]);
  });

  it("multi-channel mode with one visible channel still uses channel-qualified member ids", () => {
    const coldState = makeColdState({ visibleChannels: [2] });
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch2", makeVolumePool("img:ch2", [LEVEL0_SECTION])],
    ]);

    const result = computeWantedSet(
      coldState, wanted(["img:ch2", "detail", ["0/0/2/0/0/0"]]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing)).toEqual([
      expect.objectContaining({ memberId: "img:ch2", c: 2, chunkKey: "0/0/2/0/0/0" }),
    ]);
  });

  it("slice mode - a resident chunk cut from another plane of it is missing at the view's plane", () => {
    const coldState = makeColdState({ viewMode: "slice" });
    // Each chunk of FOUR held at the plane of the same index in `planes`.
    const planesAt = (planes: number[]) => new Map(FOUR.map((key, slot) => [vk("img:ch0", key), new Map([[planes[slot], slot]])]));
    const atlas: AtlasSnapshot = {
      slots: new Map(),
      planesByChunk: planesAt([10, 10, 10, 10]),
      entityMetas: new Map([["img:ch0", [LEVEL0_SECTION]]]),
      z: 10,
    };
    const sliceAtlases = new Map([["ds-0:ch0:32x32", atlas]]);
    const run = () => computeWantedSet(
      coldState, wanted(["img:ch0", "detail", FOUR]), new Map(), sliceAtlases, poolsFromAtlases(sliceAtlases),
    );

    expect(run().missing).toEqual([]);
    // Plane 11 is in the same chunk along Z, so every key still matches.
    atlas.z = 11;
    expect(chunks(run().missing).map((m) => m.chunkKey)).toEqual(FOUR);
    atlas.planesByChunk = planesAt([11, 11, 10, 10]);
    expect(chunks(run().missing).map((m) => m.chunkKey)).toEqual(FOUR.slice(2));
    expect(run().missing.map((m) => m.cut)).toEqual([{ axis: "z", plane: 11 }, { axis: "z", plane: 11 }]);
  });

  it("names the plane a slice view wants a chunk with no slot at", () => {
    const coldState = makeColdState({ viewMode: "slice" });
    const sliceAtlases = new Map<string, AtlasSnapshot>([["ds-0:ch0:32x32", {
      slots: new Map(), planesByChunk: new Map(), entityMetas: new Map([["img:ch0", [LEVEL0_SECTION]]]), z: 0,
    }]]);

    const result = computeWantedSet(
      coldState, wanted(["img:ch0", "detail", FOUR]), new Map(), sliceAtlases, poolsFromAtlases(sliceAtlases),
    );

    expect(chunks(result.missing)).toHaveLength(4);
    expect(result.missing.every((m) => m.cut?.axis === "z" && m.cut.plane === 0)).toBe(true);
  });

  it("reports detail and coarse chunks against their own tier's pool", () => {
    const coldState = makeColdState({
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
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch0:32x32x32:detail", makeVolumePool("img:ch0", [LEVEL0_SECTION])],
      ["ds-0:ch0:64x64x32:coarse", makeVolumePool("img:ch0", [{ level: 2, gridDims: [2, 2, 2], chunkDims: [32, 64, 64], offset: 0 }])],
    ]);

    const result = computeWantedSet(
      coldState,
      wanted(["img:ch0", "detail", ["0/0/0/0/0/0"]], ["img:ch0", "coarse", ["2/0/0/0/0/0"]]),
      volumeAtlases,
      new Map(),
      tierPool([
        ["img:ch0", "detail", "ds-0:ch0:32x32x32:detail"],
        ["img:ch0", "coarse", "ds-0:ch0:64x64x32:coarse"],
      ]),
    );

    expect(chunks(result.missing)).toEqual([
      expect.objectContaining({ tier: "detail", chunkKey: "0/0/0/0/0/0" }),
      expect.objectContaining({ tier: "coarse", chunkKey: "2/0/0/0/0/0" }),
    ]);
  });

  it("keeps one key's residency apart in the two tiers", () => {
    const chunkKey = "1/0/0/0/0/0";
    const coldState = makeColdState({
      activeSet: [
        makeActiveEntry({
          detailLevels: [1],
          coarseLevel: 1,
          levels: [{ level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] }],
        }),
      ],
    });
    const section = { level: 1, gridDims: [2, 4, 4] as [number, number, number], chunkDims: [32, 32, 32] as [number, number, number], offset: 0 };
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch0:32x32x32:detail", makeVolumePool("img:ch0", [section], new Map([[vk("img:ch0", chunkKey), 0]]))],
      ["ds-0:ch0:32x32x32:coarse", makeVolumePool("img:ch0", [section])],
    ]);

    const result = computeWantedSet(
      coldState,
      wanted(["img:ch0", "detail", [chunkKey]], ["img:ch0", "coarse", [chunkKey]]),
      volumeAtlases,
      new Map(),
      tierPool([
        ["img:ch0", "detail", "ds-0:ch0:32x32x32:detail"],
        ["img:ch0", "coarse", "ds-0:ch0:32x32x32:coarse"],
      ]),
    );

    expect(chunks(result.missing)).toEqual([expect.objectContaining({ tier: "coarse", chunkKey })]);
  });

  it("no active set -> empty wanted-set", () => {
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [LEVEL0_SECTION])]]);

    const result = computeWantedSet(
      makeColdState({ activeSet: [] }), wanted(["img:ch0", "detail", FOUR]), volumeAtlases, new Map(), poolsFromAtlases(volumeAtlases),
    );

    expect(result.missing).toHaveLength(0);
  });

  it("skips a wanted chunk the worker allocated no section for", () => {
    const result = computeWantedSet(makeColdState(), wanted(["img:ch0", "detail", FOUR]), new Map(), new Map(), noPools);

    expect(result.missing).toHaveLength(0);
  });

  it("reports a missing chunk at each wanted level", () => {
    const coldState = makeColdState({
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
    const slots = new Map([[vk("img:ch0", "0/0/0/0/0/0"), 0], [vk("img:ch0", "1/0/0/0/0/0"), 1]]);
    const atlas = makeVolumePool("img:ch0", [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 32 },
      { level: 2, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 64 },
    ], slots);
    const volumeAtlases = new Map([["ds-0", atlas]]);

    const result = computeWantedSet(
      coldState,
      wanted(["img:ch0", "detail", ["0/0/0/0/0/0", "1/0/0/0/0/0", "2/0/0/0/0/0"]]),
      volumeAtlases,
      new Map(),
      poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing).map((m) => m.chunkKey)).toEqual(["2/0/0/0/0/0"]);
  });

  it("routes each wanted level to its own pool when chunk shapes differ", () => {
    const coldState = makeColdState({
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
    const finePool = makeVolumePool("img:ch0", [{ level: 0, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], offset: 0 }]);
    const smallChunkPool = makeVolumePool("img:ch0", [
      { level: 1, gridDims: [1, 2, 2], chunkDims: [32, 16, 16], offset: 0 },
    ], new Map([[vk("img:ch0", "1/0/0/0/0/0"), 3]]));
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["ds-0:ch0:32x32x32:detail", finePool],
      ["ds-0:ch0:16x16x32:detail", smallChunkPool],
    ]);

    const result = computeWantedSet(
      coldState,
      wanted(["img:ch0", "detail", ["0/0/0/0/0/0", "1/0/0/0/0/0", "1/0/0/0/0/1"]]),
      volumeAtlases,
      new Map(),
      poolsFromAtlases(volumeAtlases),
    );

    expect(chunks(result.missing).map((m) => m.chunkKey)).toEqual(["0/0/0/0/0/0", "1/0/0/0/0/1"]);
  });

  it("skips wanted levels absent from the pool's entity metas", () => {
    const coldState = makeColdState({
      activeSet: [
        makeActiveEntry({
          detailLevels: [0, 1],
          levels: [
            { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
            { level: 1, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
          ],
        }),
      ],
    });
    const volumeAtlases = new Map([["ds-0", makeVolumePool("img:ch0", [
      { level: 1, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
    ])]]);

    const result = computeWantedSet(
      coldState,
      wanted(["img:ch0", "detail", ["0/0/0/0/0/0", "1/0/0/0/0/0"]]),
      volumeAtlases,
      new Map(),
      // Level 0 routes to the pool, which has no section for it.
      () => "ds-0",
    );

    expect(chunks(result.missing).map((m) => m.chunkKey)).toEqual(["1/0/0/0/0/0"]);
  });

  describe("displayed levels", () => {
    // Halving pyramid with one chunk shape at every level (so one pool).
    const pyramid = [
      { level: 0, chunkShape: [32, 32, 32] as [number, number, number], gridShape: [2, 4, 4] as [number, number, number], levelDims: [64, 128, 128] as [number, number, number] },
      { level: 1, chunkShape: [32, 32, 32] as [number, number, number], gridShape: [1, 2, 2] as [number, number, number], levelDims: [32, 64, 64] as [number, number, number] },
      { level: 2, chunkShape: [32, 32, 32] as [number, number, number], gridShape: [1, 1, 1] as [number, number, number], levelDims: [16, 32, 32] as [number, number, number] },
    ];
    const sections: AtlasLevelMeta[] = [
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], offset: 0 },
      { level: 1, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], offset: 32 },
      { level: 2, gridDims: [1, 1, 1], chunkDims: [32, 32, 32], offset: 36 },
    ];

    /** Every chunk key of one level, channel `c`. */
    function levelKeys(level: number, c = 0): string[] {
      const grid = pyramid[level].gridShape;
      const keys: string[] = [];
      for (let z = 0; z < grid[0]; z++) {
        for (let y = 0; y < grid[1]; y++) {
          for (let x = 0; x < grid[2]; x++) keys.push(`${level}/0/${c}/${z}/${y}/${x}`);
        }
      }
      return keys;
    }

    function everyChunk(memberId: string, level: number, c = 0): string[] {
      return levelKeys(level, c).map((key) => vk(memberId, key));
    }

    function slotsOf(keys: string[]): Map<string, number> {
      return new Map(keys.map((key, i) => [key, i]));
    }

    /** The planner wants every target-level chunk of `img`. */
    const wantTarget = (target: number) => wanted(["img:ch0", "detail", levelKeys(target)]);

    function levelsFor(
      coldState: ColdStateMessage,
      wantedChunks: WantedChunkIndex,
      volumeAtlases: Map<string, AtlasSnapshot>,
      poolFor: SourcePoolResolver = poolsFromAtlases(volumeAtlases),
    ) {
      return computeWantedSet(coldState, wantedChunks, volumeAtlases, new Map(), poolFor).levels;
    }

    it("reports the target level as displayed once every wanted target chunk is resident", () => {
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0] })] });
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections, slotsOf(everyChunk("img:ch0", 0)))]]);

      expect(levelsFor(coldState, wantTarget(0), atlases)).toEqual([
        { entityId: "entity-0", targetLevel: 0, visible: true, displayed: { min: 0, max: 0 } },
      ]);
    });

    it("reports the coarser resident section where the target is missing, and still asks for the target", () => {
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0] })] });
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections, slotsOf(everyChunk("img:ch0", 1)))]]);

      const result = computeWantedSet(coldState, wantTarget(0), atlases, new Map(), poolsFromAtlases(atlases));
      expect(result.levels).toEqual([
        { entityId: "entity-0", targetLevel: 0, visible: true, displayed: { min: 1, max: 1 } },
      ]);
      expect(chunks(result.missing).map((m) => m.chunkKey.split("/")[0])).toEqual(Array(32).fill("0"));
    });

    it("spans the finest and coarsest level when positions come from more than one", () => {
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0] })] });
      const leftHalfOfLevel0 = everyChunk("img:ch0", 0).filter((key) => key.endsWith("/0") || key.endsWith("/1"));
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections, slotsOf([...everyChunk("img:ch0", 1), ...leftHalfOfLevel0]))]]);

      expect(levelsFor(coldState, wantTarget(0), atlases)[0].displayed).toEqual({ min: 0, max: 1 });
    });

    it("reads only the wanted target positions", () => {
      // The planner wants the left half; level 0 is resident there and absent elsewhere.
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0] })] });
      const leftHalf = levelKeys(0).filter((key) => key.endsWith("/0") || key.endsWith("/1"));
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections, slotsOf([
        ...everyChunk("img:ch0", 1), ...leftHalf.map((key) => vk("img:ch0", key)),
      ]))]]);

      expect(levelsFor(coldState, wanted(["img:ch0", "detail", leftHalf]), atlases)[0].displayed).toEqual({ min: 0, max: 0 });
    });

    it("never reports a level finer than the target", () => {
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [1] })] });
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections, slotsOf([...everyChunk("img:ch0", 0), ...everyChunk("img:ch0", 2)]))]]);

      expect(levelsFor(coldState, wantTarget(1), atlases)[0]).toEqual({
        entityId: "entity-0", targetLevel: 1, visible: true, displayed: { min: 2, max: 2 },
      });
    });

    it("falls to the coarse tier when no detail section covers a position", () => {
      const coldState = makeColdState({
        activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0], coarseLevel: 2 })],
      });
      const atlases = new Map([
        ["detail-pool", makeVolumePool("img:ch0", sections.slice(0, 2))],
        ["coarse-pool", makeVolumePool("img:ch0", [sections[2]], slotsOf(everyChunk("img:ch0", 2)))],
      ]);
      const poolFor = tierPool([["img:ch0", "detail", "detail-pool"], ["img:ch0", "coarse", "coarse-pool"]]);

      expect(levelsFor(coldState, wantTarget(0), atlases, poolFor)[0].displayed).toEqual({ min: 2, max: 2 });
    });

    it("reports no displayed level while nothing is resident", () => {
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0] })] });
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections)]]);

      expect(levelsFor(coldState, wantTarget(0), atlases)).toEqual([
        { entityId: "entity-0", targetLevel: 0, visible: true, displayed: null },
      ]);
    });

    it("reports an entity the planner wants no target chunk of as not visible, with its target level", () => {
      const coldState = makeColdState({ activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [1] })] });
      const atlases = new Map([["pool", makeVolumePool("img:ch0", sections, slotsOf(everyChunk("img:ch0", 1)))]]);

      expect(levelsFor(coldState, NO_WANTED, atlases)).toEqual([
        { entityId: "entity-0", targetLevel: 1, visible: false, displayed: null },
      ]);
    });

    it("counts only target-level chunks toward the displayed level", () => {
      // A wanted coarse-tier chunk is not a target position.
      const coldState = makeColdState({
        activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0], coarseLevel: 2 })],
      });
      const atlases = new Map([
        ["detail-pool", makeVolumePool("img:ch0", sections.slice(0, 2))],
        ["coarse-pool", makeVolumePool("img:ch0", [sections[2]], slotsOf(everyChunk("img:ch0", 2)))],
      ]);
      const poolFor = tierPool([["img:ch0", "detail", "detail-pool"], ["img:ch0", "coarse", "coarse-pool"]]);

      expect(levelsFor(coldState, wanted(["img:ch0", "coarse", levelKeys(2)]), atlases, poolFor)[0])
        .toEqual({ entityId: "entity-0", targetLevel: 0, visible: false, displayed: null });
    });

    it("takes the finest and coarsest level across the visible channels", () => {
      const coldState = makeColdState({
        visibleChannels: [0, 1],
        activeSet: [makeActiveEntry({ levels: pyramid, detailLevels: [0] })],
      });
      const atlases = new Map([
        ["pool", {
          slots: slotsOf([...everyChunk("img:ch0", 0, 0), ...everyChunk("img:ch1", 1, 1)]),
          entityMetas: new Map([["img:ch0", sections], ["img:ch1", sections]]),
        }],
      ]);

      expect(levelsFor(
        coldState,
        wanted(["img:ch0", "detail", levelKeys(0, 0)], ["img:ch1", "detail", levelKeys(0, 1)]),
        atlases,
      )[0].displayed).toEqual({ min: 0, max: 1 });
    });

    it("leaves out entries that have no target level", () => {
      const coldState = makeColdState({
        activeSet: [makeActiveEntry({ detailLevels: [] })],
      });

      expect(levelsFor(coldState, NO_WANTED, new Map())).toEqual([]);
    });

    it("maps the slice plane onto a shallower level by proportion of its depth", () => {
      // Full-resolution plane 20 maps to plane 10 of the 16-deep level 1, so
      // chunk 1 of its 8-plane chunks; only that chunk covers the position.
      const levels = [
        { level: 0, chunkShape: [8, 32, 32] as [number, number, number], gridShape: [4, 1, 1] as [number, number, number], levelDims: [32, 32, 32] as [number, number, number] },
        { level: 1, chunkShape: [8, 16, 16] as [number, number, number], gridShape: [2, 1, 1] as [number, number, number], levelDims: [16, 16, 16] as [number, number, number] },
      ];
      const coldState = makeColdState({
        viewMode: "slice",
        activeSet: [makeActiveEntry({ levels, detailLevels: [0] })],
      });
      const pools = (level1ChunkZ: number) => new Map<string, AtlasSnapshot>([
        ["p0", { z: 20, slots: new Map(), entityMetas: new Map([["img:ch0", [{ level: 0, gridDims: [4, 1, 1], chunkDims: [8, 32, 32], offset: 0 }]]]) }],
        ["p1", {
          z: 20,
          slots: new Map([[vk("img:ch0", `1/0/0/${level1ChunkZ}/0/0`), 0]]),
          entityMetas: new Map([["img:ch0", [{ level: 1, gridDims: [2, 1, 1], chunkDims: [8, 16, 16], offset: 0 }]]]),
        }],
      ]);
      // Plane 20 of level 0 is in its chunk 2.
      const wantPlane = wanted(["img:ch0", "detail", ["0/0/0/2/0/0"]]);

      const rightPlane = pools(1);
      expect(computeWantedSet(coldState, wantPlane, new Map(), rightPlane, poolsFromAtlases(rightPlane)).levels[0].displayed)
        .toEqual({ min: 1, max: 1 });
      const wrongPlane = pools(0);
      expect(computeWantedSet(coldState, wantPlane, new Map(), wrongPlane, poolsFromAtlases(wrongPlane)).levels[0].displayed)
        .toBeNull();
    });
  });
});
