/** WebGPU render worker — thin dispatcher to handler modules. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import { initGPU, createOffscreenTarget } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { LayerCompositor } from "./layerCompositor.ts";
import { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { handleSliceAtlasConfig, handleSliceChunkData, handleSliceRenderMultiPass, removeSliceResources, destroyAllSliceResources } from "./sliceHandlers.ts";
import { handleVolumeAtlasConfig, handleVolumeChunkData, handleVolumeRenderMultiPass, removeVolumeResources, destroyAllVolumeResources } from "./volumeHandlers.ts";
import { handleMinimapInit, handleMinimapRender, handleMinimapSetOverview, handleMinimapUploadOverviewChunks, handleMinimapDestroy, removeMinimapResources, destroyAllMinimapResources } from "./minimapHandlers.ts";
import { getColormapData } from "../colormaps.ts";

let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;

let sliceRenderer: SliceRenderer | null = null;
let volumeRenderer: VolumeRenderer | null = null;
let compositor: LayerCompositor | null = null;
let cursorRenderer: CursorRenderer | null = null;

// LUT texture cache for colormap rendering
const lutCache = new Map<string, GPUTexture>();

function getOrCreateLUT(name: string): GPUTexture {
  let tex = lutCache.get(name);
  if (tex) return tex;
  const data = getColormapData(name);
  tex = device.createTexture({
    size: [256, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: 256 * 4 }, [256, 1]);
  lutCache.set(name, tex);
  return tex;
}

// Shared offscreen texture pool (used by slice + volume render)
let offscreenPool: GPUTexture[] = [];
let poolWidth = 0;
let poolHeight = 0;

function ensureOffscreenPool(count: number, w: number, h: number): GPUTexture[] {
  if (w !== poolWidth || h !== poolHeight) {
    for (const tex of offscreenPool) tex.destroy();
    offscreenPool = [];
    poolWidth = w;
    poolHeight = h;
  }
  while (offscreenPool.length < count) {
    offscreenPool.push(createOffscreenTarget(device, w, h));
  }
  return offscreenPool;
}

// 1x1 dummy texture for unset bindings (slice renderer)
let dummyTexture: GPUTexture | null = null;
function getDummyTexture(): GPUTexture {
  if (!dummyTexture) {
    dummyTexture = device.createTexture({
      size: [1, 1],
      format: "r16uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  return dummyTexture;
}

// 1x1x1 dummy 3D texture for unset bindings (minimap renderer)
let dummy3DTexture: GPUTexture | null = null;
function getDummy3DTexture(): GPUTexture {
  if (!dummy3DTexture) {
    dummy3DTexture = device.createTexture({
      size: [1, 1, 1],
      format: "r16uint",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  return dummy3DTexture;
}

function post(msg: WorkerToMainMessage) {
  self.postMessage(msg);
}

let ctx: WorkerCtx;

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case "init": {
        const result = await initGPU(msg.canvas);
        device = result.device;
        context = result.context;
        format = result.format;
        ctx = {
          device,
          context,
          format,
          getSliceRenderer() {
            if (!sliceRenderer) sliceRenderer = new SliceRenderer(device);
            return sliceRenderer;
          },
          getVolumeRenderer() {
            if (!volumeRenderer) volumeRenderer = new VolumeRenderer(device);
            return volumeRenderer;
          },
          getCompositor() {
            if (!compositor) compositor = new LayerCompositor(device, format);
            return compositor;
          },
          getCursorRenderer() {
            if (!cursorRenderer) cursorRenderer = new CursorRenderer(device, format);
            return cursorRenderer;
          },
          ensureOffscreenPool,
          getDummyTexture,
          getDummy3DTexture,
          getOrCreateLUT,
          post,
        };
        post({ type: "ready" });
        break;
      }

      case "resize": {
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.width;
        canvas.height = msg.height;
        break;
      }

      case "sliceAtlasConfig":
        handleSliceAtlasConfig(ctx, msg);
        break;
      case "sliceChunkData":
        handleSliceChunkData(ctx, msg);
        break;
      case "sliceRenderMultiPass":
        handleSliceRenderMultiPass(ctx, msg);
        break;

      case "volumeAtlasConfig":
        handleVolumeAtlasConfig(ctx, msg);
        break;
      case "volumeChunkData":
        handleVolumeChunkData(ctx, msg);
        break;
      case "volumeRenderMultiPass":
        handleVolumeRenderMultiPass(ctx, msg);
        break;

      case "minimapInit":
        handleMinimapInit(ctx, msg);
        break;
      case "minimapRender":
        handleMinimapRender(ctx, msg);
        break;
      case "minimapSetOverviewForLayer":
        handleMinimapSetOverview(ctx, msg);
        break;
      case "minimapUploadOverviewChunksForLayer":
        handleMinimapUploadOverviewChunks(ctx, msg);
        break;
      case "minimapDestroy":
        handleMinimapDestroy();
        break;

      case "updateCursorData": {
        if (!ctx) break;
        const cr = ctx.getCursorRenderer();
        cr.updateCursors(new Float32Array(msg.data), msg.count);
        break;
      }

      case "removeLayerResources":
        removeSliceResources(msg.datasetId);
        removeVolumeResources(msg.datasetId);
        removeMinimapResources(msg.datasetId);
        break;

      case "destroy":
        destroyAllSliceResources();
        destroyAllVolumeResources();
        destroyAllMinimapResources();
        for (const tex of offscreenPool) tex.destroy();
        offscreenPool = [];
        for (const tex of lutCache.values()) tex.destroy();
        lutCache.clear();
        dummyTexture?.destroy();
        dummyTexture = null;
        dummy3DTexture?.destroy();
        dummy3DTexture = null;
        sliceRenderer = null;
        volumeRenderer = null;
        compositor = null;
        cursorRenderer = null;
        self.close();
        break;
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
