/**
 * What finding room for a chunk costs once the pools are full, at the scale
 * of a zoomed-in three-channel deep volume on a large canvas: each channel's
 * pool holds about a thousand chunks of the 2,560 its view wants at the
 * finest level, the GPU total has no room left, and every wanted chunk that
 * arrives takes the slot of a farther one.
 *
 * The step is one chunk's delivery, as the page sends them, through
 * admission, the growth check, the eviction choice and the write on a mock
 * device. Read the logged p50.
 */
import { describe, it } from "vitest";
import { describeTiming, expectWithinBudget, timeStep } from "../test/perfBudget.ts";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 };

import type { WorkerCtx } from "./workerContext.ts";
import type { Chunk, VolumeChunkDataMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import { createInitialState } from "./worker/state.ts";
import { measureGpuMemory } from "./worker/gpuBudget.ts";
import { applyViewHotState, getOrCreateVolumePool, growVolumeAtlas, handleVolumeChunkData } from "./volume/index.ts";
import { wantedEntryKey } from "./wantedChunks.ts";
import { attachView, fakeDraw } from "./viewIndirectionFixtures.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";

const MIB = 1024 * 1024;
const CHUNK = 64;
const GRID: [number, number, number] = [10, 16, 16];
const CHANNELS = 3;
/** Layers each channel's pool holds, of 96 slots each at this cap: 960 slots. */
const LAYERS = 10;
const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 0 };

/** In nominal microseconds, about twice the typical figure. */
const FIND_ROOM_BUDGET_US = 50;

function makeCtx(): WorkerCtx {
  const resource = () => ({ createView: () => ({}), destroy: () => {} });
  const device = {
    limits: { maxTextureDimension3D: 2048, maxTextureDimension2D: 8192, maxBufferSize: 4096 * MIB, maxStorageBufferBindingSize: 2048 * MIB },
    createTexture: () => resource(),
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: () => {} }),
    createCommandEncoder: () => ({ copyTextureToTexture: () => {}, finish: () => ({}) }),
    pushErrorScope: () => {},
    popErrorScope: () => Promise.resolve(null),
    queue: { writeBuffer: () => {}, writeTexture: () => {}, submit: () => {} },
  } as unknown as GPUDevice;
  return {
    device,
    format: "bgra8unorm",
    state: createInitialState(1536 * MIB),
    post: (_msg: WorkerToMainMessage) => {},
    postWantedSet: () => {},
  } as unknown as WorkerCtx;
}

interface Cell { z: number; y: number; x: number; dist: number }

/** Every finest-level cell, nearest to the volume's center first. */
function cellsByDistance(): Cell[] {
  const [gz, gy, gx] = GRID;
  const cells: Cell[] = [];
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        const dz = (z + 0.5) / gz - 0.5;
        const dy = (y + 0.5) / gy - 0.5;
        const dx = (x + 0.5) / gx - 0.5;
        cells.push({ z, y, x, dist: dx * dx + dy * dy + dz * dz });
      }
    }
  }
  return cells.sort((a, b) => a.dist - b.dist || a.z - b.z || a.y - b.y || a.x - b.x);
}

describe("finding room in a full pool", () => {
  it("costs well under the budget per chunk at a deep volume's scale", () => {
    const ctx = makeCtx();
    const draw = fakeDraw({ datasetId: "ds" });
    ctx.state.draws.set("ds|0", draw);
    const meta: LodIndirectionMeta = {
      level: 0,
      gridDims: GRID,
      chunkDims: [CHUNK, CHUNK, CHUNK],
      levelDims: [600, 1024, 1024],
      offset: 0,
    };
    const cells = cellsByDistance();
    const data = new Uint16Array(CHUNK * CHUNK * CHUNK).buffer;
    const key = (c: number, cell: Cell) => `0/0/${c}/${cell.z}/${cell.y}/${cell.x}`;
    const message = (c: number, cell: Cell): VolumeChunkDataMessage => {
      const chunk: Chunk = { data, dataType: "uint16", x: cell.x, y: cell.y, z: cell.z, key: key(c, cell) };
      return {
        type: "volumeChunkData", epochs: EPOCHS, tier: "detail", memberId: `img:ch${c}`, chunks: [chunk],
        level: 0, t: 0, c, levelWidth: 1024, levelHeight: 1024, levelDepth: 600,
        chunkX: CHUNK, chunkY: CHUNK, chunkZ: CHUNK,
      };
    };

    const wanted = new Map<string, ReadonlySet<string>>();
    const pools: string[] = [];
    for (let c = 0; c < CHANNELS; c++) {
      const member = `img:ch${c}`;
      const poolKey = `ds:ch${c}:${CHUNK}x${CHUNK}x${CHUNK}:detail`;
      const atlas = getOrCreateVolumePool(ctx, poolKey, "ds", CHUNK, CHUNK, CHUNK, c, "u16");
      attachView(atlas, new Map([[member, [meta]]]), { draw });
      growVolumeAtlas(ctx.device, atlas, atlas.slotsY * LAYERS);
      ctx.state.memberToDataset.set(member, "ds");
      wanted.set(wantedEntryKey("detail", member), new Set(cells.map((cell) => key(c, cell))));
      pools.push(poolKey);
    }
    draw.wanted = wanted;
    applyViewHotState(ctx, {
      type: "viewHotState", epochs: EPOCHS, datasetId: "ds", view: 0,
      rayHitsByEntity: Array.from({ length: CHANNELS }, (_, c) => [`img:ch${c}`, [0.5, 0.5, 0.5]] as [string, [number, number, number]]),
    });

    // Fill every pool with its farthest chunks, then hold the GPU total there.
    const slots = ctx.state.volumeAtlases.get(pools[0])!.totalSlots;
    for (let c = 0; c < CHANNELS; c++) {
      for (let i = cells.length - 1; i >= cells.length - slots; i--) {
        handleVolumeChunkData(ctx, message(c, cells[i]), EPOCHS, pools[c], `img:ch${c}`);
      }
    }
    ctx.state.gpuTotalBytes = measureGpuMemory(ctx.state).bytes;

    // Each nearer chunk now takes the slot of the farthest one, channel by channel.
    let next = 0;
    const step = () => {
      const c = next % CHANNELS;
      const cell = cells[Math.floor(next / CHANNELS)];
      next++;
      handleVolumeChunkData(ctx, message(c, cell), EPOCHS, pools[c], `img:ch${c}`);
    };
    const timing = timeStep(step, { samples: 600, warmup: 60 });
    const held = ctx.state.volumeAtlases.get(pools[0])!.slots.size;
    console.log(`[slot search] ${CHANNELS} full pools of ${slots} slots (${held} held): ${describeTiming(timing, FIND_ROOM_BUDGET_US)}`);

    expectWithinBudget("one chunk into a full pool", timing, FIND_ROOM_BUDGET_US);
  });
});
