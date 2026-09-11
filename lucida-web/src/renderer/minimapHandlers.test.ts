import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

import type { WorkerCtx } from "./workerContext.ts";
import type { MinimapRenderMessage, ThumbnailRenderMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import {
  destroyAllMinimapResources,
  handleMinimapDestroy,
  handleMinimapInit,
  handleMinimapRender,
  handleMinimapUploadOverviewChunks,
  handleThumbnailRender,
} from "./minimapHandlers.ts";

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
    setProxyTextures: vi.fn(),
    setColormapTexture: vi.fn(),
    setVolume: vi.fn(),
    setMatrices: vi.fn(),
    setTransientDescriptor: vi.fn(),
    renderTo: vi.fn(),
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
      createCommandEncoder: () => ({ finish: () => ({}) }),
      queue: { submit: vi.fn(), writeTexture: vi.fn() },
    },
    format: "bgra8unorm",
    getVolumeRenderer: () => renderer,
    getCompositor: () => ({ isCompiled: true, compiled: Promise.resolve(), composite }),
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
    t: 0,
    c: 0,
    levelWidth: 2,
    levelHeight: 2,
    levelDepth: 1,
    chunkX: 2,
    chunkY: 2,
    chunkZ: 1,
    chunks: [{ key: "3/0/0/0/0/0", x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array([1, 2, 3, 4]).buffer }],
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
    }],
    invViewProj: IDENTITY,
    eye: new Float32Array(3),
    canvasW,
    canvasH: canvasW,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  destroyAllMinimapResources();
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

    expect(renderer.renderTo).toHaveBeenCalledOnce();
    expect(composite).toHaveBeenCalledOnce();
  });

  // The reason is on `handleMinimapRender` in minimapHandlers.ts (#1101).
  it("defers its draw until the volume renderer has compiled and then draws the latest request once", async () => {
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx, composite } = makeCtx(renderer);
    const { canvas, size } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    uploadOverview(ctx);

    handleMinimapRender(ctx, renderMsg(100));
    handleMinimapRender(ctx, renderMsg(200));
    await flush();
    expect(renderer.renderTo).not.toHaveBeenCalled();

    compile();
    await flush();
    expect(renderer.renderTo).toHaveBeenCalledOnce();
    expect(composite).toHaveBeenCalledOnce();
    expect(size.width).toBe(200);

    handleMinimapRender(ctx, renderMsg(300));
    expect(renderer.renderTo).toHaveBeenCalledTimes(2);
  });

  it("drops a deferred draw when the minimap was destroyed before the pipelines compiled", async () => {
    const { renderer, compile } = makeVolumeRenderer();
    const { ctx } = makeCtx(renderer);
    const { canvas } = minimapCanvas();
    handleMinimapInit(ctx, { type: "minimapInit", canvas });
    uploadOverview(ctx);

    handleMinimapRender(ctx, renderMsg(100));
    handleMinimapDestroy();
    compile();
    await flush();

    expect(renderer.renderTo).not.toHaveBeenCalled();
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

    expect(renderer.renderTo).not.toHaveBeenCalled();
    expect(posts.filter((post) => post.type !== "intensityRange")).toEqual([
      { type: "error", message: "volume shader refused" },
    ]);
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
      eye: new Float32Array(3),
      size: 64,
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
    expect(renderer.renderTo).not.toHaveBeenCalled();
    expect(replies()).toEqual([]);

    compile();
    await flush();
    expect(renderer.renderTo).toHaveBeenCalledOnce();
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

    expect(renderer.renderTo).not.toHaveBeenCalled();
    expect(posts.filter((post) => post.type !== "intensityRange")).toEqual([
      { type: "thumbnailResult", id: 7, bitmap: null },
      { type: "error", message: "volume shader refused" },
    ]);
  });
});
