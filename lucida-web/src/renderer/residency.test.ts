import { describe, it, expect } from "vitest";
import { remapIndirection, applyViewHotState, getRayHitForMember, type AtlasState, type LodIndirectionMeta } from "./volume/index.ts";
import { parseChunkKey } from "./chunkKeys.ts";
import { remapSliceIndirection, type SliceAtlasState } from "./slice/index.ts";
import type { ViewHotStateMessage } from "./workerProtocol.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { createInitialState } from "./worker/state.ts";

/** Build a minimal ctx whose only populated tile is `state`. The
 * applyViewHotState handler only touches `ctx.state.rayHitPerEntity`. */
function makeStubCtx(): WorkerCtx {
  return { state: createInitialState() } as unknown as WorkerCtx;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AtlasState for testing (no GPU resources). */
function makeVolumeAtlas(overrides?: Partial<AtlasState> & { defaultMember?: string }): AtlasState {
  const gridX = 4, gridY = 4, gridZ = 2;
  const totalSlots = 32;
  const defaultMember = overrides?.defaultMember ?? "memA";
  const entityMetas: Map<string, LodIndirectionMeta[]> = overrides?.entityMetas ?? new Map([
    [defaultMember, [{
      level: 0, gridDims: [gridZ, gridY, gridX], chunkDims: [32, 32, 32],
      levelDims: [64, 128, 128], offset: 0,
    }]],
  ]);
  let totalIndirection = 0;
  for (const metas of entityMetas.values()) {
    for (const m of metas) totalIndirection += m.gridDims[0] * m.gridDims[1] * m.gridDims[2];
  }
  return {
    texture: null as unknown as GPUTexture,
    indirectionBuf: null as unknown as GPUBuffer,
    indirectionData: new Uint32Array(Math.max(totalIndirection, 1)).fill(0xFFFFFFFF),
    slots: new Map(),
    slotGridIdx: new Int32Array(totalSlots).fill(-1),
    freeSlots: [],
    totalSlots,
    chunkX: 32, chunkY: 32, chunkZ: 32,
    slotsX: 4, slotsY: 4, slotsZ: 2,
    entityMetas,
    t: 0, c: 0,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: false,
    ...overrides,
  };
}

/** Create a minimal SliceAtlasState for testing (no GPU resources). */
function makeSliceAtlas(overrides?: Partial<SliceAtlasState> & { defaultMember?: string; entityZInfo?: SliceAtlasState["entityZInfo"] }): SliceAtlasState {
  const totalSlots = 16;
  const defaultMember = overrides?.defaultMember ?? "memA";
  const entityMetas: Map<string, LodIndirectionMeta[]> = overrides?.entityMetas ?? new Map([
    [defaultMember, [{
      level: 0, gridDims: [1, 4, 4], chunkDims: [32, 32, 32],
      levelDims: [64, 128, 128], offset: 0,
    }]],
  ]);
  let totalIndirection = 0;
  for (const metas of entityMetas.values()) {
    for (const m of metas) totalIndirection += m.gridDims[1] * m.gridDims[2];
  }
  const entityZInfo = overrides?.entityZInfo ?? new Map([
    [defaultMember, { chunkZ: 32, fullResDepth: 64, levelDepth: 64 }],
  ]);
  return {
    texture: null as unknown as GPUTexture,
    indirectionBuf: null as unknown as GPUBuffer,
    indirectionData: new Uint32Array(Math.max(totalIndirection, 1)).fill(0xFFFFFFFF),
    slots: new Map(),
    slotGridIdx: new Int32Array(totalSlots).fill(-1),
    freeSlots: [],
    totalSlots,
    chunkX: 32, chunkY: 32,
    slotsX: 4, slotsY: 4,
    entityMetas,
    entityZInfo,
    z: 0, t: 0, c: 0,
    staleSliceKeys: null,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: false,
    ...overrides,
  };
}

/** Insert a fake chunk into a shared-pool slice atlas's slots map (composite key). */
function insertSliceChunk(atlas: { slots: Map<string, number> }, level: number, t: number, c: number, z: number, y: number, x: number, slotIndex: number, memberId: string = "memA") {
  atlas.slots.set(`${memberId}|${level}/${t}/${c}/${z}/${y}/${x}`, slotIndex);
}

/** Insert a fake chunk into a shared-pool atlas's slots map (composite key). */
function insertChunk(atlas: { slots: Map<string, number> }, level: number, t: number, c: number, z: number, y: number, x: number, slotIndex: number, memberId: string = "memA") {
  atlas.slots.set(`${memberId}|${level}/${t}/${c}/${z}/${y}/${x}`, slotIndex);
}

// ---------------------------------------------------------------------------
// parseChunkKey
// ---------------------------------------------------------------------------

describe("parseChunkKey", () => {
  it("parses valid key", () => {
    expect(parseChunkKey("2/5/1/3/4/7")).toEqual({ level: 2, t: 5, c: 1, z: 3, y: 4, x: 7 });
  });

  it("returns null for invalid key", () => {
    expect(parseChunkKey("bad")).toBeNull();
    expect(parseChunkKey("1/2/3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remapIndirection (volume)
// ---------------------------------------------------------------------------

describe("remapIndirection (volume)", () => {
  it("maps only chunks matching current T", () => {
    const atlas = makeVolumeAtlas();
    insertChunk(atlas, 0, 5, 0, 0, 1, 2, 10);  // T=5
    insertChunk(atlas, 0, 6, 0, 0, 2, 3, 11);  // T=6

    remapIndirection(atlas, 5, 0);

    // T=5 chunk should be mapped
    const gridIdx5 = 0 * 4 * 4 + 1 * 4 + 2;
    expect(atlas.indirectionData[gridIdx5]).toBe(10);

    // T=6 chunk should NOT be mapped
    const gridIdx6 = 0 * 4 * 4 + 2 * 4 + 3;
    expect(atlas.indirectionData[gridIdx6]).toBe(0xFFFFFFFF);

    expect(atlas.indirectionDirty).toBe(true);
  });

  it("maps only chunks matching current C", () => {
    const atlas = makeVolumeAtlas();
    insertChunk(atlas, 0, 0, 0, 0, 0, 0, 1);  // C=0
    insertChunk(atlas, 0, 0, 2, 0, 1, 0, 2);  // C=2

    remapIndirection(atlas, 0, 0);

    expect(atlas.indirectionData[0]).toBe(1);  // C=0 mapped
    const gridIdx2 = 0 * 4 * 4 + 1 * 4 + 0;
    expect(atlas.indirectionData[gridIdx2]).toBe(0xFFFFFFFF);  // C=2 not mapped
  });

  it("maps only chunks matching detail levels", () => {
    const atlas = makeVolumeAtlas();
    insertChunk(atlas, 0, 0, 0, 0, 0, 0, 1);  // LOD 0
    insertChunk(atlas, 1, 0, 0, 0, 0, 1, 2);  // LOD 1

    remapIndirection(atlas, 0, 0);

    expect(atlas.indirectionData[0]).toBe(1);     // LOD 0 mapped
    expect(atlas.indirectionData[1]).toBe(0xFFFFFFFF);  // LOD 1 not mapped
  });

  it("switch-back: T=5 → T=6 → T=5 remaps cached chunks instantly", () => {
    const atlas = makeVolumeAtlas();
    insertChunk(atlas, 0, 5, 0, 0, 0, 0, 10);
    insertChunk(atlas, 0, 6, 0, 0, 0, 0, 11);

    // Remap to T=6
    remapIndirection(atlas, 6, 0);
    expect(atlas.indirectionData[0]).toBe(11);

    // Switch back to T=5
    remapIndirection(atlas, 5, 0);
    expect(atlas.indirectionData[0]).toBe(10);  // T=5 chunk still in atlas
  });

  it("empty atlas produces all-sentinel indirection", () => {
    const atlas = makeVolumeAtlas();
    remapIndirection(atlas, 0, 0);
    for (let i = 0; i < atlas.indirectionData.length; i++) {
      expect(atlas.indirectionData[i]).toBe(0xFFFFFFFF);
    }
  });
});

// ---------------------------------------------------------------------------
// remapSliceIndirection
// ---------------------------------------------------------------------------

describe("remapSliceIndirection", () => {
  it("maps only chunks matching current T and Z", () => {
    const atlas = makeSliceAtlas({ z: 16 }); // full-res Z = 16
    // chunkZ=32, fullResDepth=64, levelDepth=64 → levelZ=16, targetChunkZ=0
    insertSliceChunk(atlas, 0, 5, 0, 0, 1, 2, 3);  // T=5, Z=0
    insertSliceChunk(atlas, 0, 6, 0, 0, 1, 2, 4);  // T=6, Z=0
    insertSliceChunk(atlas, 0, 5, 0, 1, 1, 2, 5);  // T=5, Z=1 (wrong Z)

    remapSliceIndirection(atlas, 5, 0, 16);

    const gridIdx = 1 * 4 + 2;
    expect(atlas.indirectionData[gridIdx]).toBe(3);  // T=5, Z=0 mapped

    expect(atlas.indirectionDirty).toBe(true);
  });

  it("switch-back: Z=16 → Z=48 → Z=16 remaps cached chunks", () => {
    const atlas = makeSliceAtlas();
    // chunkZ=32 → Z=16 maps to chunkZ=0, Z=48 maps to chunkZ=1
    insertSliceChunk(atlas, 0, 0, 0, 0, 0, 0, 1);  // Z chunk 0
    insertSliceChunk(atlas, 0, 0, 0, 1, 0, 0, 2);  // Z chunk 1

    remapSliceIndirection(atlas, 0, 0, 48);
    expect(atlas.indirectionData[0]).toBe(2);  // Z chunk 1 mapped

    remapSliceIndirection(atlas, 0, 0, 16);
    expect(atlas.indirectionData[0]).toBe(1);  // Z chunk 0 still in atlas
  });

  it("no Z metadata → Z filter skipped → chunks still map", () => {
    // Empty entityZInfo means computeTargetChunkZ returns null → Z filter is skipped
    const atlas = makeSliceAtlas({ entityZInfo: new Map() });
    insertSliceChunk(atlas, 0, 0, 0, 0, 0, 0, 1);

    remapSliceIndirection(atlas, 0, 0, 0);
    expect(atlas.indirectionData[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Shared volume pool — multi-entity tests
// ---------------------------------------------------------------------------

describe("remapIndirection (shared volume pool)", () => {
  it("two entities with same grid coords don't collide (composite keys)", () => {
    // Pool with two entities, each having a single LOD section
    const gridX = 2, gridY = 2, gridZ = 1;
    const sectionSize = gridX * gridY * gridZ; // 4
    const entityMetas = new Map<string, LodIndirectionMeta[]>([
      ["entA", [{
        level: 0, gridDims: [gridZ, gridY, gridX], chunkDims: [32, 32, 32],
        levelDims: [32, 64, 64], offset: 0,
      }]],
      ["entB", [{
        level: 0, gridDims: [gridZ, gridY, gridX], chunkDims: [32, 32, 32],
        levelDims: [32, 64, 64], offset: sectionSize,
      }]],
    ]);
    const atlas = makeVolumeAtlas({ entityMetas });

    // Both entities have a chunk at grid (0,0,0) — same chunkKey but different memberId
    insertChunk(atlas, 0, 0, 0, 0, 0, 0, 5, "entA");
    insertChunk(atlas, 0, 0, 0, 0, 0, 0, 7, "entB");

    remapIndirection(atlas, 0, 0);

    // entA's chunk goes to its section (offset 0)
    expect(atlas.indirectionData[0]).toBe(5);
    // entB's chunk goes to its section (offset 4)
    expect(atlas.indirectionData[sectionSize]).toBe(7);
  });

  it("entity removed from active set: its slots are unmapped (skipped in remap)", () => {
    const gridX = 2, gridY = 2, gridZ = 1;
    const entityMetas = new Map<string, LodIndirectionMeta[]>([
      ["entA", [{
        level: 0, gridDims: [gridZ, gridY, gridX], chunkDims: [32, 32, 32],
        levelDims: [32, 64, 64], offset: 0,
      }]],
    ]);
    const atlas = makeVolumeAtlas({ entityMetas });

    // Insert chunks for entA (in active set) and entC (not in active set)
    insertChunk(atlas, 0, 0, 0, 0, 0, 0, 1, "entA");
    insertChunk(atlas, 0, 0, 0, 0, 0, 0, 2, "entC");

    remapIndirection(atlas, 0, 0);

    // entA mapped, entC skipped (no entityMeta)
    expect(atlas.indirectionData[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyViewHotState (rayHitPerEntity population)
// ---------------------------------------------------------------------------

describe("applyViewHotState", () => {
  function makeMsg(
    rayHitsByEntity: Array<[string, [number, number, number]]>,
  ): ViewHotStateMessage {
    return {
      type: "viewHotState",
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
      datasetId: "ds1",
      rayHitsByEntity,
    };
  }

  it("populates rayHitPerEntity for each entry", () => {
    const ctx = makeStubCtx();
    applyViewHotState(ctx, makeMsg([
      ["m3-entA", [0.1, 0.2, 0.3]],
      ["m3-entB", [0.4, 0.5, 0.6]],
    ]));
    expect(getRayHitForMember(ctx.state, "m3-entA")).toEqual([0.1, 0.2, 0.3]);
    expect(getRayHitForMember(ctx.state, "m3-entB")).toEqual([0.4, 0.5, 0.6]);
  });

  it("latest message wins for the same entity (idempotent overwrite)", () => {
    const ctx = makeStubCtx();
    applyViewHotState(ctx, makeMsg([["m3-entC", [0.1, 0.1, 0.1]]]));
    applyViewHotState(ctx, makeMsg([["m3-entC", [0.9, 0.9, 0.9]]]));
    expect(getRayHitForMember(ctx.state, "m3-entC")).toEqual([0.9, 0.9, 0.9]);
  });

  it("supports multi-channel composite memberId keying (imageId:chN)", () => {
    const ctx = makeStubCtx();
    applyViewHotState(ctx, makeMsg([
      ["m3-img:ch0", [0.2, 0.2, 0.2]],
      ["m3-img:ch1", [0.7, 0.7, 0.7]],
    ]));
    expect(getRayHitForMember(ctx.state, "m3-img:ch0")).toEqual([0.2, 0.2, 0.2]);
    expect(getRayHitForMember(ctx.state, "m3-img:ch1")).toEqual([0.7, 0.7, 0.7]);
  });

  it("entries not yet seen return undefined (handlers fall back to [0.5,0.5,0.5])", () => {
    const ctx = makeStubCtx();
    expect(getRayHitForMember(ctx.state, "m3-never-seen")).toBeUndefined();
  });
});
