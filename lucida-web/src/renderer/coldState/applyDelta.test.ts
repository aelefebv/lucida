/**
 * Characterization of `applyColdStateDelta`.
 *
 * The load-bearing invariant: a view-move delta must patch the worker's retained
 * cold state so that the resulting active set — and the descriptor buffer built
 * from it — is byte-identical to what a full cold state at the new view would
 * produce. Order must match (so entity indices bind correctly), entities that
 * left must be gone (no ghost), and unchanged entities must survive untouched.
 */

import { describe, it, expect, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40,
};

import { applyColdState } from "./apply.ts";
import { drawOf } from "../worker/draws.ts";
import { applyColdStateDelta } from "./applyDelta.ts";
import { applyColdStateDisplay } from "./applyDisplay.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDeltaMessage,
  ColdStateMessage,
} from "../workerProtocol.ts";
import { createInitialState } from "../worker/state.ts";
import { UNTIMED } from "../passTiming.ts";
import { buildDescriptorBuffer } from "../descriptorBuffer.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { growViewSlots } from "../viewIndirection.ts";
import { volumeEvictionParams } from "../volume/eviction.ts";
import { findEvictionSlot } from "../eviction.ts";

function makeMockDevice(): GPUDevice {
  const createTexture = vi.fn((desc: GPUTextureDescriptor) => ({
    destroyed: false, destroy() { this.destroyed = true; }, size: desc.size, format: desc.format,
  }));
  const createBuffer = vi.fn((desc: GPUBufferDescriptor) => ({
    destroyed: false, destroy() { this.destroyed = true; }, size: desc.size, usage: desc.usage,
  }));
  return {
    createTexture,
    createBuffer,
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve(null)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

function makeCtx(): WorkerCtx {
  return {
    device: makeMockDevice(),
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

function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function tile(entityId: string, imageId: string, level = 0): ColdStateActiveEntry {
  return {
    entityId,
    imageId,
    detailLevels: [level],
    coarseLevel: null,
    levels: [
      { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
    ],
    modelMatrix: identityMatrix(),
    invModelMatrix: identityMatrix(),
    displayStateByChannel: {
      0: { contrastMin: 0, contrastMax: 1, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 },
    },
  };
}

function makeCold(activeSet: ColdStateActiveEntry[]): ColdStateMessage {
  return {
    type: "coldState",
    labels: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 0 },
    datasetId: "ds1",
    currentT: 0,
    currentZ: 0,
    visibleChannels: [0],
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024], zRangeVox: [0, 1], effectiveZoom: 1,
      sortCenterVox: null, frustumPlanes: null,
    },
    wantedChunks: [],
    activeSet,
    view: 0,
    viewMode: "volume",
    drawnViews: [0],
    sampleFormat: "u16",
  };
}

describe("applyColdStateDelta", () => {
  it("patches the active set to match a full rebuild — same entries, same order, removed dropped", () => {
    // Ingest a full cold state, then apply a view-move delta that: changes a's
    // LOD (upsert), keeps c (retained), drops b (removed), adds d (upsert), and
    // reorders to [a, c, d].
    const ctxDelta = makeCtx();
    const cold1 = makeCold([tile("a", "img-a", 1), tile("b", "img-b", 1), tile("c", "img-c", 1)]);
    applyColdState(ctxDelta, cold1);

    const delta: ColdStateDeltaMessage = {
      type: "coldStateDelta",
      labels: [],
      view: 0,
      drawnViews: [0],
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512], zRangeVox: [0, 1], effectiveZoom: 2,
        sortCenterVox: null, frustumPlanes: null,
      },
      wantedChunks: [],
      removedEntityIds: ["b"],
      upserts: [tile("a", "img-a", 2), tile("d", "img-d", 0)],
      activeSetOrder: ["a", "c", "d"],
    };
    applyColdStateDelta(ctxDelta, delta);

    // A fresh worker fed the equivalent full cold state at the new view.
    const ctxFull = makeCtx();
    const coldFull: ColdStateMessage = {
      ...makeCold([tile("a", "img-a", 2), tile("c", "img-c", 1), tile("d", "img-d", 0)]),
      currentT: 0,
      visibleRegion: delta.visibleRegion,
    };
    applyColdState(ctxFull, coldFull);

    const patched = drawOf(ctxDelta.state, "ds1", 0)!.cold;
    const full = drawOf(ctxFull.state, "ds1", 0)!.cold;

    // Same entries in the same order — the property that binds descriptor indices.
    expect(patched.activeSet.map((e) => e.entityId)).toEqual(["a", "c", "d"]);
    expect(patched.activeSet).toEqual(full.activeSet);

    // Descriptor buffer indices agree with the full rebuild's.
    const descDelta = drawOf(ctxDelta.state, "ds1", 0)!.descriptor!;
    const descFull = drawOf(ctxFull.state, "ds1", 0)!.descriptor!;
    expect(descDelta.memberByIndex).toEqual(["img-a:ch0", "img-c:ch0", "img-d:ch0"]);
    expect(descDelta.memberByIndex).toEqual(descFull.memberByIndex);

    // The removed entity is gone from everything the render path reads — no
    // ghost tile. (Its pool routing is dropped and it never enters the rebuilt
    // descriptor buffer, exactly as a full rebuild on this worker would do.)
    expect(descDelta.indexByMember.has("img-b:ch0")).toBe(false);
    expect(drawOf(ctxDelta.state, "ds1", 0)!.routes.has("img-b:ch0")).toBe(false);
    expect(drawOf(ctxDelta.state, "ds1", 0)!.sources.has("img-b:ch0")).toBe(false);
    expect(descDelta.indexByMember.has("img-c:ch0")).toBe(true);

    // The delta re-pointed the retained cold state at the new view.
    expect(patched.visibleRegion).toEqual(delta.visibleRegion);
    expect(patched.epochs.view).toBe(2);
  });

  it("patches the retained wanted chunks with the delta's changed entries, as a full cold state would carry them", () => {
    const ctx = makeCtx();
    const cold1: ColdStateMessage = {
      ...makeCold([tile("a", "img-a", 1), tile("b", "img-b", 1)]),
      wantedChunks: [
        { memberId: "img-a", tier: "detail", chunkKeys: ["1/0/0/0/0/0"] },
        { memberId: "img-b", tier: "detail", chunkKeys: ["1/0/0/0/0/0"] },
      ],
    };
    applyColdState(ctx, cold1);

    applyColdStateDelta(ctx, {
      type: "coldStateDelta",
      labels: [],
      view: 0,
      drawnViews: [0],
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: cold1.visibleRegion,
      wantedChunks: [
        { memberId: "img-a", tier: "detail", chunkKeys: ["1/0/0/0/0/1"] },
        { memberId: "img-b", tier: "detail", chunkKeys: [] },
      ],
      removedEntityIds: ["b"],
      upserts: [],
      activeSetOrder: ["a"],
    });

    expect(drawOf(ctx.state, "ds1", 0)!.cold.wantedChunks).toEqual([
      { memberId: "img-a", tier: "detail", chunkKeys: ["1/0/0/0/0/1"] },
    ]);
    const index = drawOf(ctx.state, "ds1", 0)!.wanted;
    expect([...index.keys()]).toEqual(["detail|img-a"]);
    expect([...index.get("detail|img-a")!]).toEqual(["1/0/0/0/0/1"]);
  });

  it("re-ingests nothing when only the wanted chunks moved, and indexes them as a full cold state would", () => {
    const ctx = makeCtx();
    const cold1: ColdStateMessage = {
      ...makeCold([tile("a", "img-a", 1), tile("b", "img-b", 1)]),
      wantedChunks: [
        { memberId: "img-a:ch0", tier: "detail", chunkKeys: ["1/0/0/0/0/0"] },
        { memberId: "img-b:ch0", tier: "detail", chunkKeys: ["1/0/0/0/0/0"] },
      ],
    };
    applyColdState(ctx, cold1);
    const descriptors = drawOf(ctx.state, "ds1", 0)!.descriptor!;
    const writes = vi.mocked(ctx.device.queue.writeBuffer).mock.calls.length;

    const delta: ColdStateDeltaMessage = {
      type: "coldStateDelta",
      labels: [],
      view: 0,
      drawnViews: [0],
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512], zRangeVox: [0, 1], effectiveZoom: 2,
        sortCenterVox: null, frustumPlanes: null,
      },
      wantedChunks: [
        { memberId: "img-a:ch0", tier: "detail", chunkKeys: ["1/0/0/0/0/1"] },
        { memberId: "img-b:ch0", tier: "detail", chunkKeys: [] },
      ],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: ["a", "b"],
    };
    applyColdStateDelta(ctx, delta);

    // No descriptor rewrite and no pool rebuilt.
    expect(drawOf(ctx.state, "ds1", 0)!.descriptor).toBe(descriptors);
    expect(vi.mocked(ctx.device.queue.writeBuffer).mock.calls.length).toBe(writes);
    expect(ctx.state.currentEpochs?.view).toBe(2);

    const ctxFull = makeCtx();
    const full: ColdStateMessage = {
      ...makeCold([tile("a", "img-a", 1), tile("b", "img-b", 1)]),
      visibleRegion: delta.visibleRegion,
      wantedChunks: [{ memberId: "img-a:ch0", tier: "detail", chunkKeys: ["1/0/0/0/0/1"] }],
    };
    applyColdState(ctxFull, full);
    expect(drawOf(ctx.state, "ds1", 0)!.wanted).toEqual(drawOf(ctxFull.state, "ds1", 0)!.wanted);
  });

  it("lays out again only the members a view move changed, when the order holds", () => {
    // Three levels in one pool, so a change of target level adds and drops sections.
    const pyramid = (entityId: string, target: number): ColdStateActiveEntry => ({
      ...tile(entityId, `img-${entityId}`, target),
      levels: [
        { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
        { level: 1, chunkShape: [32, 64, 64], gridShape: [1, 2, 2], levelDims: [32, 128, 128] },
        { level: 2, chunkShape: [32, 64, 64], gridShape: [1, 1, 1], levelDims: [16, 64, 64] },
      ],
    });
    const ids = ["a", "b", "c", "d"];
    const ctx = makeCtx();
    applyColdState(ctx, makeCold(ids.map((id) => pyramid(id, 2))));
    const draw = drawOf(ctx.state, "ds1", 0)!;
    const [atlas] = ctx.state.volumeAtlases.values();
    const view = atlas.views.get(0)!;
    // Chunk 0 of every member's every level, resident, then mapped by a whole remap.
    const slotOf = (id: string, level: number) => ids.indexOf(id) * 3 + level;
    for (const id of ids) for (const level of [0, 1, 2]) atlas.slots.set(`img-${id}:ch0|${level}/0/0/0/0/0`, slotOf(id, level));
    growViewSlots(atlas, 12);
    ctx.state.remappedFor.delete(view);
    applyColdState(ctx, draw.cold);
    const buffer = view.indirectionBuf;
    const keptA = view.entityMetas.get("img-a:ch0")!;
    const writtenA = draw.descriptor!.written.get("img-a:ch0");

    const move = (targets: number[]): ColdStateDeltaMessage => {
      const before = draw.cold.activeSet;
      return {
        type: "coldStateDelta",
        labels: [],
        view: 0,
        drawnViews: [0],
        datasetId: "ds1",
        epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
        currentT: 0,
        currentZ: 0,
        visibleRegion: draw.cold.visibleRegion,
        wantedChunks: [],
        removedEntityIds: [],
        upserts: ids.flatMap((id, i) => (before[i].detailLevels[0] === targets[i] ? [] : [pyramid(id, targets[i])])),
        activeSetOrder: ids,
      };
    };
    for (const targets of [[2, 0, 2, 2], [2, 1, 0, 2], [2, 2, 1, 0], [2, 0, 0, 1]]) {
      applyColdStateDelta(ctx, move(targets));
      expect(drawOf(ctx.state, "ds1", 0)).toBe(draw);

      // Every member holds the sections its target calls for, none overlapping another.
      const cells = new Map<number, string>();
      ids.forEach((id, i) => {
        const metas = view.entityMetas.get(`img-${id}:ch0`)!;
        expect(metas.map((m) => m.level).sort(), `${id} at ${targets}`).toEqual([0, 1, 2].filter((l) => l >= targets[i]));
        for (const meta of metas) {
          const [gz, gy, gx] = meta.gridDims;
          for (let cell = meta.offset; cell < meta.offset + gz * gy * gx; cell++) {
            expect(cells.get(cell), `cell ${cell} at ${targets}`).toBeUndefined();
            cells.set(cell, id);
          }
        }
      });
      expect(view.indirectionData.length).toBeGreaterThanOrEqual(Math.max(...cells.keys()) + 1);

      // Eviction's kept order picks what classifying every slot afresh picks.
      const params = volumeEvictionParams(ctx.state, atlas, "detail");
      expect(atlas.order.next(params), `${targets}`).toEqual(findEvictionSlot(params));

      // Each resident chunk is mapped at its member's section for its level, and only there.
      for (const id of ids) {
        const metas = view.entityMetas.get(`img-${id}:ch0`)!;
        for (const level of [0, 1, 2]) {
          const meta = metas.find((m) => m.level === level);
          expect(view.slotGridIdx[slotOf(id, level)], `${id} level ${level} at ${targets}`).toBe(meta ? meta.offset : -1);
          if (meta) expect(view.indirectionData[meta.offset]).toBe(slotOf(id, level));
        }
      }

      // The descriptor entries read the sections the view lays out, as a full build would write them.
      const fresh = buildDescriptorBuffer(makeMockDevice(), draw.cold, draw.sources);
      expect(new Uint8Array(draw.descriptor!.bytes)).toEqual(new Uint8Array(fresh.bytes));
      const sources = draw.sources.get("img-b:ch0")!;
      expect(sources.map((source) => source.meta)).toEqual(view.entityMetas.get("img-b:ch0") as LodIndirectionMeta[]);
    }
    // Member a kept its level throughout: its sections and descriptor entry were never touched.
    expect(view.entityMetas.get("img-a:ch0")).toBe(keptA);
    expect(draw.descriptor!.written.get("img-a:ch0")).toBe(writtenA);
    // The buffer grows a few times at most and is never replaced on a move that frees cells.
    const grown = view.indirectionBuf;
    applyColdStateDelta(ctx, move([2, 2, 2, 2]));
    expect(view.indirectionBuf).toBe(grown);
    expect(buffer).toBeDefined();
  });

  it("re-ingests in full while failed chunks are marked, since the marks follow the wanted set", () => {
    const ctx = makeCtx();
    const cold1 = makeCold([tile("a", "img-a", 1)]);
    applyColdState(ctx, cold1);
    ctx.state.failedByDataset.set("ds1", new Map([["img-a", new Set(["1/0/0/0/0/0"])]]));
    const writes = vi.mocked(ctx.device.queue.writeBuffer).mock.calls.length;

    applyColdStateDelta(ctx, {
      type: "coldStateDelta",
      labels: [],
      view: 0,
      drawnViews: [0],
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: cold1.visibleRegion,
      wantedChunks: [{ memberId: "img-a:ch0", tier: "detail", chunkKeys: ["1/0/0/0/0/0"] }],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: ["a"],
    });

    expect(vi.mocked(ctx.device.queue.writeBuffer).mock.calls.length).toBeGreaterThan(writes);
  });

  it("is a no-op when no cold state has landed for the dataset yet", () => {
    const ctx = makeCtx();
    applyColdStateDelta(ctx, {
      type: "coldStateDelta",
      labels: [],
      view: 0,
      drawnViews: [0],
      datasetId: "never-ingested",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 1, 1], zRangeVox: [0, 1], effectiveZoom: 1,
        sortCenterVox: null, frustumPlanes: null,
      },
      wantedChunks: [],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: [],
    });
    expect(ctx.state.draws.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
  });

  it("throws (not silently skips) when an order id has no retained or upserted match", () => {
    // Producer-invariant violation: silently dropping the id would shift every
    // later descriptor index by one and bind wrong-entity descriptors with no
    // error. It must fail loudly instead.
    const ctx = makeCtx();
    const cold = makeCold([tile("a", "img-a"), tile("b", "img-b")]);
    applyColdState(ctx, cold);

    expect(() =>
      applyColdStateDelta(ctx, {
        type: "coldStateDelta",
        labels: [],
        view: 0,
        drawnViews: [0],
        datasetId: "ds1",
        epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
        currentT: 0,
        currentZ: 0,
        visibleRegion: cold.visibleRegion,
        wantedChunks: [],
        removedEntityIds: [],
        upserts: [],
        // "c" is neither retained ([a, b]) nor upserted.
        activeSetOrder: ["a", "c"],
      }),
    ).toThrow(/activeSetOrder id c missing from retained\+upserts/);
  });

  it("preserves a display edit's contrast on retained entries across a view move", () => {
    // A display edit (applyColdStateDisplay) mutates the retained cold state's
    // per-entry display; a later pure view move (a delta) retains those entries,
    // so the edited contrast must survive rather than snapping back to the value
    // baked at the last full cold state.
    const ctx = makeCtx();
    const cold = makeCold([tile("a", "img-a"), tile("b", "img-b")]);
    applyColdState(ctx, cold);

    applyColdStateDisplay(ctx, {
      type: "coldStateDisplay",
      datasetId: "ds1",
      view: 0,
      displayStateByChannel: {
        0: { contrastMin: 1000, contrastMax: 2000, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 },
      },
    });

    // Pure view move: no LOD/membership change, so nothing is upserted or
    // removed — just a re-point of the view.
    applyColdStateDelta(ctx, {
      type: "coldStateDelta",
      labels: [],
      view: 0,
      drawnViews: [0],
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512], zRangeVox: [0, 1], effectiveZoom: 2,
        sortCenterVox: null, frustumPlanes: null,
      },
      wantedChunks: [],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: ["a", "b"],
    });

    const patched = drawOf(ctx.state, "ds1", 0)!.cold;
    for (const entry of patched.activeSet) {
      expect(entry.displayStateByChannel[0].contrastMin).toBe(1000);
      expect(entry.displayStateByChannel[0].contrastMax).toBe(2000);
    }
  });
});
