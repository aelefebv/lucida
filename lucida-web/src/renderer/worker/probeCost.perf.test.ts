/**
 * What a hover's probe costs the render worker over a large collection in
 * 3D: 576 tiles of two channels, a layer each, laid out in a grid that fills
 * the view. The point is over one tile, so two layers are marched.
 *
 * The first step probes a frame already probed, as a pointer moving over a
 * still view does; the second probes each frame once, as a pointer resting
 * while the view draws frames does. Read the logged p50s: carrying the ray
 * into every layer's cube, and finding every layer's member, at every probe
 * cost about 850 µs a probe at this size, most of it for the layers the point
 * misses.
 */
import { describe, it } from "vitest";
import { describeTiming, expectWithinBudget, timeStep } from "../../test/perfBudget.ts";

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateActiveEntry, ColdStateMessage, VolumeLayerParams, VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { AtlasState, LodIndirectionMeta } from "../volume/atlas.ts";
import { fakeDraw } from "../viewIndirectionFixtures.ts";
import { createInitialState } from "./state.ts";
import { handleProbe } from "./probe.ts";

// The read-back names these, and node has neither.
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { MAP_READ: 0x01, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 0x01 };

const SIDE = 24;
const CHANNELS = 2;

/** In nominal microseconds, about twice the typical figure. Most of it marches the two layers under the point. */
const REPEAT_BUDGET_US = 180;
/** Also twice the typical figure, about half of it each layer's screen bounds. */
const FIRST_BUDGET_US = 600;

/** The tile at grid `(col, row)`: a box over its cell of NDC, which the camera takes as world space. */
function tileMatrices(col: number, row: number): { model: Float32Array; inv: Float32Array } {
  const cell = 2 / SIDE;
  const [w, d] = [cell * 0.9, 0.2];
  const [x0, y0, z0] = [-1 + col * cell, 1 - (row + 1) * cell, -d / 2];
  return {
    model: new Float32Array([w, 0, 0, 0, 0, w, 0, 0, 0, 0, d, 0, x0, y0, z0, 1]),
    inv: new Float32Array([1 / w, 0, 0, 0, 0, 1 / w, 0, 0, 0, 0, 1 / d, 0, -x0 / w, -y0 / w, -z0 / d, 1]),
  };
}

function collectionFrame() {
  const state = createInitialState();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // Every tile is 16x128x128 samples in one brick, each in a pool of its own channel.
  const meta: LodIndirectionMeta = { level: 0, levelDims: [16, 128, 128], chunkDims: [16, 128, 128], gridDims: [1, 1, 1], offset: 0 };
  const activeSet: ColdStateActiveEntry[] = [];
  const layers: VolumeLayerParams[] = [];
  const draw = fakeDraw({ datasetId: "ds", mode: "volume" });
  const sourceBindingByMember = new Map<string, { levelPoolKeys: string[]; coarsePoolKey: null }>();
  const entityMetas = Array.from({ length: CHANNELS }, () => new Map<string, LodIndirectionMeta[]>());
  for (let row = 0; row < SIDE; row++) {
    for (let col = 0; col < SIDE; col++) {
      const imageId = `tile-${row}-${col}`;
      const { model, inv } = tileMatrices(col, row);
      activeSet.push({
        entityId: imageId,
        imageId,
        levels: [{ level: 0, chunkShape: [16, 128, 128], gridShape: [1, 1, 1], levelDims: [16, 128, 128] }],
        detailLevels: [0],
        coarseLevel: null,
        modelMatrix: model,
        invModelMatrix: inv,
        displayStateByChannel: Object.fromEntries(Array.from({ length: CHANNELS }, (_, c) => [
          c, { contrastMin: 0, contrastMax: 1000, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 << c },
        ])),
      });
      for (let c = 0; c < CHANNELS; c++) {
        const memberId = `${imageId}:ch${c}`;
        state.memberToDataset.set(memberId, "ds");
        draw.sources.set(memberId, [{ tier: "detail", poolKey: `pool${c}`, meta }]);
        sourceBindingByMember.set(memberId, { levelPoolKeys: [`pool${c}`], coarsePoolKey: null });
        entityMetas[c].set(memberId, [meta]);
      }
    }
  }
  for (let c = 0; c < CHANNELS; c++) {
    for (const entry of activeSet) {
      layers.push({ datasetId: `${entry.imageId}:ch${c}`, blendMode: "additive", renderMode: "translucent", entityIndex: layers.length });
    }
    state.volumeAtlases.set(`pool${c}`, {
      texture: {} as GPUTexture,
      format: "u16",
      slotsX: 1,
      slotsY: 1,
      slotsZ: 1,
      views: new Map([[0, { indirectionData: new Uint32Array([0]), entityMetas: entityMetas[c] }]]),
    } as unknown as AtlasState);
  }
  draw.cold = { type: "coldState", datasetId: "ds", visibleChannels: [0, 1], activeSet, sampleFormat: "u16" } as unknown as ColdStateMessage;
  draw.descriptor = { sourceBindingByMember } as unknown as EntityDescriptorIndex;
  state.draws.set("ds|0", draw);
  const frame: VolumeRenderMultiPassMessage = {
    type: "volumeRenderMultiPass",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    layers,
    invViewProj: identity,
    viewProj: identity,
    eye: new Float32Array([0, 0, -2]),
    camForward: new Float32Array([0, 0, 1]),
    view: 0,
    canvasW: 1600,
    canvasH: 1600,
    rect: [0, 0, 1600, 1600],
    fullW: 1600,
    fullH: 1600,
  };
  state.lastFrames.set(0, frame);
  const ctx = {
    state,
    device: {
      createBuffer: () => ({ mapAsync: () => new Promise<void>(() => {}), getMappedRange: () => new ArrayBuffer(0), unmap() {}, destroy() {} }),
      createCommandEncoder: () => ({ copyTextureToBuffer() {}, finish: () => ({}) }),
      queue: { submit() {} },
    },
    post() {},
  } as unknown as WorkerCtx;
  return { ctx, frame };
}

describe("a hover's probe over a 3D collection of 576 two-channel tiles", () => {
  // Points over tiles near the middle, each probe at the next.
  const points = Array.from({ length: 16 }, (_, i) => ({ x: 0.3 + (i % 4) * 0.13, y: 0.3 + Math.floor(i / 4) * 0.13 }));

  it("costs the layers under the point when the frame was probed before", () => {
    const { ctx } = collectionFrame();
    let n = 0;
    const step = () => {
      const { x, y } = points[n++ % points.length];
      handleProbe(ctx, { type: "probe", id: n, x, y });
    };
    const timing = timeStep(step, { samples: 400, warmup: 40 });
    console.log(`[probe] a frame probed before: ${describeTiming(timing, REPEAT_BUDGET_US)}`);

    expectWithinBudget("a probe of a frame probed before", timing, REPEAT_BUDGET_US);
  });

  it("finds each layer's member and bounds once at a frame's first probe", () => {
    const { ctx, frame } = collectionFrame();
    let n = 0;
    const step = () => {
      const { x, y } = points[n++ % points.length];
      handleProbe(ctx, { type: "probe", id: n, x, y });
    };
    // A new frame message with the same layers, as each frame of a gesture sends.
    const before = () => ctx.state.lastFrames.set(0, { ...frame, layers: [...frame.layers] });
    const timing = timeStep(step, { samples: 200, warmup: 20, before });
    console.log(`[probe] a frame's first probe: ${describeTiming(timing, FIRST_BUDGET_US)}`);

    expectWithinBudget("a frame's first probe", timing, FIRST_BUDGET_US);
  });
});
