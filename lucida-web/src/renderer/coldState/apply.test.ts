/**
 * Suite A: cold-state ingestion characterization. Locks the behavior of
 * `applyColdState`.
 *
 * Mocks `WorkerCtx` and `GPUDevice`, no real GPU. Each test owns its own
 * RendererState via `makeCtx()`, so no teardown is needed between cases.
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
import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  SliceChunkDataMessage,
  VolumeChunkDataMessage,
} from "../workerProtocol.ts";
import { createInitialState, type RendererState, type ViewDraw } from "../worker/state.ts";
import { drawsOf } from "../worker/draws.ts";
import type { SharedChunkPool } from "../viewIndirection.ts";
import { viewOf } from "../viewIndirectionFixtures.ts";
import { UNTIMED } from "../passTiming.ts";
import { findEvictionSlot, handleVolumeChunkData } from "../volume/index.ts";
import { handleSliceChunkData } from "../slice/index.ts";
import { sourceKey } from "../poolKeys.ts";
import { wantedEntryKey } from "../wantedChunks.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import type { ResidencyTier } from "../../pipeline/residencyTier.ts";

// Mock GPU device — texture + buffer creation only.

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
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve(null)),
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
    passTimer: UNTIMED,
    getSliceRenderer: () => ({} as never),
    getVolumeRenderer: () => ({} as never),
    getCompositor: () => ({} as never),
    getCursorRenderer: () => ({} as never),
    getViewLander: () => ({} as never),
    ensureOffscreenPool: () => [],
    getOrCreateLUT: () => ({} as GPUTexture),
    post: () => {},
    postWantedSet: () => {},
    lookupEntityDescriptor: () => null,
  };
}

// Fixture helpers

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
  opts: Partial<ColdStateActiveEntry> & { entityId: string; imageId: string },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    levels: opts.levels ?? [
      { level: 0, chunkShape: [32, 64, 64] as [number, number, number], gridShape: [2, 4, 4] as [number, number, number], levelDims: [64, 256, 256] as [number, number, number] },
    ],
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
  return {
    ...base,
    imageId: opts.imageId,
    detailLevels: opts.detailLevels ?? [0],
    coarseLevel: opts.coarseLevel ?? null,
  };
}

function makeCold(
  activeSet: ColdStateActiveEntry[],
  opts?: Partial<ColdStateMessage>,
): ColdStateMessage {
  return {
    type: "coldState",
    labels: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 0 },
    datasetId: opts?.datasetId ?? "ds1",
    currentT: opts?.currentT ?? 0,
    currentZ: opts?.currentZ ?? 0,
    visibleChannels: opts?.visibleChannels ?? [0],
    visibleRegion: opts?.visibleRegion ?? {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    wantedChunks: [],
    activeSet,
    view: opts?.view ?? 0,
    viewMode: opts?.viewMode ?? "volume",
    drawnViews: opts?.drawnViews ?? [opts?.view ?? 0],
    sampleFormat: "u16",
  };
}

function vol(state: RendererState) {
  return state.volumeAtlases;
}
function sli(state: RendererState) {
  return state.sliceAtlases;
}

/** Pool routing for one member's (tier, level) section, in any view. */
function poolOf(state: RendererState, memberId: string, tier: "detail" | "coarse", level: number) {
  for (const draw of state.draws.values()) {
    const poolKey = draw.routes.get(memberId)?.get(sourceKey(tier, level));
    if (poolKey) return poolKey;
  }
  return undefined;
}

/** The draw of "ds1" in view 0, which these tests' cold states lay out. */
function draw0(state: RendererState): ViewDraw {
  return state.draws.get("ds1|0")!;
}

/**
 * A four-level halving volume pyramid in [Z, Y, X] with one chunk shape,
 * so every level lands in the same detail pool.
 */
const HALVING_PYRAMID: ColdStateActiveEntry["levels"] = [
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
/** Add chunks to the wanted set of each view drawing the member's dataset in `mode`, as a cold state from the planner would. */
function wantChunks(
  ctx: WorkerCtx, mode: "slice" | "volume", memberId: string, tier: ResidencyTier, keys: string[],
): void {
  for (const draw of drawsOf(ctx.state, ctx.state.memberToDataset.get(memberId)!, mode)) {
    const entry = wantedEntryKey(tier, memberId);
    draw.wanted = new Map([...draw.wanted, [entry, new Set([...(draw.wanted.get(entry) ?? []), ...keys])]]);
  }
}

/** Upload chunks the planner wants. These tests are about sections, not admission. */
function deliverVolume(
  ctx: WorkerCtx, msg: VolumeChunkDataMessage, epochs: SceneEpochs, poolKey: string, memberId: string,
): void {
  wantChunks(ctx, "volume", memberId, msg.tier, msg.chunks.map((c) => c.key));
  handleVolumeChunkData(ctx, msg, epochs, poolKey, memberId);
}

function deliverSlice(
  ctx: WorkerCtx, msg: SliceChunkDataMessage, epochs: SceneEpochs, poolKey: string, memberId: string,
): void {
  wantChunks(ctx, "slice", memberId, msg.tier, msg.chunks.map((c) => c.key));
  handleSliceChunkData(ctx, msg, epochs, poolKey, memberId);
}

function ingest(ctx: WorkerCtx, activeSet: ColdStateActiveEntry[]): ColdStateMessage {
  const cold = makeCold(activeSet);
  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = cold.epochs;
  applyColdState(ctx, cold);
  return cold;
}

function mappedLevels(atlas: SharedChunkPool, memberId: string): number[] {
  const levels = new Set<number>();
  for (const [key, slot] of atlas.slots) {
    if (viewOf(atlas).slotGridIdx[slot] < 0) continue;
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
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 0 },
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

// Tests

describe("Suite A — applyColdState", () => {
  // 1. Single-channel volume cold state
  it("single-channel volume → one pool group + correct entityMetas + indirection sized to gridX*gridY*gridZ", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, cold);

    // memberToDataset populated for the single member.
    expect(ctx.state.memberToDataset.get("imgA:ch0")).toBe("ds1");
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe("ds1:ch0:64x64x32:detail");
    // One pool created.
    expect(vol(ctx.state).size).toBe(1);
    const atlas = vol(ctx.state).get("ds1:ch0:64x64x32:detail")!;
    expect(atlas).toBeTruthy();
    // entityMetas pinned on the atlas.
    expect(viewOf(atlas).entityMetas.get("imgA:ch0")).toEqual([
      { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 64, 64], levelDims: [64, 256, 256], offset: 0 },
    ]);
    // Indirection sized to gridX*gridY*gridZ = 2*4*4 = 32.
    expect(viewOf(atlas).indirectionData.length).toBe(32);
    // Snapshot captured for the dataset.
    expect(draw0(ctx.state)?.sources?.get("imgA:ch0")).toHaveLength(1);
    // Descriptor buffer was built for the dataset.
    expect((draw0(ctx.state)?.descriptor != null)).toBe(true);
  });

  // 2. Multi-channel volume cold state
  it("multi-channel volume → one pool group per channel + per-channel memberIds + per-channel pool keys", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA",
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

  // 4. Tiles sharing chunk dims → one pool
  it("two tiles with the same chunk dims → ONE pool group with sequential entityMetas offsets", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, cold);

    expect(vol(ctx.state).size).toBe(1);
    const atlas = vol(ctx.state).get("ds1:ch0:64x64x32:detail")!;
    // Both members live in the same pool.
    expect(viewOf(atlas).entityMetas.size).toBe(2);
    // Sequential offsets: A starts at 0; B starts at 32 (= 2*4*4 from A).
    expect(viewOf(atlas).entityMetas.get("imgA:ch0")?.[0].offset).toBe(0);
    expect(viewOf(atlas).entityMetas.get("imgB:ch0")?.[0].offset).toBe(32);
    // Indirection sized to cover both: 64 entries.
    expect(viewOf(atlas).indirectionData.length).toBe(64);
  });

  // 5. Tiles with different chunk dims → multiple pools per dataset
  it("two tiles with different chunk dims → TWO pool groups + separate entityMetas", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
      makeEntry({
        entityId: "imgB", imageId: "imgB",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, cold);

    expect(vol(ctx.state).size).toBe(2);
    const a = vol(ctx.state).get("ds1:ch0:64x64x32:detail")!;
    const b = vol(ctx.state).get("ds1:ch0:32x32x16:detail")!;
    expect(viewOf(a).entityMetas.get("imgA:ch0")).toBeTruthy();
    expect(viewOf(a).entityMetas.has("imgB:ch0")).toBe(false);
    expect(viewOf(b).entityMetas.get("imgB:ch0")).toBeTruthy();
    expect(viewOf(b).entityMetas.has("imgA:ch0")).toBe(false);
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe("ds1:ch0:64x64x32:detail");
    expect(poolOf(ctx.state, "imgB:ch0", "detail", 0)).toBe("ds1:ch0:32x32x16:detail");
  });

  it("source-backed detail and coarse levels get separate tier pools and descriptor sections", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA",
        detailLevels: [0],
        coarseLevel: 2,
        levels: [
          { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
          { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
        ],
      }),
    ]);

    applyColdState(ctx, cold);

    // Level 2 is a coarser resident level of the detail tier and the
    // coarse tier's level; the tiers keep separate pools at that shape.
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe("ds1:ch0:64x64x32:detail");
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 2)).toBe("ds1:ch0:128x128x8:detail");
    expect(poolOf(ctx.state, "imgA:ch0", "coarse", 2)).toBe("ds1:ch0:128x128x8:coarse");
    expect(vol(ctx.state).get("ds1:ch0:64x64x32:detail")?.views.get(0)?.entityMetas.get("imgA:ch0")?.[0]).toMatchObject({
      level: 0,
      chunkDims: [32, 64, 64],
      offset: 0,
    });
    expect(vol(ctx.state).get("ds1:ch0:128x128x8:coarse")?.views.get(0)?.entityMetas.get("imgA:ch0")?.[0]).toMatchObject({
      level: 2,
      chunkDims: [8, 128, 128],
      offset: 0,
    });
    const sources = draw0(ctx.state)?.sources?.get("imgA:ch0") ?? [];
    expect(sources.map((s) => [s.tier, s.meta.level])).toEqual([
      ["detail", 0],
      ["detail", 2],
      ["coarse", 2],
    ]);
    // The draw binds both detail pools (finest first) and the coarse pool.
    expect(draw0(ctx.state).descriptor?.sourceBindingByMember.get("imgA:ch0")).toEqual({
      levelPoolKeys: ["ds1:ch0:64x64x32:detail", "ds1:ch0:128x128x8:detail"],
      coarsePoolKey: "ds1:ch0:128x128x8:coarse",
    });
  });

  it("source-backed detail and coarse tiers stay separate when they share the same level", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA",
        detailLevels: [1],
        coarseLevel: 1,
        levels: [
          { level: 1, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        ],
      }),
    ]);

    applyColdState(ctx, cold);

    expect(poolOf(ctx.state, "imgA:ch0", "detail", 1)).toBe("ds1:ch0:64x64x32:detail");
    expect(poolOf(ctx.state, "imgA:ch0", "coarse", 1)).toBe("ds1:ch0:64x64x32:coarse");
    expect(vol(ctx.state).get("ds1:ch0:64x64x32:detail")?.views.get(0)?.entityMetas.get("imgA:ch0")?.[0]).toMatchObject({
      level: 1,
      offset: 0,
    });
    expect(vol(ctx.state).get("ds1:ch0:64x64x32:coarse")?.views.get(0)?.entityMetas.get("imgA:ch0")?.[0]).toMatchObject({
      level: 1,
      offset: 0,
    });
    const sources = draw0(ctx.state)?.sources?.get("imgA:ch0") ?? [];
    expect(sources.map((s) => [s.tier, s.meta.level])).toEqual([["detail", 1], ["coarse", 1]]);
  });

  // 6. Resident levels: the target and the coarser levels under it
  it("holds one section per level for the target and the next three coarser levels, none finer", () => {
    const ctx = makeCtx(makeMockDevice());
    const six: ColdStateActiveEntry["levels"] = [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      chunkShape: [32, 32, 32],
      gridShape: [1, 1, 1],
      levelDims: [32, 32, 32],
    }));
    const cold = makeCold([
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [1], levels: six }),
    ]);
    applyColdState(ctx, cold);

    const atlas = vol(ctx.state).get("ds1:ch0:32x32x32:detail")!;
    expect(viewOf(atlas).entityMetas.get("imgA:ch0")?.map((m) => [m.level, m.offset])).toEqual([
      [1, 0], [2, 1], [3, 2], [4, 3],
    ]);
    expect(viewOf(atlas).indirectionData.length).toBe(4);
    for (const level of [1, 2, 3, 4]) {
      expect(poolOf(ctx.state, "imgA:ch0", "detail", level)).toBe("ds1:ch0:32x32x32:detail");
    }
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBeUndefined();
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 5)).toBeUndefined();
    expect(draw0(ctx.state).descriptor?.sourceBindingByMember.get("imgA:ch0")).toEqual({
      levelPoolKeys: ["ds1:ch0:32x32x32:detail"],
      coarsePoolKey: null,
    });
  });

  it("keeps coarser resident chunks mapped when the target moves finer, and unmaps them once they are finer than the target", () => {
    const ctx = makeCtx(makeMockDevice());
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [target], levels: HALVING_PYRAMID });

    // Target 2: sections for levels 2 and 3. A level-2 chunk arrives.
    const coldCoarse = makeCold([entryAt(2)]);
    ctx.state.currentColdState = coldCoarse;
    ctx.state.currentEpochs = coldCoarse.epochs;
    applyColdState(ctx, coldCoarse);
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 2)!;
    deliverVolume(ctx, chunkUpload("imgA:ch0", 2), coldCoarse.epochs, poolKey, "imgA:ch0");
    const atlas = vol(ctx.state).get(poolKey)!;
    const slot = atlas.slots.get("imgA:ch0|2/0/0/0/0/0");
    expect(slot).toBeDefined();
    expect(viewOf(atlas).indirectionData[0]).toBe(slot);

    // Target 0: sections for 0..3. Levels 2 and 3 keep their cells, so the
    // resident level-2 chunk fills the screen until level 0 arrives.
    const coldFine = makeCold([entryAt(0)]);
    ctx.state.currentColdState = coldFine;
    applyColdState(ctx, coldFine);
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe(poolKey);
    const metas = viewOf(atlas).entityMetas.get("imgA:ch0")!;
    expect(metas.map((m) => [m.level, m.offset])).toEqual([[0, 2], [1, 34], [2, 0], [3, 1]]);
    expect(viewOf(atlas).indirectionData[0]).toBe(slot);
    expect(viewOf(atlas).slotGridIdx[slot!]).toBe(0);

    // Target 3: level 2 is now finer than the target. Its chunk stays in
    // the pool but is unmapped, which makes it the first eviction victim.
    const coldCoarsest = makeCold([entryAt(3)]);
    ctx.state.currentColdState = coldCoarsest;
    applyColdState(ctx, coldCoarsest);
    expect(viewOf(atlas).entityMetas.get("imgA:ch0")?.map((m) => m.level)).toEqual([3]);
    expect(atlas.slots.has("imgA:ch0|2/0/0/0/0/0")).toBe(true);
    expect(viewOf(atlas).slotGridIdx[slot!]).toBe(-1);
    expect(findEvictionSlot(ctx.state, atlas, "detail")).toEqual({ key: "imgA:ch0|2/0/0/0/0/0", class: "unsampled", dist: Infinity });
  });

  it("leaves a pool's indirection as it is when a cold state lays the pool out as the last one did", () => {
    const ctx = makeCtx(makeMockDevice());
    const entry = () => makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [2], levels: HALVING_PYRAMID });
    const first = ingest(ctx, [entry()]);
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 2)!;
    deliverVolume(ctx, chunkUpload("imgA:ch0", 2), first.epochs, poolKey, "imgA:ch0");
    const atlas = vol(ctx.state).get(poolKey)!;
    const slot = atlas.slots.get("imgA:ch0|2/0/0/0/0/0")!;
    const indirection = viewOf(atlas).indirectionData;
    // As if the frame after the upload had written the indirection out.
    viewOf(atlas).dirty = false;

    // The same layout, as a view move with nothing entering or leaving sends.
    ingest(ctx, [entry()]);
    expect(viewOf(atlas).dirty).toBe(false);
    expect(viewOf(atlas).indirectionData).toBe(indirection);
    expect(viewOf(atlas).indirectionData[0]).toBe(slot);

    // Another timepoint maps none of the resident chunks.
    const later = makeCold([entry()], { currentT: 1 });
    ctx.state.currentColdState = later;
    applyColdState(ctx, later);
    expect(viewOf(atlas).dirty).toBe(true);
    expect(viewOf(atlas).indirectionData[0]).toBe(0xffffffff);
    expect(viewOf(atlas).slotGridIdx[slot]).toBe(-1);
  });

  it("moves only the sections of a member whose levels changed, and keeps the indirection buffer", () => {
    const ctx = makeCtx(makeMockDevice());
    const entry = (id: string, target: number) =>
      makeEntry({ entityId: id, imageId: id, detailLevels: [target], levels: HALVING_PYRAMID });
    const first = ingest(ctx, [entry("imgA", 2), entry("imgB", 2)]);
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 2)!;
    for (const member of ["imgA:ch0", "imgB:ch0"]) {
      deliverVolume(ctx, chunkUpload(member, 2), first.epochs, poolKey, member);
    }
    const atlas = vol(ctx.state).get(poolKey)!;
    const view = viewOf(atlas);
    const slotA = atlas.slots.get("imgA:ch0|2/0/0/0/0/0")!;
    const slotB = atlas.slots.get("imgB:ch0|2/0/0/0/0/0")!;
    const [sectionA] = view.entityMetas.get("imgA:ch0")!;
    const cellA = sectionA.offset;

    // B goes finer: it gains sections for levels 0 and 1. A keeps its cells.
    ingest(ctx, [entry("imgA", 2), entry("imgB", 0)]);
    expect(view.entityMetas.get("imgA:ch0")![0]).toBe(sectionA);
    expect(view.indirectionData[cellA]).toBe(slotA);
    expect(view.slotGridIdx[slotA]).toBe(cellA);
    const level2B = view.entityMetas.get("imgB:ch0")!.find((m) => m.level === 2)!;
    expect(view.indirectionData[level2B.offset]).toBe(slotB);
    const buffer = view.indirectionBuf;

    // B goes back to level 2: its finer sections free their cells, and the
    // indirection keeps its buffer, which every draw's bind group names.
    ingest(ctx, [entry("imgA", 2), entry("imgB", 2)]);
    expect(view.entityMetas.get("imgB:ch0")!.map((m) => m.level)).toEqual([2, 3]);
    expect(view.indirectionData[cellA]).toBe(slotA);
    expect(view.indirectionData[view.entityMetas.get("imgB:ch0")![0].offset]).toBe(slotB);
    expect(view.indirectionBuf).toBe(buffer);
    const mapped = [...view.indirectionData].filter((cell) => cell !== 0xffffffff).sort();
    expect(mapped).toEqual([slotA, slotB].sort());
  });

  it("maps every resident chunk in its member's section for its level, after a sequence of view moves", () => {
    const entry = (id: string, target: number) =>
      makeEntry({ entityId: id, imageId: id, detailLevels: [target], levels: HALVING_PYRAMID });
    const ids = ["imgA", "imgB", "imgC"];
    const ctx = makeCtx(makeMockDevice());
    const first = ingest(ctx, ids.map((id) => entry(id, 2)));
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 2)!;
    for (const id of ids) {
      for (const level of [2, 3]) deliverVolume(ctx, chunkUpload(`${id}:ch0`, level), first.epochs, poolKey, `${id}:ch0`);
    }
    const atlas = vol(ctx.state).get(poolKey)!;
    expect(atlas.slots.size).toBe(6);
    for (const targets of [[3, 2, 1], [0, 3, 1], [3, 0, 3], [1, 1, 2], [2, 2, 2]]) {
      ingest(ctx, ids.map((id, i) => entry(id, targets[i])));
      const view = viewOf(atlas);
      for (const [key, slot] of atlas.slots) {
        const [member, chunkKey] = key.split("|");
        const level = Number(chunkKey.split("/")[0]);
        const meta = view.entityMetas.get(member)?.find((m) => m.level === level);
        // Each upload is a level's chunk 0, so it maps at its section's first cell.
        expect(view.slotGridIdx[slot], `${key} after ${targets}`).toBe(meta ? meta.offset : -1);
        if (meta) expect(view.indirectionData[meta.offset], key).toBe(slot);
      }
      const mapped = [...view.indirectionData].filter((cell) => cell !== 0xffffffff);
      expect(new Set(mapped).size, `${targets}`).toBe(mapped.length);
    }
  });

  it("remaps only the pools whose sections moved", () => {
    const ctx = makeCtx(makeMockDevice());
    const levels: ColdStateActiveEntry["levels"] = [
      { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
      { level: 1, chunkShape: [32, 64, 64], gridShape: [1, 2, 2], levelDims: [32, 128, 128] },
      { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
    ];
    const entry = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [target], coarseLevel: 2, levels });
    ingest(ctx, [entry(1)]);
    const detail = vol(ctx.state).get("ds1:ch0:64x64x32:detail")!;
    const coarse = vol(ctx.state).get("ds1:ch0:128x128x8:coarse")!;
    viewOf(detail).dirty = false;
    viewOf(coarse).dirty = false;

    // A finer target adds a level-0 section to the detail pool and leaves the
    // coarse pool's one section where it was.
    ingest(ctx, [entry(0)]);
    expect(viewOf(detail).dirty).toBe(true);
    expect(viewOf(detail).entityMetas.get("imgA:ch0")?.map((m) => m.level)).toEqual([0, 1]);
    expect(viewOf(coarse).dirty).toBe(false);
  });

  it("remaps every time while failed chunks are marked, since the marks follow the wanted set", () => {
    const ctx = makeCtx(makeMockDevice());
    const entry = () => makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [2], levels: HALVING_PYRAMID });
    ctx.state.failedByDataset.set("ds1", new Map([["imgA", new Set(["2/0/0/0/0/0"])]]));
    const cold = makeCold([entry()]);
    cold.wantedChunks = [{ tier: "detail", memberId: "imgA:ch0", chunkKeys: ["2/0/0/0/0/0"] }];
    applyColdState(ctx, cold);
    const atlas = vol(ctx.state).get(poolOf(ctx.state, "imgA:ch0", "detail", 2)!)!;
    expect(viewOf(atlas).indirectionData[0]).toBe(0xfffffffe);
    viewOf(atlas).dirty = false;

    applyColdState(ctx, cold);
    expect(viewOf(atlas).dirty).toBe(true);
  });

  it("records each member's target level for eviction, and drops it with the dataset", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [2], levels: HALVING_PYRAMID }),
    ]);
    applyColdState(ctx, cold);
    expect(draw0(ctx.state).targetLevels.get("imgA:ch0")).toBe(2);
    expect(draw0(ctx.state).targetLevels.has("grp")).toBe(false);

    applyColdState(ctx, makeCold([
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [0], levels: HALVING_PYRAMID }),
    ]));
    expect(draw0(ctx.state).targetLevels.get("imgA:ch0")).toBe(0);
  });

  // Pins the four-level bound from the eviction side. The bound itself is
  // the section allocation (`detailTierLevels`). A level outside the
  // resident levels has no section, so the upload path never maps it.
  it("maps at most four levels per entity; the level furthest from the target is the one that drops out", () => {
    const ctx = makeCtx(makeMockDevice());
    const six: ColdStateActiveEntry["levels"] = [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      chunkShape: [32, 32, 32],
      gridShape: [1, 1, 1],
      levelDims: [32, 32, 32],
    }));
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [target], levels: six });
    const uploadAt = (level: number): VolumeChunkDataMessage => ({
      type: "volumeChunkData",
      epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 0 },
      tier: "detail",
      memberId: "imgA:ch0",
      chunks: [{ data: new Uint16Array(32 * 32 * 32).buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: `${level}/0/0/0/0/0` }],
      level, t: 0, c: 0,
      levelWidth: 32, levelHeight: 32, levelDepth: 32,
      chunkX: 32, chunkY: 32, chunkZ: 32,
    });

    const cold = ingest(ctx, [entryAt(1)]);
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 1)!;
    const atlas = vol(ctx.state).get(poolKey)!;
    for (const level of [0, 1, 2, 3, 4, 5]) {
      deliverVolume(ctx, uploadAt(level), cold.epochs, poolKey, "imgA:ch0");
    }
    expect([...atlas.slots.keys()].sort()).toEqual([1, 2, 3, 4].map((l) => `imgA:ch0|${l}/0/0/0/0/0`));
    expect(mappedLevels(atlas, "imgA:ch0")).toEqual([1, 2, 3, 4]);

    const coldMid = ingest(ctx, [entryAt(2)]);
    expect(mappedLevels(atlas, "imgA:ch0")).toEqual([2, 3, 4]);
    expect(findEvictionSlot(ctx.state, atlas, "detail")).toEqual({ key: "imgA:ch0|1/0/0/0/0/0", class: "unsampled", dist: Infinity });
    deliverVolume(ctx, uploadAt(5), coldMid.epochs, poolKey, "imgA:ch0");
    expect(mappedLevels(atlas, "imgA:ch0")).toEqual([2, 3, 4, 5]);

    // Back at target 1, level 1's resident chunk maps again without a
    // refetch, and level 5's stays resident but unmapped.
    ingest(ctx, [entryAt(1)]);
    expect(mappedLevels(atlas, "imgA:ch0")).toEqual([1, 2, 3, 4]);
    expect(atlas.slots.has("imgA:ch0|5/0/0/0/0/0")).toBe(true);
    expect(viewOf(atlas).slotGridIdx[atlas.slots.get("imgA:ch0|5/0/0/0/0/0")!]).toBe(-1);
  });

  it("a coarser resident the planner no longer wants leaves before any wanted chunk; the old target's chunks leave first after it moves coarser", () => {
    const ctx = makeCtx(makeMockDevice());
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [target], levels: HALVING_PYRAMID });
    const uploadAt = (level: number, z: number, y: number, x: number): VolumeChunkDataMessage => {
      const base = chunkUpload("imgA:ch0", level);
      return {
        ...base,
        chunks: [{ ...base.chunks[0], x, y, z, key: `${level}/0/0/${z}/${y}/${x}` }],
      };
    };
    ctx.state.rayHits.set(0, "imgA:ch0", [0, 0, 0]);

    const coldCoarse = ingest(ctx, [entryAt(2)]);
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 2)!;
    const atlas = vol(ctx.state).get(poolKey)!;
    atlas.freeSlots = [1, 0];
    deliverVolume(ctx, uploadAt(2, 0, 0, 0), coldCoarse.epochs, poolKey, "imgA:ch0");

    const coldFine = ingest(ctx, [entryAt(0)]);
    deliverVolume(ctx, uploadAt(0, 1, 3, 3), coldFine.epochs, poolKey, "imgA:ch0");
    expect(atlas.slots.size).toBe(2);

    // The coarser resident is still mapped as fallback, but the planner wants
    // only level 0 now, so it goes rather than the farther wanted chunk.
    expect(viewOf(atlas).slotGridIdx[atlas.slots.get("imgA:ch0|2/0/0/0/0/0")!]).toBeGreaterThanOrEqual(0);
    deliverVolume(ctx, uploadAt(0, 0, 0, 0), coldFine.epochs, poolKey, "imgA:ch0");
    expect([...atlas.slots.keys()].sort()).toEqual(["imgA:ch0|0/0/0/0/0/0", "imgA:ch0|0/0/0/1/3/3"]);

    // Both residents are now finer than the target and never sampled: the
    // greatest key goes first.
    const coldCoarsest = ingest(ctx, [entryAt(3)]);
    deliverVolume(ctx, uploadAt(3, 0, 0, 0), coldCoarsest.epochs, poolKey, "imgA:ch0");
    expect([...atlas.slots.keys()].sort()).toEqual(["imgA:ch0|0/0/0/0/0/0", "imgA:ch0|3/0/0/0/0/0"]);
    expect(findEvictionSlot(ctx.state, atlas, "detail")).toEqual({ key: "imgA:ch0|0/0/0/0/0/0", class: "unsampled", dist: Infinity });
  });

  it("slice mode: a coarser level's plane stays mapped after the target moves finer, each level retargeting Z on its own depth", () => {
    // A pyramid downsampled along Z too: level 0 is 32 deep in two 16-deep
    // chunks, level 1 is 16 deep in one. At full-res Z = 20, level 0's
    // plane lives in chunk z=1 while level 1's lives in chunk z=0.
    const pyramid: ColdStateActiveEntry["levels"] = [
      { level: 0, chunkShape: [16, 64, 64], gridShape: [2, 4, 4], levelDims: [32, 256, 256] },
      { level: 1, chunkShape: [16, 64, 64], gridShape: [1, 2, 2], levelDims: [16, 128, 128] },
    ];
    const entryAt = (target: number) =>
      makeEntry({ entityId: "imgA", imageId: "imgA", detailLevels: [target], levels: pyramid });
    const sliceUpload = (level: number, z: number): SliceChunkDataMessage => {
      const lm = pyramid.find((l) => l.level === level)!;
      const data = new Uint16Array(16 * 64 * 64).fill(level + 1);
      return {
        type: "sliceChunkData",
        epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 0 },
        tier: "detail",
        memberId: "imgA:ch0",
        chunks: [{ data: data.buffer, dataType: "uint16", x: 0, y: 0, z, key: `${level}/0/0/${z}/0/0` }],
        // Full-resolution Z 20 is plane 20 of level 0 and plane 10 of level 1.
        level, t: 0, c: 0,
        levelWidth: lm.levelDims[2], levelHeight: lm.levelDims[1],
        chunkX: 64, chunkY: 64, chunkZ: 16,
        fullResDepth: 32, levelDepth: lm.levelDims[0], plane: level === 0 ? 20 : 10,
      };
    };
    const ctx = makeCtx(makeMockDevice());

    // Target 1 at Z = 20: level 1's chunk z=0 arrives.
    const coldCoarse = makeCold([entryAt(1)], { viewMode: "slice", currentZ: 20 });
    ctx.state.currentColdState = coldCoarse;
    ctx.state.currentEpochs = coldCoarse.epochs;
    applyColdState(ctx, coldCoarse);
    const poolKey = poolOf(ctx.state, "imgA:ch0", "detail", 1)!;
    deliverSlice(ctx, sliceUpload(1, 0), coldCoarse.epochs, poolKey, "imgA:ch0");
    const atlas = sli(ctx.state).get(poolKey)!;
    const slot1 = atlas.slots.get("imgA:ch0|1/0/0/0/0/0|10")!;
    expect(viewOf(atlas).indirectionData[0]).toBe(slot1);

    // Target 0: level 1's plane stays mapped in its own section, which keeps
    // its cells, while level 0 has nothing yet.
    const coldFine = makeCold([entryAt(0)], { viewMode: "slice", currentZ: 20 });
    ctx.state.currentColdState = coldFine;
    applyColdState(ctx, coldFine);
    const metas = viewOf(atlas).entityMetas.get("imgA:ch0")!;
    expect(metas.map((m) => [m.level, m.offset])).toEqual([[0, 4], [1, 0]]);
    expect(viewOf(atlas).indirectionData[0]).toBe(slot1);

    // Level 0's chunk for the same plane is z=1; both levels map at once,
    // each against its own chunk-Z target.
    deliverSlice(ctx, sliceUpload(0, 1), coldFine.epochs, poolOf(ctx.state, "imgA:ch0", "detail", 0)!, "imgA:ch0");
    const slot0 = atlas.slots.get("imgA:ch0|0/0/0/1/0/0|20")!;
    applyColdState(ctx, coldFine);
    expect(viewOf(atlas).indirectionData[4]).toBe(slot0);
    expect(viewOf(atlas).indirectionData[0]).toBe(slot1);
  });

  // 7. Slice mode cold state
  it("slice mode → 2D pool key + one 2D section per resident level", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold(
      [
        makeEntry({
          entityId: "imgA", imageId: "imgA",
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
    const atlas = sli(ctx.state).get("ds1:ch0:128x128:detail")!;
    expect(atlas).toBeTruthy();
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe("ds1:ch0:128x128:detail");
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 1)).toBe("ds1:ch0:128x128:detail");
    // 2D sections: level 0 is 2*2 = 4 entries, level 1 is 1*1 = 1 entry.
    const metas = viewOf(atlas).entityMetas.get("imgA:ch0")!;
    expect(metas.map((m) => [m.level, m.offset])).toEqual([[0, 0], [1, 4]]);
    expect(viewOf(atlas).indirectionData.length).toBe(5);
  });

  // 8. Cold-state churn (replace)
  it("two cold states in a row → pool routing is repopulated; descriptor buffer is rewritten in place", () => {
    const ctx = makeCtx(makeMockDevice());
    const coldA = makeCold([
      makeEntry({
        entityId: "imgA", imageId: "imgA",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, coldA);
    const descA = draw0(ctx.state).descriptor!;
    const descABuffer = descA.buffer as unknown as MockBuffer;
    expect(poolOf(ctx.state, "imgA:ch0", "detail", 0)).toBe("ds1:ch0:64x64x32:detail");

    // Second cold state — different active set.
    const coldB = makeCold([
      makeEntry({
        entityId: "imgB", imageId: "imgB",
        levels: [{ level: 0, chunkShape: [16, 32, 32], gridShape: [4, 8, 8], levelDims: [64, 256, 256] }],
      }),
    ]);
    applyColdState(ctx, coldB);
    // Routing for B is set.
    expect(poolOf(ctx.state, "imgB:ch0", "detail", 0)).toBe("ds1:ch0:32x32x16:detail");
    // B's entries are written into A's buffer, which holds them, so every
    // bind group that names it stays valid.
    const descB = draw0(ctx.state).descriptor!;
    expect(descB).not.toBe(descA);
    expect(descB.buffer).toBe(descA.buffer);
    expect(descABuffer.destroyed).toBe(false);
    expect([...descB.indexByMember.keys()]).toEqual(["imgB:ch0"]);
    // Stale routing for A is cleared before B is registered.
    expect(draw0(ctx.state).routes.has("imgA:ch0")).toBe(false);
  });

  it("replaces a descriptor buffer too small for the next cold state, destroying the old one", () => {
    const ctx = makeCtx(makeMockDevice());
    const entry = (id: string) => makeEntry({
      entityId: id, imageId: id,
      levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
    });
    applyColdState(ctx, makeCold([entry("imgA")]));
    const descA = draw0(ctx.state).descriptor!;

    applyColdState(ctx, makeCold([entry("imgA"), entry("imgB"), entry("imgC")]));

    const descB = draw0(ctx.state).descriptor!;
    expect(descB.buffer).not.toBe(descA.buffer);
    expect((descA.buffer as unknown as MockBuffer).destroyed).toBe(true);
    expect(descB.entityCount).toBe(3);
  });

  // 9. Empty active-set cold state
  it("empty active set → no pools, no panics, empty descriptor buffer still created", () => {
    const ctx = makeCtx(makeMockDevice());
    const cold = makeCold([]);
    expect(() => applyColdState(ctx, cold)).not.toThrow();
    // No pools.
    expect(vol(ctx.state).size).toBe(0);
    // No routing entries.
    expect(draw0(ctx.state).routes.size).toBe(0);
    // No memberToDataset entries (iterateColdMembers yields nothing).
    expect(ctx.state.memberToDataset.size).toBe(0);
    // Snapshot recorded (empty) for the dataset.
    expect(draw0(ctx.state)?.sources?.size).toBe(0);
    // Descriptor buffer was still built (empty buffer is fine — the
    // build path always runs).
    expect((draw0(ctx.state)?.descriptor != null)).toBe(true);
  });

});
