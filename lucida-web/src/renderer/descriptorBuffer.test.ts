/**
 * Per-dataset entity descriptor buffer tests.
 *
 * Locks down:
 *   1. Entity-index assignment is deterministic across cold-state churn
 *      (orchestrator and worker converge on the same indices).
 *   2. Pool-index assignment is stable when descriptors rebuild over the
 *      same poolKeys.
 *   3. Descriptor struct serialization byte layout matches the WGSL
 *      `EntityDescriptor` declaration.
 *   4. `mode` → renderMode is the orchestrator's job, but the descriptor
 *      assigns the same memberId conventions the worker uses for
 *      `well-as-proxy` vs field modes.
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
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_LODS_OFFSET,
  DESCRIPTOR_LOD_INFO_SIZE,
  DESCRIPTOR_MAX_LODS,
  DESCRIPTOR_SENTINEL_INDEX,
} from "./descriptorBuffer.ts";
import { serializeTransientDescriptor } from "./descriptor/transient.ts";
import {
  OFFSET_COARSE_SOURCE,
  OFFSET_DETAIL_SOURCE,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_VALID,
  DESCRIPTOR_TIER_SOURCE_SIZE,
} from "./descriptor/layout.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "./workerContext.ts";
import type { ColdStateActiveEntry, ColdStateMessage } from "./workerProtocol.ts";
import type { ProxyAtlasState } from "./proxyAtlas.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";

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
 * unchanged: pass `mode: "well-as-proxy"` (with `imageId: ""`) to get
 * the well-as-proxy variant; anything else returns a `kind: "field"`
 * entry. Hides the discriminated-union construction so test fixtures
 * don't have to know about it.
 */
type MakeEntryOpts = Partial<Omit<ColdStateActiveEntry, "kind">> & {
  entityId: string;
  imageId: string;
  mode: ColdStateActiveEntry["mode"];
};
function makeEntry(opts: MakeEntryOpts): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    targetLod: opts.targetLod ?? 0,
    detailOwnedLodRange: opts.detailOwnedLodRange ?? [0, 0] as [number, number],
    detailLevel: opts.detailLevel,
    coarseLevel: opts.coarseLevel,
    wantedLodLevels: opts.wantedLodLevels,
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
    ],
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    wellProxyAvailable: opts.wellProxyAvailable ?? false,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplayState() },
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

/** Build LodIndirectionMeta[] for an entry the way the worker builds them
 *  (per-entity offset accumulating in canonical detailOwnedLodRange order),
 *  for tests that need to seed the new descriptor `entityMetasByMember`
 *  argument with realistic absolute offsets. */
function metasFromEntry(entry: ColdStateActiveEntry): LodIndirectionMeta[] {
  const [finest, coarsest] = entry.detailOwnedLodRange;
  const out: LodIndirectionMeta[] = [];
  let offset = 0;
  for (let lvl = finest; lvl <= coarsest; lvl++) {
    const lm = entry.levels.find(l => l.level === lvl);
    if (!lm) continue;
    const [cZ, cY, cX] = lm.chunkShape;
    const [gZ, gY, gX] = lm.gridShape;
    const [lD, lH, lW] = lm.levelDims;
    out.push({
      level: lvl,
      gridDims: [gZ, gY, gX],
      chunkDims: [cZ, cY, cX],
      levelDims: [lD, lH, lW],
      offset,
    });
    offset += gX * gY * Math.max(gZ, 1);
  }
  if (out.length === 0) {
    const lm = entry.levels.find(l => l.level === entry.targetLod);
    if (!lm) return out;
    const [cZ, cY, cX] = lm.chunkShape;
    const [gZ, gY, gX] = lm.gridShape;
    const [lD, lH, lW] = lm.levelDims;
    out.push({
      level: entry.targetLod,
      gridDims: [gZ, gY, gX],
      chunkDims: [cZ, cY, cX],
      levelDims: [lD, lH, lW],
      offset: 0,
    });
  }
  return out;
}

/** Build a per-dataset metas map for all entries in `cold.activeSet`
 *  (single-channel only — multi-channel tests can build their own map if
 *  they need one). */
function metasForCold(cold: ColdStateMessage): Map<string, LodIndirectionMeta[]> {
  const out = new Map<string, LodIndirectionMeta[]>();
  for (const entry of cold.activeSet) {
    const memberId = entry.kind === "well-as-proxy" ? entry.entityId : entry.imageId;
    out.set(memberId, metasFromEntry(entry));
  }
  return out;
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
    kind: "WellProxy3D",
    channel: 0,
    touchOrder: [],
  };
}

// ---------------------------------------------------------------------------
// memberIdForColdEntry / iterateColdMembers
// ---------------------------------------------------------------------------

describe("memberIdForColdEntry", () => {
  it("uses imageId for fields (single-channel)", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    expect(memberIdForColdEntry(entry, 0, false)).toBe("img-0");
  });
  it("uses entityId for well-as-proxy entries (single-channel)", () => {
    const entry = makeEntry({ entityId: "well-A1", imageId: "", mode: "well-as-proxy" });
    expect(memberIdForColdEntry(entry, 0, false)).toBe("well-A1");
  });
  it("appends :chN for multi-channel fields", () => {
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    expect(memberIdForColdEntry(entry, 2, true)).toBe("img-0:ch2");
  });
  it("appends :chN for multi-channel well-as-proxy", () => {
    const entry = makeEntry({ entityId: "well-A1", imageId: "", mode: "well-as-proxy" });
    expect(memberIdForColdEntry(entry, 1, true)).toBe("well-A1:ch1");
  });
});

describe("iterateColdMembers", () => {
  it("walks activeSet × visibleChannels with channel as inner loop", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
        makeEntry({ entityId: "e2", imageId: "img-1", mode: "fields-with-detail" }),
      ],
      [0, 1],
    );
    const ids = Array.from(iterateColdMembers(cold)).map(x => x.memberId);
    expect(ids).toEqual([
      "img-0:ch0", "img-0:ch1",
      "img-1:ch0", "img-1:ch1",
    ]);
  });

  it("uses cold-state multiChannel flag instead of visible channel count", () => {
    const cold = makeCold(
      [makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" })],
      [2],
      true,
    );

    expect(Array.from(iterateColdMembers(cold)).map(x => x.memberId)).toEqual([
      "img-0:ch2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Index assignment determinism (worker ↔ orchestrator convergence)
// ---------------------------------------------------------------------------

describe("computeMemberIndexMap", () => {
  it("assigns dense indices in canonical iteration order", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "fields-with-detail" }),
      makeEntry({ entityId: "well-A1", imageId: "", mode: "well-as-proxy" }),
    ]);
    const idx = computeMemberIndexMap(cold);
    expect(Array.from(idx.entries())).toEqual([
      ["img-0", 0],
      ["img-1", 1],
      ["well-A1", 2],
    ]);
  });

  it("orchestrator's index map matches worker's buildDescriptorBuffer indices", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
        makeEntry({ entityId: "e2", imageId: "img-1", mode: "fields-with-detail" }),
      ],
      [0, 1],
    );
    const orchestratorIdx = computeMemberIndexMap(cold);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
    expect(Array.from(result.indexByMember.entries())).toEqual(
      Array.from(orchestratorIdx.entries()),
    );
    destroyDescriptorBuffer(result);
  });

  it("repeat builds with same activeSet → same indices", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "fields-with-detail" }),
    ]);
    const a = computeMemberIndexMap(cold);
    const b = computeMemberIndexMap(cold);
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()));
  });
});

// ---------------------------------------------------------------------------
// Pool index stability across rebuilds
// ---------------------------------------------------------------------------

describe("pool index assignment", () => {
  it("assigns dense indices to referenced poolKeys in first-seen order", () => {
    const cold = makeCold([
      makeEntry({ entityId: "well-A", imageId: "", mode: "well-as-proxy" }),
      makeEntry({ entityId: "field-1", imageId: "img-1", mode: "fields-with-proxy-fallback" }),
    ]);
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("well-A", 0, 0), { fieldProxyHandle: null, wellProxyHandle: { poolKey: "ds1|proxy|WellProxy3D|64x64x16|ch0", slotIndex: 3 } }],
      [proxyDescriptorKey("field-1", 0, 0), { fieldProxyHandle: { poolKey: "ds1|proxy|FieldProxy3D|32x32x8|ch0", slotIndex: 1 }, wellProxyHandle: { poolKey: "ds1|proxy|WellProxy3D|64x64x16|ch0", slotIndex: 3 } }],
    ]);
    const dsPools = new Map<string, ProxyAtlasState>([
      ["ds1|proxy|WellProxy3D|64x64x16|ch0", fakePool([16, 64, 64])],
      ["ds1|proxy|FieldProxy3D|32x32x8|ch0", fakePool([8, 32, 32])],
    ]);
    const proxyPoolsByDataset = new Map([["ds1", dsPools]]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, metasForCold(cold));
    expect(result.proxyPoolIndexByKey.get("ds1|proxy|WellProxy3D|64x64x16|ch0")).toBe(0);
    expect(result.proxyPoolIndexByKey.get("ds1|proxy|FieldProxy3D|32x32x8|ch0")).toBe(1);
    expect(result.proxyPoolsByIndex.length).toBe(2);
    destroyDescriptorBuffer(result);
  });

  it("rebuild with same poolKeys → same pool indices", () => {
    const cold = makeCold([
      makeEntry({ entityId: "well-A", imageId: "", mode: "well-as-proxy" }),
    ]);
    const pool = fakePool([16, 64, 64]);
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("well-A", 0, 0), { fieldProxyHandle: null, wellProxyHandle: { poolKey: "ds1|proxy|WellProxy3D|64x64x16|ch0", slotIndex: 3 } }],
    ]);
    const proxyPoolsByDataset = new Map([
      ["ds1", new Map([["ds1|proxy|WellProxy3D|64x64x16|ch0", pool]])],
    ]);
    const { device } = makeMockDevice();
    const a = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, metasForCold(cold));
    const b = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, metasForCold(cold));
    expect(Array.from(a.proxyPoolIndexByKey.entries()))
      .toEqual(Array.from(b.proxyPoolIndexByKey.entries()));
    destroyDescriptorBuffer(a);
    destroyDescriptorBuffer(b);
  });
});

// ---------------------------------------------------------------------------
// Byte layout — must match the WGSL `EntityDescriptor` struct
// ---------------------------------------------------------------------------

describe("EntityDescriptor byte layout", () => {
  it("writes modelMatrix at offset 0 and invModelMatrix at offset 64", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const model = new Float32Array(16);
    const inv = new Float32Array(16);
    for (let i = 0; i < 16; i++) { model[i] = i + 1; inv[i] = i + 100; }
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail", modelMatrix: model, invModelMatrix: inv });
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), defaultDisplayState(), new Map(), new Map(), [], new Map());
    const f32 = new Float32Array(buf);
    for (let i = 0; i < 16; i++) {
      expect(f32[i]).toBe(model[i]);
      expect(f32[16 + i]).toBe(inv[i]);
    }
  });

  it("writes proxy fields at offsets 132/136/140/144 (sentinel when no descriptor)", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), defaultDisplayState(), new Map(), new Map(), [], new Map());
    const u32 = new Uint32Array(buf);
    expect(u32[33]).toBe(DESCRIPTOR_SENTINEL_INDEX);
    expect(u32[34]).toBe(DESCRIPTOR_SENTINEL_INDEX);
    expect(u32[35]).toBe(DESCRIPTOR_SENTINEL_INDEX);
    expect(u32[36]).toBe(DESCRIPTOR_SENTINEL_INDEX);
  });

  it("packs proxy pool/slot indices and slot dims when descriptor exists", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-proxy-fallback" });
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      ["e1", {
        fieldProxyHandle: { poolKey: "fp", slotIndex: 7 },
        wellProxyHandle: { poolKey: "wp", slotIndex: 3 },
      }],
    ]);
    const poolIdx = new Map([["fp", 0], ["wp", 1]]);
    const pools = [fakePool([8, 16, 32]), fakePool([4, 64, 128])];
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), defaultDisplayState(), proxyDesc, poolIdx, pools, new Map());
    const u32 = new Uint32Array(buf);
    expect(u32[33]).toBe(0);  // fieldProxyPoolIndex
    expect(u32[34]).toBe(7);  // fieldProxySlotIndex
    expect(u32[35]).toBe(1);  // wellProxyPoolIndex
    expect(u32[36]).toBe(3);  // wellProxySlotIndex
    // fieldProxyDims @ 160 = u32 idx 40, vec3 = (Z, Y, X)
    expect(u32[40]).toBe(8); expect(u32[41]).toBe(16); expect(u32[42]).toBe(32);
    // wellProxyDims @ 176 = u32 idx 44
    expect(u32[44]).toBe(4); expect(u32[45]).toBe(64); expect(u32[46]).toBe(128);
  });

  it("writes lodCount at offset 212 and lods array at offset 224", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
      detailOwnedLodRange: [0, 2],
      targetLod: 0,
      levels: [
        { level: 0, chunkShape: [1, 64, 64], gridShape: [1, 4, 4], levelDims: [1, 256, 256] },
        { level: 1, chunkShape: [1, 32, 32], gridShape: [1, 2, 2], levelDims: [1, 128, 128] },
        { level: 2, chunkShape: [1, 16, 16], gridShape: [1, 1, 1], levelDims: [1, 64, 64] },
      ],
    });
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), defaultDisplayState(), new Map(), new Map(), [], new Map());
    const u32 = new Uint32Array(buf);
    expect(u32[53]).toBe(3);  // lodCount @ 212

    // First LOD slot starts at byte 224 = u32 idx 56.
    const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4;
    expect(u32[lodsBaseU32 + 0]).toBe(0);     // level
    expect(u32[lodsBaseU32 + 1]).toBe(0);     // indirectionOffset
    // gridDims = (X, Y, Z) = (4, 4, 1)
    expect(u32[lodsBaseU32 + 4]).toBe(4);
    expect(u32[lodsBaseU32 + 5]).toBe(4);
    expect(u32[lodsBaseU32 + 6]).toBe(1);
    // chunkDims = (X, Y, Z) = (64, 64, 1)
    expect(u32[lodsBaseU32 + 8]).toBe(64);
    expect(u32[lodsBaseU32 + 9]).toBe(64);
    expect(u32[lodsBaseU32 + 10]).toBe(1);
    // levelDims = (X, Y, Z) = (256, 256, 1)
    expect(u32[lodsBaseU32 + 12]).toBe(256);
    expect(u32[lodsBaseU32 + 13]).toBe(256);
    expect(u32[lodsBaseU32 + 14]).toBe(1);

    // Second LOD slot at u32 idx 56 + 16
    const slot1 = lodsBaseU32 + DESCRIPTOR_LOD_INFO_SIZE / 4;
    expect(u32[slot1 + 0]).toBe(1);
    // indirectionOffset = previous LOD's gridX * gridY * gridZ = 4 * 4 * 1 = 16
    expect(u32[slot1 + 1]).toBe(16);
  });

  it("zero-fills unused LOD slots", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), defaultDisplayState(), new Map(), new Map(), [], new Map());
    const u32 = new Uint32Array(buf);
    const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4;
    for (let i = 1; i < DESCRIPTOR_MAX_LODS; i++) {
      const base = lodsBaseU32 + i * (DESCRIPTOR_LOD_INFO_SIZE / 4);
      for (let s = 0; s < DESCRIPTOR_LOD_INFO_SIZE / 4; s++) {
        expect(u32[base + s]).toBe(0);
      }
    }
  });

  it("writes explicit detail and coarse tier sources from matching lod metas", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
      detailLevel: 0,
      coarseLevel: 2,
      wantedLodLevels: [0, 2],
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
      ],
    });
    const metas: LodIndirectionMeta[] = [
      {
        level: 0,
        gridDims: [2, 4, 4],
        chunkDims: [32, 64, 64],
        levelDims: [64, 256, 256],
        offset: 5,
      },
      {
        level: 2,
        gridDims: [8, 2, 2],
        chunkDims: [8, 128, 128],
        levelDims: [64, 256, 256],
        offset: 37,
      },
    ];
    serializeEntityDescriptor(buf, 0, entry, metas, defaultDisplayState(), new Map(), new Map(), [], new Map());

    const u32 = new Uint32Array(buf);
    const detail = OFFSET_DETAIL_SOURCE / 4;
    const coarse = OFFSET_COARSE_SOURCE / 4;
    expect(u32[detail + SOURCE_OFFSET_VALID / 4]).toBe(1);
    expect(u32[detail + SOURCE_OFFSET_LEVEL / 4]).toBe(0);
    expect(u32[detail + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(5);
    expect(u32[detail + SOURCE_OFFSET_GRID_DIMS / 4 + 0]).toBe(4);
    expect(u32[detail + SOURCE_OFFSET_GRID_DIMS / 4 + 1]).toBe(4);
    expect(u32[detail + SOURCE_OFFSET_GRID_DIMS / 4 + 2]).toBe(2);
    expect(u32[detail + SOURCE_OFFSET_CHUNK_DIMS / 4 + 0]).toBe(64);
    expect(u32[detail + SOURCE_OFFSET_CHUNK_DIMS / 4 + 1]).toBe(64);
    expect(u32[detail + SOURCE_OFFSET_CHUNK_DIMS / 4 + 2]).toBe(32);
    expect(u32[detail + SOURCE_OFFSET_LEVEL_DIMS / 4 + 0]).toBe(256);
    expect(u32[detail + SOURCE_OFFSET_LEVEL_DIMS / 4 + 1]).toBe(256);
    expect(u32[detail + SOURCE_OFFSET_LEVEL_DIMS / 4 + 2]).toBe(64);

    expect(u32[coarse + SOURCE_OFFSET_VALID / 4]).toBe(1);
    expect(u32[coarse + SOURCE_OFFSET_LEVEL / 4]).toBe(2);
    expect(u32[coarse + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(37);
    expect(u32[coarse + SOURCE_OFFSET_GRID_DIMS / 4 + 0]).toBe(2);
    expect(u32[coarse + SOURCE_OFFSET_GRID_DIMS / 4 + 1]).toBe(2);
    expect(u32[coarse + SOURCE_OFFSET_GRID_DIMS / 4 + 2]).toBe(8);
    expect(u32[coarse + SOURCE_OFFSET_CHUNK_DIMS / 4 + 0]).toBe(128);
    expect(u32[coarse + SOURCE_OFFSET_CHUNK_DIMS / 4 + 1]).toBe(128);
    expect(u32[coarse + SOURCE_OFFSET_CHUNK_DIMS / 4 + 2]).toBe(8);
  });

  it("uses separate same-level metas for explicit detail and coarse tier sources", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({
      entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
      detailLevel: 1,
      coarseLevel: 1,
      wantedLodLevels: [1],
      levels: [
        { level: 1, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
      ],
    });
    const metas: LodIndirectionMeta[] = [
      {
        level: 1,
        gridDims: [2, 4, 4],
        chunkDims: [32, 64, 64],
        levelDims: [64, 256, 256],
        offset: 11,
      },
      {
        level: 1,
        gridDims: [2, 4, 4],
        chunkDims: [32, 64, 64],
        levelDims: [64, 256, 256],
        offset: 43,
      },
    ];
    serializeEntityDescriptor(buf, 0, entry, metas, defaultDisplayState(), new Map(), new Map(), [], new Map());

    const u32 = new Uint32Array(buf);
    const detail = OFFSET_DETAIL_SOURCE / 4;
    const coarse = OFFSET_COARSE_SOURCE / 4;
    expect(u32[detail + SOURCE_OFFSET_LEVEL / 4]).toBe(1);
    expect(u32[detail + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(11);
    expect(u32[coarse + SOURCE_OFFSET_LEVEL / 4]).toBe(1);
    expect(u32[coarse + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(43);
  });

  it("keeps tier sources invalid for legacy entries without detailLevel", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), defaultDisplayState(), new Map(), new Map(), [], new Map());
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < (2 * DESCRIPTOR_TIER_SOURCE_SIZE) / 4; i++) {
      expect(u32[OFFSET_DETAIL_SOURCE / 4 + i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Display state (contrast/gamma/opacity/colormap/channelMask)
// ---------------------------------------------------------------------------

describe("EntityDescriptor display state", () => {
  it("writes contrastMin/contrastMax/gamma/opacity at offsets 192..208", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    const displayState = {
      contrastMin: 100,
      contrastMax: 5000,
      gamma: 2.2,
      opacity: 0.7,
      colormapName: "viridis",
      channelMask: 1 << 3,
    };
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), displayState, new Map(), new Map(), [], new Map([["viridis", 5]]));
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    expect(f32[48]).toBe(100);     // contrastMin @ 192
    expect(f32[49]).toBe(5000);    // contrastMax @ 196
    expect(f32[50]).toBeCloseTo(2.2, 5); // gamma @ 200
    expect(f32[51]).toBeCloseTo(0.7, 5); // opacity @ 204
    expect(u32[52]).toBe(5);       // colormapLutIndex @ 208
    expect(u32[32]).toBe(1 << 3);  // channelMask @ 128
  });

  it("changes to displayState produce different bytes at the display-state offsets", () => {
    const buf1 = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const buf2 = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    const ds1 = { contrastMin: 0, contrastMax: 1, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 };
    const ds2 = { contrastMin: 50, contrastMax: 200, gamma: 1.5, opacity: 0.5, colormapName: "magma", channelMask: 1 };
    const lutIdx = new Map([["gray", 0], ["magma", 1]]);
    serializeEntityDescriptor(buf1, 0, entry, metasFromEntry(entry), ds1, new Map(), new Map(), [], lutIdx);
    serializeEntityDescriptor(buf2, 0, entry, metasFromEntry(entry), ds2, new Map(), new Map(), [], lutIdx);
    const f1 = new Float32Array(buf1);
    const f2 = new Float32Array(buf2);
    const u1 = new Uint32Array(buf1);
    const u2 = new Uint32Array(buf2);
    expect(f1[48]).not.toBe(f2[48]);
    expect(f1[49]).not.toBe(f2[49]);
    expect(f1[50]).not.toBe(f2[50]);
    expect(f1[51]).not.toBe(f2[51]);
    expect(u1[52]).not.toBe(u2[52]);
  });

  it("falls back to LUT index 0 when colormap is missing from the lookup", () => {
    const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" });
    const displayState = {
      contrastMin: 0, contrastMax: 1, gamma: 1, opacity: 1,
      colormapName: "unknown", channelMask: 1,
    };
    serializeEntityDescriptor(buf, 0, entry, metasFromEntry(entry), displayState, new Map(), new Map(), [], new Map());
    const u32 = new Uint32Array(buf);
    expect(u32[52]).toBe(0);
  });
});

describe("buildDescriptorBuffer colormap LUT assignment", () => {
  it("assigns dense indices to referenced colormap names in first-seen order", () => {
    const cold = makeCold([
      makeEntry({
        entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "magma" } },
      }),
      makeEntry({
        entityId: "e2", imageId: "img-1", mode: "fields-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "viridis" } },
      }),
      makeEntry({
        entityId: "e3", imageId: "img-2", mode: "fields-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "magma" } },
      }),
    ]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
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
        entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "magma" } },
      }),
      makeEntry({
        entityId: "e2", imageId: "img-1", mode: "fields-with-detail",
        displayStateByChannel: { 0: { ...defaultDisplayState(), colormapName: "viridis" } },
      }),
    ]);
    const { device } = makeMockDevice();
    const a = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
    const b = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
    expect(Array.from(a.colormapLutIndices.entries()))
      .toEqual(Array.from(b.colormapLutIndices.entries()));
    destroyDescriptorBuffer(a);
    destroyDescriptorBuffer(b);
  });

  it("multi-channel composite picks each channel's display state per descriptor entry", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
          displayStateByChannel: {
            0: { ...defaultDisplayState(), colormapName: "magenta", contrastMax: 1000 },
            1: { ...defaultDisplayState(), colormapName: "green",   contrastMax: 2000 },
          },
        }),
      ],
      [0, 1],
    );
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
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
          entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
          displayStateByChannel: {
            0: { ...defaultDisplayState(), colormapName: "magenta" },
            1: { ...defaultDisplayState(), colormapName: "green" },
          },
        }),
      ],
      [0, 1],
    );
    const ch0Pool = "ds1|proxy|FieldProxy3D|32x32x8|ch0";
    const ch1Pool = "ds1|proxy|FieldProxy3D|32x32x8|ch1";
    const proxyDesc = new Map<string, EntityProxyDescriptor>([
      [proxyDescriptorKey("e1", 0, 0), { fieldProxyHandle: { poolKey: ch0Pool, slotIndex: 1 }, wellProxyHandle: null }],
      [proxyDescriptorKey("e1", 0, 1), { fieldProxyHandle: { poolKey: ch1Pool, slotIndex: 2 }, wellProxyHandle: null }],
    ]);
    const proxyPoolsByDataset = new Map([
      ["ds1", new Map<string, ProxyAtlasState>([
        [ch0Pool, fakePool([8, 32, 32])],
        [ch1Pool, fakePool([8, 32, 32])],
      ])],
    ]);

    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, proxyDesc, proxyPoolsByDataset, new Map());

    expect(result.proxyDescriptorByMember.get("img-0:ch0")?.fieldProxyHandle?.poolKey).toBe(ch0Pool);
    expect(result.proxyDescriptorByMember.get("img-0:ch1")?.fieldProxyHandle?.poolKey).toBe(ch1Pool);
    expect(result.proxyPoolIndexByKey.get(ch0Pool)).toBe(0);
    expect(result.proxyPoolIndexByKey.get(ch1Pool)).toBe(1);
    destroyDescriptorBuffer(result);
  });

  it("channel mask packs a single bit per descriptor entry", () => {
    const cold = makeCold(
      [
        makeEntry({
          entityId: "e1", imageId: "img-0", mode: "fields-with-detail",
          displayStateByChannel: {
            0: { ...defaultDisplayState(), channelMask: 1 << 0 },
            2: { ...defaultDisplayState(), channelMask: 1 << 2 },
          },
        }),
      ],
      [0, 2],
    );
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
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
// Mode handling (well-as-proxy vs field modes)
// ---------------------------------------------------------------------------

describe("mode → memberId conventions", () => {
  it("well-as-proxy entries use entityId, field entries use imageId", () => {
    const cold = makeCold([
      makeEntry({ entityId: "well-A", imageId: "", mode: "well-as-proxy" }),
      makeEntry({ entityId: "field-1", imageId: "img-1", mode: "fields-with-proxy-fallback" }),
      makeEntry({ entityId: "field-2", imageId: "img-2", mode: "fields-with-detail" }),
    ]);
    const idx = computeMemberIndexMap(cold);
    expect(idx.has("well-A")).toBe(true);
    expect(idx.has("img-1")).toBe(true);
    expect(idx.has("img-2")).toBe(true);
  });

  it("buildDescriptorBuffer writes one entry per (entry, channel) combo", () => {
    const cold = makeCold(
      [
        makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
        makeEntry({ entityId: "well-A", imageId: "", mode: "well-as-proxy" }),
      ],
      [0, 1],
    );
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
    expect(result.entityCount).toBe(4);
    expect(result.indexByMember.get("img-0:ch0")).toBe(0);
    expect(result.indexByMember.get("img-0:ch1")).toBe(1);
    expect(result.indexByMember.get("well-A:ch0")).toBe(2);
    expect(result.indexByMember.get("well-A:ch1")).toBe(3);
    destroyDescriptorBuffer(result);
  });
});

// ---------------------------------------------------------------------------
// Buffer sizing + GPU write
// ---------------------------------------------------------------------------

describe("buildDescriptorBuffer GPU write", () => {
  it("creates a buffer sized to entityCount * DESCRIPTOR_ENTRY_SIZE", () => {
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "fields-with-detail" }),
    ]);
    const { device } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
    expect((result.buffer as unknown as MockBuffer).size).toBe(2 * DESCRIPTOR_ENTRY_SIZE);
    destroyDescriptorBuffer(result);
  });

  it("writes the assembled buffer to GPU memory", () => {
    const cold = makeCold([makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" })]);
    const { device, lastWrite } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), metasForCold(cold));
    const written = lastWrite();
    expect(written).not.toBeNull();
    expect(written!.byteLength).toBe(DESCRIPTOR_ENTRY_SIZE);
    destroyDescriptorBuffer(result);
  });

  it("each entity's lods[i].indirectionOffset comes from entityMetasByMember (shared-pool absolute offsets, not per-entity-local)", () => {
    // Regression: descriptor used to compute per-entity-local offsets
    // starting at 0, so every entity addressed offset 0 in the shared
    // pool indirection buffer = entity 0's data. Symptom in plate mode:
    // all fields rendered the same image, panning changed which.
    const cold = makeCold([
      makeEntry({ entityId: "e1", imageId: "img-0", mode: "fields-with-detail" }),
      makeEntry({ entityId: "e2", imageId: "img-1", mode: "fields-with-detail" }),
    ]);
    const entityMetas = new Map<string, LodIndirectionMeta[]>([
      ["img-0", [{
        level: 0, gridDims: [1, 4, 4], chunkDims: [1, 64, 64],
        levelDims: [1, 256, 256], offset: 0,
      }]],
      ["img-1", [{
        level: 0, gridDims: [1, 4, 4], chunkDims: [1, 64, 64],
        levelDims: [1, 256, 256], offset: 16, // entity 0 occupied [0, 16)
      }]],
    ]);
    const { device, lastWrite } = makeMockDevice();
    const result = buildDescriptorBuffer(device, cold, new Map(), new Map(), entityMetas);
    const written = lastWrite()!;
    const u32 = new Uint32Array(written);
    const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4;
    const entry0Lod0Offset = u32[lodsBaseU32 + 1];
    const entry1Lod0Offset = u32[(DESCRIPTOR_ENTRY_SIZE / 4) + lodsBaseU32 + 1];
    expect(entry0Lod0Offset).toBe(0);
    expect(entry1Lod0Offset).toBe(16);
    destroyDescriptorBuffer(result);
  });
});

// ---------------------------------------------------------------------------
// Transient ↔ canonical byte equivalence
// ---------------------------------------------------------------------------

describe("transient descriptor matches canonical for equivalent params", () => {
  it("agrees byte-for-byte on modelMatrix, invModelMatrix, display state, sentinel proxy handles, and the single LOD slot", () => {
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
    //   - single LOD, level=0, offset=0
    //   - gridDims=[1,1,1], chunkDims=levelDims=volumeDims
    //   - sentinel proxy handles (no proxy descriptor)
    //   - colormap absent → lutIdx = 0 (matches transient writer which
    //     skips colormapLutIndex entirely → buffer-init zero)
    //   - channelMask = 0 (transient writer doesn't write it)
    // `metasFromEntry` walks (entry.levels × entry.detailOwnedLodRange) in
    // X/Y/Z conventions that match `serializeEntityDescriptor` → the LOD
    // bytes line up with what the transient writer emits.
    const entry = makeEntry({
      entityId: "transient", imageId: "transient", mode: "fields-with-detail",
      modelMatrix, invModelMatrix,
      detailOwnedLodRange: [0, 0],
      targetLod: 0,
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
      canonicalBuf, 0, entry, metasFromEntry(entry),
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

    // lodCount at offset 212
    expect(cU32[53]).toBe(1);
    expect(tU32[53]).toBe(1);

    // First LOD slot — level / offset / gridDims / chunkDims / levelDims.
    const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4;
    for (let i = 0; i < DESCRIPTOR_LOD_INFO_SIZE / 4; i++) {
      expect(cU32[lodsBaseU32 + i]).toBe(tU32[lodsBaseU32 + i]);
    }

    // Remaining LOD slots zero-filled in both writers.
    for (let slot = 1; slot < DESCRIPTOR_MAX_LODS; slot++) {
      const base = lodsBaseU32 + slot * (DESCRIPTOR_LOD_INFO_SIZE / 4);
      for (let s = 0; s < DESCRIPTOR_LOD_INFO_SIZE / 4; s++) {
        expect(cU32[base + s]).toBe(tU32[base + s]);
        expect(cU32[base + s]).toBe(0);
      }
    }
  });
});
