/**
 * Suite A — cold-state ingestion characterization.
 *
 * Locks the behavior of `applyColdState`. Covers single + multi
 * channel volume cold state, mixed `tiles-with-detail` +
 * `group-as-proxy` entries, tiles sharing chunk dims, tiles with
 * different chunk dims, the multi-level sections the detail tier holds
 * under the target, slice mode with mixed levels + Z retargeting,
 * cold-state churn (replace), and empty active-set cold state.
 *
 * Mocks `WorkerCtx` + `GPUDevice` — no real GPU. The per-dataset atlas
 * Map lives on `ctx.state.{volumeAtlases, sliceAtlases}`, so each test
 * owns its own RendererState via `makeCtx()` and no module teardown is
 * required between cases.
 */

import { describe, it, expect, vi } from "vitest";

// Polyfill the GPU usage constants the production code reads at module
// scope. `volume/atlas` / `slice/atlas` reference `GPUTextureUsage.*` /
// `GPUBufferUsage.*` literals when allocating atlases.
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

import { applyColdState } from "./apply.ts";
import {
  proxyDescriptorKey,
  type WorkerCtx,
} from "../workerContext.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  ColdStateTileEntry,
  SliceChunkDataMessage,
  VolumeChunkDataMessage,
} from "../workerProtocol.ts";
import {
  allocateProxySlot,
  createProxyAtlas,
  proxyPoolKey,
  proxySlotKey,
} from "../proxyAtlas.ts";
import { createInitialState, type RendererState } from "../worker/state.ts";
import { findFarthestSlot, handleVolumeChunkData } from "../volume/index.ts";
import { handleSliceChunkData } from "../slice/index.ts";
import { sourceKey } from "../poolKeys.ts";

// ---------------------------------------------------------------------------
// Mock GPU device — texture + buffer creation only.
// ---------------------------------------------------------------------------

interface MockTexture { destroyed: boolean; destroy: () => void; size: GPUExtent3DStrict; format: GPUTextureFormat }
interface MockBuffer { destroyed: boolean; destroy: () => void; size: number; usage: number }

function makeMockDevice(): GPUDevice {
  const createTexture = vi.fn((desc: GPUTextureDescriptor): MockTexture => ({
    destroyed: false,
    destroy() { this.destroyed = true; },
    size: desc.size,
    format: desc.format,
  }));
  const createBuffer = vi.fn((desc: GPUBufferDescriptor): MockBuffer => ({
    destroyed: false,
    destroy() { this.destroyed = true; },
    size: desc.size,
    usage: desc.usage,
  }));
  const writeBuffer = vi.fn();
  const writeTexture = vi.fn();
  return {
    createTexture,
    createBuffer,
    queue: { writeBuffer, writeTexture } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

function makeCtx(device: GPUDevice): WorkerCtx {
  // Only `device` + `state` are actually used by applyColdState; the
  // rest can be stub no-ops since pool creation / descriptor build only
  // touch `ctx.device` and `ctx.state`.
  return {
    device,
    context: {} as GPUCanvasContext,
    format: "bgra8unorm",
    state: createInitialState(),
    getSliceRenderer: () => ({} as never),
    getVolumeRenderer: () => ({} as never),
    getCompositor: () => ({} as never),
    getCursorRenderer: () => ({} as never),
    ensureOffscreenPool: () => [],
    getOrCreateLUT: () => ({} as GPUTexture),
    post: () => {},
    postWantedSet: () => {},
    lookupProxyDescriptor: () => null,
    lookupProxyPool: () => null,
    lookupEntityDescriptor: () => null,
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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
  opts: Partial<Omit<ColdStateTileEntry, "kind" | "mode">> & {
    entityId: string;
    imageId: string;
    mode: ColdStateActiveEntry["mode"];
  },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    levels: opts.levels ?? [
      { level: 0, chunkShape: [32, 64, 64] as [number, number, number], gridShape: [2, 4, 4] as [number, number, number], levelDims: [64, 256, 256] as [number, number, number] },
    ],
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    groupProxyAvailable: opts.groupProxyAvailable ?? false,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
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
  opts?: Partial<ColdStateMessage>,
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
    datasetId: opts?.datasetId ?? "ds1",
    currentT: opts?.currentT ?? 0,
    currentZ: opts?.currentZ ?? 0,
    multiChannel: opts?.multiChannel ?? (opts?.visibleChannels?.length ?? 1) > 1,
    visibleChannels: opts?.visibleChannels ?? [0],
    visibleRegion: opts?.visibleRegion ?? {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    desiredProxyKeys: opts?.desiredProxyKeys,
    activeSet,
    viewMode: opts?.viewMode ?? "volume",
  };
}

function vol(state: RendererState) {
  return state.volumeAtlases;
}
function sli(state: RendererState) {
  return state.sliceAtlases;
}

/** Pool routing for one member's (tier, level) section. */
function poolOf(state: RendererState, memberId: string, tier: "detail" | "coarse", level: number) {
  return state.memberSourcePools.get(memberId)?.get(sourceKey(tier, level));
}

/**
 * A four-level halving volume pyramid in [Z, Y, X] with one chunk shape,
 * so every level lands in the same detail pool.
 */
const HALVING_PYRAMID: ColdStateTileEntry["levels"] = [
  { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
  { level: 1, chunkShape: [32, 32, 32], gridShape: [1, 2, 2], levelDims: [32, 64, 64] },
  { level: 2, chunkShape: [32, 32, 32], gridShape: [1, 1, 1], levelDims: [32, 32, 32] },
  { level: 3, chunkShape: [32, 32, 32], gridShape: [1, 1, 1], levelDims: [16, 16, 16] },
];

/**
 * Apply a cold state and make it the worker's current one, as the
 * dispatcher does, so the upload path's radius filter and the epoch
 * check see it.
 */
function ingest(ctx: WorkerCtx, activeSet: ColdStateActiveEntry[]): ColdStateMessage {
  const cold = makeCold(activeSet);
  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = cold.epochs;
  applyColdState(ctx, cold);
  return cold;
}

function mappedLevels(
  atlas: { slots: Map<string, number>; slotGridIdx: Int32Array },
  memberId: string,
): number[] {
  const levels = new Set<number>();
  for (const [key, slot] of atlas.slots) {
    if (atlas.slotGridIdx[slot] < 0) continue;
    const [member, chunkKey] = key.split("|");
    if (member !== memberId) continue;
    levels.add(Number(chunkKey.split("/")[0]));
  }
  return [...levels].sort((a, b) => a - b);
}

/** One 32³ uint16 chunk upload for `memberId` at `level`, grid cell (0,0,0). */
function chunkUpload(memberId: string, level: number): VolumeChunkDataMessage {
  const lm = HALVING_PYRAMID.find((l) => l.level === level)!;
  const [levelD, levelH, levelW] = lm.levelDims;
  const data = new Uint16Array(32 * 32 * 32);
  data.fill(level + 1);
  return {
    type: "volumeChunkData",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
    tier: "detail",
    memberId,
    chunks: [{ data: data.buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: `${level}/0/0/0/0/0` }],
    level,
    t: 0,
    c: 0,
    levelWidth: levelW,
    levelHeight: levelH,
    levelDepth: levelD,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 32,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Suite A — applyColdState", () => {
  // -------------------------------------------------------------------------
  // 1. Single-channel volume cold state
  // -------------------------------------------------------------------------
  it("single-channel volume → one pool group + correct entityMetas + indirection sized to gridX*gridY*gridZ", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, cold);

    // memberToDataset populated for the single member.
    expect(ctx.state.memberToDataset.get("imgA")).toBe("ds1");
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBe("ds1:64x64x32:detail");
    // One pool created.
    expect(vol(ctx.state).size).toBe(1);
    const atlas = vol(ctx.state).get("ds1:64x64x32:detail")!;
    expect(atlas).toBeTruthy();
    // entityMetas pinned on the atlas.
    expect(atlas.entityMetas.get("imgA")).toEqual([
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 64, 64], levelDims: [64, 256, 256], offset: 0 },
    ]);
    // Indirection sized to gridX*gridY*gridZ = 2*4*4 = 32.
    expect(atlas.indirectionData.length).toBe(32);
    // Snapshot captured for the dataset.
    expect(ctx.state.currentSourcesByDataset.get("ds1")?.get("imgA")).toHaveLength(1);
    // Descriptor buffer was built for the dataset.
    expect(ctx.state.descriptorBuffersByDataset.has("ds1")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Multi-channel volume cold state
  // -------------------------------------------------------------------------
  it("multi-channel volume → one pool group per channel + per-channel memberIds + per-channel pool keys", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
          levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
          displayStateByChannel: { 0: defaultDisplay(), 1: defaultDisplay(), 2: defaultDisplay() },
        }),
      ],
      { visibleChannels: [0, 1, 2] },
    );
    applyColdState(ctx, cold);

    // memberToDataset populated for each (entry, channel).
    expect(ctx.state.memberToDataset.get("imgA:ch0")).toBe("ds1");
    expect(ctx.state.memberToDataset.get("imgA:ch1")).toBe("ds1");
    expect(ctx.state.memberToDataset.get("imgA:ch2")).toBe("ds1");
    // Per-channel pool keys + memberIds.
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe("ds1:ch0:64x64x32:detail");
    expect(poolOf(ctx.state, "imgA:ch1", "detail", 0)).toBe("ds1:ch1:64x64x32:detail");
    expect(poolOf(ctx.state, "imgA:ch2", "detail", 0)).toBe("ds1:ch2:64x64x32:detail");
    // 3 pool atlases — one per channel.
    expect(vol(ctx.state).size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 3. Mixed `tiles-with-detail` + `group-as-proxy`
  // -------------------------------------------------------------------------
  it("mixed tiles + group-as-proxy → only tiles register a chunk pool; group registers in memberToDataset only", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "groupA", imageId: "", mode: "group-as-proxy",
        // group-as-proxy carries no levels[] because it has no chunks
        // to upload.
        levels: [],
      }),
    ]);
    applyColdState(ctx, cold);

    // Both entries land in memberToDataset (iterateColdMembers walks
    // both — group-as-proxy resolves to entityId).
    expect(ctx.state.memberToDataset.get("imgA")).toBe("ds1");
    expect(ctx.state.memberToDataset.get("groupA")).toBe("ds1");
    // Only the tile registers a pool (groupEntriesByPool skips
    // entries with no detail levels).
    expect(ctx.state.memberSourcePools.has("imgA")).toBe(true);
    expect(ctx.state.memberSourcePools.has("groupA")).toBe(false);
    expect(vol(ctx.state).size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Tiles sharing chunk dims → one pool
  // -------------------------------------------------------------------------
  it("two tiles with the same chunk dims → ONE pool group with sequential entityMetas offsets", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, cold);

    expect(vol(ctx.state).size).toBe(1);
    const atlas = vol(ctx.state).get("ds1:64x64x32:detail")!;
    // Both members live in the same pool.
    expect(atlas.entityMetas.size).toBe(2);
    // Sequential offsets: A starts at 0; B starts at 32 (= 2*4*4 from A).
    expect(atlas.entityMetas.get("imgA")?.[0].offset).toBe(0);
    expect(atlas.entityMetas.get("imgB")?.[0].offset).toBe(32);
    // Indirection sized to cover both: 64 entries.
    expect(atlas.indirectionData.length).toBe(64);
  });

  // -------------------------------------------------------------------------
  // 5. Tiles with different chunk dims → multiple pools per dataset
  // -------------------------------------------------------------------------
  it("two tiles with different chunk dims → TWO pool groups + separate entityMetas", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, cold);

    expect(vol(ctx.state).size).toBe(2);
    const a = vol(ctx.state).get("ds1:64x64x32:detail")!;
    const b = vol(ctx.state).get("ds1:32x32x16:detail")!;
    expect(a.entityMetas.get("imgA")).toBeTruthy();
    expect(a.entityMetas.has("imgB")).toBe(false);
    expect(b.entityMetas.get("imgB")).toBeTruthy();
    expect(b.entityMetas.has("imgA")).toBe(false);
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBe("ds1:64x64x32:detail");
    expect(poolOf(ctx.state, "imgB", "detail", 0)).toBe("ds1:32x32x16:detail");
  });

  it("source-backed detail and coarse levels get separate tier pools and descriptor sections", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        detailLevels: [0],
        coarseLevel: 2,
        levels: [
          { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
          { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
        ],
      }),
    ]);

    applyColdState(ctx, cold);

    // Level 2 is a coarser resident level of the detail tier AND the
    // coarse tier's level; the tiers keep separate pools at that shape.
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBe("ds1:64x64x32:detail");
    expect(poolOf(ctx.state, "imgA", "detail", 2)).toBe("ds1:128x128x8:detail");
    expect(poolOf(ctx.state, "imgA", "coarse", 2)).toBe("ds1:128x128x8:coarse");
    expect(vol(ctx.state).get("ds1:64x64x32:detail")?.entityMetas.get("imgA")?.[0]).toMatchObject({
      level: 0,
      chunkDims: [32, 64, 64],
      offset: 0,
    });
    expect(vol(ctx.state).get("ds1:128x128x8:coarse")?.entityMetas.get("imgA")?.[0]).toMatchObject({
      level: 2,
      chunkDims: [8, 128, 128],
      offset: 0,
    });
    const sources = ctx.state.currentSourcesByDataset.get("ds1")?.get("imgA") ?? [];
    expect(sources.map((s) => [s.tier, s.meta.level])).toEqual([
      ["detail", 0],
      ["detail", 2],
      ["coarse", 2],
    ]);
    // The draw binds both detail pools (finest first) and the coarse pool.
    expect(ctx.state.descriptorBuffersByDataset.get("ds1")?.sourceBindingByMember.get("imgA")).toEqual({
      levelPoolKeys: ["ds1:64x64x32:detail", "ds1:128x128x8:detail"],
      coarsePoolKey: "ds1:128x128x8:coarse",
    });
  });

  it("source-backed detail and coarse tiers stay separate when they share the same level", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        detailLevels: [1],
        coarseLevel: 1,
        levels: [
          { level: 1, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        ],
      }),
    ]);

    applyColdState(ctx, cold);

    expect(poolOf(ctx.state, "imgA", "detail", 1)).toBe("ds1:64x64x32:detail");
    expect(poolOf(ctx.state, "imgA", "coarse", 1)).toBe("ds1:64x64x32:coarse");
    expect(vol(ctx.state).get("ds1:64x64x32:detail")?.entityMetas.get("imgA")?.[0]).toMatchObject({
      level: 1,
      offset: 0,
    });
    expect(vol(ctx.state).get("ds1:64x64x32:coarse")?.entityMetas.get("imgA")?.[0]).toMatchObject({
      level: 1,
      offset: 0,
    });
    const sources = ctx.state.currentSourcesByDataset.get("ds1")?.get("imgA") ?? [];
    expect(sources.map((s) => [s.tier, s.meta.level])).toEqual([["detail", 1], ["coarse", 1]]);
  });

  // -------------------------------------------------------------------------
  // 6. Resident levels: the target and the coarser levels under it
  // -------------------------------------------------------------------------
  it("holds one section per level for the target and the next three coarser levels, none finer", () => {
    const ctx = makeCtx(makeMockDevice());
    const six: ColdStateTileEntry["levels"] = [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      chunkShape: [32, 32, 32],
      gridShape: [1, 1, 1],
      levelDims: [32, 32, 32],
    }));
    const cold = makeCold([
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [1], levels: six }),
    ]);
    applyColdState(ctx, cold);

    const atlas = vol(ctx.state).get("ds1:32x32x32:detail")!;
    expect(atlas.entityMetas.get("imgA")?.map((m) => [m.level, m.offset])).toEqual([
      [1, 0], [2, 1], [3, 2], [4, 3],
    ]);
    expect(atlas.indirectionData.length).toBe(4);
    for (const level of [1, 2, 3, 4]) {
      expect(poolOf(ctx.state, "imgA", "detail", level)).toBe("ds1:32x32x32:detail");
    }
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBeUndefined();
    expect(poolOf(ctx.state, "imgA", "detail", 5)).toBeUndefined();
    expect(ctx.state.descriptorBuffersByDataset.get("ds1")?.sourceBindingByMember.get("imgA")).toEqual({
      levelPoolKeys: ["ds1:32x32x32:detail"],
      coarsePoolKey: null,
    });
  });

  it("keeps coarser resident chunks mapped when the target moves finer, and unmaps them once they are finer than the target", () => {
    const ctx = makeCtx(makeMockDevice());
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [target], levels: HALVING_PYRAMID });

    // Target 2: sections for levels 2 and 3. A level-2 chunk arrives.
    const coldCoarse = makeCold([entryAt(2)]);
    ctx.state.currentColdState = coldCoarse;
    ctx.state.currentEpochs = coldCoarse.epochs;
    applyColdState(ctx, coldCoarse);
    const poolKey = poolOf(ctx.state, "imgA", "detail", 2)!;
    handleVolumeChunkData(ctx, chunkUpload("imgA", 2), coldCoarse.epochs, poolKey, "imgA");
    const atlas = vol(ctx.state).get(poolKey)!;
    const slot = atlas.slots.get("imgA|2/0/0/0/0/0");
    expect(slot).toBeDefined();
    expect(atlas.indirectionData[0]).toBe(slot);

    // Target 0: sections for 0..3. The resident level-2 chunk stays mapped
    // in level 2's section, so it fills the screen until level 0 arrives.
    const coldFine = makeCold([entryAt(0)]);
    ctx.state.currentColdState = coldFine;
    applyColdState(ctx, coldFine);
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBe(poolKey);
    const metas = atlas.entityMetas.get("imgA")!;
    expect(metas.map((m) => [m.level, m.offset])).toEqual([[0, 0], [1, 32], [2, 36], [3, 37]]);
    expect(atlas.indirectionData[36]).toBe(slot);
    expect(atlas.slotGridIdx[slot!]).toBe(36);

    // Target 3: level 2 is now finer than the target. Its chunk stays in
    // the pool but is unmapped, which makes it the first eviction victim.
    const coldCoarsest = makeCold([entryAt(3)]);
    ctx.state.currentColdState = coldCoarsest;
    applyColdState(ctx, coldCoarsest);
    expect(atlas.entityMetas.get("imgA")?.map((m) => m.level)).toEqual([3]);
    expect(atlas.slots.has("imgA|2/0/0/0/0/0")).toBe(true);
    expect(atlas.slotGridIdx[slot!]).toBe(-1);
    expect(findFarthestSlot(ctx.state, atlas)).toEqual({ key: "imgA|2/0/0/0/0/0", dist: Infinity });
  });

  it("records each member's target level for eviction, and drops it with the dataset", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [2], levels: HALVING_PYRAMID }),
      makeEntry({ entityId: "grp", imageId: "grp", mode: "group-as-proxy" }),
    ]);
    applyColdState(ctx, cold);
    expect(ctx.state.targetLevelByMember.get("imgA")).toBe(2);
    expect(ctx.state.targetLevelByMember.has("grp")).toBe(false);

    applyColdState(ctx, makeCold([
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [0], levels: HALVING_PYRAMID }),
    ]));
    expect(ctx.state.targetLevelByMember.get("imgA")).toBe(0);
  });

  // Pins the four-level bound from the eviction side. The bound itself is
  // the section allocation (`detailTierLevels`). A level outside the
  // resident levels has no section, so the upload path never maps it.
  it("maps at most four levels per entity; the level furthest from the target is the one that drops out", () => {
    const ctx = makeCtx(makeMockDevice());
    const six: ColdStateTileEntry["levels"] = [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      chunkShape: [32, 32, 32],
      gridShape: [1, 1, 1],
      levelDims: [32, 32, 32],
    }));
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [target], levels: six });
    const uploadAt = (level: number): VolumeChunkDataMessage => ({
      type: "volumeChunkData",
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
      tier: "detail",
      memberId: "imgA",
      chunks: [{ data: new Uint16Array(32 * 32 * 32).buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: `${level}/0/0/0/0/0` }],
      level, t: 0, c: 0,
      levelWidth: 32, levelHeight: 32, levelDepth: 32,
      chunkX: 32, chunkY: 32, chunkZ: 32,
    });

    const cold = ingest(ctx, [entryAt(1)]);
    const poolKey = poolOf(ctx.state, "imgA", "detail", 1)!;
    const atlas = vol(ctx.state).get(poolKey)!;
    for (const level of [0, 1, 2, 3, 4, 5]) {
      handleVolumeChunkData(ctx, uploadAt(level), cold.epochs, poolKey, "imgA");
    }
    expect([...atlas.slots.keys()].sort()).toEqual([1, 2, 3, 4].map((l) => `imgA|${l}/0/0/0/0/0`));
    expect(mappedLevels(atlas, "imgA")).toEqual([1, 2, 3, 4]);

    const coldMid = ingest(ctx, [entryAt(2)]);
    expect(mappedLevels(atlas, "imgA")).toEqual([2, 3, 4]);
    expect(findFarthestSlot(ctx.state, atlas)).toEqual({ key: "imgA|1/0/0/0/0/0", dist: Infinity });
    handleVolumeChunkData(ctx, uploadAt(5), coldMid.epochs, poolKey, "imgA");
    expect(mappedLevels(atlas, "imgA")).toEqual([2, 3, 4, 5]);

    // Back at target 1, level 1's resident chunk maps again without a
    // refetch, and level 5's stays resident but unmapped.
    ingest(ctx, [entryAt(1)]);
    expect(mappedLevels(atlas, "imgA")).toEqual([1, 2, 3, 4]);
    expect(atlas.slots.has("imgA|5/0/0/0/0/0")).toBe(true);
    expect(atlas.slotGridIdx[atlas.slots.get("imgA|5/0/0/0/0/0")!]).toBe(-1);
  });

  it("a coarser resident leaves only by distance after the target moves finer; the old target's chunks leave first after it moves coarser", () => {
    const ctx = makeCtx(makeMockDevice());
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [target], levels: HALVING_PYRAMID });
    const uploadAt = (level: number, z: number, y: number, x: number): VolumeChunkDataMessage => {
      const base = chunkUpload("imgA", level);
      return {
        ...base,
        chunks: [{ ...base.chunks[0], x, y, z, key: `${level}/0/0/${z}/${y}/${x}` }],
      };
    };
    ctx.state.rayHitPerEntity.set("imgA", [0, 0, 0]);

    const coldCoarse = ingest(ctx, [entryAt(2)]);
    const poolKey = poolOf(ctx.state, "imgA", "detail", 2)!;
    const atlas = vol(ctx.state).get(poolKey)!;
    atlas.freeSlots = [1, 0];
    handleVolumeChunkData(ctx, uploadAt(2, 0, 0, 0), coldCoarse.epochs, poolKey, "imgA");

    const coldFine = ingest(ctx, [entryAt(0)]);
    handleVolumeChunkData(ctx, uploadAt(0, 1, 3, 3), coldFine.epochs, poolKey, "imgA");
    expect(atlas.slots.size).toBe(2);

    // The far level-0 chunk goes, not the coarser resident nearer the view.
    handleVolumeChunkData(ctx, uploadAt(0, 0, 0, 0), coldFine.epochs, poolKey, "imgA");
    expect([...atlas.slots.keys()].sort()).toEqual(["imgA|0/0/0/0/0/0", "imgA|2/0/0/0/0/0"]);
    expect(atlas.slotGridIdx[atlas.slots.get("imgA|2/0/0/0/0/0")!]).toBeGreaterThanOrEqual(0);

    // Both residents are now finer than the target: the finest goes first.
    const coldCoarsest = ingest(ctx, [entryAt(3)]);
    handleVolumeChunkData(ctx, uploadAt(3, 0, 0, 0), coldCoarsest.epochs, poolKey, "imgA");
    expect([...atlas.slots.keys()].sort()).toEqual(["imgA|2/0/0/0/0/0", "imgA|3/0/0/0/0/0"]);
    expect(findFarthestSlot(ctx.state, atlas)).toEqual({ key: "imgA|2/0/0/0/0/0", dist: Infinity });
  });

  it("slice mode: a coarser level's plane stays mapped after the target moves finer, each level retargeting Z on its own depth", () => {
    // A pyramid downsampled along Z too: level 0 is 32 deep in two 16-deep
    // chunks, level 1 is 16 deep in one. At full-res Z = 20, level 0's
    // plane lives in chunk z=1 while level 1's lives in chunk z=0.
    const pyramid: ColdStateTileEntry["levels"] = [
      { level: 0, chunkShape: [16, 64, 64], gridShape: [2, 4, 4], levelDims: [32, 256, 256] },
      { level: 1, chunkShape: [16, 64, 64], gridShape: [1, 2, 2], levelDims: [16, 128, 128] },
    ];
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail", detailLevels: [target], levels: pyramid });
    const sliceUpload = (level: number, z: number): SliceChunkDataMessage => {
      const lm = pyramid.find((l) => l.level === level)!;
      const data = new Uint16Array(16 * 64 * 64).fill(level + 1);
      return {
        type: "sliceChunkData",
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
        tier: "detail",
        memberId: "imgA",
        chunks: [{ data: data.buffer, dataType: "uint16", x: 0, y: 0, z, key: `${level}/0/0/${z}/0/0` }],
        level, z, t: 0, c: 0,
        levelWidth: lm.levelDims[2], levelHeight: lm.levelDims[1],
        chunkX: 64, chunkY: 64, chunkZ: 16,
        fullResDepth: 32, levelDepth: lm.levelDims[0], fullResZ: 20,
      };
    };
    const ctx = makeCtx(makeMockDevice());

    // Target 1 at Z = 20: level 1's chunk z=0 arrives.
    const coldCoarse = makeCold([entryAt(1)], { viewMode: "slice", currentZ: 20 });
    ctx.state.currentColdState = coldCoarse;
    ctx.state.currentEpochs = coldCoarse.epochs;
    applyColdState(ctx, coldCoarse);
    const poolKey = poolOf(ctx.state, "imgA", "detail", 1)!;
    handleSliceChunkData(ctx, sliceUpload(1, 0), coldCoarse.epochs, poolKey, "imgA");
    const atlas = sli(ctx.state).get(poolKey)!;
    const slot1 = atlas.slots.get("imgA|1/0/0/0/0/0")!;
    expect(atlas.indirectionData[0]).toBe(slot1);

    // Target 0: level 1's plane stays mapped in its own section while
    // level 0 has nothing yet.
    const coldFine = makeCold([entryAt(0)], { viewMode: "slice", currentZ: 20 });
    ctx.state.currentColdState = coldFine;
    applyColdState(ctx, coldFine);
    const metas = atlas.entityMetas.get("imgA")!;
    expect(metas.map((m) => [m.level, m.offset])).toEqual([[0, 0], [1, 16]]);
    expect(atlas.indirectionData[16]).toBe(slot1);

    // Level 0's chunk for the same plane is z=1; both levels map at once,
    // each against its own chunk-Z target.
    handleSliceChunkData(ctx, sliceUpload(0, 1), coldFine.epochs, poolOf(ctx.state, "imgA", "detail", 0)!, "imgA");
    const slot0 = atlas.slots.get("imgA|0/0/0/1/0/0")!;
    applyColdState(ctx, coldFine);
    expect(atlas.indirectionData[0]).toBe(slot0);
    expect(atlas.indirectionData[16]).toBe(slot1);
  });

  // -------------------------------------------------------------------------
  // 7. Slice mode cold state
  // -------------------------------------------------------------------------
  it("slice mode → 2D pool key + one 2D section per resident level", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
          detailLevels: [0],
          levels: [
            { level: 0, chunkShape: [8, 128, 128], gridShape: [4, 2, 2], levelDims: [32, 256, 256] },
            { level: 1, chunkShape: [8, 128, 128], gridShape: [2, 1, 1], levelDims: [16, 128, 128] },
          ],
        }),
      ],
      { viewMode: "slice", currentZ: 0 },
    );
    applyColdState(ctx, cold);

    expect(sli(ctx.state).size).toBe(1);
    const atlas = sli(ctx.state).get("ds1:128x128:detail")!;
    expect(atlas).toBeTruthy();
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBe("ds1:128x128:detail");
    expect(poolOf(ctx.state, "imgA", "detail", 1)).toBe("ds1:128x128:detail");
    // 2D sections: level 0 is 2*2 = 4 entries, level 1 is 1*1 = 1 entry.
    const metas = atlas.entityMetas.get("imgA")!;
    expect(metas.map((m) => [m.level, m.offset])).toEqual([[0, 0], [1, 4]]);
    expect(atlas.indirectionData.length).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 8. Cold-state churn (replace)
  // -------------------------------------------------------------------------
  it("two cold states in a row → pool routing is repopulated; descriptor buffer is destroyed + replaced", () => {
    const ctx = makeCtx(makeMockDevice());
    const coldA = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, coldA);
    const descA = ctx.state.descriptorBuffersByDataset.get("ds1")!;
    const descABuffer = descA.buffer as unknown as MockBuffer;
    expect(poolOf(ctx.state, "imgA", "detail", 0)).toBe("ds1:64x64x32:detail");

    // Second cold state — different active set.
    const coldB = makeCold([
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, coldB);
    // Routing for B is set.
    expect(poolOf(ctx.state, "imgB", "detail", 0)).toBe("ds1:32x32x16:detail");
    // Old descriptor buffer was destroyed (the new one replaces it).
    expect(descABuffer.destroyed).toBe(true);
    // A new descriptor buffer was written.
    const descB = ctx.state.descriptorBuffersByDataset.get("ds1")!;
    expect(descB).not.toBe(descA);
    // Stale routing for A is cleared before B is registered.
    expect(ctx.state.memberSourcePools.has("imgA")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 9. Empty active-set cold state
  // -------------------------------------------------------------------------
  it("empty active set → no pools, no panics, empty descriptor buffer still created", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([]);
    expect(() => applyColdState(ctx, cold)).not.toThrow();
    // No pools.
    expect(vol(ctx.state).size).toBe(0);
    // No routing entries.
    expect(ctx.state.memberSourcePools.size).toBe(0);
    // No memberToDataset entries (iterateColdMembers yields nothing).
    expect(ctx.state.memberToDataset.size).toBe(0);
    // Snapshot recorded (empty) for the dataset.
    expect(ctx.state.currentSourcesByDataset.get("ds1")?.size).toBe(0);
    // Descriptor buffer was still built (empty buffer is fine — the
    // build path always runs).
    expect(ctx.state.descriptorBuffersByDataset.has("ds1")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Bonus: group→tiles fan-out gets populated from parentGroupId
  // -------------------------------------------------------------------------
  it("populates groupToTiles from entries' parentGroupId", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "tile1", imageId: "img1", mode: "tiles-with-detail",
        parentGroupId: "groupA",
      }),
      makeEntry({
        entityId: "tile2", imageId: "img2", mode: "tiles-with-detail",
        parentGroupId: "groupA",
      }),
      makeEntry({
        entityId: "tile3", imageId: "img3", mode: "tiles-with-detail",
        parentGroupId: "groupB",
      }),
    ]);
    applyColdState(ctx, cold);
    expect(ctx.state.groupToTiles.get("groupA")).toEqual(new Set(["tile1", "tile2"]));
    expect(ctx.state.groupToTiles.get("groupB")).toEqual(new Set(["tile3"]));
    // groupsByDataset tracks which groups came from this dataset so
    // removeLayerResources can clear them cheaply.
    expect(ctx.state.groupsByDataset.get("ds1")).toEqual(new Set(["groupA", "groupB"]));
  });

  it("reconciles resident proxies against desiredProxyKeys before rebuilding descriptors", () => {
    const device = makeMockDevice();
    const ctx = makeCtx(device);
    const poolKey = proxyPoolKey("ds1", "TileProxy3D", [8, 8, 8], 0);
    const pool = createProxyAtlas(device, "TileProxy3D", [8, 8, 8], 0, 4);
    const slotIndex = allocateProxySlot(pool, proxySlotKey("tile1", 0, 0));
    ctx.state.proxyPoolsByDataset.set("ds1", new Map([[poolKey, pool]]));
    ctx.state.proxyDescriptorsByEntity.set(proxyDescriptorKey("tile1", 0, 0), {
      tileProxyHandle: { poolKey, slotIndex },
      groupProxyHandle: null,
    });

    const cold = makeCold(
      [
        makeEntry({
          entityId: "tile1", imageId: "img1", mode: "tiles-with-detail",
          proxyKind: "TileProxy3D",
          proxyAvailable: true,
        }),
      ],
      { desiredProxyKeys: [] },
    );
    applyColdState(ctx, cold);

    expect(pool.slots.has(proxySlotKey("tile1", 0, 0))).toBe(false);
    expect(pool.freeSlots).toContain(slotIndex);
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("tile1", 0, 0))!.tileProxyHandle,
    ).toBeNull();
    expect(ctx.state.descriptorBuffersByDataset.has("ds1")).toBe(true);
  });
});
