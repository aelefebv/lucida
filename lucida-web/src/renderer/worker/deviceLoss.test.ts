/**
 * Device loss and GPU errors, through the worker dispatcher on a mock device
 * that can be lost, raise uncaught errors, and fail an allocation's error
 * scope: a lost device is replaced on the same canvas with the pools rebuilt
 * empty, an atlas the device could not allocate gives its chunks back, and a
 * chunk that throws mid-batch goes back to the page while the rest lands.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ChunkResidencyMessage,
  ColdStateMessage,
  GpuErrorMessage,
  VolumeChunkDataMessage,
  WorkerToMainMessage,
} from "../workerProtocol.ts";
import { UNTIMED } from "../passTiming.ts";
import { CEILING_BUDGETS } from "../../deviceBudget.ts";
import { createInitialState } from "./state.ts";
import { createWantedSetPoster } from "./bootstrap.ts";
import { dispatchMessage } from "./dispatch.ts";
import { DEVICE_LOSS_WINDOW_MS, MAX_DEVICE_LOSSES, recoverDevice, watchDevice, type DeviceRecovery } from "./deviceLoss.ts";
import { clearGpuErrorReports, GPU_ERROR_REPORT_SPACING_MS } from "./gpuErrors.ts";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 };

interface MockTexture { destroyed: boolean; destroy(): void }

/** A scope the test resolves itself, with the textures allocated inside it. */
interface Scope { textures: MockTexture[]; resolve(error: GPUError | null): void }

function mockDevice() {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const textures: MockTexture[] = [];
  const scopes: Scope[] = [];
  const open: Scope[] = [];
  let onError: ((event: GPUUncapturedErrorEvent) => void) | null = null;
  const writeTexture = vi.fn();
  const device = {
    lost,
    destroy: vi.fn(() => resolveLost({ reason: "destroyed", message: "" } as GPUDeviceLostInfo)),
    addEventListener(type: string, listener: (event: GPUUncapturedErrorEvent) => void) {
      if (type === "uncapturederror") onError = listener;
    },
    createTexture(): MockTexture {
      const texture = { destroyed: false, destroy() { this.destroyed = true; }, createView: () => ({}) };
      textures.push(texture);
      for (const scope of open) scope.textures.push(texture);
      return texture;
    },
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
    createCommandEncoder: () => ({ copyTextureToTexture() {}, finish: () => ({}) }),
    pushErrorScope() {
      open.push({ textures: [], resolve: () => {} });
    },
    popErrorScope(): Promise<GPUError | null> {
      const scope = open.pop()!;
      scopes.push(scope);
      return new Promise((resolve) => {
        scope.resolve = resolve;
      });
    },
    queue: { writeBuffer() {}, writeTexture, submit() {} },
  } as unknown as GPUDevice;
  return {
    device,
    writeTexture,
    lose: (reason: GPUDeviceLostReason = "unknown") =>
      resolveLost({ reason, message: "the GPU process crashed" } as GPUDeviceLostInfo),
    raise: (error: GPUError) => onError?.({ error } as GPUUncapturedErrorEvent),
    /** Answer every scope still waiting: none ran out of memory. */
    settleScopes: () => {
      for (const scope of scopes.splice(0)) scope.resolve(null);
    },
    scopeOf: (texture: GPUTexture) => scopes.find((scope) => scope.textures.includes(texture as unknown as MockTexture)),
    liveTextures: () => textures.filter((texture) => !texture.destroyed).length,
  };
}

function makeCtx(device: GPUDevice): { ctx: WorkerCtx; posts: WorkerToMainMessage[] } {
  const posts: WorkerToMainMessage[] = [];
  const state = createInitialState();
  const post = (msg: WorkerToMainMessage) => {
    posts.push(msg);
  };
  const ctx: WorkerCtx = {
    device,
    context: { configure: vi.fn(), canvas: { width: 8, height: 8 } } as unknown as GPUCanvasContext,
    format: "bgra8unorm",
    state,
    passTimer: UNTIMED,
    getSliceRenderer: () => ({ setTileBorderColor: vi.fn() }) as never,
    getVolumeRenderer: () => ({}) as never,
    getCompositor: () => ({ setBackground: vi.fn() }) as never,
    getCursorRenderer: () => ({ updateCursors: vi.fn() }) as never,
    ensureOffscreenPool: () => [],
    getOrCreateLUT: () => ({}) as GPUTexture,
    post,
    postWantedSet: createWantedSetPoster(state, post),
    lookupEntityDescriptor: () => null,
  };
  return { ctx, posts };
}

function recoveryFor(ctx: WorkerCtx, devices: GPUDevice[]): DeviceRecovery & { tasks: Array<() => Promise<void>> } {
  const tasks: Array<() => Promise<void>> = [];
  return {
    tasks,
    schedule: (task) => {
      tasks.push(task);
    },
    requestDevice: async () => {
      const next = devices.shift();
      if (!next) throw new Error("no adapter");
      return next;
    },
    adopt: (device) => {
      ctx.device = device;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 0 };

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

const display = { contrastMin: 0, contrastMax: 1, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 };

/** One image of 32³ chunks, its target level a 2×2 grid. */
function cold(datasetId: string): ColdStateMessage {
  return {
    type: "coldState",
    epochs: EPOCHS,
    datasetId,
    currentT: 0,
    currentZ: 0,
    multiChannel: false,
    visibleChannels: [0],
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 128],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    // The planner wants the whole target level.
    wantedChunks: [{
      memberId: `${datasetId}-img`,
      tier: "detail",
      chunkKeys: ["1/0/0/0/0/0", "1/0/0/0/0/1", "1/0/0/0/1/0", "1/0/0/0/1/1"],
    }],
    activeSet: [{
      entityId: `${datasetId}-img`,
      imageId: `${datasetId}-img`,
      levels: [
        { level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] },
        { level: 1, chunkShape: [32, 32, 32], gridShape: [1, 2, 2], levelDims: [32, 64, 64] },
        { level: 2, chunkShape: [32, 32, 32], gridShape: [1, 1, 1], levelDims: [16, 32, 32] },
      ],
      detailLevels: [1],
      coarseLevel: 2,
      modelMatrix: identity(),
      invModelMatrix: identity(),
      displayStateByChannel: { 0: display },
    }],
    viewMode: "volume",
    sampleFormat: "u16",
  };
}

/** Target-level chunks at the given (x, y) cells. */
function chunksAt(memberId: string, cells: Array<[number, number]>): VolumeChunkDataMessage {
  return {
    type: "volumeChunkData",
    epochs: EPOCHS,
    tier: "detail",
    memberId,
    chunks: cells.map(([x, y]) => ({
      data: new Uint16Array(32 * 32 * 32).fill(7).buffer,
      dataType: "uint16",
      x, y, z: 0,
      key: `1/0/0/0/${y}/${x}`,
    })),
    level: 1,
    t: 0,
    c: 0,
    levelWidth: 64,
    levelHeight: 64,
    levelDepth: 32,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 32,
  };
}

const DETAIL_POOL = "ds1:32x32x32:detail";

function residency(posts: WorkerToMainMessage[]): ChunkResidencyMessage[] {
  return posts.filter((msg): msg is ChunkResidencyMessage => msg.type === "chunkResidency");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a lost device", () => {
  it("is replaced on the same canvas, with every pool freed and rebuilt empty from the cold state", async () => {
    const first = mockDevice();
    const second = mockDevice();
    const { ctx, posts } = makeCtx(first.device);
    const recovery = recoveryFor(ctx, [second.device]);
    watchDevice(ctx, first.device, recovery);
    await dispatchMessage(ctx, cold("ds1"));
    await dispatchMessage(ctx, chunksAt("ds1-img", [[0, 0]]));
    expect(ctx.state.volumeAtlases.get(DETAIL_POOL)!.slots.size).toBe(1);

    first.lose();
    await flush();
    expect(posts).toContainEqual(expect.objectContaining({ type: "gpuError", kind: "device-lost" }));
    // Recovery waits its turn in the message order.
    expect(recovery.tasks).toHaveLength(1);
    expect(ctx.device).toBe(first.device);

    posts.length = 0;
    await recovery.tasks[0]();

    expect(first.liveTextures()).toBe(0);
    expect(ctx.device).toBe(second.device);
    expect(ctx.context.configure).toHaveBeenCalledWith(expect.objectContaining({ device: second.device }));
    const pool = ctx.state.volumeAtlases.get(DETAIL_POOL)!;
    expect(pool.slots.size).toBe(0);
    expect(second.liveTextures()).toBeGreaterThan(0);
    // The page forgets what it sent before it hears what is missing.
    const restored = posts.findIndex((msg) => msg.type === "gpuDeviceRestored");
    const wanted = posts.findIndex((msg) => msg.type === "wantedSetDelta");
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(wanted).toBeGreaterThan(restored);

    await dispatchMessage(ctx, chunksAt("ds1-img", [[0, 0]]));
    expect(pool.slots.size).toBe(1);
    expect(second.writeTexture).toHaveBeenCalled();
    clearGpuErrorReports(ctx);
  });

  it("is replaced the same way when the test hook destroys it", async () => {
    const first = mockDevice();
    const second = mockDevice();
    const { ctx } = makeCtx(first.device);
    const recovery = recoveryFor(ctx, [second.device]);
    watchDevice(ctx, first.device, recovery);
    await dispatchMessage(ctx, cold("ds1"));

    await dispatchMessage(ctx, { type: "loseDevice" });
    await flush();
    await recovery.tasks[0]();

    expect(first.device.destroy).toHaveBeenCalled();
    expect(ctx.device).toBe(second.device);
    expect(ctx.state.volumeAtlases.has(DETAIL_POOL)).toBe(true);
    clearGpuErrorReports(ctx);
  });

  it("is given up on when it keeps being lost, and the page is told", async () => {
    const devices = Array.from({ length: MAX_DEVICE_LOSSES + 1 }, () => mockDevice().device);
    const { ctx, posts } = makeCtx(mockDevice().device);
    const recovery = recoveryFor(ctx, devices);

    for (let loss = 0; loss < MAX_DEVICE_LOSSES; loss++) await recoverDevice(ctx, recovery, loss * 1000);
    expect(ctx.state.gpuFailed).toBe(false);
    await recoverDevice(ctx, recovery, MAX_DEVICE_LOSSES * 1000);

    expect(ctx.state.gpuFailed).toBe(true);
    expect(posts.at(-1)).toEqual(expect.objectContaining({ type: "gpuFailed" }));
    clearGpuErrorReports(ctx);
  });

  it("is replaced again once its earlier losses leave the window", async () => {
    const devices = Array.from({ length: MAX_DEVICE_LOSSES + 1 }, () => mockDevice().device);
    const { ctx } = makeCtx(mockDevice().device);
    const recovery = recoveryFor(ctx, devices);

    for (let loss = 0; loss <= MAX_DEVICE_LOSSES; loss++) {
      await recoverDevice(ctx, recovery, loss * DEVICE_LOSS_WINDOW_MS);
    }
    expect(ctx.state.gpuFailed).toBe(false);
  });

  it("is given up on when no device can replace it", async () => {
    const { ctx, posts } = makeCtx(mockDevice().device);
    await recoverDevice(ctx, recoveryFor(ctx, []));

    expect(ctx.state.gpuFailed).toBe(true);
    expect(posts).toContainEqual({
      type: "gpuFailed",
      message: "The GPU device was lost and could not be replaced (no adapter)",
    });
  });

  it("is not replaced while the worker tears down", async () => {
    const first = mockDevice();
    const { ctx } = makeCtx(first.device);
    const recovery = recoveryFor(ctx, [mockDevice().device]);
    watchDevice(ctx, first.device, recovery);
    ctx.state.closing = true;

    first.lose("destroyed");
    await flush();

    expect(recovery.tasks).toHaveLength(0);
  });
});

describe("GPU errors", () => {
  it("are reported to the page about once a second per kind, with a count of the ones folded in", () => {
    vi.useFakeTimers();
    const gpu = mockDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    watchDevice(ctx, gpu.device, recoveryFor(ctx, []));
    const reports = () => posts.filter((msg): msg is GpuErrorMessage => msg.type === "gpuError");

    for (let i = 0; i < 4; i++) gpu.raise({ message: `invalid bind group ${i}` } as GPUError);
    expect(reports()).toEqual([{ type: "gpuError", kind: "validation", message: "invalid bind group 0", count: 1 }]);

    vi.advanceTimersByTime(GPU_ERROR_REPORT_SPACING_MS);
    expect(reports()).toHaveLength(2);
    expect(reports()[1]).toEqual({ type: "gpuError", kind: "validation", message: "invalid bind group 1", count: 3 });

    vi.advanceTimersByTime(GPU_ERROR_REPORT_SPACING_MS);
    gpu.raise({ message: "later" } as GPUError);
    expect(reports()).toHaveLength(3);
    clearGpuErrorReports(ctx);
  });

  it("from an atlas the device could not allocate hand its chunks back, halve the GPU total, and rebuild it", async () => {
    const gpu = mockDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1"));
    await dispatchMessage(ctx, chunksAt("ds1-img", [[0, 0], [1, 0]]));
    const lost = ctx.state.volumeAtlases.get(DETAIL_POOL)!;
    expect(lost.slots.size).toBe(2);

    gpu.scopeOf(lost.texture)!.resolve({ message: "out of memory" } as GPUError);
    await flush();

    expect(residency(posts)).toContainEqual({
      type: "chunkResidency",
      memberId: "ds1-img",
      tier: "detail",
      change: "lost",
      keys: ["1/0/0/0/0/0", "1/0/0/0/0/1"],
      reason: "out-of-memory",
    });
    expect(posts).toContainEqual(expect.objectContaining({ type: "gpuError", kind: "out-of-memory" }));
    expect((lost.texture as unknown as MockTexture).destroyed).toBe(true);
    expect(ctx.state.gpuTotalBytes).toBe(CEILING_BUDGETS.gpuTotalBytes / 2);
    const rebuilt = ctx.state.volumeAtlases.get(DETAIL_POOL)!;
    expect(rebuilt).not.toBe(lost);
    expect(rebuilt.slots.size).toBe(0);
    expect(rebuilt.entityMetas).toBe(lost.entityMetas);
    expect(rebuilt.indirectionData.length).toBe(lost.indirectionData.length);
    expect(rebuilt.indirectionData.every((entry) => entry === 0xFFFFFFFF)).toBe(true);
    gpu.settleScopes();
    clearGpuErrorReports(ctx);
  });
});

describe("a chunk that throws mid-batch", () => {
  it("goes back to the page as not resident, and the rest of the batch lands", async () => {
    const gpu = mockDevice();
    const { ctx, posts } = makeCtx(gpu.device);
    await dispatchMessage(ctx, cold("ds1"));
    const pool = ctx.state.volumeAtlases.get(DETAIL_POOL)!;
    const free = pool.freeSlots.length;
    gpu.writeTexture
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new TypeError("detached buffer");
      });

    await expect(
      dispatchMessage(ctx, chunksAt("ds1-img", [[0, 0], [1, 0], [0, 1]])),
    ).rejects.toThrow("detached buffer");

    expect([...pool.slots.keys()].sort()).toEqual(["ds1-img|1/0/0/0/0/0", "ds1-img|1/0/0/0/1/0"]);
    expect(pool.freeSlots.length).toBe(free - 2);
    expect(residency(posts)).toEqual([
      { type: "chunkResidency", memberId: "ds1-img", tier: "detail", change: "held", keys: ["1/0/0/0/0/0", "1/0/0/0/1/0"], reason: undefined },
      { type: "chunkResidency", memberId: "ds1-img", tier: "detail", change: "refused", keys: ["1/0/0/0/0/1"], reason: "upload-failed" },
    ]);
    gpu.settleScopes();
  });
});
