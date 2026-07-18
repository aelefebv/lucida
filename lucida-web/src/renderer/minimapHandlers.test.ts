import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  TEXTURE_BINDING: 0x04,
  COPY_DST: 0x02,
  RENDER_ATTACHMENT: 0x10,
};

import { GpuResourceBudget } from "./gpuResourceBudget.ts";
import {
  destroyAllMinimapResources,
  handleMinimapInit,
  handleMinimapRender,
  handleMinimapUploadOverviewChunks,
} from "./minimapHandlers.ts";
import { createInitialState } from "./worker/state.ts";
import type { WorkerCtx } from "./workerContext.ts";

afterEach(() => destroyAllMinimapResources());

describe("minimap GPU ownership", () => {
  it("renders 256 layers through one budgeted offscreen target and returns to baseline", () => {
    let nextTexture = 0;
    const textures: Array<{ id: number; destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }> = [];
    const device = {
      createTexture: vi.fn(() => {
        const texture = {
          id: nextTexture++,
          destroy: vi.fn(),
          createView: vi.fn(() => ({})),
        };
        textures.push(texture);
        return texture;
      }),
      createCommandEncoder: vi.fn(() => ({ finish: vi.fn(() => ({})) })),
      queue: { writeTexture: vi.fn(), submit: vi.fn() },
    } as unknown as GPUDevice;
    const renderer = {
      setProxyTextures: vi.fn(),
      setColormapTexture: vi.fn(),
      setVolume: vi.fn(),
      setMatrices: vi.fn(),
      setTransientDescriptor: vi.fn(),
      renderTo: vi.fn(),
    };
    const composite = vi.fn();
    const gpuResources = new GpuResourceBudget(1024 * 1024);
    const context = {
      canvas: { width: 0, height: 0 },
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getCurrentTexture: vi.fn(() => ({ createView: () => ({}) })),
    };
    const canvas = {
      getContext: vi.fn(() => context),
    } as unknown as OffscreenCanvas;
    const ctx = {
      device,
      format: "rgba8unorm",
      gpuResources,
      state: createInitialState(),
      getVolumeRenderer: () => renderer,
      getCompositor: () => ({ composite }),
      getOrCreateLUT: () => ({}),
      post: vi.fn(),
    } as unknown as WorkerCtx;

    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    const ids = Array.from({ length: 256 }, (_, index) => `dataset-${index}`);
    for (const datasetId of ids) {
      handleMinimapUploadOverviewChunks(ctx, {
        type: "minimapUploadOverviewChunksForLayer",
        datasetId,
        chunks: [],
        t: 0,
        c: 0,
        levelWidth: 1,
        levelHeight: 1,
        levelDepth: 1,
        chunkX: 1,
        chunkY: 1,
        chunkZ: 1,
      });
    }
    const identity = new Float32Array(16);
    handleMinimapRender(ctx, {
      type: "minimapRender",
      layers: ids.map((datasetId) => ({
        datasetId,
        modelMatrix: identity,
        invModelMatrix: identity,
        contrastMin: 0,
        contrastMax: 1,
        gamma: 1,
        colormap: "gray",
      })),
      invViewProj: identity,
      eye: new Float32Array(3),
      canvasW: 64,
      canvasH: 64,
    });

    expect(renderer.renderTo).toHaveBeenCalledTimes(256);
    expect(composite).toHaveBeenCalledTimes(256);
    expect(gpuResources.snapshot()).toMatchObject({
      allocationCount: 257,
      byKind: {
        minimap: 256 * 2,
        offscreen: 64 * 64 * 8,
      },
    });
    // 256 tiny overview textures plus exactly one reusable render target.
    expect(device.createTexture).toHaveBeenCalledTimes(257);

    destroyAllMinimapResources();
    expect(gpuResources.snapshot()).toMatchObject({
      usedBytes: 0,
      allocationCount: 0,
    });
    for (const texture of textures) {
      expect(texture.destroy).toHaveBeenCalledTimes(1);
    }
  });
});
