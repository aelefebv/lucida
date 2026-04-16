/** WebGPU render worker — thin dispatcher to handler modules. */
import type { MainToWorkerMessage, WorkerToMainMessage, ColdStateMessage } from "./workerProtocol.ts";
import { initGPU, createOffscreenTarget } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { LayerCompositor } from "./layerCompositor.ts";
import { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { handleSliceChunkData, handleSliceRenderMultiPass, removeSliceResources, destroyAllSliceResources, getSliceAtlases, handleSliceAtlasConfig, remapSliceIndirection } from "./sliceHandlers.ts";
import { handleVolumeChunkData, handleVolumeRenderMultiPass, removeVolumeResources, destroyAllVolumeResources, getVolumeAtlases, handleVolumeAtlasConfig, remapIndirection, type LodIndirectionMeta } from "./volumeHandlers.ts";
import type { ColdStateActiveEntry } from "./workerProtocol.ts";
import { computeWantedSet } from "./wantedSet.ts";
import { handleMinimapInit, handleMinimapRender, handleMinimapSetOverview, handleMinimapUploadOverviewChunks, handleMinimapDestroy, removeMinimapResources, destroyAllMinimapResources } from "./minimapHandlers.ts";
import { getColormapData } from "../colormaps.ts";
import type { PlanningEpochs } from "../pipeline/planning.ts";

let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;

let sliceRenderer: SliceRenderer | null = null;
let volumeRenderer: VolumeRenderer | null = null;
let compositor: LayerCompositor | null = null;
let cursorRenderer: CursorRenderer | null = null;

let currentEpochs: PlanningEpochs | null = null;
let currentColdState: ColdStateMessage | null = null;

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

/** Compute and post wanted-set delta from current cold state + atlas state. */
function postWantedSet() {
  if (!currentColdState || !currentEpochs) return;
  const result = computeWantedSet(currentColdState, getVolumeAtlases(), getSliceAtlases());
  post({ type: "wantedSetDelta", epochs: currentEpochs, missing: result.missing });
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
          postWantedSet,
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

      case "sliceChunkData":
        handleSliceChunkData(ctx, msg, currentEpochs);
        break;
      case "sliceRenderMultiPass":
        handleSliceRenderMultiPass(ctx, msg);
        break;

      case "volumeChunkData":
        handleVolumeChunkData(ctx, msg, currentEpochs);
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

      case "coldState": {
        currentColdState = msg;
        currentEpochs = msg.epochs;

        // Manage atlases from cold state — create, remap, or rebuild as needed
        const isMultiCh = msg.visibleChannels.length > 1;
        for (const entry of msg.activeSet) {
          const members: Array<{ memberId: string; channel: number }> = [];
          if (isMultiCh) {
            for (const ch of msg.visibleChannels) {
              members.push({ memberId: `${entry.imageId}:ch${ch}`, channel: ch });
            }
          } else {
            members.push({ memberId: entry.imageId, channel: msg.visibleChannels[0] });
          }

          // Use target LOD level metadata for atlas dimensions
          const targetLevel = entry.levels.find(l => l.level === entry.targetLod);
          if (!targetLevel) continue;
          const [chunkZ, chunkY, chunkX] = targetLevel.chunkShape;
          const [gridZ, gridY, gridX] = targetLevel.gridShape;
          const [levelD, levelH, levelW] = targetLevel.levelDims;

          for (const { memberId, channel } of members) {
            if (msg.viewMode === "volume") {
              const atlas = getVolumeAtlases().get(memberId);
              if (!atlas) {
                // First time — create atlas
                handleVolumeAtlasConfig(ctx, {

                  epochs: msg.epochs,
                  datasetId: memberId,
                  level: entry.targetLod, t: msg.currentT, c: channel,
                  levelWidth: levelW, levelHeight: levelH, levelDepth: levelD,
                  chunkX, chunkY, chunkZ,
                });
              } else if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
                // Chunk dims changed — rebuild
                handleVolumeAtlasConfig(ctx, {

                  epochs: msg.epochs,
                  datasetId: memberId,
                  level: entry.targetLod, t: msg.currentT, c: channel,
                  levelWidth: levelW, levelHeight: levelH, levelDepth: levelD,
                  chunkX, chunkY, chunkZ,
                });
              } else {
                // Same chunk dims — compute multi-LOD indirection and remap
                atlas.level = entry.targetLod;
                atlas.t = msg.currentT;
                atlas.c = channel;
                atlas.levelWidth = levelW;
                atlas.levelHeight = levelH;
                atlas.levelDepth = levelD;
                atlas.gridX = gridX;
                atlas.gridY = gridY;
                atlas.gridZ = gridZ;

                // Build multi-LOD lodMetas for all detail-owned levels with matching chunk dims
                const [finest, coarsest] = entry.detailOwnedLodRange;
                const newLodMetas: LodIndirectionMeta[] = [];
                let offset = 0;
                for (let lvl = finest; lvl <= coarsest; lvl++) {
                  const lm = entry.levels.find(l => l.level === lvl);
                  if (!lm) continue;
                  const [lChunkZ, lChunkY, lChunkX] = lm.chunkShape;
                  // Only include levels with matching chunk dims (multi-LOD constraint)
                  if (lChunkX !== chunkX || lChunkY !== chunkY || lChunkZ !== chunkZ) continue;
                  const [lGridZ, lGridY, lGridX] = lm.gridShape;
                  const [lLevelD, lLevelH, lLevelW] = lm.levelDims;
                  newLodMetas.push({
                    level: lvl,
                    gridDims: [lGridZ, lGridY, lGridX],
                    chunkDims: [lChunkZ, lChunkY, lChunkX],
                    levelDims: [lLevelD, lLevelH, lLevelW],
                    offset,
                  });
                  offset += lGridX * lGridY * lGridZ;
                }
                // Fallback: at least include target LOD
                if (newLodMetas.length === 0) {
                  newLodMetas.push({
                    level: entry.targetLod,
                    gridDims: [gridZ, gridY, gridX],
                    chunkDims: [chunkZ, chunkY, chunkX],
                    levelDims: [levelD, levelH, levelW],
                    offset: 0,
                  });
                  offset = gridX * gridY * gridZ;
                }
                atlas.lodMetas = newLodMetas;

                // Resize indirection buffer for total multi-LOD size
                const totalIndirectionSize = offset;
                if (totalIndirectionSize !== atlas.indirectionData.length) {
                  atlas.indirectionData = new Uint32Array(totalIndirectionSize);
                  atlas.indirectionBuf.destroy();
                  atlas.indirectionBuf = device.createBuffer({
                    size: Math.max(totalIndirectionSize * 4, 4),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                  });
                }

                remapIndirection(atlas, msg.currentT, channel);
              }
            } else {
              // Slice mode
              const atlas = getSliceAtlases().get(memberId);
              if (!atlas) {
                handleSliceAtlasConfig(ctx, {

                  epochs: msg.epochs,
                  datasetId: memberId,
                  level: entry.targetLod, z: msg.currentZ, t: msg.currentT, c: channel,
                  levelWidth: levelW, levelHeight: levelH,
                  chunkX, chunkY,
                });
              } else if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
                handleSliceAtlasConfig(ctx, {

                  epochs: msg.epochs,
                  datasetId: memberId,
                  level: entry.targetLod, z: msg.currentZ, t: msg.currentT, c: channel,
                  levelWidth: levelW, levelHeight: levelH,
                  chunkX, chunkY,
                });
              } else {
                // Update Z metadata from cold state
                if (atlas.chunkZ == null) atlas.chunkZ = chunkZ;
                if (atlas.fullResDepth == null) atlas.fullResDepth = levelD;
                if (atlas.levelDepth == null) atlas.levelDepth = levelD;
                // Mark stale on Z change
                if (msg.currentZ !== atlas.z && atlas.slots.size > 0) {
                  atlas.staleSliceKeys = new Set(atlas.slots.keys());
                }
                atlas.level = entry.targetLod;
                atlas.z = msg.currentZ;
                atlas.t = msg.currentT;
                atlas.c = channel;
                atlas.levelWidth = levelW;
                atlas.levelHeight = levelH;
                atlas.gridX = gridX;
                atlas.gridY = gridY;

                // Build multi-LOD lodMetas for slice (2D — gridDims Z=1)
                const [slFinest, slCoarsest] = entry.detailOwnedLodRange;
                const sliceLodMetas: LodIndirectionMeta[] = [];
                let slOffset = 0;
                for (let lvl = slFinest; lvl <= slCoarsest; lvl++) {
                  const lm = entry.levels.find(l => l.level === lvl);
                  if (!lm) continue;
                  const [lChunkZ, lChunkY, lChunkX] = lm.chunkShape;
                  if (lChunkX !== chunkX || lChunkY !== chunkY) continue;
                  const [lGridZ, lGridY, lGridX] = lm.gridShape;
                  const [lLevelD, lLevelH, lLevelW] = lm.levelDims;
                  sliceLodMetas.push({
                    level: lvl,
                    gridDims: [lGridZ, lGridY, lGridX],
                    chunkDims: [lChunkZ, lChunkY, lChunkX],
                    levelDims: [lLevelD, lLevelH, lLevelW],
                    offset: slOffset,
                  });
                  slOffset += lGridX * lGridY; // 2D indirection for slice
                }
                if (sliceLodMetas.length === 0) {
                  sliceLodMetas.push({
                    level: entry.targetLod,
                    gridDims: [1, gridY, gridX],
                    chunkDims: [chunkZ, chunkY, chunkX],
                    levelDims: [levelD, levelH, levelW],
                    offset: 0,
                  });
                  slOffset = gridX * gridY;
                }
                atlas.lodMetas = sliceLodMetas;

                const totalSliceIndirection = slOffset;
                if (totalSliceIndirection !== atlas.indirectionData.length) {
                  atlas.indirectionData = new Uint32Array(totalSliceIndirection);
                  atlas.indirectionBuf.destroy();
                  atlas.indirectionBuf = device.createBuffer({
                    size: Math.max(totalSliceIndirection * 4, 4),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                  });
                }

                remapSliceIndirection(atlas, msg.currentT, channel, msg.currentZ);
              }
            }
          }
        }

        postWantedSet();
        break;
      }

      case "removeLayerResources":
        removeSliceResources(msg.datasetId);
        removeVolumeResources(msg.datasetId);
        removeMinimapResources(msg.datasetId);
        break;

      case "destroy":
        currentEpochs = null;
        currentColdState = null;
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
