/** WebGPU render worker — handles both slice and volume rendering off the main thread. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import { VOL_CACHE_BUDGET } from "./workerProtocol.ts";
import { initGPU, createSliceTexture, writeSliceRegion, createEmptyVolumeTexture, writeVolumeChunk, createOffscreenTarget } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { LayerCompositor, type CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;

let sliceRenderer: SliceRenderer | null = null;
let volumeRenderer: VolumeRenderer | null = null;
let compositor: LayerCompositor | null = null;

// Per-dataset slice tile state
interface TileState {
  texture: GPUTexture;
  level: number;
  z: number;
  t: number;
  c: number;
  uploaded: Set<string>;
  intensityMin: number;
  intensityMax: number;
}
const tileStatePerDataset = new Map<string, TileState>();
const fallbackPerDataset = new Map<string, GPUTexture>();

// Volume texture LRU cache (byte-budget eviction, Map iteration order = insertion order)
// Key format: "${datasetId}/${level}/${t}/${c}"
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

// Offscreen texture pool
let offscreenPool: GPUTexture[] = [];
let poolWidth = 0;
let poolHeight = 0;

function volTextureBytes(w: number, h: number, d: number): number {
  return w * h * d * 2; // r16uint = 2 bytes per texel
}

function post(msg: WorkerToMainMessage) {
  self.postMessage(msg);
}

function getSliceRenderer(): SliceRenderer {
  if (!sliceRenderer) {
    sliceRenderer = new SliceRenderer(device);
  }
  return sliceRenderer;
}

function getVolumeRenderer(): VolumeRenderer {
  if (!volumeRenderer) {
    volumeRenderer = new VolumeRenderer(device);
  }
  return volumeRenderer;
}

function getCompositor(): LayerCompositor {
  if (!compositor) {
    compositor = new LayerCompositor(device, format);
  }
  return compositor;
}

function ensureOffscreenPool(count: number, w: number, h: number) {
  if (w !== poolWidth || h !== poolHeight) {
    for (const tex of offscreenPool) tex.destroy();
    offscreenPool = [];
    poolWidth = w;
    poolHeight = h;
  }
  while (offscreenPool.length < count) {
    offscreenPool.push(createOffscreenTarget(device, w, h));
  }
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

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case "init": {
        const result = await initGPU(msg.canvas);
        device = result.device;
        context = result.context;
        format = result.format;
        post({ type: "ready" });
        break;
      }

      case "resize": {
        // OffscreenCanvas dimensions are set directly
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.width;
        canvas.height = msg.height;
        break;
      }

      case "sliceSetFallbackForLayer": {
        const slice = new Uint16Array(msg.data);
        const { min, max } = sampleIntensityRange(slice);
        const texture = createSliceTexture(device, msg.width, msg.height, slice);
        fallbackPerDataset.set(msg.datasetId, texture);
        post({ type: "intensityRange", datasetId: msg.datasetId, min, max });
        break;
      }

      case "sliceUploadTilesForLayer": {
        const { datasetId, level, z, t, c, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

        let ts = tileStatePerDataset.get(datasetId);
        if (!ts || ts.level !== level || ts.z !== z || ts.t !== t || ts.c !== c) {
          if (ts) ts.texture.destroy();
          const texture = createSliceTexture(device, levelWidth, levelHeight, null);
          ts = { texture, level, z, t, c, uploaded: new Set(), intensityMin: 65535, intensityMax: 0 };
          tileStatePerDataset.set(datasetId, ts);
        }

        // Map full-res Z to level Z
        const levelZ = Math.min(
          Math.floor((fullResZ / Math.max(fullResDepth - 1, 1)) * Math.max(levelDepth - 1, 1)),
          levelDepth - 1,
        );
        const targetChunkZ = Math.floor(levelZ / chunkZ);
        const localZ = levelZ - targetChunkZ * chunkZ;

        if (msg.tiles.length > 0) {
          let intensityChanged = false;
          const perChunkSamples = Math.floor(10000 / Math.max(1, msg.tiles.length));

          for (const tile of msg.tiles) {
            if (ts.uploaded.has(tile.key)) continue;
            if (tile.z !== targetChunkZ) continue;
            const data = new Uint16Array(tile.data);

            const r = sampleIntensityRange(data, perChunkSamples);
            if (r.min < ts.intensityMin) { ts.intensityMin = r.min; intensityChanged = true; }
            if (r.max > ts.intensityMax) { ts.intensityMax = r.max; intensityChanged = true; }

            const xOff = tile.x * chunkX;
            const yOff = tile.y * chunkY;
            const tileW = Math.min(chunkX, levelWidth - xOff);
            const tileH = Math.min(chunkY, levelHeight - yOff);
            const sliceOffset = localZ * chunkY * chunkX;
            const sliceData = data.subarray(sliceOffset, sliceOffset + chunkY * chunkX);
            writeSliceRegion(device, ts.texture, sliceData, chunkX, xOff, yOff, tileW, tileH);
            ts.uploaded.add(tile.key);
          }

          if (intensityChanged) {
            post({ type: "intensityRange", datasetId, min: ts.intensityMin, max: ts.intensityMax });
          }
        }
        break;
      }

      case "volumeSetInitialForLayer": {
        const data = new Uint16Array(msg.data);
        const texture = createEmptyVolumeTexture(device, msg.width, msg.height, msg.depth);
        for (let z = 0; z < msg.depth; z++) {
          device.queue.writeTexture(
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
        post({ type: "intensityRange", datasetId: msg.datasetId, min, max });

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
        break;
      }

      case "volumeUploadChunksForLayer": {
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
          const texture = createEmptyVolumeTexture(device, levelWidth, levelHeight, levelDepth);
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

          writeVolumeChunk(device, entry.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);
          entry.uploaded.add(chunk.key);

          const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
          const { min, max } = sampleIntensityRange(data, perChunkSamples);
          if (min < entry.intensityMin) { entry.intensityMin = min; intensityChanged = true; }
          if (max > entry.intensityMax) { entry.intensityMax = max; intensityChanged = true; }
        }

        if (intensityChanged) {
          post({ type: "intensityRange", datasetId, min: entry.intensityMin, max: entry.intensityMax });
        }
        break;
      }

      case "volumeRenderMultiPass": {
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.canvasW;
        canvas.height = msg.canvasH;

        const renderer = getVolumeRenderer();
        const comp = getCompositor();
        ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);

        const encoder = device.createCommandEncoder();
        const renderedLayers: CompositeLayer[] = [];

        for (const layer of msg.layers) {
          const volKey = activeVolKeyPerDataset.get(layer.datasetId);
          if (!volKey) continue;
          const entry = volCache.get(volKey);
          if (!entry) continue;

          const idx = renderedLayers.length;
          renderer.setVolume(entry.texture, entry.levelWidth, entry.levelHeight, entry.levelDepth);
          renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
          renderer.setOpacity(layer.opacity);
          renderer.setMatrices(msg.invViewProj, layer.modelMatrix, layer.invModelMatrix, msg.eye);
          renderer.renderTo(offscreenPool[idx].createView(), encoder);
          renderedLayers.push({ view: offscreenPool[idx].createView(), blendMode: layer.blendMode });
        }

        comp.composite(context.getCurrentTexture().createView(), renderedLayers, encoder);
        device.queue.submit([encoder.finish()]);
        break;
      }

      case "sliceRenderMultiPass": {
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.canvasW;
        canvas.height = msg.canvasH;

        const renderer = getSliceRenderer();
        const comp = getCompositor();
        ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);

        const encoder = device.createCommandEncoder();
        const renderedLayers: CompositeLayer[] = [];

        for (const layer of msg.layers) {
          const fb = fallbackPerDataset.get(layer.datasetId);
          const ts = tileStatePerDataset.get(layer.datasetId);
          if (!fb && !ts) continue;

          const idx = renderedLayers.length;
          renderer.setFallback(fb ?? getDummyTexture());
          renderer.setTileTexture(ts?.texture ?? getDummyTexture());
          renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
          renderer.setOpacity(layer.opacity);
          renderer.setTransform(msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
          renderer.renderTo(offscreenPool[idx].createView(), encoder);
          renderedLayers.push({ view: offscreenPool[idx].createView(), blendMode: layer.blendMode });
        }

        comp.composite(context.getCurrentTexture().createView(), renderedLayers, encoder);
        device.queue.submit([encoder.finish()]);
        break;
      }

      case "destroy": {
        for (const ts of tileStatePerDataset.values()) ts.texture.destroy();
        tileStatePerDataset.clear();
        for (const fb of fallbackPerDataset.values()) fb.destroy();
        fallbackPerDataset.clear();
        for (const entry of volCache.values()) entry.texture.destroy();
        volCache.clear();
        volCacheBytes = 0;
        activeVolKeyPerDataset.clear();
        for (const tex of offscreenPool) tex.destroy();
        offscreenPool = [];
        dummyTexture?.destroy();
        dummyTexture = null;
        sliceRenderer = null;
        volumeRenderer = null;
        compositor = null;
        self.close();
        break;
      }
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
