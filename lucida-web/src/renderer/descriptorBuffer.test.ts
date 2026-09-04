/**
 * Per-dataset entity descriptor buffer tests.
 *
 * Locks down:
 *   1. Entity-index assignment is deterministic across cold-state churn
 *      (orchestrator and worker converge on the same indices).
 *   2. Pool-index assignment is stable when descriptors rebuild over the
 *      same poolKeys.
 *   3. Descriptor struct serialization byte layout matches the WGSL
 *      `EntityDescriptor` declaration: up to four level sources finest
 *      first, each naming its pool binding, plus the coarse source.
 *   4. `mode` → renderMode is the orchestrator's job, but the descriptor
 *      assigns the same memberId conventions the worker uses for
 *      `group-as-proxy` vs field modes.
 */

import { describe, it, expect, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
  UNIFORM: 0x40,
};

import {
  buildDescriptorBuffer,
  computeMemberIndexMap,
  destroyDescriptorBuffer,
  iterateColdMembers,
  memberIdForColdEntry,
  serializeEntityDescriptor,
} from "./descriptorBuffer.ts";
import { serializeTransientDescriptor } from "./descriptor/transient.ts";
import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_MAX_LEVEL_SOURCES,
  DESCRIPTOR_SENTINEL_INDEX,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  OFFSET_COARSE_SOURCE,
  OFFSET_LEVEL_SOURCE_COUNT,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_POOL_INDEX,
  SOURCE_OFFSET_VALID,
  levelSourceOffset,
} from "./descriptor/layout.ts";
import {
  detailTierLevels,
  selectEntitySources,
  type EntitySource,
} from "./entitySources.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "./workerContext.ts";
import type { ColdStateActiveEntry, ColdStateMessage, ColdStateTileEntry } from "./workerProtocol.ts";
import type { ProxyAtlasState } from "./proxyAtlas.ts";

// ---------------------------------------------------------------------------
// Mock GPU device — buffer creation only.
// ---------------------------------------------------------------------------

interface MockBuffer {
  size: number;
  usage: number;
  destroyed: boolean;
  destroy: () => void;
  contents: ArrayBuffer | null;
}

function makeMockDevice(): { device: GPUDevice; lastWrite: () => ArrayBuffer | null } {
  let lastWriteCopy: ArrayBuffer | null = null;
  const createBuffer = vi.fn((desc: GPUBufferDescriptor): MockBuffer => {
    const buf: MockBuffer = {
      size: desc.size,
      usage: desc.usage,
      destroyed: false,
      destroy() { this.destroyed = true; },
      contents: null,
    };
    return buf;
  });
  const writeBuffer = vi.fn((buffer: GPUBuffer, _offset: number, data: BufferSource) => {
    const ab = data instanceof ArrayBuffer
      ? data
      : (data as ArrayBufferView).buffer.slice(
          (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength,
        );
    // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
    // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app). See #438.
    lastWriteCopy = ab.slice(0) as ArrayBuffer;
    (buffer as unknown as MockBuffer).contents = lastWriteCopy;
  });
  const device = {
    createBuffer,
    queue: { writeBuffer } as unknown as GPUQueue,
  } as unknown as GPUDevice;
  return { device, lastWrite: () => lastWriteCopy };
}

function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function defaultDisplayState(): ColdStateActiveEntry["displayStateByChannel"][number] {
  return {
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    colormapName: "gray",
    channelMask: 1,
  };
}

/**
 * Test-fixture helper. Mode-driven branching keeps existing call sites
 * unchanged: pass `mode: "group-as-proxy"` (with `imageId: ""`) to get
 * the group-as-proxy variant; anything else returns a `kind: "tile"`
 * entry. Hides the discriminated-union construction so test fixtures
 * don't have to know about it.
 */
type MakeEntryOpts = Partial<Omit<ColdStateTileEntry, "kind" | "mode">> & {
  entityId: string;
  imageId: string;
  mode: ColdStateActiveEntry["mode"];
};
function makeEntry(opts: MakeEntryOpts): ColdStateActiveEntry {
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
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplayState() },
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

function makeCold(
  activeSet: ColdStateActiveEntry[],
  visibleChannels: number[] = [0],
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
    viewMode: "slice",
  };
}

/**
 * Build the sections the worker would allocate for an entry: one detail
 * section per level in {@link detailTierLevels} with sequential offsets
 * in one detail pool, plus a coarse section in its own pool. Offsets
 * mimic the worker's per-pool accumulation so tests that seed the
 * descriptor's sources see realistic absolute offsets.
 */
function sourcesFromEntry(entry: ColdStateActiveEntry, detailPoolKey = "ds1:64x64:detail"): EntitySource[] {
  if (entry.kind !== "tile") return [];
  const out: EntitySource[] = [];
  let offset = 0;
  const sectionFor = (lvl: number, offsetAt: number) => {
    const lm = entry.levels.find((l) => l.level === lvl);
    if (!lm) return null;
    const [cZ, cY, cX] = lm.chunkShape;
    const [gZ, gY, gX] = lm.gridShape;
    const [lD, lH, lW] = lm.levelDims;
    return {
      meta: {
        level: lvl,
        gridDims: [gZ, gY, gX] as [number, number, number],
        chunkDims: [cZ, cY, cX] as [number, number, number],
        levelDims: [lD, lH, lW] as [number, number, number],
        offset: offsetAt,
      },
      size: gX * gY * Math.max(gZ, 1),
    };
  };
  for (const lvl of detailTierLevels(entry)) {
    const s = sectionFor(lvl, offset);
    if (!s) continue;
    out.push({ tier: "detail", poolKey: detailPoolKey, meta: s.meta });
    offset += s.size;
  }
  if (entry.coarseLevel !== null) {
    const s = sectionFor(entry.coarseLevel, 0);
    if (s) out.push({ tier: "coarse", poolKey: "ds1:64x64:coarse", meta: s.meta });
  }
  return out;
}

/** Build a per-dataset sources map for all entries in `cold.activeSet`
 *  (single-channel only — multi-channel tests can build their own map if
 *  they need one). */
function sourcesForCold(cold: ColdStateMessage): Map<string, EntitySource[]> {
  const out = new Map<string, EntitySource[]>();
  for (const entry of cold.activeSet) {
    const memberId = entry.kind === "group-as-proxy" ? entry.entityId : entry.imageId;
    out.set(memberId, sourcesFromEntry(entry));
  }
  return out;
}

/** Serialize `entry` into a fresh buffer with the sources the worker would allocate. */
function serialize(
  entry: ColdStateActiveEntry,
  sources: EntitySource[] = sourcesFromEntry(entry),
  displayState = defaultDisplayState(),
  proxyDesc = new Map<string, EntityProxyDescriptor>(),
  proxyPoolIdx = new Map<string, number>(),
  proxyPools: ProxyAtlasState[] = [],
): { u32: Uint32Array; f32: Float32Array } {
  const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
  serializeEntityDescriptor(
    buf, 0, entry, selectEntitySources(entry, sources), displayState,
    proxyDesc, proxyPoolIdx, proxyPools, new Map(),
  );
  return { u32: new Uint32Array(buf), f32: new Float32Array(buf) };
}

/** Read one ChunkTierSource back out of a descriptor entry. */
function readSource(u32: Uint32Array, offsetBytes: number) {
  const b = offsetBytes / 4;
  return {
    valid: u32[b + SOURCE_OFFSET_VALID / 4],
    level: u32[b + SOURCE_OFFSET_LEVEL / 4],
    indirectionOffset: u32[b + SOURCE_OFFSET_INDIRECTION_OFFSET / 4],
    poolIndex: u32[b + SOURCE_OFFSET_POOL_INDEX / 4],
    gridDims: [u32[b + SOURCE_OFFSET_GRID_DIMS / 4], u32[b + SOURCE_OFFSET_GRID_DIMS / 4 + 1], u32[b + SOURCE_OFFSET_GRID_DIMS / 4 + 2]],
    chunkDims: [u32[b + SOURCE_OFFSET_CHUNK_DIMS / 4], u32[b + SOURCE_OFFSET_CHUNK_DIMS / 4 + 1], u32[b + SOURCE_OFFSET_CHUNK_DIMS / 4 + 2]],
    levelDims: [u32[b + SOURCE_OFFSET_LEVEL_DIMS / 4], u32[b + SOURCE_OFFSET_LEVEL_DIMS / 4 + 1], u32[b + SOURCE_OFFSET_LEVEL_DIMS / 4 + 2]],
  };
}

function fakePool(slotDims: [number, number, number]): ProxyAtlasState {
  return {
    texture: { destroy() {} } as unknown as GPUTexture,
    slots: new Map(),
    freeSlots: [],
    capacity: 4,
    requestedCapacity: 4,
    slotDims,
    slotsX: 1,
    slotsY: 1,
    slotsZ: 4,
    kind: "GroupProxy3D",
    channel: 0,
    touchOrder: [],
  };
}

/** A four-level halving pyramid in [Z, Y, X] with one chunk shape. */
const PYRAMID: ColdStateTileEntry["levels"] = [
  { level: 0, chunkShape: [1, 64, 64], gridShape: [1, 8, 8], levelDims: [1, 512, 512] },
  { level: 1, chunkShape: [1, 64, 64], gridShape: [1, 4, 4], levelDims: [1, 256, 256] },
  { level: 2, chunkShape: [1, 64, 64], gridShape: [1, 2, 2], levelDims: [1, 128, 128] },
  { level: 3, chunkShape: [1, 64, 64], gridShape: [1, 1, 1], levelDims: [1, 64, 64] },
];

// ---------------------------------------------------------------------------
// memberIdForColdEntry / iterateColdMembers
// ---------------------------------------------------------------------------

describe("memberIdForColdEntry", () => {
  it("uses imageId for fields (single-channel)", () => {
    const e = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    expect(memberIdForColdEntry(e, 0, false)).toBe("img-0");
  });
  it("uses entityId for group-as-proxy entries (single-channel)", () => {
    const e = makeEntry({ entityId: "group-A", imageId: "", mode: "group-as-proxy" });
    expect(memberIdForColdEntry(e, 0, false)).toBe("group-A");
  });
  it("appends :chN for multi-channel fields", () => {
    const e = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    expect(memberIdForColdEntry(e, 2, true)).toBe("img-0:ch2");
  });
  it("appends :chN for multi-channel group-as-proxy", () => {
    const e = makeEntry({ entityId: "group-A", imageId: "", mode: "group-as-proxy" });
    expect(memberIdForColdEntry(e, 1, true)).toBe("group-A:ch1");
  });
});

describe("iterateColdMembers", () => {
  it("walks activeSet × visibleChannels with channel as inner loop", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-detail" }),
      ],
      [0, 1],
    );
    const seen = Array.from(iterateColdMembers(cold)).map((m) => m.memberId);
    expect(seen).toEqual(["img-0:ch0", "img-0:ch1", "img-1:ch0", "img-1:ch1"]);
  });

  it("uses cold-state multiChannel flag instead of visible channel count", () => {
    const cold = makeCold(
      [makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" })],
      [2],
      true,
    );
    const seen = Array.from(iterateColdMembers(cold)).map((m) => m.memberId);
    expect(seen).toEqual(["img-0:ch2"]);
  });
});

// ---------------------------------------------------------------------------
// computeMemberIndexMap — determinism
// ---------------------------------------------------------------------------

describe("computeMemberIndexMap", () => {
  it("assigns dense indices in canonical iteration order", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-detail" }),
      ],
      [0, 1],
    );
    const idx = computeMemberIndexMap(cold);
    expect(idx.get("img-0:ch0")).toBe(0);
    expect(idx.get("img-0:ch1")).toBe(1);
    expect(idx.get("img-1:ch0")).toBe(2);
    expect(idx.get("img-1:ch1")).toBe(3);
  });

  it("orchestrator's index map matches worker's buildDescriptorBuffer indices", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "group-A", imageId: "", mode: "group-as-proxy" }),
      ],
      [0, 3],
    );
    const orchestratorIdx = computeMemberIndexMap(cold);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    for (const [memberId, i] of orchestratorIdx) {
      expect(result.indexByMember.get(memberId)).toBe(i);
    }
    expect(result.entityCount).toBe(orchestratorIdx.size);
    destroyDescriptorBuffer(result);
  });

  it("repeat builds with same activeSet → same indices", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-detail" }),
    ]);
    const a = computeMemberIndexMap(cold);
    const b = computeMemberIndexMap(cold);
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()));
  });
});

// ---------------------------------------------------------------------------
// Pool index assignment (proxy pools)
// ---------------------------------------------------------------------------

describe("pool index assignment", () => {
  it("assigns dense indices to referenced poolKeys in first-seen order", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-proxy-fallback" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-proxy-fallback" }),
    ]);
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("e1", 0, 0), { tileProxyHandle: { poolKey: "poolB", slotIndex: 0 }, groupProxyHandle: null }],
      [proxyDescriptorKey("e2", 0, 0), { tileProxyHandle: { poolKey: "poolA", slotIndex: 1 }, groupProxyHandle: { poolKey: "poolB", slotIndex: 2 } }],
    ]);
    const proxyPoolsByDataset = new Map([
      ["ds1", new Map<string, ProxyAtlasState>([
        ["poolA", fakePool([8, 8, 8])],
        ["poolB", fakePool([16, 16, 16])],
      ])],
    ]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, new Map());
    expect(result.proxyPoolIndexByKey.get("poolB")).toBe(0);
    expect(result.proxyPoolIndexByKey.get("poolA")).toBe(1);
    expect(result.proxyPoolsByIndex).toHaveLength(2);
    destroyDescriptorBuffer(result);
  });

  it("rebuild with same poolKeys → same pool indices", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-proxy-fallback" }),
    ]);
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("e1", 0, 0), { tileProxyHandle: { poolKey: "poolX", slotIndex: 0 }, groupProxyHandle: { poolKey: "poolY", slotIndex: 0 } }],
    ]);
    const proxyPoolsByDataset = new Map([
      ["ds1", new Map<string, ProxyAtlasState>([
        ["poolX", fakePool([8, 8, 8])],
        ["poolY", fakePool([8, 8, 8])],
      ])],
    ]);
    const { device } = makeMockDevice();
    const a = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, new Map());
    const b = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, new Map());
    expect(Array.from(a.proxyPoolIndexByKey.entries()))
      .toEqual(Array.from(b.proxyPoolIndexByKey.entries()));
    destroyDescriptorBuffer(a);
    destroyDescriptorBuffer(b);
  });
});

// ---------------------------------------------------------------------------
// Byte layout
// ---------------------------------------------------------------------------

describe("EntityDescriptor byte layout", () => {
  it("writes modelMatrix at offset 0 and invModelMatrix at offset 64", () => {
    const model = new Float32Array(16);
    const inv = new Float32Array(16);
    for (let i = 0; i < 16; i++) { model[i] = i + 1; inv[i] = i + 100; }
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail", modelMatrix: model, invModelMatrix: inv });
    const { f32 } = serialize(entry);
    for (let i = 0; i < 16; i++) {
      expect(f32[i]).toBe(model[i]);
      expect(f32[16 + i]).toBe(inv[i]);
    }
  });

  it("writes proxy fields at offsets 132/136/140/144 (sentinel when no descriptor)", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    const { u32 } = serialize(entry);
    expect(u32[33]).toBe(DESCRIPTOR_SENTINEL_INDEX);
    expect(u32[34]).toBe(DESCRIPTOR_SENTINEL_INDEX);
    expect(u32[35]).toBe(DESCRIPTOR_SENTINEL_INDEX);
    expect(u32[36]).toBe(DESCRIPTOR_SENTINEL_INDEX);
  });

  it("packs proxy pool/slot indices and slot dims when descriptor exists", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-proxy-fallback" });
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      ["e1", {
        tileProxyHandle: { poolKey: "fp", slotIndex: 7 },
        groupProxyHandle: { poolKey: "wp", slotIndex: 3 },
      }],
    ]);
    const poolIdx = new Map([["fp", 0], ["wp", 1]]);
    const pools = [fakePool([8, 16, 32]), fakePool([4, 64, 128])];
    const { u32 } = serialize(entry, sourcesFromEntry(entry), defaultDisplayState(), proxyDesc, poolIdx, pools);
    expect(u32[33]).toBe(0);  // tileProxyPoolIndex
    expect(u32[34]).toBe(7);  // tileProxySlotIndex
    expect(u32[35]).toBe(1);  // groupProxyPoolIndex
    expect(u32[36]).toBe(3);  // groupProxySlotIndex
    // tileProxyDims @ 160 = u32 idx 40, vec3 = (Z, Y, X)
    expect(u32[40]).toBe(8); expect(u32[41]).toBe(16); expect(u32[42]).toBe(32);
    // groupProxyDims @ 176 = u32 idx 44
    expect(u32[44]).toBe(4); expect(u32[45]).toBe(64); expect(u32[46]).toBe(128);
  });

  it("writes the level sources finest first with the count at offset 212 and the array at 224", () => {
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
      detailLevels: [1],
      levels: PYRAMID,
    });
    const { u32 } = serialize(entry);
    // Target 1 plus the coarser levels 2 and 3: three level sources.
    expect(u32[OFFSET_LEVEL_SOURCE_COUNT / 4]).toBe(3);
    expect(levelSourceOffset(0)).toBe(224);

    const s0 = readSource(u32, levelSourceOffset(0));
    expect(s0.valid).toBe(1);
    expect(s0.level).toBe(1);
    expect(s0.indirectionOffset).toBe(0);
    expect(s0.poolIndex).toBe(0);
    // gridDims / chunkDims / levelDims are written (X, Y, Z).
    expect(s0.gridDims).toEqual([4, 4, 1]);
    expect(s0.chunkDims).toEqual([64, 64, 1]);
    expect(s0.levelDims).toEqual([256, 256, 1]);

    const s1 = readSource(u32, levelSourceOffset(1));
    expect(s1.level).toBe(2);
    // Sequential section offsets: level 1 occupies 4*4 = 16 entries.
    expect(s1.indirectionOffset).toBe(16);
    const s2 = readSource(u32, levelSourceOffset(2));
    expect(s2.level).toBe(3);
    expect(s2.indirectionOffset).toBe(20);
  });

  it("zero-fills unused level source slots and an absent coarse source", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    const { u32 } = serialize(entry);
    expect(u32[OFFSET_LEVEL_SOURCE_COUNT / 4]).toBe(1);
    for (let i = 1; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const base = levelSourceOffset(i) / 4;
      for (let s = 0; s < DESCRIPTOR_TIER_SOURCE_SIZE / 4; s++) {
        expect(u32[base + s]).toBe(0);
      }
    }
    expect(readSource(u32, OFFSET_COARSE_SOURCE).valid).toBe(0);
  });

  it("never names a level finer than the target and caps at four sources", () => {
    const deep: ColdStateTileEntry["levels"] = Array.from({ length: 7 }, (_, level) => ({
      level,
      chunkShape: [1, 64, 64] as [number, number, number],
      gridShape: [1, 1, 1] as [number, number, number],
      levelDims: [1, 64, 64] as [number, number, number],
    }));
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
      detailLevels: [2],
      levels: deep,
    });
    // Sections exist for every level (a stale finer level still resident).
    const sources: EntitySource[] = deep.map((l, i) => ({
      tier: "detail",
      poolKey: "p",
      meta: { level: l.level, gridDims: [1, 1, 1], chunkDims: [1, 64, 64], levelDims: [1, 64, 64], offset: i },
    }));
    const { u32 } = serialize(entry, sources);
    expect(u32[OFFSET_LEVEL_SOURCE_COUNT / 4]).toBe(DESCRIPTOR_MAX_LEVEL_SOURCES);
    const levels = Array.from({ length: DESCRIPTOR_MAX_LEVEL_SOURCES }, (_, i) => readSource(u32, levelSourceOffset(i)).level);
    expect(levels).toEqual([2, 3, 4, 5]);
  });

  it("names a different pool binding for a level whose chunk shape puts it in another pool", () => {
    const levels: ColdStateTileEntry["levels"] = [
      { level: 0, chunkShape: [1, 64, 64], gridShape: [1, 4, 4], levelDims: [1, 256, 256] },
      { level: 1, chunkShape: [1, 32, 32], gridShape: [1, 4, 4], levelDims: [1, 128, 128] },
      { level: 2, chunkShape: [1, 64, 64], gridShape: [1, 1, 1], levelDims: [1, 64, 64] },
    ];
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
      detailLevels: [0],
      levels,
    });
    const sources: EntitySource[] = [
      { tier: "detail", poolKey: "ds1:64x64:detail", meta: { level: 0, gridDims: [1, 4, 4], chunkDims: [1, 64, 64], levelDims: [1, 256, 256], offset: 0 } },
      { tier: "detail", poolKey: "ds1:32x32:detail", meta: { level: 1, gridDims: [1, 4, 4], chunkDims: [1, 32, 32], levelDims: [1, 128, 128], offset: 0 } },
      { tier: "detail", poolKey: "ds1:64x64:detail", meta: { level: 2, gridDims: [1, 1, 1], chunkDims: [1, 64, 64], levelDims: [1, 64, 64], offset: 16 } },
    ];
    const { u32 } = serialize(entry, sources);
    expect(readSource(u32, levelSourceOffset(0)).poolIndex).toBe(0);
    expect(readSource(u32, levelSourceOffset(1)).poolIndex).toBe(1);
    expect(readSource(u32, levelSourceOffset(2)).poolIndex).toBe(0);
    expect(readSource(u32, levelSourceOffset(1)).chunkDims).toEqual([32, 32, 1]);
  });

  it("writes the coarse tier's section into the coarse source", () => {
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
      detailLevels: [0],
      coarseLevel: 2,
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
      ],
    });
    const sources: EntitySource[] = [
      { tier: "detail", poolKey: "d", meta: { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 64, 64], levelDims: [64, 256, 256], offset: 5 } },
      { tier: "coarse", poolKey: "c", meta: { level: 2, gridDims: [8, 2, 2], chunkDims: [8, 128, 128], levelDims: [64, 256, 256], offset: 37 } },
    ];
    const { u32 } = serialize(entry, sources);

    const detail = readSource(u32, levelSourceOffset(0));
    expect(detail.valid).toBe(1);
    expect(detail.level).toBe(0);
    expect(detail.indirectionOffset).toBe(5);
    expect(detail.gridDims).toEqual([4, 4, 2]);
    expect(detail.chunkDims).toEqual([64, 64, 32]);
    expect(detail.levelDims).toEqual([256, 256, 64]);
    // Level 2 is the coarse tier's section, not a level source: only one
    // detail section was allocated.
    expect(u32[OFFSET_LEVEL_SOURCE_COUNT / 4]).toBe(1);

    const coarse = readSource(u32, OFFSET_COARSE_SOURCE);
    expect(coarse.valid).toBe(1);
    expect(coarse.level).toBe(2);
    expect(coarse.indirectionOffset).toBe(37);
    expect(coarse.gridDims).toEqual([2, 2, 8]);
    expect(coarse.chunkDims).toEqual([128, 128, 8]);
  });

  it("keeps same-level detail and coarse sections apart by tier", () => {
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
      detailLevels: [1],
      coarseLevel: 1,
      levels: [
        { level: 1, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
      ],
    });
    const meta = { level: 1, gridDims: [2, 4, 4] as [number, number, number], chunkDims: [32, 64, 64] as [number, number, number], levelDims: [64, 256, 256] as [number, number, number] };
    const sources: EntitySource[] = [
      { tier: "coarse", poolKey: "c", meta: { ...meta, offset: 43 } },
      { tier: "detail", poolKey: "d", meta: { ...meta, offset: 11 } },
    ];
    const { u32 } = serialize(entry, sources);
    expect(readSource(u32, levelSourceOffset(0)).indirectionOffset).toBe(11);
    expect(readSource(u32, OFFSET_COARSE_SOURCE).indirectionOffset).toBe(43);
  });
});

// ---------------------------------------------------------------------------
// Display state (contrast/gamma/opacity/colormap/channelMask)
// ---------------------------------------------------------------------------

describe("EntityDescriptor display state", () => {
  it("writes contrastMin/contrastMax/gamma/opacity at offsets 192..208", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    const { f32, u32 } = serialize(entry, sourcesFromEntry(entry), {
      contrastMin: 100, contrastMax: 5000, gamma: 2.2, opacity: 0.75,
      colormapName: "gray", channelMask: 1,
    });
    expect(f32[48]).toBe(100);
    expect(f32[49]).toBe(5000);
    expect(f32[50]).toBeCloseTo(2.2, 5);
    expect(f32[51]).toBe(0.75);
    expect(u32[32]).toBe(1);
  });

  it("changes to displayState produce different bytes at the display-state offsets", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    const a = serialize(entry, sourcesFromEntry(entry), { ...defaultDisplayState(), contrastMax: 100 });
    const b = serialize(entry, sourcesFromEntry(entry), { ...defaultDisplayState(), contrastMax: 200 });
    expect(a.f32[49]).toBe(100);
    expect(b.f32[49]).toBe(200);
    for (let i = 0; i < 48; i++) expect(a.f32[i]).toBe(b.f32[i]);
  });

  it("falls back to LUT index 0 when colormap is missing from the lookup", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" });
    const { u32 } = serialize(entry, sourcesFromEntry(entry), { ...defaultDisplayState(), colormapName: "nonexistent" });
    expect(u32[52]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Colormap LUT index assignment
// ---------------------------------------------------------------------------

describe("buildDescriptorBuffer colormap LUT assignment", () => {
  it("assigns dense indices to referenced colormap names in first-seen order", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "magma" } },
      }),
      makeEntry({
        entityId: "e2", imageId: "img-1", mode: "tiles-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "viridis" } },
      }),
      makeEntry({
        entityId: "e3", imageId: "img-2", mode: "tiles-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "magma" } },
      }),
    ]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    expect(result.colormapLutIndices.get("magma")).toBe(0);
    expect(result.colormapLutIndices.get("viridis")).toBe(1);
    expect(result.colormapNameByMember.get("img-0")).toBe("magma");
    expect(result.colormapNameByMember.get("img-1")).toBe("viridis");
    expect(result.colormapNameByMember.get("img-2")).toBe("magma");
    destroyDescriptorBuffer(result);
  });

  it("rebuild with same colormap names → same LUT indices (stable across rebuilds)", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "magma" } },
      }),
      makeEntry({
        entityId: "e2", imageId: "img-1", mode: "tiles-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "viridis" } },
      }),
    ]);
    const { device } = makeMockDevice();
    const a = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    const b = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    expect(Array.from(a.colormapLutIndices.entries()))
      .toEqual(Array.from(b.colormapLutIndices.entries()));
    destroyDescriptorBuffer(a);
    destroyDescriptorBuffer(b);
  });

  it("multi-channel composite picks each channel's display state per descriptor entry", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
          displayStateByChannel: {
            0: { ...defaultDisplayState(), colormapName: "magenta", contrastMax: 1000 },
            1: { ...defaultDisplayState(), colormapName: "green",   contrastMax: 2000 },
          },
        }),
      ],
      [0, 1],
    );
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    expect(result.colormapNameByMember.get("img-0:ch0")).toBe("magenta");
    expect(result.colormapNameByMember.get("img-0:ch1")).toBe("green");

    // The descriptor buffer carries per-channel contrast in the
    // corresponding entry slot. Both entities share entityId in iteration
    // but different memberIds → different descriptor indices.
    const idx0 = result.indexByMember.get("img-0:ch0")!;
    const idx1 = result.indexByMember.get("img-0:ch1")!;
    const buf = (result.buffer as unknown as { contents: ArrayBuffer }).contents;
    const f0 = new Float32Array(buf, idx0 * DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_ENTRY_SIZE / 4);
    const f1 = new Float32Array(buf, idx1 * DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_ENTRY_SIZE / 4);
    expect(f0[49]).toBe(1000);
    expect(f1[49]).toBe(2000);
    destroyDescriptorBuffer(result);
  });

  it("multi-channel proxy descriptors stay scoped to each member channel", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
          displayStateByChannel: {
            0: { ...defaultDisplayState(), colormapName: "magenta" },
            1: { ...defaultDisplayState(), colormapName: "green" },
          },
        }),
      ],
      [0, 1],
    );
    const ch0Pool = "ds1|proxy|TileProxy3D|32x32x8|ch0";
    const ch1Pool = "ds1|proxy|TileProxy3D|32x32x8|ch1";
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("e1", 0, 0), { tileProxyHandle: { poolKey: ch0Pool, slotIndex: 1 }, groupProxyHandle: null }],
      [proxyDescriptorKey("e1", 0, 1), { tileProxyHandle: { poolKey: ch1Pool, slotIndex: 2 }, groupProxyHandle: null }],
    ]);
    const proxyPoolsByDataset = new Map([
      ["ds1", new Map<string, ProxyAtlasState>([
        [ch0Pool, fakePool([8, 32, 32])],
        [ch1Pool, fakePool([8, 32, 32])],
      ])],
    ]);

    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, new Map());

    expect(result.proxyDescriptorByMember.get("img-0:ch0")?.tileProxyHandle?.poolKey).toBe(ch0Pool);
    expect(result.proxyDescriptorByMember.get("img-0:ch1")?.tileProxyHandle?.poolKey).toBe(ch1Pool);
    expect(result.proxyPoolIndexByKey.get(ch0Pool)).toBe(0);
    expect(result.proxyPoolIndexByKey.get(ch1Pool)).toBe(1);
    destroyDescriptorBuffer(result);
  });

  it("channel mask packs a single bit per descriptor entry", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
          displayStateByChannel: {
            0: { ...defaultDisplayState(), channelMask: 1 << 0 },
            2: { ...defaultDisplayState(), channelMask: 1 << 2 },
          },
        }),
      ],
      [0, 2],
    );
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    const idx0 = result.indexByMember.get("img-0:ch0")!;
    const idx2 = result.indexByMember.get("img-0:ch2")!;
    const buf = (result.buffer as unknown as { contents: ArrayBuffer }).contents;
    const u0 = new Uint32Array(buf, idx0 * DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_ENTRY_SIZE / 4);
    const u2 = new Uint32Array(buf, idx2 * DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_ENTRY_SIZE / 4);
    expect(u0[32]).toBe(1 << 0);
    expect(u2[32]).toBe(1 << 2);
    destroyDescriptorBuffer(result);
  });
});

// ---------------------------------------------------------------------------
// Mode handling (group-as-proxy vs field modes)
// ---------------------------------------------------------------------------

describe("mode → memberId conventions", () => {
  it("group-as-proxy entries use entityId, field entries use imageId", () => {
    const cold = makeCold([
      makeEntry({ entityId: "group-A", imageId: "", mode: "group-as-proxy" }),
      makeEntry({ entityId: "tile-1", imageId: "img-1", mode: "tiles-with-proxy-fallback" }),
      makeEntry({ entityId: "tile-2", imageId: "img-2", mode: "tiles-with-detail" }),
    ]);
    const idx = computeMemberIndexMap(cold);
    expect(idx.has("group-A")).toBe(true);
    expect(idx.has("img-1")).toBe(true);
    expect(idx.has("img-2")).toBe(true);
  });

  it("buildDescriptorBuffer writes one entry per (entry, channel) combo", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "group-A", imageId: "", mode: "group-as-proxy" }),
      ],
      [0, 1],
    );
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    expect(result.entityCount).toBe(4);
    expect(result.indexByMember.get("img-0:ch0")).toBe(0);
    expect(result.indexByMember.get("img-0:ch1")).toBe(1);
    expect(result.indexByMember.get("group-A:ch0")).toBe(2);
    expect(result.indexByMember.get("group-A:ch1")).toBe(3);
    destroyDescriptorBuffer(result);
  });
});

// ---------------------------------------------------------------------------
// Buffer sizing + GPU write
// ---------------------------------------------------------------------------

describe("buildDescriptorBuffer GPU write", () => {
  it("creates a buffer sized to entityCount * DESCRIPTOR_ENTRY_SIZE", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-detail" }),
    ]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    expect((result.buffer as unknown as MockBuffer).size).toBe(2 * DESCRIPTOR_ENTRY_SIZE);
    destroyDescriptorBuffer(result);
  });

  it("writes the assembled buffer to GPU memory", () => {
    const cold = makeCold([makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" })]);
    const { device, lastWrite } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sourcesForCold(cold));
    const written = lastWrite();
    expect(written).not.toBeNull();
    expect(written!.byteLength).toBe(DESCRIPTOR_ENTRY_SIZE);
    destroyDescriptorBuffer(result);
  });

  it("each entity's level source offsets come from the worker's sections (shared-pool absolute offsets, not per-entity-local)", () => {
    // Regression: descriptor used to compute per-entity-local offsets
    // starting at 0, so every entity addressed offset 0 in the shared
    // pool indirection buffer = entity 0's data. Symptom in collection mode:
    // all fields rendered the same image, panning changed which.
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "tiles-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "tiles-with-detail" }),
    ]);
    const meta = { level: 0, gridDims: [1, 4, 4] as [number, number, number], chunkDims: [1, 64, 64] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] };
    const sources = new Map<string, EntitySource[]>([
      ["img-0", [{ tier: "detail", poolKey: "p", meta: { ...meta, offset: 0 } }]],
      ["img-1", [{ tier: "detail", poolKey: "p", meta: { ...meta, offset: 16 } }]], // entity 0 occupied [0, 16)
    ]);
    const { device, lastWrite } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sources);
    const u32 = new Uint32Array(lastWrite()!);
    const entry0 = readSource(u32, levelSourceOffset(0));
    const entry1 = readSource(u32.subarray(DESCRIPTOR_ENTRY_SIZE / 4), levelSourceOffset(0));
    expect(entry0.indirectionOffset).toBe(0);
    expect(entry1.indirectionOffset).toBe(16);
    destroyDescriptorBuffer(result);
  });

  it("mirrors each member's level pools in binding-slot order and its coarse pool for the draw", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "e1", imageId: "img-0", mode: "tiles-with-detail",
        detailLevels: [0], coarseLevel: 2,
        levels: [
          { level: 0, chunkShape: [1, 64, 64], gridShape: [1, 4, 4], levelDims: [1, 256, 256] },
          { level: 1, chunkShape: [1, 32, 32], gridShape: [1, 4, 4], levelDims: [1, 128, 128] },
          { level: 2, chunkShape: [1, 64, 64], gridShape: [1, 1, 1], levelDims: [1, 64, 64] },
        ],
      }),
      makeEntry({ entityId: "group-A", imageId: "", mode: "group-as-proxy", levels: [] }),
    ]);
    const sources = new Map<string, EntitySource[]>([
      ["img-0", [
        { tier: "detail", poolKey: "ds1:64x64:detail", meta: { level: 0, gridDims: [1, 4, 4], chunkDims: [1, 64, 64], levelDims: [1, 256, 256], offset: 0 } },
        { tier: "detail", poolKey: "ds1:32x32:detail", meta: { level: 1, gridDims: [1, 4, 4], chunkDims: [1, 32, 32], levelDims: [1, 128, 128], offset: 0 } },
        { tier: "detail", poolKey: "ds1:64x64:detail", meta: { level: 2, gridDims: [1, 1, 1], chunkDims: [1, 64, 64], levelDims: [1, 64, 64], offset: 16 } },
        { tier: "coarse", poolKey: "ds1:64x64:coarse", meta: { level: 2, gridDims: [1, 1, 1], chunkDims: [1, 64, 64], levelDims: [1, 64, 64], offset: 0 } },
      ]],
    ]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), sources);
    expect(result.sourceBindingByMember.get("img-0")).toEqual({
      levelPoolKeys: ["ds1:64x64:detail", "ds1:32x32:detail"],
      coarsePoolKey: "ds1:64x64:coarse",
    });
    expect(result.sourceBindingByMember.get("group-A")).toEqual({
      levelPoolKeys: [],
      coarsePoolKey: null,
    });
    destroyDescriptorBuffer(result);
  });
});

// ---------------------------------------------------------------------------
// Transient ↔ canonical byte equivalence
// ---------------------------------------------------------------------------

describe("transient descriptor matches canonical for equivalent params", () => {
  it("agrees byte-for-byte on modelMatrix, invModelMatrix, display state, sentinel proxy handles, and the single level source", () => {
    // Same volume + display state for both writers.
    const volumeDims: [number, number, number] = [128, 64, 32]; // X, Y, Z
    const modelMatrix = new Float32Array([
       1, 0, 0, 0,
       0, 2, 0, 0,
       0, 0, 3, 0,
       4, 5, 6, 1,
    ]);
    const invModelMatrix = new Float32Array([
       1.5, 0, 0, 0,
       0, 1.5, 0, 0,
       0, 0, 1.5, 0,
       -1, -2, -3, 1,
    ]);
    const contrastMin = 50;
    const contrastMax = 5000;
    const gamma = 1.8;
    const opacity = 0.6;

    // Transient writer.
    const transientBuf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    serializeTransientDescriptor(transientBuf, {
      modelMatrix, invModelMatrix, volumeDims,
      contrastMin, contrastMax, gamma, opacity,
    });

    // Canonical writer fed an entry that mimics the transient's shape:
    //   - one level source, level=0, offset=0, pool binding 0
    //   - gridDims=[1,1,1], chunkDims=levelDims=volumeDims
    //   - sentinel proxy handles (no proxy descriptor)
    //   - colormap absent → lutIdx = 0 (matches transient writer which
    //     skips colormapLutIndex entirely → buffer-init zero)
    //   - channelMask = 0 (transient writer doesn't write it)
    const entry = makeEntry({
      entityId: "transient", imageId: "transient", mode: "tiles-with-detail",
      modelMatrix, invModelMatrix,
      detailLevels: [0],
      levels: [{
        level: 0,
        chunkShape: [volumeDims[2], volumeDims[1], volumeDims[0]], // (Z, Y, X)
        gridShape: [1, 1, 1],
        levelDims: [volumeDims[2], volumeDims[1], volumeDims[0]],  // (Z, Y, X)
      }],
      displayStateByChannel: { 0: {
        contrastMin, contrastMax, gamma, opacity,
        colormapName: "missing", channelMask: 0,
      }},
    });
    const canonicalBuf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    serializeEntityDescriptor(
      canonicalBuf, 0, entry, selectEntitySources(entry, sourcesFromEntry(entry)),
      { contrastMin, contrastMax, gamma, opacity, colormapName: "missing", channelMask: 0 },
      new Map(), new Map(), [], new Map(),
    );

    const tF32 = new Float32Array(transientBuf);
    const cF32 = new Float32Array(canonicalBuf);
    const tU32 = new Uint32Array(transientBuf);
    const cU32 = new Uint32Array(canonicalBuf);

    // modelMatrix at offset 0 (16 f32s)
    for (let i = 0; i < 16; i++) expect(cF32[i]).toBe(tF32[i]);
    // invModelMatrix at offset 64 (16 f32s)
    for (let i = 0; i < 16; i++) expect(cF32[16 + i]).toBe(tF32[16 + i]);

    // Sentinel proxy handles at offsets 132/136/140/144
    expect(cU32[33]).toBe(tU32[33]);
    expect(cU32[34]).toBe(tU32[34]);
    expect(cU32[35]).toBe(tU32[35]);
    expect(cU32[36]).toBe(tU32[36]);
    expect(cU32[33]).toBe(DESCRIPTOR_SENTINEL_INDEX);

    // Proxy dims (canonical defaults to (1,1,1) when handle missing; transient writes (1,1,1))
    expect(cU32[40]).toBe(tU32[40]); expect(cU32[41]).toBe(tU32[41]); expect(cU32[42]).toBe(tU32[42]);
    expect(cU32[44]).toBe(tU32[44]); expect(cU32[45]).toBe(tU32[45]); expect(cU32[46]).toBe(tU32[46]);

    // Display state: contrast / gamma / opacity
    expect(cF32[48]).toBe(tF32[48]);
    expect(cF32[49]).toBe(tF32[49]);
    expect(cF32[50]).toBe(tF32[50]);
    expect(cF32[51]).toBe(tF32[51]);

    // levelSourceCount at offset 212
    expect(cU32[OFFSET_LEVEL_SOURCE_COUNT / 4]).toBe(1);
    expect(tU32[OFFSET_LEVEL_SOURCE_COUNT / 4]).toBe(1);

    // Every level source slot and the coarse source, word for word; the
    // slots past the first are zero in both writers.
    const wordsPerSource = DESCRIPTOR_TIER_SOURCE_SIZE / 4;
    for (let slot = 0; slot <= DESCRIPTOR_MAX_LEVEL_SOURCES; slot++) {
      const base = levelSourceOffset(slot) / 4;
      for (let s = 0; s < wordsPerSource; s++) {
        expect(cU32[base + s]).toBe(tU32[base + s]);
        if (slot > 0) expect(cU32[base + s]).toBe(0);
      }
    }
    expect(readSource(tU32, levelSourceOffset(0))).toMatchObject({
      valid: 1, level: 0, indirectionOffset: 0, poolIndex: 0,
      gridDims: [1, 1, 1], chunkDims: volumeDims, levelDims: volumeDims,
    });
  });
});
