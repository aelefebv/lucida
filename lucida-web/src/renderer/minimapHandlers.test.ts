import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 };

import type { TransientDescriptorParams } from "./descriptor/transient.ts";
import type { VolumeMemberDraw } from "./volumeRenderer.ts";
import type { WorkerCtx } from "./workerContext.ts";
import type { MinimapRenderMessage, ThumbnailRenderMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import {
  handleMinimapDestroy,
  handleMinimapInit,
  handleMinimapRender,
  handleMinimapUploadOverviewChunks,
  handleThumbnailRender,
} from "./minimapHandlers.ts";
import { createInitialState } from "./worker/state.ts";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A volume renderer whose compile the test finishes, or fails, by hand. */
function makeVolumeRenderer() {
  let finish!: () => void;
  let reject!: (err: Error) => void;
  const compiled = new Promise<void>((resolve, rej) => {
    finish = resolve;
    reject = rej;
  });
  const renderer = {
    isCompiled: false,
    compiled,
    setPixelRatio: vi.fn(),
    setMatrices: vi.fn(),
    writeDescriptorTable: vi.fn((_set: string, _descriptors: TransientDescriptorParams[]) => ({})),
    prepareMembers: vi.fn((_set: string, _draws: VolumeMemberDraw[]) => {}),
    renderMembers: vi.fn(),
    transientDepthView: vi.fn(() => ({})),
  };
  return {
    renderer,
    compile() {
      renderer.isCompiled = true;
      finish();
    },
    fail(message: string) {
      reject(new Error(message));
    },
  };
}

function makeCtx(renderer: ReturnType<typeof makeVolumeRenderer>["renderer"]) {
  const posts: WorkerToMainMessage[] = [];
  const composite = vi.fn();
  const texture = { createView: () => ({}), destroy: vi.fn() };
  const ctx = {
    device: {
      createTexture: vi.fn(() => texture),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createCommandEncoder: () => ({ finish: () => ({}) }),
      pushErrorScope: vi.fn(),
      popErrorScope: () => Promise.resolve(null),
      queue: { submit: vi.fn(), writeTexture: vi.fn(), writeBuffer: vi.fn() },
    },
    state: createInitialState(),
    format: "bgra8unorm",
    getVolumeRenderer: () => renderer,
    getCompositor: () => ({ isCompiled: true, compiled: Promise.resolve(), composite, underlayBackground: vi.fn() }),
    getOrCreateLUT: () => ({}),
    post(msg: WorkerToMainMessage) {
      posts.push(msg);
    },
  } as unknown as WorkerCtx;
  return { ctx, composite, posts };
}

/** The minimap's canvas as the main thread transfers it, with its size readable. */
function minimapCanvas() {
  const context = {
    canvas: { width: 0, height: 0 },
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: () => ({ createView: () => ({}) }),
  };
  const canvas = { getContext: () => context } as unknown as OffscreenCanvas;
  return { canvas, size: context.canvas };
}

function uploadOverview(ctx: WorkerCtx): void {
  handleMinimapUploadOverviewChunks(ctx, {
    type: "minimapUploadOverviewChunksForLayer",
    datasetId: "ds",
    imageId: "ds",
    level: 3,
    t: 0,
    c: 0,
    levelWidth: 2,
    levelHeight: 2,
    levelDepth: 1,
    chunkX: 2,
    chunkY: 2,
    chunkZ: 1,
    chunks: [{ key: "3/0/0/0/0/0", x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array([1, 2, 3, 4]).buffer }],
    sampleFormat: "u16",
  });
}

function renderMsg(canvasW: number): MinimapRenderMessage {
  return {
    type: "minimapRender",
    layers: [{
      datasetId: "ds",
      modelMatrix: IDENTITY,
      invModelMatrix: IDENTITY,
      contrastMin: 0,
      contrastMax: 1,
      gamma: 1,
      colormap: "gray",
      blendMode: "alpha",
    }],
    invViewProj: IDENTITY,
    viewProj: IDENTITY,
    eye: new Float32Array(3),
    canvasW,
    canvasH: canvasW,
    pixelRatio: 1,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the minimap's overview render", () => {
  it("draws at once when the volume renderer has compiled", () => {
    const { renderer, compile } = makeVolumeRenderer();
    compile();
    const { ctx, composite } = makeCtx(renderer);
    const { canvas } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    uploadOverview(ctx);

    handleMinimapRender(ctx, renderMsg(100));

    expect(renderer.renderMembers).toHaveBeenCalledOnce();
    expect(composite).toHaveBeenCalledOnce();
  });

  // The reason is on `handleMinimapRender` in minimapHandlers.ts.
  it("defers its draw until the volume renderer has compiled and then draws the latest request once", async () => {
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx, composite } = makeCtx(renderer);
    const { canvas, size } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    uploadOverview(ctx);

    handleMinimapRender(ctx, renderMsg(100));
    handleMinimapRender(ctx, renderMsg(200));
    await flush();
    expect(renderer.renderMembers).not.toHaveBeenCalled();

    compile();
    await flush();
    expect(renderer.renderMembers).toHaveBeenCalledOnce();
    expect(composite).toHaveBeenCalledOnce();
    expect(size.width).toBe(200);

    handleMinimapRender(ctx, renderMsg(300));
    expect(renderer.renderMembers).toHaveBeenCalledTimes(2);
  });

  it("drops a deferred draw when the minimap was destroyed before the pipelines compiled", async () => {
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx } = makeCtx(renderer);
    const { canvas } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    uploadOverview(ctx);

    handleMinimapRender(ctx, renderMsg(100));
    handleMinimapDestroy(ctx.state.minimap);
    compile();
    await flush();

    expect(renderer.renderMembers).not.toHaveBeenCalled();
  });

  it("reports a compile that failed, since no frame on a slice page awaits it", async () => {
    const { renderer, fail } = makeVolumeRenderer();
    const { ctx, posts } = makeCtx(renderer);
    const { canvas } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    uploadOverview(ctx);

    handleMinimapRender(ctx, renderMsg(100));
    fail("volume shader refused");
    await flush();

    expect(renderer.renderMembers).not.toHaveBeenCalled();
    expect(posts).toEqual([
      { type: "error", message: "volume shader refused" },
    ]);
  });

  it("draws members whose places do not meet through one target, in one pass and one composite", () => {
    const { renderer, compile } = makeVolumeRenderer();
    compile();
    const { ctx, composite } = makeCtx(renderer);
    const createTexture = ctx.device.createTexture as unknown as ReturnType<typeof vi.fn>;
    handleMinimapInit(ctx, { type: "minimapInit", canvas: minimapCanvas().canvas });
    const members = ["m0", "m1", "m2"];
    for (const id of members) {
      handleMinimapUploadOverviewChunks(ctx, {
        type: "minimapUploadOverviewChunksForLayer",
        datasetId: `${id}:ch0`,
        imageId: id,
        level: 0,
        t: 0,
        c: 0,
        levelWidth: 2,
        levelHeight: 2,
        levelDepth: 1,
        chunkX: 2,
        chunkY: 2,
        chunkZ: 1,
        chunks: [{ key: "0/0/0/0/0/0", x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array(4).buffer }],
        sampleFormat: "u16",
      });
    }
    const texturesBefore = createTexture.mock.calls.length;

    const msg = renderMsg(100);
    // Side by side across the canvas: each member's unit cube a third of the clip space wide.
    const placed = (i: number) => new Float32Array([0.6, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, -1 + 0.65 * i, -1, 0, 1]);
    msg.layers = members.map((id, i) => ({ ...msg.layers[0], datasetId: `${id}:ch0`, modelMatrix: placed(i) }));
    handleMinimapRender(ctx, msg);

    expect(renderer.writeDescriptorTable.mock.calls[0][1]).toHaveLength(3);
    expect(renderer.prepareMembers.mock.calls[0][1].map((d) => d.entityIndex)).toEqual([0, 1, 2]);
    expect(renderer.renderMembers).toHaveBeenCalledOnce();
    expect(renderer.renderMembers.mock.calls[0][1]).toEqual([0, 1, 2]);
    expect(createTexture.mock.calls.length - texturesBefore).toBe(1);
    expect(composite.mock.calls.map((call) => [call[1].length, call[3]])).toEqual([[1, true]]);
  });

  it("composites members that overlap one at a time, in their order", () => {
    const { renderer, compile } = makeVolumeRenderer();
    compile();
    const { ctx, composite } = makeCtx(renderer);
    handleMinimapInit(ctx, { type: "minimapInit", canvas: minimapCanvas().canvas });
    for (const id of ["m0", "m1"]) {
      handleMinimapUploadOverviewChunks(ctx, {
        type: "minimapUploadOverviewChunksForLayer",
        datasetId: `${id}:ch0`,
        imageId: id,
        level: 0,
        t: 0,
        c: 0,
        levelWidth: 2,
        levelHeight: 2,
        levelDepth: 1,
        chunkX: 2,
        chunkY: 2,
        chunkZ: 1,
        chunks: [{ key: "0/0/0/0/0/0", x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array(4).buffer }],
        sampleFormat: "u16",
      });
    }

    const msg = renderMsg(100);
    msg.layers = ["m0", "m1"].map((id) => ({ ...msg.layers[0], datasetId: `${id}:ch0` }));
    handleMinimapRender(ctx, msg);

    expect(renderer.renderMembers.mock.calls.map((call) => call[1])).toEqual([[0], [1]]);
    expect(composite.mock.calls.map((call) => call[3])).toEqual([true, false]);
  });

  it("draws each chunk at its place, a missing one as nothing and a failed one as failed", () => {
    const { renderer, compile } = makeVolumeRenderer();
    compile();
    const { ctx } = makeCtx(renderer);
    const writeBuffer = (ctx.device.queue as unknown as { writeBuffer: ReturnType<typeof vi.fn> }).writeBuffer;
    handleMinimapInit(ctx, { type: "minimapInit", canvas: minimapCanvas().canvas });
    // A 2x2 grid of 2x2 chunks, of which the first arrived.
    handleMinimapUploadOverviewChunks(ctx, {
      type: "minimapUploadOverviewChunksForLayer",
      datasetId: "ds:ch0",
      imageId: "ds",
      level: 3,
      t: 0,
      c: 0,
      levelWidth: 4,
      levelHeight: 4,
      levelDepth: 1,
      chunkX: 2,
      chunkY: 2,
      chunkZ: 1,
      chunks: [{ key: "3/0/0/0/0/0", x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array(4).buffer }],
      sampleFormat: "u16",
    });
    // The last chunk failed for good, and a failed chunk of another level marks nothing.
    ctx.state.failedByDataset.set("ds", new Map([["ds", new Set(["3/0/0/0/1/1", "2/0/0/0/1/0"])]]));

    const msg = renderMsg(100);
    msg.layers[0].datasetId = "ds:ch0";
    handleMinimapRender(ctx, msg);

    const written = writeBuffer.mock.calls.at(-1)![2] as Uint32Array;
    expect([...written]).toEqual([0, 0xffffffff, 0xffffffff, 0xfffffffe]);
    expect(renderer.prepareMembers.mock.calls.at(-1)![1][0].levels[0]).toMatchObject({ slotsX: 2, slotsY: 2, slotsZ: 1 });
    expect(renderer.writeDescriptorTable.mock.calls.at(-1)![1][0].chunkGrid).toEqual({
      gridDims: [2, 2, 1],
      chunkDims: [2, 2, 1],
    });
  });
});

describe("a thumbnail render", () => {
  function fakeOffscreenCanvas(bitmap: { close: () => void }) {
    return class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => ({ createView: () => ({}) }) };
      }
      transferToImageBitmap() {
        return bitmap;
      }
    };
  }

  function thumbnailMsg(): ThumbnailRenderMessage {
    return {
      type: "thumbnailRender",
      id: 7,
      layers: renderMsg(64).layers,
      invViewProj: IDENTITY,
      viewProj: IDENTITY,
      eye: new Float32Array(3),
      size: 64,
      pixelRatio: 1,
    };
  }

  it("waits for the volume renderer outside the message order, then draws and replies", async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal("OffscreenCanvas", fakeOffscreenCanvas(bitmap));
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx, posts } = makeCtx(renderer);
    uploadOverview(ctx);
    const replies = () => posts.filter((post) => post.type === "thumbnailResult");

    expect(handleThumbnailRender(ctx, thumbnailMsg())).toBeUndefined();
    await flush();
    expect(renderer.renderMembers).not.toHaveBeenCalled();
    expect(replies()).toEqual([]);

    compile();
    await flush();
    expect(renderer.renderMembers).toHaveBeenCalledOnce();
    expect(replies()).toEqual([{ type: "thumbnailResult", id: 7, bitmap }]);
  });

  it("answers with no bitmap and reports the failure when the compile fails", async () => {
    vi.stubGlobal("OffscreenCanvas", fakeOffscreenCanvas({ close: vi.fn() }));
    const { renderer, fail } = makeVolumeRenderer();
    const { ctx, posts } = makeCtx(renderer);
    uploadOverview(ctx);

    handleThumbnailRender(ctx, thumbnailMsg());
    fail("volume shader refused");
    await flush();

    expect(renderer.renderMembers).not.toHaveBeenCalled();
    expect(posts).toEqual([
      { type: "thumbnailResult", id: 7, bitmap: null },
      { type: "error", message: "volume shader refused" },
    ]);
  });
});
