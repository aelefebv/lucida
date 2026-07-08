import { describe, expect, it, vi } from "vitest";

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

import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { createInitialState } from "../worker/state.ts";
import { getOrCreateVolumePool } from "./atlas.ts";
import { handleVolumeRenderMultiPass } from "./render.ts";

function makeDevice(): GPUDevice {
  const texture = {
    destroy: vi.fn(),
    createView: vi.fn(() => ({})),
  };
  const encoder = {
    finish: vi.fn(() => ({})),
  };
  return {
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createTexture: vi.fn(() => texture),
    createCommandEncoder: vi.fn(() => encoder),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

describe("handleVolumeRenderMultiPass", () => {
  it("does not advance first-layer state for skipped non-renderable layers", () => {
    const device = makeDevice();
    const renderTo = vi.fn();
    const composite = vi.fn();
    const state = createInitialState();
    const atlas = getOrCreateVolumePool(
      { device, state } as unknown as WorkerCtx,
      "pool-b",
      16,
      16,
      16,
      0,
      0,
    );
    atlas.entityMetas.set("img-b", [
      {
        level: 0,
        gridDims: [1, 1, 1],
        chunkDims: [16, 16, 16],
        levelDims: [16, 16, 16],
        offset: 0,
      },
    ]);

    const descIndex: EntityDescriptorIndex = {
      buffer: {} as GPUBuffer,
      indexByMember: new Map([["img-a", 0], ["img-b", 1]]),
      memberByIndex: ["img-a", "img-b"],
      proxyPoolIndexByKey: new Map(),
      proxyPoolsByIndex: [],
      entityCount: 2,
      colormapLutIndices: new Map([["gray", 0]]),
      colormapNameByMember: new Map([["img-a", "gray"], ["img-b", "gray"]]),
      proxyDescriptorByMember: new Map(),
    };

    const ctx = {
      device,
      context: {
        canvas: { width: 0, height: 0 },
        getCurrentTexture: () => ({ createView: () => ({}) }),
      },
      state,
      getVolumeRenderer: () => ({
        setColormapTexture: vi.fn(),
        setProxyTextures: vi.fn(),
        setAtlas: vi.fn(),
        setTierAtlases: vi.fn(),
        setRenderMode: vi.fn(),
        setMatrices: vi.fn(),
        setLabelColorBuffer: vi.fn(),
        setDescriptorBinding: vi.fn(),
        renderTo,
      }),
      getCompositor: () => ({ composite }),
      getCursorRenderer: () => ({ hasData: () => false }),
      ensureOffscreenPool: () => [{ createView: () => ({}) }],
      getOrCreateLUT: () => ({}),
      lookupEntityDescriptor: () => descIndex,
      lookupProxyDescriptor: () => null,
      getDummy3DTexture: () => ({}),
    } as unknown as WorkerCtx;

    handleVolumeRenderMultiPass(
      ctx,
      {
        type: "volumeRenderMultiPass",
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        layers: [
          { datasetId: "img-a", entityId: "entity-a", entityIndex: 0, blendMode: "alpha", renderMode: "translucent" },
          { datasetId: "img-b", entityId: "entity-b", entityIndex: 1, blendMode: "alpha", renderMode: "translucent" },
        ],
        invViewProj: new Float32Array(16),
        eye: new Float32Array(3),
        canvasW: 64,
        canvasH: 64,
        fullW: 64,
        fullH: 64,
      },
      (memberId) => (
        memberId === "img-b"
          ? { detailPoolKey: "pool-b", coarsePoolKey: null, datasetId: "ds-0" }
          : { detailPoolKey: null, coarsePoolKey: null, datasetId: "ds-0" }
      ),
    );

    expect(renderTo).toHaveBeenCalledTimes(1);
    expect(renderTo.mock.calls[0][3]).toBe(true);
    expect(composite).toHaveBeenCalledTimes(1);
    expect(composite.mock.calls[0][3]).toBe(true);
  });

  it("renders a layer backed only by a resident coarse chunk tier", () => {
    const device = makeDevice();
    const renderTo = vi.fn();
    const composite = vi.fn();
    const state = createInitialState();
    const coarseAtlas = getOrCreateVolumePool(
      { device, state } as unknown as WorkerCtx,
      "coarse-pool",
      64,
      64,
      16,
      0,
      0,
    );
    coarseAtlas.indirectionDirty = false;
    coarseAtlas.entityMetas.set("img-a", [
      {
        level: 2,
        gridDims: [1, 2, 2],
        chunkDims: [16, 64, 64],
        levelDims: [16, 128, 128],
        offset: 0,
      },
    ]);

    const descIndex: EntityDescriptorIndex = {
      buffer: {} as GPUBuffer,
      indexByMember: new Map([["img-a", 0]]),
      memberByIndex: ["img-a"],
      proxyPoolIndexByKey: new Map(),
      proxyPoolsByIndex: [],
      entityCount: 1,
      colormapLutIndices: new Map([["gray", 0]]),
      colormapNameByMember: new Map([["img-a", "gray"]]),
      proxyDescriptorByMember: new Map(),
    };

    const setTierAtlases = vi.fn();
    const ctx = {
      device,
      context: {
        canvas: { width: 0, height: 0 },
        getCurrentTexture: () => ({ createView: () => ({}) }),
      },
      state,
      getVolumeRenderer: () => ({
        setColormapTexture: vi.fn(),
        setProxyTextures: vi.fn(),
        setAtlas: vi.fn(),
        setTierAtlases,
        setRenderMode: vi.fn(),
        setMatrices: vi.fn(),
        setLabelColorBuffer: vi.fn(),
        setDescriptorBinding: vi.fn(),
        renderTo,
      }),
      getCompositor: () => ({ composite }),
      getCursorRenderer: () => ({ hasData: () => false }),
      ensureOffscreenPool: () => [{ createView: () => ({}) }],
      getOrCreateLUT: () => ({}),
      lookupEntityDescriptor: () => descIndex,
      lookupProxyDescriptor: () => null,
      getDummy3DTexture: () => ({}),
    } as unknown as WorkerCtx;

    handleVolumeRenderMultiPass(
      ctx,
      {
        type: "volumeRenderMultiPass",
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        layers: [
          { datasetId: "img-a", entityId: "entity-a", entityIndex: 0, blendMode: "alpha", renderMode: "translucent" },
        ],
        invViewProj: new Float32Array(16),
        eye: new Float32Array(3),
        canvasW: 64,
        canvasH: 64,
        fullW: 64,
        fullH: 64,
      },
      () => ({ detailPoolKey: null, coarsePoolKey: "coarse-pool", datasetId: "ds-0" }),
    );

    expect(renderTo).toHaveBeenCalledTimes(1);
    const args = setTierAtlases.mock.calls[0];
    expect(args[0]).toBe(coarseAtlas.texture);
    expect(args[2]).toEqual([0, 0, 0]);
    expect(args[3]).toBe(coarseAtlas.texture);
    expect(args[4]).toBe(coarseAtlas.indirectionBuf);
    expect(args[5]).toEqual([coarseAtlas.slotsX, coarseAtlas.slotsY, coarseAtlas.slotsZ]);
    expect(args[6]).toEqual([128, 128, 16]);
    expect(composite).toHaveBeenCalledTimes(1);
  });

  it("renders a layer backed only by a resident tile proxy", () => {
    const device = makeDevice();
    const renderTo = vi.fn();
    const composite = vi.fn();
    const state = createInitialState();
    const tileProxyTexture = {} as GPUTexture;
    const descIndex: EntityDescriptorIndex = {
      buffer: {} as GPUBuffer,
      indexByMember: new Map([["img-a:ch1", 0]]),
      memberByIndex: ["img-a:ch1"],
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
      entityCount: 1,
      colormapLutIndices: new Map([["green", 0]]),
      colormapNameByMember: new Map([["img-a:ch1", "green"]]),
      proxyDescriptorByMember: new Map([
        ["img-a:ch1", {
          tileProxyHandle: { poolKey: "tile-proxy-ch1", slotIndex: 0 },
          groupProxyHandle: null,
        }],
      ]),
    };

    const setProxyTextures = vi.fn();
    const setTierAtlases = vi.fn();
    const ctx = {
      device,
      context: {
        canvas: { width: 0, height: 0 },
        getCurrentTexture: () => ({ createView: () => ({}) }),
      },
      state,
      getVolumeRenderer: () => ({
        setColormapTexture: vi.fn(),
        setProxyTextures,
        setAtlas: vi.fn(),
        setTierAtlases,
        setRenderMode: vi.fn(),
        setMatrices: vi.fn(),
        setLabelColorBuffer: vi.fn(),
        setDescriptorBinding: vi.fn(),
        renderTo,
      }),
      getCompositor: () => ({ composite }),
      getCursorRenderer: () => ({ hasData: () => false }),
      ensureOffscreenPool: () => [{ createView: () => ({}) }],
      getOrCreateLUT: () => ({}),
      lookupEntityDescriptor: () => descIndex,
      getDummy3DTexture: () => ({}),
    } as unknown as WorkerCtx;

    handleVolumeRenderMultiPass(
      ctx,
      {
        type: "volumeRenderMultiPass",
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        layers: [
          { datasetId: "img-a:ch1", entityId: "entity-a", entityIndex: 0, blendMode: "additive", renderMode: "translucent" },
        ],
        invViewProj: new Float32Array(16),
        eye: new Float32Array(3),
        canvasW: 64,
        canvasH: 64,
        fullW: 64,
        fullH: 64,
      },
      () => ({ detailPoolKey: null, coarsePoolKey: null, datasetId: "ds-0" }),
    );

    expect(renderTo).toHaveBeenCalledTimes(1);
    expect(setProxyTextures).toHaveBeenCalledWith(tileProxyTexture, null);
    expect(setTierAtlases.mock.calls[0][6]).toEqual([32, 16, 8]);
    expect(composite).toHaveBeenCalledTimes(1);
  });
});
