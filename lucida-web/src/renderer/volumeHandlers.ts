import type { WorkerCtx } from "./workerContext.ts";
import type {
  VolumeSetInitialForLayerMessage,
  VolumeUploadChunksForLayerMessage,
  VolumeRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { VOL_CACHE_BUDGET } from "./workerProtocol.ts";
import { createEmptyVolumeTexture, writeVolumeChunk } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

interface VolCacheEntry {
  texture: GPUTexture;
  uploaded: Set<string>;
  intensityMin: number;
  intensityMax: number;
  levelWidth: number;
  levelHeight: number;
  levelDepth: number;
  byteSize: number;
}

const volCache = new Map<string, VolCacheEntry>();
let volCacheBytes = 0;
const activeVolKeyPerDataset = new Map<string, string>();

function volTextureBytes(w: number, h: number, d: number): number {
  return w * h * d * 2; // r16uint = 2 bytes per texel
}

export function handleVolumeSetInitial(ctx: WorkerCtx, msg: VolumeSetInitialForLayerMessage): void {
  const data = new Uint16Array(msg.data);
  const texture = createEmptyVolumeTexture(ctx.device, msg.width, msg.height, msg.depth);
  for (let z = 0; z < msg.depth; z++) {
    ctx.device.queue.writeTexture(
      { texture, origin: [0, 0, z] },
      msg.data,
      {
        offset: z * msg.width * msg.height * 2,
        bytesPerRow: msg.width * 2,
        rowsPerImage: msg.height,
      },
      [msg.width, msg.height, 1],
    );
  }
  const { min, max } = sampleIntensityRange(data);
  ctx.post({ type: "intensityRange", datasetId: msg.datasetId, min, max });

  // Clear volume cache entries for this dataset only
  for (const [key, entry] of volCache) {
    if (key.startsWith(msg.datasetId + "/")) {
      entry.texture.destroy();
      volCacheBytes -= entry.byteSize;
      volCache.delete(key);
    }
  }

  // Store as a cache entry so renderMultiPass can find it
  const byteSize = volTextureBytes(msg.width, msg.height, msg.depth);
  const cacheKey = `${msg.datasetId}/initial`;
  volCache.set(cacheKey, {
    texture,
    uploaded: new Set(["initial"]),
    intensityMin: min,
    intensityMax: max,
    levelWidth: msg.width,
    levelHeight: msg.height,
    levelDepth: msg.depth,
    byteSize,
  });
  volCacheBytes += byteSize;
  activeVolKeyPerDataset.set(msg.datasetId, cacheKey);
}

export function handleVolumeUploadChunks(ctx: WorkerCtx, msg: VolumeUploadChunksForLayerMessage): void {
  const { datasetId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;
  const key = `${datasetId}/${level}/${t}/${c}`;

  let entry = volCache.get(key);
  if (entry) {
    // LRU touch: delete and re-insert so it becomes newest
    volCache.delete(key);
    volCache.set(key, entry);
  } else {
    const newBytes = volTextureBytes(levelWidth, levelHeight, levelDepth);
    // Evict oldest entries until the new texture fits within budget
    while (volCache.size > 0 && volCacheBytes + newBytes > VOL_CACHE_BUDGET) {
      const oldestKey = volCache.keys().next().value!;
      const oldest = volCache.get(oldestKey)!;
      oldest.texture.destroy();
      volCacheBytes -= oldest.byteSize;
      volCache.delete(oldestKey);
    }
    const texture = createEmptyVolumeTexture(ctx.device, levelWidth, levelHeight, levelDepth);
    entry = {
      texture,
      uploaded: new Set(),
      intensityMin: 65535,
      intensityMax: 0,
      levelWidth,
      levelHeight,
      levelDepth,
      byteSize: newBytes,
    };
    volCache.set(key, entry);
    volCacheBytes += newBytes;
  }

  activeVolKeyPerDataset.set(datasetId, key);

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;

  for (const chunk of msg.chunks) {
    if (entry.uploaded.has(chunk.key)) continue;
    const data = new Uint16Array(chunk.data);
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    const zOff = chunk.z * chunkZ;
    const cw = Math.min(chunkX, levelWidth - xOff);
    const ch = Math.min(chunkY, levelHeight - yOff);
    const cd = Math.min(chunkZ, levelDepth - zOff);

    writeVolumeChunk(ctx.device, entry.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);
    entry.uploaded.add(chunk.key);

    const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
    const { min, max } = sampleIntensityRange(data, perChunkSamples);
    if (min < entry.intensityMin) { entry.intensityMin = min; intensityChanged = true; }
    if (max > entry.intensityMax) { entry.intensityMax = max; intensityChanged = true; }
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId, min: entry.intensityMin, max: entry.intensityMax });
  }
}

export function handleVolumeRenderMultiPass(ctx: WorkerCtx, msg: VolumeRenderMultiPassMessage): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  const pool = ctx.ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const volKey = activeVolKeyPerDataset.get(layer.datasetId);
    if (!volKey) continue;
    const entry = volCache.get(volKey);
    if (!entry) continue;

    // Find fallback: any other volCache entry for same dataset with uploaded chunks
    let fallbackEntry: VolCacheEntry | null = null;
    const dsPrefix = layer.datasetId + "/";
    for (const [key, cacheEntry] of volCache) {
      if (key === volKey) continue;
      if (!key.startsWith(dsPrefix)) continue;
      if (cacheEntry.uploaded.size === 0) continue;
      if (!fallbackEntry || cacheEntry.uploaded.size > fallbackEntry.uploaded.size) {
        fallbackEntry = cacheEntry;
      }
    }

    if (fallbackEntry) {
      renderer.setFallbackVolume(fallbackEntry.texture,
        fallbackEntry.levelWidth, fallbackEntry.levelHeight, fallbackEntry.levelDepth);
    } else {
      renderer.clearFallback();
    }

    const idx = renderedLayers.length;
    renderer.setVolume(entry.texture, entry.levelWidth, entry.levelHeight, entry.levelDepth);
    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(layer.opacity);
    renderer.setRenderMode(layer.renderMode === "max_intensity" ? 1 : 0);
    renderer.setMatrices(msg.invViewProj, layer.modelMatrix, layer.invModelMatrix, msg.eye);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[idx].createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: pool[idx].createView(), blendMode: layer.blendMode });
  }

  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(ctx.context.getCurrentTexture().createView(), renderedLayers, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);
}

export function removeVolumeResources(datasetId: string): void {
  for (const [key, entry] of volCache) {
    if (key.startsWith(datasetId + "/")) {
      entry.texture.destroy();
      volCacheBytes -= entry.byteSize;
      volCache.delete(key);
    }
  }
  activeVolKeyPerDataset.delete(datasetId);
}

export function destroyAllVolumeResources(): void {
  for (const entry of volCache.values()) entry.texture.destroy();
  volCache.clear();
  volCacheBytes = 0;
  activeVolKeyPerDataset.clear();
}
