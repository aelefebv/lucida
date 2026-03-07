/** WebGPU render worker — handles both slice and volume rendering off the main thread. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import { VOL_CACHE_BUDGET } from "./workerProtocol.ts";
import { initGPU, createSliceTexture, writeSliceRegion, createEmptyVolumeTexture, writeVolumeChunk } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;

let sliceRenderer: SliceRenderer | null = null;
let volumeRenderer: VolumeRenderer | null = null;

let displayOverrideActive = false;
let storedContrastMin = 0;
let storedContrastMax = 65535;
let storedGamma = 1.0;

// Slice tile texture state
let tileState: {
  texture: GPUTexture;
  level: number;
  z: number;
  t: number;
  c: number;
  uploaded: Set<string>;
  intensityMin: number;
  intensityMax: number;
} | null = null;

// Volume texture LRU cache (byte-budget eviction, Map iteration order = insertion order)
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
// VOL_CACHE_BUDGET imported from workerProtocol.ts
const volCache = new Map<string, VolCacheEntry>();
let volCacheBytes = 0;
let activeVolKey: string | null = null;

function volTextureBytes(w: number, h: number, d: number): number {
  return w * h * d * 2; // r16uint = 2 bytes per texel
}

function post(msg: WorkerToMainMessage) {
  self.postMessage(msg);
}

function getSliceRenderer(): SliceRenderer {
  if (!sliceRenderer) {
    sliceRenderer = new SliceRenderer(device, context, format);
  }
  return sliceRenderer;
}

function getVolumeRenderer(): VolumeRenderer {
  if (!volumeRenderer) {
    volumeRenderer = new VolumeRenderer(device, context, format);
  }
  return volumeRenderer;
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

      case "setModeSlice": {
        const renderer = getSliceRenderer();
        if (displayOverrideActive) {
          renderer.setDisplayParams(storedContrastMin, storedContrastMax, storedGamma);
        }
        break;
      }

      case "setModeVolume": {
        const renderer = getVolumeRenderer();
        if (displayOverrideActive) {
          renderer.setDisplayParams(storedContrastMin, storedContrastMax, storedGamma);
        }
        break;
      }

      case "resize": {
        // OffscreenCanvas dimensions are set directly
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.width;
        canvas.height = msg.height;
        break;
      }

      case "sliceSetFallback": {
        const renderer = getSliceRenderer();
        const slice = new Uint16Array(msg.data);
        const { min, max } = sampleIntensityRange(slice);
        const texture = createSliceTexture(device, msg.width, msg.height, slice);
        renderer.setFallback(texture);
        if (!displayOverrideActive) renderer.setIntensityRange(min, max);
        post({ type: "intensityRange", min, max });
        break;
      }

      case "sliceUploadTiles": {
        const renderer = getSliceRenderer();
        const { level, z, t, c, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

        // Invalidate tile texture if view params changed
        if (!tileState || tileState.level !== level || tileState.z !== z || tileState.t !== t || tileState.c !== c) {
          if (tileState) tileState.texture.destroy();
          const texture = createSliceTexture(device, levelWidth, levelHeight, null);
          tileState = { texture, level, z, t, c, uploaded: new Set(), intensityMin: 65535, intensityMax: 0 };
          renderer.setTileTexture(texture);
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
            if (tileState!.uploaded.has(tile.key)) continue;
            if (tile.z !== targetChunkZ) continue;
            const data = new Uint16Array(tile.data);

            // Incremental intensity tracking
            const r = sampleIntensityRange(data, perChunkSamples);
            if (r.min < tileState!.intensityMin) { tileState!.intensityMin = r.min; intensityChanged = true; }
            if (r.max > tileState!.intensityMax) { tileState!.intensityMax = r.max; intensityChanged = true; }

            const xOff = tile.x * chunkX;
            const yOff = tile.y * chunkY;
            const tileW = Math.min(chunkX, levelWidth - xOff);
            const tileH = Math.min(chunkY, levelHeight - yOff);
            const sliceOffset = localZ * chunkY * chunkX;
            const sliceData = data.subarray(sliceOffset, sliceOffset + chunkY * chunkX);
            writeSliceRegion(device, tileState!.texture, sliceData, chunkX, xOff, yOff, tileW, tileH);
            tileState!.uploaded.add(tile.key);
          }

          if (intensityChanged) {
            if (!displayOverrideActive) renderer.setIntensityRange(tileState!.intensityMin, tileState!.intensityMax);
            post({ type: "intensityRange", min: tileState!.intensityMin, max: tileState!.intensityMax });
          }
        }
        break;
      }

      case "sliceRender": {
        const renderer = getSliceRenderer();
        renderer.render(msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH, msg.dataW, msg.dataH);
        break;
      }

      case "volumeSetInitial": {
        const renderer = getVolumeRenderer();
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
        renderer.setVolume(texture, msg.width, msg.height, msg.depth);
        const { min, max } = sampleIntensityRange(data);
        if (!displayOverrideActive) renderer.setIntensityRange(min, max);
        post({ type: "intensityRange", min, max });
        // Clear volume cache — dataset/mode changed
        for (const entry of volCache.values()) entry.texture.destroy();
        volCache.clear();
        volCacheBytes = 0;
        activeVolKey = null;
        break;
      }

      case "volumeUploadChunks": {
        const renderer = getVolumeRenderer();
        const { level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;
        const key = `${level}/${t}/${c}`;

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

        // Activate this texture if it changed
        if (activeVolKey !== key) {
          renderer.setVolume(entry.texture, entry.levelWidth, entry.levelHeight, entry.levelDepth);
          activeVolKey = key;
          if (entry.intensityMin <= entry.intensityMax) {
            if (!displayOverrideActive) renderer.setIntensityRange(entry.intensityMin, entry.intensityMax);
            post({ type: "intensityRange", min: entry.intensityMin, max: entry.intensityMax });
          }
        }

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
          if (!displayOverrideActive) renderer.setIntensityRange(entry.intensityMin, entry.intensityMax);
          post({ type: "intensityRange", min: entry.intensityMin, max: entry.intensityMax });
        }
        break;
      }

      case "volumeRender": {
        const renderer = getVolumeRenderer();
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.canvasW;
        canvas.height = msg.canvasH;
        renderer.setMatrices(msg.invViewProj, msg.modelMatrix, msg.invModelMatrix, msg.eye);
        renderer.render();
        break;
      }

      case "setDisplayParams": {
        displayOverrideActive = true;
        storedContrastMin = msg.contrastMin;
        storedContrastMax = msg.contrastMax;
        storedGamma = msg.gamma;
        if (sliceRenderer) sliceRenderer.setDisplayParams(msg.contrastMin, msg.contrastMax, msg.gamma);
        if (volumeRenderer) volumeRenderer.setDisplayParams(msg.contrastMin, msg.contrastMax, msg.gamma);
        break;
      }

      case "destroy": {
        displayOverrideActive = false;
        if (tileState) {
          tileState.texture.destroy();
          tileState = null;
        }
        for (const entry of volCache.values()) entry.texture.destroy();
        volCache.clear();
        volCacheBytes = 0;
        activeVolKey = null;
        sliceRenderer = null;
        volumeRenderer = null;
        self.close();
        break;
      }
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
