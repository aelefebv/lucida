/**
 * Suite A — cold-state ingestion characterization.
 *
 * Locks the behavior of `applyColdState`. Covers single + multi
 * channel volume cold state, mixed `tiles-with-detail` +
 * `group-as-proxy` entries, tiles sharing chunk dims, tiles with
 * different chunk dims, slice mode with mixed LODs + Z retargeting,
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
} from "../workerProtocol.ts";
import {
  allocateProxySlot,
  createProxyAtlas,
  proxyPoolKey,
  proxySlotKey,
} from "../proxyAtlas.ts";
import { createInitialState, type RendererState } from "../worker/state.ts";

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
    getDummyTexture: () => ({} as GPUTexture),
    getDummy3DTexture: () => ({} as GPUTexture),
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
    // memberToPool preserves the legacy detail alias; memberTierToPool is
    // the canonical tier-aware routing table.
    expect(ctx.state.memberToPool.get("imgA")).toBe("ds1:64x64x32:detail");
    expect(ctx.state.memberTierToPool.get("imgA|detail")).toBe("ds1:64x64x32:detail");
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
    expect(ctx.state.currentEntityMetasByDataset.get("ds1")?.get("imgA")).toHaveLength(1);
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
    expect(ctx.state.memberToPool.get("imgA:ch0")).toBe("ds1:ch0:64x64x32:detail");
    expect(ctx.state.memberToPool.get("imgA:ch1")).toBe("ds1:ch1:64x64x32:detail");
    expect(ctx.state.memberToPool.get("imgA:ch2")).toBe("ds1:ch2:64x64x32:detail");
    expect(ctx.state.memberTierToPool.get("imgA:ch2|detail")).toBe("ds1:ch2:64x64x32:detail");
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
    // entries with no targetLevel).
    expect(ctx.state.memberToPool.has("imgA")).toBe(true);
    expect(ctx.state.memberToPool.has("groupA")).toBe(false);
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
    expect(ctx.state.memberToPool.get("imgA")).toBe("ds1:64x64x32:detail");
    expect(ctx.state.memberToPool.get("imgB")).toBe("ds1:32x32x16:detail");
  });

  it("source-backed detail and coarse levels get separate tier pools and descriptor metas", () => {
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

    expect(ctx.state.memberTierToPool.get("imgA|detail")).toBe("ds1:64x64x32:detail");
    expect(ctx.state.memberTierToPool.get("imgA|coarse")).toBe("ds1:128x128x8:coarse");
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
    expect(ctx.state.currentEntityMetasByDataset.get("ds1")?.get("imgA")?.map((m) => m.level)).toEqual([0, 2]);
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

    expect(ctx.state.memberTierToPool.get("imgA|detail")).toBe("ds1:64x64x32:detail");
    expect(ctx.state.memberTierToPool.get("imgA|coarse")).toBe("ds1:64x64x32:coarse");
    expect(vol(ctx.state).get("ds1:64x64x32:detail")?.entityMetas.get("imgA")?.[0]).toMatchObject({
      level: 1,
      offset: 0,
    });
    expect(vol(ctx.state).get("ds1:64x64x32:coarse")?.entityMetas.get("imgA")?.[0]).toMatchObject({
      level: 1,
      offset: 0,
    });
    expect(ctx.state.currentEntityMetasByDataset.get("ds1")?.get("imgA")?.map((m) => m.level)).toEqual([1, 1]);
  });

  // -------------------------------------------------------------------------
  // 6. Slice mode cold state
  // -------------------------------------------------------------------------
  it("slice mode → 2D pool key + entityMetas computed for 2D indirection", () => {
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
    expect(ctx.state.memberToPool.get("imgA")).toBe("ds1:128x128:detail");
    const metas = atlas.entityMetas.get("imgA")!;
    expect(metas).toHaveLength(1);
    expect(metas[0].offset).toBe(0);
    expect(atlas.indirectionData.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 7. Cold-state churn (replace)
  // -------------------------------------------------------------------------
  it("two cold states in a row → memberToPool is repopulated; descriptor buffer is destroyed + replaced", () => {
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
    expect(ctx.state.memberToPool.get("imgA")).toBe("ds1:64x64x32:detail");

    // Second cold state — different active set.
    const coldB = makeCold([
      makeEntry({
        entityId: "imgB", imageId: "imgB", mode: "tiles-with-detail",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, coldB);
    // memberToPool for B is set.
    expect(ctx.state.memberToPool.get("imgB")).toBe("ds1:32x32x16:detail");
    // Old descriptor buffer was destroyed (the new one replaces it).
    expect(descABuffer.destroyed).toBe(true);
    // A new descriptor buffer was written.
    const descB = ctx.state.descriptorBuffersByDataset.get("ds1")!;
    expect(descB).not.toBe(descA);
    // Stale routing for A is cleared before B is registered.
    expect(ctx.state.memberToPool.has("imgA")).toBe(false);
    expect(ctx.state.memberTierToPool.has("imgA|detail")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. Empty active-set cold state
  // -------------------------------------------------------------------------
  it("empty active set → no pools, no panics, empty descriptor buffer still created", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([]);
    expect(() => applyColdState(ctx, cold)).not.toThrow();
    // No pools.
    expect(vol(ctx.state).size).toBe(0);
    // No memberToPool entries.
    expect(ctx.state.memberToPool.size).toBe(0);
    // No memberToDataset entries (iterateColdMembers yields nothing).
    expect(ctx.state.memberToDataset.size).toBe(0);
    // Snapshot recorded (empty) for the dataset.
    expect(ctx.state.currentEntityMetasByDataset.get("ds1")?.size).toBe(0);
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
