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
import type { MemberBatch, MemberInstance, VolumeMemberDraw } from "./volumeRenderer.ts";
import type { WorkerCtx } from "./workerContext.ts";
import type {
  MinimapRenderMessage,
  MinimapUploadOverviewChunksForLayerMessage,
  OverviewDisplay,
  OverviewLayers,
  ThumbnailRenderMessage,
  WorkerToMainMessage,
} from "./workerProtocol.ts";
import {
  handleMinimapDestroy,
  handleMinimapInit,
  handleMinimapLayers,
  handleMinimapRender,
  handleMinimapUploadOverviewChunks,
  handleThumbnailRender,
} from "./minimapHandlers.ts";
import { markOverviewsFailed } from "./overviewAtlas.ts";
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
    setMemberInstances: vi.fn((_set: string, _instances: MemberInstance[], _w: number, _h: number) => {}),
    renderMemberBatch: vi.fn((_set: string, _batch: MemberBatch) => {}),
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
  const ctx = {
    device: {
      createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createCommandEncoder: () => ({ copyTextureToTexture: vi.fn(), finish: () => ({}) }),
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

/** One member's channel `c`: a 2x2 level in one chunk, which arrives. */
function overviewUpload(member: string, c = 0, over: Partial<MinimapUploadOverviewChunksForLayerMessage> = {}): MinimapUploadOverviewChunksForLayerMessage {
  return {
    type: "minimapUploadOverviewChunksForLayer",
    overviewKey: `${member}:ch${c}`,
    datasetId: "ds",
    imageId: member,
    level: 3,
    t: 0,
    c,
    levelWidth: 2,
    levelHeight: 2,
    levelDepth: 1,
    chunkX: 2,
    chunkY: 2,
    chunkZ: 1,
    chunks: [{ key: `3/0/${c}/0/0/0`, x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array([1, 2, 3, 4]).buffer }],
    sampleFormat: "u16",
    ...over,
  };
}

/** Overview layers placing each key by its model matrix, all taking display `display`. */
function layersOf(keys: string[], model: (i: number) => Float32Array = () => IDENTITY, display = (_i: number) => 0): OverviewLayers {
  const matrices = new Float32Array(keys.length * 32);
  keys.forEach((_key, i) => {
    matrices.set(model(i), i * 32);
    matrices.set(IDENTITY, i * 32 + 16);
  });
  return { keys, matrices, displays: Uint32Array.from(keys, (_key, i) => display(i)) };
}

function display(over: Partial<OverviewDisplay> = {}): OverviewDisplay {
  return { contrastMin: 0, contrastMax: 1, gamma: 1, colormap: "gray", blendMode: "alpha", ...over };
}

function renderMsg(canvasW: number, displays: Array<OverviewDisplay | null> = [display()]): MinimapRenderMessage {
  return {
    type: "minimapRender",
    displays,
    invViewProj: IDENTITY,
    viewProj: IDENTITY,
    eye: new Float32Array(3),
    canvasW,
    canvasH: canvasW,
    pixelRatio: 1,
  };
}

/** Members side by side across the canvas: each one's unit cube a fifth of the clip space wide. */
function sideBySide(i: number): Float32Array {
  return new Float32Array([0.3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, -1 + 0.4 * i, -1, 0, 1]);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the minimap's overview render", () => {
  function ready() {
    const { renderer, compile } = makeVolumeRenderer();
    compile();
    const made = makeCtx(renderer);
    handleMinimapInit(made.ctx, { type: "minimapInit", canvas: minimapCanvas().canvas });
    return { renderer, ...made };
  }

  it("draws at once when the volume renderer has compiled", () => {
    const { renderer, ctx, composite } = ready();
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds"));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["ds:ch0"]) });

    handleMinimapRender(ctx, renderMsg(100));

    expect(renderer.renderMemberBatch).toHaveBeenCalledOnce();
    expect(composite).toHaveBeenCalledOnce();
  });

  // The reason is on `handleMinimapRender` in minimapHandlers.ts.
  it("defers its draw until the volume renderer has compiled and then draws the latest request once", async () => {
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx, composite } = makeCtx(renderer);
    const { canvas, size } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds"));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["ds:ch0"]) });

    handleMinimapRender(ctx, renderMsg(100));
    handleMinimapRender(ctx, renderMsg(200));
    await flush();
    expect(renderer.renderMemberBatch).not.toHaveBeenCalled();

    compile();
    await flush();
    expect(renderer.renderMemberBatch).toHaveBeenCalledOnce();
    expect(composite).toHaveBeenCalledOnce();
    expect(size.width).toBe(200);

    handleMinimapRender(ctx, renderMsg(300));
    expect(renderer.renderMemberBatch).toHaveBeenCalledTimes(2);
  });

  it("drops a deferred draw when the minimap was destroyed before the pipelines compiled", async () => {
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx } = makeCtx(renderer);
    handleMinimapInit(ctx, { type: "minimapInit", canvas: minimapCanvas().canvas });
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds"));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["ds:ch0"]) });

    handleMinimapRender(ctx, renderMsg(100));
    handleMinimapDestroy(ctx.state.minimap);
    compile();
    await flush();

    expect(renderer.renderMemberBatch).not.toHaveBeenCalled();
  });

  it("reports a compile that failed, since no frame on a slice page awaits it", async () => {
    const { renderer, fail } = makeVolumeRenderer();
    const { ctx, posts } = makeCtx(renderer);
    handleMinimapInit(ctx, { type: "minimapInit", canvas: minimapCanvas().canvas });
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds"));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["ds:ch0"]) });

    handleMinimapRender(ctx, renderMsg(100));
    fail("volume shader refused");
    await flush();

    expect(renderer.renderMemberBatch).not.toHaveBeenCalled();
    expect(posts).toEqual([
      { type: "error", message: "volume shader refused" },
    ]);
  });

  it("draws a channel of members whose places do not meet as one batch with one draw, however many members", () => {
    for (const count of [2, 5]) {
      const { renderer, ctx, composite } = ready();
      const members = Array.from({ length: count }, (_, i) => `m${i}`);
      const keys: string[] = [];
      for (const id of members) {
        for (const c of [0, 1]) {
          handleMinimapUploadOverviewChunks(ctx, overviewUpload(id, c));
          keys.push(`${id}:ch${c}`);
        }
      }
      // Each member's two channels, at its place, the second channel added over the first.
      const layers = layersOf(keys, (i) => sideBySide(Math.floor(i / 2)), (i) => i % 2);
      handleMinimapLayers(ctx, { type: "minimapLayers", layers });
      handleMinimapRender(ctx, renderMsg(100, [display({ colormap: "green" }), display({ colormap: "magenta", blendMode: "additive" })]));

      // One atlas holds every overview: one draw per channel.
      expect(renderer.writeDescriptorTable.mock.calls[0][1]).toHaveLength(2 * count);
      expect(renderer.prepareMembers.mock.calls[0][1].map((draw) => draw.display?.contrastMax)).toEqual([1, 1]);
      expect(new Set(renderer.prepareMembers.mock.calls[0][1].map((draw) => draw.levels[0]!.texture)).size).toBe(1);
      const batches = renderer.renderMemberBatch.mock.calls.map((call) => call[1]);
      expect(batches.map(({ count: n, draws }) => [n, draws])).toEqual([[count, [0]], [count, [1]]]);
      const instances = renderer.setMemberInstances.mock.calls[0][1];
      expect(instances.map(({ entityIndex, draw }) => [entityIndex, draw])).toEqual(
        Array.from({ length: count }, (_, i) => [2 * i, 0]).concat(Array.from({ length: count }, (_, i) => [2 * i + 1, 1])),
      );
      expect(composite.mock.calls.map((call) => [call[1][0].blendMode, call[3]])).toEqual([["alpha", true], ["additive", false]]);
    }
  });

  it("composites members that overlap one at a time, in their order", () => {
    const { renderer, ctx, composite } = ready();
    for (const id of ["m0", "m1"]) handleMinimapUploadOverviewChunks(ctx, overviewUpload(id));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["m0:ch0", "m1:ch0"]) });

    handleMinimapRender(ctx, renderMsg(100));

    expect(renderer.renderMemberBatch.mock.calls.map((call) => [call[1].first, call[1].count])).toEqual([[0, 1], [1, 1]]);
    expect(composite.mock.calls.map((call) => call[3])).toEqual([true, false]);
  });

  it("redraws a display edit with the camera still without writing anything per overview", () => {
    const { renderer, ctx } = ready();
    const keys = ["m0", "m1", "m2"].map((id) => `${id}:ch0`);
    for (const id of ["m0", "m1", "m2"]) handleMinimapUploadOverviewChunks(ctx, overviewUpload(id));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(keys, sideBySide) });

    handleMinimapRender(ctx, renderMsg(100, [display({ contrastMax: 10 })]));
    handleMinimapRender(ctx, renderMsg(100, [display({ contrastMax: 20 })]));

    expect(renderer.writeDescriptorTable).toHaveBeenCalledOnce();
    expect(renderer.setMemberInstances).toHaveBeenCalledOnce();
    expect(renderer.prepareMembers.mock.calls.map((call) => call[1].map((draw) => draw.display?.contrastMax))).toEqual([[10], [20]]);
    expect(renderer.renderMemberBatch).toHaveBeenCalledTimes(2);

    // A camera move places them again, and an overview that opens lays them out again.
    handleMinimapRender(ctx, { ...renderMsg(100), viewProj: sideBySide(1) });
    expect(renderer.setMemberInstances).toHaveBeenCalledTimes(2);
    expect(renderer.writeDescriptorTable).toHaveBeenCalledOnce();
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("m3"));
    handleMinimapRender(ctx, renderMsg(100));
    expect(renderer.writeDescriptorTable).toHaveBeenCalledTimes(2);
  });

  it("leaves out an overview not yet open, and a channel no longer shown", () => {
    const { renderer, ctx } = ready();
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("m0", 0));
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("m0", 1));
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["m0:ch0", "m0:ch1", "m1:ch0"], () => IDENTITY, (i) => i % 2) });

    handleMinimapRender(ctx, renderMsg(100, [display(), null]));

    expect(renderer.writeDescriptorTable.mock.calls[0][1]).toHaveLength(1);
    expect(renderer.setMemberInstances.mock.calls[0][1]).toHaveLength(1);
  });

  it("draws each chunk at its slot, a missing one as nothing and a failed one as failed", () => {
    const { renderer, ctx } = ready();
    const writeBuffer = (ctx.device.queue as unknown as { writeBuffer: ReturnType<typeof vi.fn> }).writeBuffer;
    // A 2x2 grid of 2x2 chunks, of which the first arrived.
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds", 0, { levelWidth: 4, levelHeight: 4 }));
    // The last chunk failed for good, and a failed chunk of another level marks nothing.
    ctx.state.failedByDataset.set("ds", new Map([["ds", new Set(["3/0/0/0/1/1", "2/0/0/0/1/0"])]]));
    markOverviewsFailed(ctx, ctx.state.minimap.atlases);
    handleMinimapLayers(ctx, { type: "minimapLayers", layers: layersOf(["ds:ch0"]) });

    handleMinimapRender(ctx, renderMsg(100));

    const [, offset, written, start, length] = writeBuffer.mock.calls.at(-1)!;
    expect([offset, start, length]).toEqual([0, 0, 4]);
    const slot = (written as Uint32Array)[0];
    expect([...(written as Uint32Array)]).toEqual([slot, 0xffffffff, 0xffffffff, 0xfffffffe]);
    expect(renderer.writeDescriptorTable.mock.calls.at(-1)![1][0].chunkGrid).toEqual({
      gridDims: [2, 2, 1],
      chunkDims: [2, 2, 1],
      indirectionOffset: 0,
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
      layers: layersOf(["ds:ch0"]),
      displays: [display()],
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
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds"));
    const replies = () => posts.filter((post) => post.type === "thumbnailResult");

    expect(handleThumbnailRender(ctx, thumbnailMsg())).toBeUndefined();
    await flush();
    expect(renderer.renderMemberBatch).not.toHaveBeenCalled();
    expect(replies()).toEqual([]);

    compile();
    await flush();
    expect(renderer.renderMemberBatch).toHaveBeenCalledOnce();
    expect(replies()).toEqual([{ type: "thumbnailResult", id: 7, bitmap }]);
  });

  it("answers with no bitmap and reports the failure when the compile fails", async () => {
    vi.stubGlobal("OffscreenCanvas", fakeOffscreenCanvas({ close: vi.fn() }));
    const { renderer, fail } = makeVolumeRenderer();
    const { ctx, posts } = makeCtx(renderer);
    handleMinimapUploadOverviewChunks(ctx, overviewUpload("ds"));

    handleThumbnailRender(ctx, thumbnailMsg());
    fail("volume shader refused");
    await flush();

    expect(renderer.renderMemberBatch).not.toHaveBeenCalled();
    expect(posts).toEqual([
      { type: "thumbnailResult", id: 7, bitmap: null },
      { type: "error", message: "volume shader refused" },
    ]);
  });
});
