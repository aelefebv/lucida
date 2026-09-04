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
import { applyColdStateDelta } from "./applyDelta.ts";
import { applyColdStateDisplay } from "./applyDisplay.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDeltaMessage,
  ColdStateMessage,
} from "../workerProtocol.ts";
import { createInitialState } from "../worker/state.ts";

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
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

function makeCtx(): WorkerCtx {
  return {
    device: makeMockDevice(),
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

function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function tile(entityId: string, imageId: string, level = 0): ColdStateActiveEntry {
  return {
    kind: "tile",
    entityId,
    imageId,
    mode: "tiles-with-detail",
    detailLevels: [level],
    coarseLevel: null,
    levels: [
      { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
    ],
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
    parentGroupId: null,
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
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
    datasetId: "ds1",
    currentT: 0,
    currentZ: 0,
    multiChannel: false,
    visibleChannels: [0],
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024], zRangeVox: [0, 1], effectiveZoom: 1,
      sortCenterVox: null, frustumPlanes: null,
    },
    desiredProxyKeys: [],
    activeSet,
    viewMode: "volume",
  };
}

describe("applyColdStateDelta", () => {
  it("patches the active set to match a full rebuild — same entries, same order, removed dropped", () => {
    // Ingest a full cold state, then apply a view-move delta that: changes a's
    // LOD (upsert), keeps c (retained), drops b (removed), adds d (upsert), and
    // reorders to [a, c, d].
    const ctxDelta = makeCtx();
    const cold1 = makeCold([tile("a", "img-a", 1), tile("b", "img-b", 1), tile("c", "img-c", 1)]);
    // The dispatch handler retains the message; mirror that so the delta has
    // something to patch.
    ctxDelta.state.coldStateByDataset.set("ds1", cold1);
    applyColdState(ctxDelta, cold1);

    const delta: ColdStateDeltaMessage = {
      type: "coldStateDelta",
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, asset: 0, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512], zRangeVox: [0, 1], effectiveZoom: 2,
        sortCenterVox: null, frustumPlanes: null,
      },
      desiredProxyKeys: [],
      removedEntityIds: ["b"],
      upserts: [tile("a", "img-a", 2), tile("d", "img-d", 0)],
      activeSetOrder: ["a", "c", "d"],
    };
    applyColdStateDelta(ctxDelta, delta);

    // A fresh worker fed the equivalent FULL cold state at the new view.
    const ctxFull = makeCtx();
    const coldFull: ColdStateMessage = {
      ...makeCold([tile("a", "img-a", 2), tile("c", "img-c", 1), tile("d", "img-d", 0)]),
      currentT: 0,
      visibleRegion: delta.visibleRegion,
    };
    ctxFull.state.coldStateByDataset.set("ds1", coldFull);
    applyColdState(ctxFull, coldFull);

    const patched = ctxDelta.state.coldStateByDataset.get("ds1")!;
    const full = ctxFull.state.coldStateByDataset.get("ds1")!;

    // Same entries in the same order — the property that binds descriptor indices.
    expect(patched.activeSet.map((e) => e.entityId)).toEqual(["a", "c", "d"]);
    expect(patched.activeSet).toEqual(full.activeSet);

    // Descriptor buffer indices agree with the full rebuild's.
    const descDelta = ctxDelta.state.descriptorBuffersByDataset.get("ds1")!;
    const descFull = ctxFull.state.descriptorBuffersByDataset.get("ds1")!;
    expect(descDelta.memberByIndex).toEqual(["img-a", "img-c", "img-d"]);
    expect(descDelta.memberByIndex).toEqual(descFull.memberByIndex);

    // The removed entity is gone from everything the render path reads — no
    // ghost tile. (Its pool routing is dropped and it never enters the rebuilt
    // descriptor buffer, exactly as a full rebuild on this worker would do.)
    expect(descDelta.indexByMember.has("img-b")).toBe(false);
    expect(ctxDelta.state.memberToPool.has("img-b")).toBe(false);
    expect(ctxDelta.state.currentEntityMetasByDataset.get("ds1")!.has("img-b")).toBe(false);
    expect(descDelta.indexByMember.has("img-c")).toBe(true);

    // The delta re-pointed the retained cold state at the new view.
    expect(patched.visibleRegion).toEqual(delta.visibleRegion);
    expect(patched.epochs.view).toBe(2);
  });

  it("is a no-op when no cold state has landed for the dataset yet", () => {
    const ctx = makeCtx();
    applyColdStateDelta(ctx, {
      type: "coldStateDelta",
      datasetId: "never-ingested",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, asset: 0, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 1, 1], zRangeVox: [0, 1], effectiveZoom: 1,
        sortCenterVox: null, frustumPlanes: null,
      },
      desiredProxyKeys: [],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: [],
    });
    expect(ctx.state.coldStateByDataset.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
  });

  it("throws (not silently skips) when an order id has no retained or upserted match", () => {
    // Producer-invariant violation: silently dropping the id would shift every
    // later descriptor index by one and bind wrong-entity descriptors with no
    // error. It must fail loudly instead.
    const ctx = makeCtx();
    const cold = makeCold([tile("a", "img-a"), tile("b", "img-b")]);
    ctx.state.coldStateByDataset.set("ds1", cold);
    applyColdState(ctx, cold);

    expect(() =>
      applyColdStateDelta(ctx, {
        type: "coldStateDelta",
        datasetId: "ds1",
        epochs: { content: 1, layout: 1, view: 2, selection: 1, asset: 0, request: 1 },
        currentT: 0,
        currentZ: 0,
        visibleRegion: cold.visibleRegion,
        desiredProxyKeys: [],
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
    ctx.state.coldStateByDataset.set("ds1", cold);
    applyColdState(ctx, cold);

    applyColdStateDisplay(ctx, {
      type: "coldStateDisplay",
      datasetId: "ds1",
      displayStateByChannel: {
        0: { contrastMin: 1000, contrastMax: 2000, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 },
      },
    });

    // Pure view move: no LOD/membership change, so nothing is upserted or
    // removed — just a re-point of the view.
    applyColdStateDelta(ctx, {
      type: "coldStateDelta",
      datasetId: "ds1",
      epochs: { content: 1, layout: 1, view: 2, selection: 1, asset: 0, request: 1 },
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512], zRangeVox: [0, 1], effectiveZoom: 2,
        sortCenterVox: null, frustumPlanes: null,
      },
      desiredProxyKeys: [],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: ["a", "b"],
    });

    const patched = ctx.state.coldStateByDataset.get("ds1")!;
    for (const entry of patched.activeSet) {
      expect(entry.displayStateByChannel[0].contrastMin).toBe(1000);
      expect(entry.displayStateByChannel[0].contrastMax).toBe(2000);
    }
  });
});
