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

import type { EntityDescriptorIndex, MemberSourceBinding } from "../descriptorBuffer.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type { VolumePoolBinding } from "../volumeRenderer.ts";
import type { VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import { createInitialState, type RendererState } from "../worker/state.ts";
import { getOrCreateVolumePool, type AtlasState } from "./atlas.ts";
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

/** The binding the renderer receives for `atlas`. */
function bindingOf(atlas: AtlasState): VolumePoolBinding {
  return {
    texture: atlas.texture,
    indirectionBuf: atlas.indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
    slotsZ: atlas.slotsZ,
  };
}

function makeDescIndex(
  memberIds: string[],
  overrides?: Partial<EntityDescriptorIndex>,
): EntityDescriptorIndex {
  return {
    buffer: {} as GPUBuffer,
    indexByMember: new Map(memberIds.map((id, i) => [id, i])),
    memberByIndex: [...memberIds],
    sourceBindingByMember: new Map(),
    proxyPoolIndexByKey: new Map(),
    proxyPoolsByIndex: [],
    entityCount: memberIds.length,
    colormapLutIndices: new Map([["gray", 0]]),
    colormapNameByMember: new Map(memberIds.map((id) => [id, "gray"])),
    proxyDescriptorByMember: new Map(),
    ...overrides,
  };
}

function bindings(entries: Record<string, MemberSourceBinding>): Map<string, MemberSourceBinding> {
  return new Map(Object.entries(entries));
}

interface MockRenderer {
  setColormapTexture: ReturnType<typeof vi.fn>;
  setProxyTextures: ReturnType<typeof vi.fn>;
  setTierAtlases: ReturnType<typeof vi.fn>;
  setRenderMode: ReturnType<typeof vi.fn>;
  setMatrices: ReturnType<typeof vi.fn>;
  setLabelColorBuffer: ReturnType<typeof vi.fn>;
  setDescriptorBinding: ReturnType<typeof vi.fn>;
  renderTo: ReturnType<typeof vi.fn>;
}

function makeRenderer(): MockRenderer {
  return {
    setColormapTexture: vi.fn(),
    setProxyTextures: vi.fn(),
    setTierAtlases: vi.fn(),
    setRenderMode: vi.fn(),
    setMatrices: vi.fn(),
    setLabelColorBuffer: vi.fn(),
    setDescriptorBinding: vi.fn(),
    renderTo: vi.fn(),
  };
}

function makeCtx(opts: {
  device: GPUDevice;
  state: RendererState;
  renderer: MockRenderer;
  composite: ReturnType<typeof vi.fn>;
  descIndex: EntityDescriptorIndex;
}): WorkerCtx {
  for (const memberId of opts.descIndex.memberByIndex) {
    opts.state.memberToDataset.set(memberId, "ds-0");
  }
  return {
    device: opts.device,
    context: {
      canvas: { width: 0, height: 0 },
      getCurrentTexture: () => ({ createView: () => ({}) }),
    },
    state: opts.state,
    getVolumeRenderer: () => opts.renderer,
    getCompositor: () => ({ composite: opts.composite }),
    getCursorRenderer: () => ({ hasData: () => false }),
    ensureOffscreenPool: () => [{ createView: () => ({}) }],
    getOrCreateLUT: () => ({}),
    lookupEntityDescriptor: () => opts.descIndex,
    lookupProxyDescriptor: () => null,
  } as unknown as WorkerCtx;
}

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 };

function msgFor(layers: Array<{ memberId: string; entityIndex: number; blendMode?: "alpha" | "additive" }>): VolumeRenderMultiPassMessage {
  return {
    type: "volumeRenderMultiPass",
    epochs: EPOCHS,
    layers: layers.map((l) => ({
      datasetId: l.memberId,
      entityId: `entity-${l.memberId}`,
      entityIndex: l.entityIndex,
      blendMode: l.blendMode ?? "alpha",
      renderMode: "translucent" as const,
    })),
    invViewProj: new Float32Array(16),
    eye: new Float32Array(3),
    canvasW: 64,
    canvasH: 64,
    fullW: 64,
    fullH: 64,
  };
}

describe("handleVolumeRenderMultiPass", () => {
  it("does not advance first-layer state for skipped non-renderable layers", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
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

    // img-a's descriptor names no pool; img-b's names pool-b.
    const descIndex = makeDescIndex(["img-a", "img-b"], {
      sourceBindingByMember: bindings({ "img-b": { levelPoolKeys: ["pool-b"], coarsePoolKey: null } }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleVolumeRenderMultiPass(ctx, msgFor([
      { memberId: "img-a", entityIndex: 0 },
      { memberId: "img-b", entityIndex: 1 },
    ]));

    expect(renderer.renderTo).toHaveBeenCalledTimes(1);
    expect(renderer.renderTo.mock.calls[0][3]).toBe(true);
    expect(composite).toHaveBeenCalledTimes(1);
    expect(composite.mock.calls[0][3]).toBe(true);
    expect(renderer.setTierAtlases).toHaveBeenCalledWith([bindingOf(atlas)], null);
  });

  it("renders a layer backed only by a resident coarse chunk tier", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
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

    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({ "img-a": { levelPoolKeys: [], coarsePoolKey: "coarse-pool" } }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));

    expect(renderer.renderTo).toHaveBeenCalledTimes(1);
    expect(renderer.setTierAtlases).toHaveBeenCalledWith([], bindingOf(coarseAtlas));
    expect(composite).toHaveBeenCalledTimes(1);
  });

  it("binds every level pool the entity's level sources name, in slot order, plus the coarse pool", () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const stub = { device, state } as unknown as WorkerCtx;
    const finePool = getOrCreateVolumePool(stub, "ds-0:32x32x32:detail", 32, 32, 32, 0, 0);
    const smallChunkPool = getOrCreateVolumePool(stub, "ds-0:16x16x16:detail", 16, 16, 16, 0, 0);
    const coarsePool = getOrCreateVolumePool(stub, "ds-0:16x16x16:coarse", 16, 16, 16, 0, 0);
    const meta = (level: number, chunk: number) => [{
      level,
      gridDims: [1, 1, 1] as [number, number, number],
      chunkDims: [chunk, chunk, chunk] as [number, number, number],
      levelDims: [chunk, chunk, chunk] as [number, number, number],
      offset: 0,
    }];
    finePool.entityMetas.set("img-a", meta(0, 32));
    smallChunkPool.entityMetas.set("img-a", meta(1, 16));
    coarsePool.entityMetas.set("img-a", meta(3, 16));
    finePool.indirectionDirty = true;
    smallChunkPool.indirectionDirty = true;
    coarsePool.indirectionDirty = true;

    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({
        "img-a": {
          levelPoolKeys: ["ds-0:32x32x32:detail", "ds-0:16x16x16:detail"],
          coarsePoolKey: "ds-0:16x16x16:coarse",
        },
      }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));

    expect(renderer.renderTo).toHaveBeenCalledTimes(1);
    expect(renderer.setTierAtlases).toHaveBeenCalledWith(
      [bindingOf(finePool), bindingOf(smallChunkPool)],
      bindingOf(coarsePool),
    );
    // Every bound pool's indirection is flushed before the draw.
    expect(finePool.indirectionDirty).toBe(false);
    expect(smallChunkPool.indirectionDirty).toBe(false);
    expect(coarsePool.indirectionDirty).toBe(false);
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

    handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a:ch1", entityIndex: 0, blendMode: "additive" }]));

    expect(renderer.renderTo).toHaveBeenCalledTimes(1);
    expect(renderer.setProxyTextures).toHaveBeenCalledWith(tileProxyTexture, null);
    // No chunk tier is bound; the shader takes the proxy path.
    expect(renderer.setTierAtlases).toHaveBeenCalledWith([], null);
    expect(composite).toHaveBeenCalledTimes(1);
  });
});
