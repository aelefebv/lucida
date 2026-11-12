/**
 * What the render worker spends redrawing a collection's minimap for a
 * display edit, a contrast drag's step, at 144, 576 and 2,304 members of two
 * channels each: from the render message as the worker receives it, through
 * the overview draw, on a mock device with the real volume renderer. The
 * cost must not grow with the members. Read the logged p50s.
 */
import { describe, expect, it, vi } from "vitest";
import { describeTiming, expectWithinBudget, timeStep, type StepTiming } from "../test/perfBudget.ts";

(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 };

import type { WorkerCtx } from "./workerContext.ts";
import type { MinimapRenderMessage, OverviewLayers, WorkerToMainMessage } from "./workerProtocol.ts";
import { handleMinimapInit, handleMinimapLayers, handleMinimapRender, handleMinimapUploadOverviewChunks } from "./minimapHandlers.ts";
import { createInitialState } from "./worker/state.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";

const MIB = 1024 * 1024;
const CHANNELS = 2;

/** In nominal microseconds, about twice the typical figure at any of the sizes. */
const DISPLAY_EDIT_BUDGET_US = 120;

function makeDevice(): GPUDevice {
  const resource = () => ({ createView: () => ({}), destroy: () => {} });
  const pass = { setPipeline() {}, setBindGroup() {}, setScissorRect() {}, draw() {}, end() {} };
  return {
    limits: { maxTextureDimension3D: 2048, maxTextureDimension2D: 8192, maxBufferSize: 4096 * MIB, maxStorageBufferBindingSize: 2048 * MIB },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipelineAsync: () => Promise.resolve({}),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    createTexture: () => resource(),
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: () => {} }),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, copyTextureToTexture() {}, finish: () => ({}) }),
    pushErrorScope: () => {},
    popErrorScope: () => Promise.resolve(null),
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
  } as unknown as GPUDevice;
}

/** A worker holding `members` tiles' overviews in a square grid, and the minimap's layers over them. */
async function minimapOf(members: number) {
  const device = makeDevice();
  const renderer = new VolumeRenderer(device);
  await renderer.compiled;
  const lut = { createView: () => ({}) };
  const ctx = {
    device,
    format: "bgra8unorm",
    state: createInitialState(16384 * MIB),
    getVolumeRenderer: () => renderer,
    getCompositor: () => ({ isCompiled: true, compiled: Promise.resolve(), composite: vi.fn(), underlayBackground: vi.fn() }),
    getOrCreateLUT: () => lut,
    post: (_msg: WorkerToMainMessage) => {},
  } as unknown as WorkerCtx;
  const context = { canvas: { width: 0, height: 0 }, configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
  handleMinimapInit(ctx, { type: "minimapInit", canvas: { getContext: () => context } as unknown as OffscreenCanvas });

  const side = Math.ceil(Math.sqrt(members));
  const step = 1.8 / side;
  const keys: string[] = [];
  const matrices = new Float32Array(members * CHANNELS * 32);
  const displays = new Uint32Array(members * CHANNELS);
  for (let m = 0; m < members; m++) {
    // A tile in its grid cell, with a gap around it.
    const model = [step * 0.9, 0, 0, 0, 0, step * 0.9, 0, 0, 0, 0, 1, 0, -0.9 + (m % side) * step, -0.9 + Math.floor(m / side) * step, 0, 1];
    for (let c = 0; c < CHANNELS; c++) {
      handleMinimapUploadOverviewChunks(ctx, {
        type: "minimapUploadOverviewChunksForLayer",
        overviewKey: `m${m}:ch${c}`, datasetId: "ds", imageId: `m${m}`, level: 2, t: 0, c,
        levelWidth: 64, levelHeight: 64, levelDepth: 1, chunkX: 128, chunkY: 128, chunkZ: 1,
        chunks: [{ key: `2/0/${c}/0/0/0`, x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array(128 * 128).buffer }],
        sampleFormat: "u16",
      });
      const at = keys.length;
      keys.push(`m${m}:ch${c}`);
      matrices.set(model, at * 32);
      matrices.set(model, at * 32 + 16);
      displays[at] = c;
    }
  }
  const layers: OverviewLayers = { keys, matrices, displays };
  handleMinimapLayers(ctx, structuredClone({ type: "minimapLayers", layers }));
  return { ctx, renderer };
}

function renderMessage(contrastMax: number, viewProj: Float32Array): MinimapRenderMessage {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    type: "minimapRender",
    displays: [
      { contrastMin: 0, contrastMax, gamma: 1, colormap: "green", blendMode: "additive" },
      { contrastMin: 0, contrastMax, gamma: 1, colormap: "magenta", blendMode: "additive" },
    ],
    invViewProj: identity,
    viewProj,
    eye: new Float32Array(3),
    canvasW: 400,
    canvasH: 400,
    pixelRatio: 2,
  };
}

describe("a collection minimap's redraw", () => {
  it("costs the same for a display edit however many members the collection has", async () => {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const timings = new Map<number, StepTiming>();
    for (const members of [144, 576, 2304]) {
      const { ctx, renderer } = await minimapOf(members);
      const placed = vi.spyOn(renderer, "setMemberInstances");
      let n = 0;
      // A contrast drag's step, as the worker receives it.
      const step = () => handleMinimapRender(ctx, structuredClone(renderMessage(1000 + (n++ % 7), identity)));
      timings.set(members, timeStep(step, { samples: 200, warmup: 20 }));
      expect(placed).toHaveBeenCalledTimes(1);

      // An orbit of the minimap's camera places every overview again, which is per member, and logged for scale.
      let turn = 0;
      const orbit = timeStep(
        () => handleMinimapRender(ctx, structuredClone(renderMessage(1000, new Float32Array(identity).fill(1e-3 * ++turn, 4, 5)))),
        { samples: 40, warmup: 5 },
      );
      console.log(`[minimap redraw] ${members} members x ${CHANNELS} channels: display edit ${describeTiming(timings.get(members)!, DISPLAY_EDIT_BUDGET_US)}`);
      console.log(`[minimap redraw] ${members} members x ${CHANNELS} channels: camera move p50=${orbit.p50Us.toFixed(1)}µs nominal p50=${orbit.nominalUs.toFixed(1)}µs`);
    }
    for (const [members, timing] of timings) expectWithinBudget(`a display edit at ${members} members`, timing, DISPLAY_EDIT_BUDGET_US);
  });
});
