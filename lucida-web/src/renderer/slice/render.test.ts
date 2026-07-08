import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
};

import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type { AggregateDrawParams } from "../sliceRenderer.ts";
import type { SliceRenderMultiPassMessage } from "../workerProtocol.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { createInitialState, type RendererState } from "../worker/state.ts";
import type { SliceAtlasState } from "./atlas.ts";
import { handleSliceRenderMultiPass } from "./render.ts";

function makeDevice(): GPUDevice {
  const encoder = {
    finish: vi.fn(() => ({})),
  };
  return {
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createCommandEncoder: vi.fn(() => encoder),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

function makeAtlas(entityMetas: SliceAtlasState["entityMetas"]): SliceAtlasState {
  return {
    texture: {} as GPUTexture,
    indirectionBuf: {} as GPUBuffer,
    indirectionData: new Uint32Array([0]),
    slots: new Map(),
    slotGridIdx: new Int32Array(1),
    freeSlots: [],
    totalSlots: 1,
    chunkX: 64,
    chunkY: 64,
    slotsX: 1,
    slotsY: 1,
    entityMetas,
    entityZInfo: new Map(),
    z: 0,
    t: 0,
    c: 0,
    staleSliceKeys: null,
    intensityMin: 0,
    intensityMax: 0,
    indirectionDirty: false,
  };
}

/** One resident single-LOD meta list, enough to count as chunk-backed. */
function residentMetas(): LodIndirectionMeta[] {
  return [{
    level: 2,
    gridDims: [1, 2, 2],
    chunkDims: [1, 64, 64],
    levelDims: [1, 128, 128],
    offset: 0,
  }];
}

function makeDescIndex(
  memberIds: string[],
  overrides?: Partial<EntityDescriptorIndex>,
): EntityDescriptorIndex {
  return {
    buffer: {} as GPUBuffer,
    indexByMember: new Map(memberIds.map((id, i) => [id, i])),
    memberByIndex: [...memberIds],
    proxyPoolIndexByKey: new Map(),
    proxyPoolsByIndex: [],
    entityCount: memberIds.length,
    colormapLutIndices: new Map([["gray", 0]]),
    colormapNameByMember: new Map(memberIds.map((id) => [id, "gray"])),
    proxyDescriptorByMember: new Map(),
    ...overrides,
  };
}

/** Pack `SliceAggregateParams.quads` records (rect f32×4 + entityIndex u32). */
function makeQuads(
  records: Array<{ rect: [number, number, number, number]; entityIndex: number }>,
): ArrayBuffer {
  const buf = new ArrayBuffer(records.length * 32);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  records.forEach((rec, i) => {
    f32.set(rec.rect, i * 8);
    u32[i * 8 + 4] = rec.entityIndex;
  });
  return buf;
}

interface MockRenderer {
  setColormapTexture: ReturnType<typeof vi.fn>;
  setProxyTextures: ReturnType<typeof vi.fn>;
  setAtlas: ReturnType<typeof vi.fn>;
  setTierAtlases: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
  setLabelColorBuffer: ReturnType<typeof vi.fn>;
  setDescriptorBinding: ReturnType<typeof vi.fn>;
  renderTo: ReturnType<typeof vi.fn>;
  renderAggregateBatches: ReturnType<typeof vi.fn>;
}

function makeRenderer(): MockRenderer {
  return {
    setColormapTexture: vi.fn(),
    setProxyTextures: vi.fn(),
    setAtlas: vi.fn(),
    setTierAtlases: vi.fn(),
    setTransform: vi.fn(),
    setLabelColorBuffer: vi.fn(),
    setDescriptorBinding: vi.fn(),
    renderTo: vi.fn(),
    renderAggregateBatches: vi.fn(),
  };
}

function makeCtx(opts: {
  device: GPUDevice;
  state: RendererState;
  renderer: MockRenderer;
  composite: ReturnType<typeof vi.fn>;
  descIndex: EntityDescriptorIndex;
}): WorkerCtx {
  return {
    device: opts.device,
    context: {
      canvas: { width: 0, height: 0 },
      getCurrentTexture: () => ({ createView: () => ({}) }),
    },
    state: opts.state,
    getSliceRenderer: () => opts.renderer,
    getCompositor: () => ({ composite: opts.composite }),
    getCursorRenderer: () => ({ hasData: () => false }),
    ensureOffscreenPool: (n: number) =>
      Array.from({ length: n }, () => ({ createView: () => ({}) })),
    getOrCreateLUT: () => ({}),
    lookupEntityDescriptor: () => opts.descIndex,
    getDummyTexture: () => ({}),
  } as unknown as WorkerCtx;
}

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 };

describe("handleSliceRenderMultiPass", () => {
  it("renders a layer backed only by a resident coarse chunk tier", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const coarseAtlas = makeAtlas(new Map([["img-a", residentMetas()]]));
    state.sliceAtlases.set("coarse-pool", coarseAtlas);

    const descIndex = makeDescIndex(["img-a"]);
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleSliceRenderMultiPass(
      ctx,
      {
        type: "sliceRenderMultiPass",
        epochs: EPOCHS,
        layers: [
          { datasetId: "img-a", entityId: "entity-a", entityIndex: 0, blendMode: "alpha", dataW: 128, dataH: 128 },
        ],
        zoom: 1,
        cx: 64,
        cy: 64,
        canvasW: 64,
        canvasH: 64,
      },
      () => ({ detailPoolKey: null, coarsePoolKey: "coarse-pool", datasetId: "ds-0" }),
    );

    expect(renderer.renderTo).toHaveBeenCalledTimes(1);
    expect(renderer.setTierAtlases).toHaveBeenCalledWith(
      null,
      null,
      [0, 0],
      coarseAtlas.texture,
      coarseAtlas.indirectionBuf,
      [1, 1],
    );
    expect(composite.mock.calls[0][1]).toHaveLength(1);
  });

  it("renders a layer backed only by a resident tile proxy", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const tileProxyTexture = {} as GPUTexture;
    const descIndex = makeDescIndex(["img-a:ch1"], {
      proxyPoolIndexByKey: new Map([["tile-proxy-ch1", 0]]),
      proxyPoolsByIndex: [{
        texture: tileProxyTexture,
        slots: new Map(),
        freeSlots: [],
        capacity: 1,
        requestedCapacity: 1,
        slotDims: [8, 16, 32],
        slotsX: 1,
        slotsY: 1,
        slotsZ: 1,
        kind: "TileProxy3D",
        channel: 1,
        touchOrder: [],
      }],
      colormapLutIndices: new Map([["green", 0]]),
      colormapNameByMember: new Map([["img-a:ch1", "green"]]),
      proxyDescriptorByMember: new Map([
        ["img-a:ch1", {
          tileProxyHandle: { poolKey: "tile-proxy-ch1", slotIndex: 0 },
          groupProxyHandle: null,
        }],
      ]),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleSliceRenderMultiPass(
      ctx,
      {
        type: "sliceRenderMultiPass",
        epochs: EPOCHS,
        layers: [
          { datasetId: "img-a:ch1", entityId: "entity-a", entityIndex: 0, blendMode: "additive", dataW: 256, dataH: 256 },
        ],
        zoom: 1,
        cx: 128,
        cy: 128,
        canvasW: 64,
        canvasH: 64,
      },
      () => ({ detailPoolKey: null, coarsePoolKey: null, datasetId: "ds-0" }),
    );

    expect(renderer.renderTo).toHaveBeenCalledTimes(1);
    expect(renderer.setProxyTextures).toHaveBeenCalledWith(tileProxyTexture, null);
    expect(composite).toHaveBeenCalledTimes(1);
  });
});

describe("handleSliceRenderMultiPass — aggregate layers", () => {
  /** The shared aggregate message: two members tiling a 2048×1024 extent. */
  function aggregateMsg(
    quads: ArrayBuffer,
    count: number,
    blendMode: "alpha" | "additive" | "max" = "additive",
  ): SliceRenderMultiPassMessage {
    return {
      type: "sliceRenderMultiPass",
      epochs: EPOCHS,
      layers: [
        {
          datasetId: "img-0",
          entityIndex: 0,
          blendMode,
          dataW: 2048,
          dataH: 1024,
          offsetX: 100,
          offsetY: 200,
          aggregate: { poolMemberId: "img-0", count, quads },
        },
      ],
      zoom: 0.01,
      cx: 1124,
      cy: 712,
      canvasW: 64,
      canvasH: 64,
    };
  }

  const twoMemberQuads = () => makeQuads([
    { rect: [0, 0, 0.5, 0.5], entityIndex: 0 },
    { rect: [0.5, 0.5, 0.5, 0.5], entityIndex: 1 },
  ]);

  it("draws resident members in ONE pass bound to the current descriptor buffer", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const coarseAtlas = makeAtlas(new Map([
      ["img-0", residentMetas()],
      ["img-1", residentMetas()],
    ]));
    coarseAtlas.indirectionDirty = true;
    state.sliceAtlases.set("coarse-pool", coarseAtlas);
    const descIndex = makeDescIndex(["img-0", "img-1"]);
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleSliceRenderMultiPass(
      ctx,
      aggregateMsg(twoMemberQuads(), 2),
      () => ({ detailPoolKey: null, coarsePoolKey: "coarse-pool", datasetId: "ds-0" }),
    );

    expect(renderer.renderAggregateBatches).toHaveBeenCalledTimes(1);
    expect(renderer.renderTo).not.toHaveBeenCalled();
    const params = renderer.renderAggregateBatches.mock.calls[0][2] as AggregateDrawParams;
    // The descriptor buffer is passed per draw (bound fresh inside the
    // renderer), so appearance edits that rebuild it repaint the batch.
    expect(params.descriptorBuffer).toBe(descIndex.buffer);
    expect(params.blendMode).toBe("additive");
    // Both members share one pool-binding set → a single instanced draw.
    expect(params.batches).toHaveLength(1);
    expect(params.batches[0].firstInstance).toBe(0);
    expect(params.batches[0].count).toBe(2);
    expect(params.batches[0].coarse?.texture).toBe(coarseAtlas.texture);
    expect(params.batches[0].detail).toBeNull();
    // Quad order preserved (roster order = aggregate draw order).
    const u32 = new Uint32Array(params.quadData);
    expect([u32[4], u32[12]]).toEqual([0, 1]);
    // Dirty indirection flushed before the draw.
    expect(coarseAtlas.indirectionDirty).toBe(false);
    expect(device.queue.writeBuffer).toHaveBeenCalledWith(
      coarseAtlas.indirectionBuf, 0, coarseAtlas.indirectionData,
    );
    // One composite layer for the whole batch.
    expect(composite.mock.calls[0][1]).toHaveLength(1);
  });

  it("updates camera-UV eviction recency for chunk-backed batched members", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    state.sliceAtlases.set("coarse-pool", makeAtlas(new Map([
      ["img-0", residentMetas()],
      ["img-1", residentMetas()],
    ])));
    const ctx = makeCtx({
      device, state, renderer, composite,
      descIndex: makeDescIndex(["img-0", "img-1"]),
    });

    handleSliceRenderMultiPass(
      ctx,
      aggregateMsg(twoMemberQuads(), 2),
      () => ({ detailPoolKey: null, coarsePoolKey: "coarse-pool", datasetId: "ds-0" }),
    );

    // View center (cx=1124, cy=712) in each member's own UV space:
    // img-0 spans [100..1124]×[200..712], img-1 spans [1124..2148]×[712..1224].
    expect(state.cameraUVPerEntity.get("img-0")).toEqual([1, 1]);
    expect(state.cameraUVPerEntity.get("img-1")).toEqual([0, 0]);
  });

  it("skips the whole layer when no batched member has resident content", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState(); // no atlases, no proxies
    const ctx = makeCtx({
      device, state, renderer, composite,
      descIndex: makeDescIndex(["img-0", "img-1"]),
    });

    handleSliceRenderMultiPass(
      ctx,
      aggregateMsg(twoMemberQuads(), 2),
      () => ({ detailPoolKey: null, coarsePoolKey: "coarse-pool", datasetId: "ds-0" }),
    );

    expect(renderer.renderAggregateBatches).not.toHaveBeenCalled();
    expect(renderer.renderTo).not.toHaveBeenCalled();
    expect(composite.mock.calls[0][1]).toHaveLength(0);
  });

  it("drops quads for members with nothing resident while keeping the rest", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    // Only img-0 has resident chunks; img-1 has nothing anywhere.
    state.sliceAtlases.set("coarse-pool", makeAtlas(new Map([
      ["img-0", residentMetas()],
    ])));
    const ctx = makeCtx({
      device, state, renderer, composite,
      descIndex: makeDescIndex(["img-0", "img-1"]),
    });

    handleSliceRenderMultiPass(
      ctx,
      aggregateMsg(twoMemberQuads(), 2),
      () => ({ detailPoolKey: null, coarsePoolKey: "coarse-pool", datasetId: "ds-0" }),
    );

    const params = renderer.renderAggregateBatches.mock.calls[0][2] as AggregateDrawParams;
    expect(params.batches).toHaveLength(1);
    expect(params.batches[0].count).toBe(1);
    expect(params.quadData.byteLength).toBe(32);
    expect(new Uint32Array(params.quadData)[4]).toBe(0);
    // The dead member contributes no eviction-recency update either.
    expect(state.cameraUVPerEntity.has("img-0")).toBe(true);
    expect(state.cameraUVPerEntity.has("img-1")).toBe(false);
  });

  it("sub-batches by pool-binding set so members never sample another pool", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const atlasA = makeAtlas(new Map([["img-0", residentMetas()]]));
    const atlasB = makeAtlas(new Map([["img-1", residentMetas()]]));
    state.sliceAtlases.set("pool-a", atlasA);
    state.sliceAtlases.set("pool-b", atlasB);
    const ctx = makeCtx({
      device, state, renderer, composite,
      descIndex: makeDescIndex(["img-0", "img-1"]),
    });

    handleSliceRenderMultiPass(
      ctx,
      aggregateMsg(twoMemberQuads(), 2),
      (memberId) => ({
        detailPoolKey: null,
        coarsePoolKey: memberId === "img-0" ? "pool-a" : "pool-b",
        datasetId: "ds-0",
      }),
    );

    const params = renderer.renderAggregateBatches.mock.calls[0][2] as AggregateDrawParams;
    // Two binding sets → two instanced draws in ONE pass, roster order.
    expect(params.batches).toHaveLength(2);
    expect(params.batches[0].coarse?.texture).toBe(atlasA.texture);
    expect(params.batches[0].firstInstance).toBe(0);
    expect(params.batches[0].count).toBe(1);
    expect(params.batches[1].coarse?.texture).toBe(atlasB.texture);
    expect(params.batches[1].firstInstance).toBe(1);
    expect(params.batches[1].count).toBe(1);
    const u32 = new Uint32Array(params.quadData);
    expect([u32[4], u32[12]]).toEqual([0, 1]);
    expect(composite.mock.calls[0][1]).toHaveLength(1);
  });

  it("binds a proxy-backed batched member's own pool texture", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState(); // no chunk atlases at all
    const tileProxyTexture = {} as GPUTexture;
    const descIndex = makeDescIndex(["img-0", "img-1"], {
      proxyPoolIndexByKey: new Map([["tile-proxy-ch0", 0]]),
      proxyPoolsByIndex: [{
        texture: tileProxyTexture,
        slots: new Map(),
        freeSlots: [],
        capacity: 1,
        requestedCapacity: 1,
        slotDims: [8, 16, 32],
        slotsX: 1,
        slotsY: 1,
        slotsZ: 1,
        kind: "TileProxy3D",
        channel: 0,
        touchOrder: [],
      }],
      proxyDescriptorByMember: new Map([
        ["img-0", {
          tileProxyHandle: { poolKey: "tile-proxy-ch0", slotIndex: 0 },
          groupProxyHandle: null,
        }],
      ]),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleSliceRenderMultiPass(
      ctx,
      aggregateMsg(twoMemberQuads(), 2),
      () => ({ detailPoolKey: null, coarsePoolKey: null, datasetId: "ds-0" }),
    );

    const params = renderer.renderAggregateBatches.mock.calls[0][2] as AggregateDrawParams;
    // img-0 rides its proxy pool; img-1 (nothing resident) is dropped.
    expect(params.batches).toHaveLength(1);
    expect(params.batches[0].count).toBe(1);
    expect(params.batches[0].tileProxyTexture).toBe(tileProxyTexture);
    expect(params.batches[0].detail).toBeNull();
    expect(params.batches[0].coarse).toBeNull();
    // Proxy-only members carry no chunk residency → no camera-UV update.
    expect(state.cameraUVPerEntity.size).toBe(0);
  });
});
