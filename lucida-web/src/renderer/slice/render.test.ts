import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
};

import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { createInitialState } from "../worker/state.ts";
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

describe("handleSliceRenderMultiPass", () => {
  it("renders a layer backed only by a resident field proxy", () => {
    const device = makeDevice();
    const renderTo = vi.fn();
    const composite = vi.fn();
    const state = createInitialState();
    const fieldProxyTexture = {} as GPUTexture;
    const descIndex: EntityDescriptorIndex = {
      buffer: {} as GPUBuffer,
      indexByMember: new Map([["img-a:ch1", 0]]),
      proxyPoolIndexByKey: new Map([["field-proxy-ch1", 0]]),
      proxyPoolsByIndex: [{
        texture: fieldProxyTexture,
        slots: new Map(),
        freeSlots: [],
        capacity: 1,
        requestedCapacity: 1,
        slotDims: [8, 16, 32],
        slotsX: 1,
        slotsY: 1,
        slotsZ: 1,
        kind: "FieldProxy3D",
        channel: 1,
        touchOrder: [],
      }],
      entityCount: 1,
      colormapLutIndices: new Map([["green", 0]]),
      colormapNameByMember: new Map([["img-a:ch1", "green"]]),
      proxyDescriptorByMember: new Map([
        ["img-a:ch1", {
          fieldProxyHandle: { poolKey: "field-proxy-ch1", slotIndex: 0 },
          wellProxyHandle: null,
        }],
      ]),
    };

    const setProxyTextures = vi.fn();
    const ctx = {
      device,
      context: {
        canvas: { width: 0, height: 0 },
        getCurrentTexture: () => ({ createView: () => ({}) }),
      },
      state,
      getSliceRenderer: () => ({
        setColormapTexture: vi.fn(),
        setProxyTextures,
        setAtlas: vi.fn(),
        setTransform: vi.fn(),
        setDescriptorBinding: vi.fn(),
        renderTo,
      }),
      getCompositor: () => ({ composite }),
      getCursorRenderer: () => ({ hasData: () => false }),
      ensureOffscreenPool: () => [{ createView: () => ({}) }],
      getOrCreateLUT: () => ({}),
      lookupEntityDescriptor: () => descIndex,
      getDummyTexture: () => ({}),
    } as unknown as WorkerCtx;

    handleSliceRenderMultiPass(
      ctx,
      {
        type: "sliceRenderMultiPass",
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        layers: [
          { datasetId: "img-a:ch1", entityId: "entity-a", entityIndex: 0, blendMode: "additive", dataW: 256, dataH: 256 },
        ],
        zoom: 1,
        cx: 128,
        cy: 128,
        canvasW: 64,
        canvasH: 64,
      },
      () => ({ poolKey: null, datasetId: "ds-0" }),
    );

    expect(renderTo).toHaveBeenCalledTimes(1);
    expect(setProxyTextures).toHaveBeenCalledWith(fieldProxyTexture, null);
    expect(composite).toHaveBeenCalledTimes(1);
  });
});
