import type { WorkerCtx } from "./workerContext.ts";
import type {
  SliceSetFallbackForLayerMessage,
  SliceUploadTilesForLayerMessage,
  SliceRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { SLICE_ATLAS_BUDGET } from "./workerProtocol.ts";
import { createSliceTexture, writeSliceRegion } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

interface SliceAtlasState {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  slots: Map<string, number>;     // tileKey → slotIndex (insertion-order = LRU)
  slotGridIdx: Int32Array<ArrayBuffer>;        // slotIndex → gridIdx (for eviction cleanup)
  freeSlots: number[];
  totalSlots: number;
  chunkX: number; chunkY: number;
  gridX: number; gridY: number;
  slotsX: number; slotsY: number;
  levelWidth: number; levelHeight: number;
  level: number; z: number; t: number; c: number;
  intensityMin: number; intensityMax: number;
}

const atlasPerDataset = new Map<string, SliceAtlasState>();
const fallbackPerDataset = new Map<string, GPUTexture>();
// Last known viewport center in [0,1] UV space per dataset
const cameraUVPerDataset = new Map<string, [number, number]>();

let dummyIndirectionBuf: GPUBuffer | null = null;
function getDummyIndirectionBuf(device: GPUDevice): GPUBuffer {
  if (!dummyIndirectionBuf) {
    const data = new Uint32Array([0xFFFFFFFF]);
    dummyIndirectionBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dummyIndirectionBuf, 0, data);
  }
  return dummyIndirectionBuf;
}

function createSliceAtlas(
  device: GPUDevice,
  levelW: number, levelH: number,
  chunkX: number, chunkY: number,
  level: number, z: number, t: number, c: number,
): SliceAtlasState {
  const gridX = Math.ceil(levelW / chunkX);
  const gridY = Math.ceil(levelH / chunkY);

  const chunkTexels = chunkX * chunkY;
  const maxSlots = Math.floor(SLICE_ATLAS_BUDGET / (chunkTexels * 2));
  const slotsPerAxis = Math.floor(Math.sqrt(maxSlots));
  const slotsX = Math.min(slotsPerAxis, Math.floor(8192 / chunkX));
  const slotsY = Math.min(slotsPerAxis, Math.floor(8192 / chunkY));
  const totalSlots = slotsX * slotsY;

  const atlasW = slotsX * chunkX;
  const atlasH = slotsY * chunkY;

  const texture = createSliceTexture(device, atlasW, atlasH, null);

  const indirectionSize = gridX * gridY;
  const indirectionData = new Uint32Array(indirectionSize);
  indirectionData.fill(0xFFFFFFFF);

  const indirectionBuf = device.createBuffer({
    size: Math.max(indirectionSize * 4, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indirectionBuf, 0, indirectionData);

  const freeSlots: number[] = [];
  for (let i = totalSlots - 1; i >= 0; i--) freeSlots.push(i);

  const slotGridIdx = new Int32Array(totalSlots);
  slotGridIdx.fill(-1);

  return {
    texture, indirectionBuf, indirectionData,
    slots: new Map(), slotGridIdx, freeSlots, totalSlots,
    chunkX, chunkY,
    gridX, gridY,
    slotsX, slotsY,
    levelWidth: levelW, levelHeight: levelH,
    level, z, t, c,
    intensityMin: 65535, intensityMax: 0,
  };
}

function destroySliceAtlas(atlas: SliceAtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/** Find the occupied slot whose tile center is farthest from the viewport center. */
function findFarthestSlot2D(atlas: SliceAtlasState, cam: [number, number]): string {
  const [camX, camY] = cam;
  let farthestKey = "";
  let maxDist = -1;

  for (const [key, slotIdx] of atlas.slots) {
    const gridIdx = atlas.slotGridIdx[slotIdx];
    if (gridIdx < 0) continue;

    const cx = gridIdx % atlas.gridX;
    const cy = Math.floor(gridIdx / atlas.gridX);

    // Tile center in [0,1] UV space
    const px = (cx + 0.5) * atlas.chunkX / atlas.levelWidth;
    const py = (cy + 0.5) * atlas.chunkY / atlas.levelHeight;

    const dx = px - camX;
    const dy = py - camY;
    const dist = dx * dx + dy * dy;

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = key;
    }
  }

  return farthestKey;
}

export function handleSliceSetFallback(ctx: WorkerCtx, msg: SliceSetFallbackForLayerMessage): void {
  const slice = new Uint16Array(msg.data);
  const { min, max } = sampleIntensityRange(slice);
  const old = fallbackPerDataset.get(msg.datasetId);
  if (old) old.destroy();
  const texture = createSliceTexture(ctx.device, msg.width, msg.height, slice);
  fallbackPerDataset.set(msg.datasetId, texture);
  ctx.post({ type: "intensityRange", datasetId: msg.datasetId, min, max });
}

export function handleSliceUploadTiles(ctx: WorkerCtx, msg: SliceUploadTilesForLayerMessage): void {
  const { datasetId, level, z, t, c, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

  let atlas = atlasPerDataset.get(datasetId);
  if (!atlas || atlas.level !== level || atlas.z !== z || atlas.t !== t || atlas.c !== c
      || atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    if (atlas) destroySliceAtlas(atlas);
    atlas = createSliceAtlas(ctx.device, levelWidth, levelHeight, chunkX, chunkY, level, z, t, c);
    atlasPerDataset.set(datasetId, atlas);
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
      if (atlas.slots.has(tile.key)) continue;
      if (tile.z !== targetChunkZ) continue;
      const data = new Uint16Array(tile.data);

      const r = sampleIntensityRange(data, perChunkSamples);
      if (r.min < atlas.intensityMin) { atlas.intensityMin = r.min; intensityChanged = true; }
      if (r.max > atlas.intensityMax) { atlas.intensityMax = r.max; intensityChanged = true; }

      // Allocate a slot
      let slotIndex: number;
      if (atlas.freeSlots.length > 0) {
        slotIndex = atlas.freeSlots.pop()!;
      } else {
        // Evict the tile farthest from the viewport center
        const cam = cameraUVPerDataset.get(datasetId) ?? [0.5, 0.5];
        const evictKey = findFarthestSlot2D(atlas, cam);
        slotIndex = atlas.slots.get(evictKey)!;
        atlas.slots.delete(evictKey);
        const oldGridIdx = atlas.slotGridIdx[slotIndex];
        if (oldGridIdx >= 0) {
          atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
        }
      }

      // Decode slot to atlas grid position
      const sx = slotIndex % atlas.slotsX;
      const sy = Math.floor(slotIndex / atlas.slotsX);

      const tileW = Math.min(chunkX, levelWidth - tile.x * chunkX);
      const tileH = Math.min(chunkY, levelHeight - tile.y * chunkY);
      const sliceOffset = localZ * chunkY * chunkX;
      const sliceData = data.subarray(sliceOffset, sliceOffset + chunkY * chunkX);

      const xOff = sx * chunkX;
      const yOff = sy * chunkY;
      writeSliceRegion(ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, tileW, tileH);

      // Update indirection
      const gridIdx = tile.y * atlas.gridX + tile.x;
      atlas.indirectionData[gridIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = gridIdx;
      atlas.slots.set(tile.key, slotIndex);
    }

    if (intensityChanged) {
      ctx.post({ type: "intensityRange", datasetId, min: atlas.intensityMin, max: atlas.intensityMax });
    }
  }
}

export function handleSliceRenderMultiPass(ctx: WorkerCtx, msg: SliceRenderMultiPassMessage): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  const pool = ctx.ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const atlas = atlasPerDataset.get(layer.datasetId);
    const fb = fallbackPerDataset.get(layer.datasetId);
    if (!atlas && !fb) continue;

    // Update viewport center in [0,1] UV space for distance-based eviction
    cameraUVPerDataset.set(layer.datasetId, [
      msg.cx / layer.dataW,
      msg.cy / layer.dataH,
    ]);

    const idx = renderedLayers.length;
    renderer.setFallback(fb ?? ctx.getDummyTexture());

    if (atlas) {
      // Flush indirection data to GPU
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      renderer.setAtlas(
        atlas.texture, atlas.indirectionBuf,
        [atlas.chunkX, atlas.chunkY],
        [atlas.gridX, atlas.gridY],
        [atlas.slotsX, atlas.slotsY],
        [atlas.levelWidth, atlas.levelHeight],
      );
    } else {
      // No atlas — set chunkDims = levelDims so single indirection entry covers all
      // levelDims unknown here without atlas, so use [1,1] effectively making 1 chunk
      // The dummy indirection has sentinel, so everything falls back
      renderer.setAtlas(
        ctx.getDummyTexture(), getDummyIndirectionBuf(ctx.device),
        [8192, 8192], [1, 1], [1, 1],
        [1, 1],
      );
    }

    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(layer.opacity);
    renderer.setTransform(msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[idx].createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: pool[idx].createView(), blendMode: layer.blendMode });
  }

  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(ctx.context.getCurrentTexture().createView(), renderedLayers, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);
}

export function removeSliceResources(datasetId: string): void {
  const atlas = atlasPerDataset.get(datasetId);
  if (atlas) {
    destroySliceAtlas(atlas);
    atlasPerDataset.delete(datasetId);
  }
  const fb = fallbackPerDataset.get(datasetId);
  if (fb) {
    fb.destroy();
    fallbackPerDataset.delete(datasetId);
  }
  cameraUVPerDataset.delete(datasetId);
}

export function destroyAllSliceResources(): void {
  for (const atlas of atlasPerDataset.values()) destroySliceAtlas(atlas);
  atlasPerDataset.clear();
  for (const fb of fallbackPerDataset.values()) fb.destroy();
  fallbackPerDataset.clear();
  cameraUVPerDataset.clear();
  dummyIndirectionBuf?.destroy();
  dummyIndirectionBuf = null;
}
