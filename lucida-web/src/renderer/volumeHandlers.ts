import type { WorkerCtx } from "./workerContext.ts";
import type {
  VolumeWriteFallbackChunkMessage,
  VolumeAtlasConfigMessage,
  VolumeChunkDataMessage,
  VolumeRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { VOLUME_ATLAS_BUDGET } from "./workerProtocol.ts";
import { createEmptyVolumeTexture, writeVolumeChunk } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

interface AtlasState {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  slots: Map<string, number>;     // chunkKey → slotIndex (insertion-order = LRU)
  slotGridIdx: Int32Array<ArrayBuffer>;        // slotIndex → gridIdx (for eviction cleanup)
  freeSlots: number[];            // available slot indices (stack)
  totalSlots: number;
  chunkX: number; chunkY: number; chunkZ: number;
  gridX: number; gridY: number; gridZ: number;
  slotsX: number; slotsY: number; slotsZ: number;
  levelWidth: number; levelHeight: number; levelDepth: number;
  level: number; t: number; c: number;
  intensityMin: number; intensityMax: number;
  indirectionDirty: boolean;
}

interface FallbackState {
  texture: GPUTexture;
  width: number;
  height: number;
  depth: number;
  tcKey: string;
  intensityMin: number;
  intensityMax: number;
}

const atlasPerDataset = new Map<string, AtlasState>();
const fallbackPerDataset = new Map<string, FallbackState>();

// Shared depth texture for volume rendering (used by cursor renderer for occlusion)
let depthTexture: GPUTexture | null = null;
let depthW = 0;
let depthH = 0;

function ensureDepthTexture(device: GPUDevice, w: number, h: number): GPUTexture {
  if (depthTexture && depthW === w && depthH === h) return depthTexture;
  depthTexture?.destroy();
  depthTexture = device.createTexture({
    size: [w, h],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  depthW = w;
  depthH = h;
  return depthTexture;
}
// Last known ray-volume hit point in local [0,1]³ space per dataset (persists across atlas recreations).
// Chunks closest to this point are kept; farthest are evicted first.
const rayHitPerDataset = new Map<string, [number, number, number]>();

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

function createVolumeAtlas(
  device: GPUDevice,
  levelW: number, levelH: number, levelD: number,
  chunkX: number, chunkY: number, chunkZ: number,
  level: number, t: number, c: number,
): AtlasState {
  const gridX = Math.ceil(levelW / chunkX);
  const gridY = Math.ceil(levelH / chunkY);
  const gridZ = Math.ceil(levelD / chunkZ);

  const chunkTexels = chunkX * chunkY * chunkZ;
  const maxSlots = Math.floor(VOLUME_ATLAS_BUDGET / (chunkTexels * 2));
  const slotsPerAxis = Math.floor(Math.cbrt(maxSlots));
  const slotsX = Math.min(slotsPerAxis, Math.floor(2048 / chunkX));
  const slotsY = Math.min(slotsPerAxis, Math.floor(2048 / chunkY));
  const slotsZ = Math.min(slotsPerAxis, Math.floor(2048 / chunkZ));
  const totalSlots = slotsX * slotsY * slotsZ;

  const atlasW = slotsX * chunkX;
  const atlasH = slotsY * chunkY;
  const atlasD = slotsZ * chunkZ;

  const texture = device.createTexture({
    size: [atlasW, atlasH, atlasD],
    format: "r16uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  const indirectionSize = gridX * gridY * gridZ;
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
    chunkX, chunkY, chunkZ,
    gridX, gridY, gridZ,
    slotsX, slotsY, slotsZ,
    levelWidth: levelW, levelHeight: levelH, levelDepth: levelD,
    level, t, c,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: true,
  };
}

function destroyAtlas(atlas: AtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/** Squared distance from a chunk grid coordinate to a reference point in [0,1] volume space. */
function chunkDistSq(
  atlas: AtlasState, cx: number, cy: number, cz: number,
  cam: [number, number, number],
): number {
  const px = (cx + 0.5) * atlas.chunkX / atlas.levelWidth;
  const py = (cy + 0.5) * atlas.chunkY / atlas.levelHeight;
  const pz = (cz + 0.5) * atlas.chunkZ / atlas.levelDepth;
  const dx = px - cam[0];
  const dy = py - cam[1];
  const dz = pz - cam[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Find the occupied slot whose chunk center is farthest from the ray hit point. */
function findFarthestSlot(atlas: AtlasState, cam: [number, number, number]): { key: string; dist: number } {
  let farthestKey = "";
  let maxDist = -1;

  for (const [key, slotIdx] of atlas.slots) {
    const gridIdx = atlas.slotGridIdx[slotIdx];
    if (gridIdx < 0) continue;

    const cx = gridIdx % atlas.gridX;
    const cy = Math.floor(gridIdx / atlas.gridX) % atlas.gridY;
    const cz = Math.floor(gridIdx / (atlas.gridX * atlas.gridY));

    const dist = chunkDistSq(atlas, cx, cy, cz, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = key;
    }
  }

  return { key: farthestKey, dist: maxDist };
}

export function handleVolumeWriteFallbackChunk(ctx: WorkerCtx, msg: VolumeWriteFallbackChunkMessage): void {
  let fb = fallbackPerDataset.get(msg.datasetId);
  if (!fb || fb.tcKey !== msg.tcKey) {
    if (fb) fb.texture.destroy();
    const texture = createEmptyVolumeTexture(ctx.device, msg.fbWidth, msg.fbHeight, msg.fbDepth);
    fb = { texture, width: msg.fbWidth, height: msg.fbHeight, depth: msg.fbDepth, tcKey: msg.tcKey, intensityMin: 65535, intensityMax: 0 };
    fallbackPerDataset.set(msg.datasetId, fb);
  }
  const data = new Uint16Array(msg.data);
  writeVolumeChunk(ctx.device, fb.texture, data, msg.srcChunkX, msg.srcChunkY, msg.chunkW, msg.chunkH, msg.chunkD, msg.xOff, msg.yOff, msg.zOff);
  const { min, max } = sampleIntensityRange(data);
  let changed = false;
  if (min < fb.intensityMin) { fb.intensityMin = min; changed = true; }
  if (max > fb.intensityMax) { fb.intensityMax = max; changed = true; }
  if (changed) {
    ctx.post({ type: "intensityRange", datasetId: msg.datasetId, min: fb.intensityMin, max: fb.intensityMax });
  }
}

export function handleVolumeAtlasConfig(ctx: WorkerCtx, msg: VolumeAtlasConfigMessage): void {
  const { datasetId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  const atlas = atlasPerDataset.get(datasetId);
  if (atlas) destroyAtlas(atlas);
  const newAtlas = createVolumeAtlas(ctx.device, levelWidth, levelHeight, levelDepth,
    chunkX, chunkY, chunkZ, level, t, c);
  atlasPerDataset.set(datasetId, newAtlas);
}

export function handleVolumeChunkData(ctx: WorkerCtx, msg: VolumeChunkDataMessage): void {
  const { datasetId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  let atlas = atlasPerDataset.get(datasetId);
  if (!atlas || atlas.level !== level || atlas.t !== t || atlas.c !== c
      || atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
    if (atlas) destroyAtlas(atlas);
    atlas = createVolumeAtlas(ctx.device, levelWidth, levelHeight, levelDepth,
      chunkX, chunkY, chunkZ, level, t, c);
    atlasPerDataset.set(datasetId, atlas);
  }

  rayHitPerDataset.set(datasetId, msg.hitLocal);

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;

  for (const chunk of msg.chunks) {
    const chunkKey = chunk.key;
    if (atlas.slots.has(chunkKey)) continue;

    let slotIndex: number;
    if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      const cam = rayHitPerDataset.get(datasetId) ?? [0.5, 0.5, 0.5];
      const { key: evictKey, dist: farthestDist } = findFarthestSlot(atlas, cam);
      if (!evictKey) continue;
      const incomingDist = chunkDistSq(atlas, chunk.x, chunk.y, chunk.z, cam);
      if (incomingDist >= farthestDist) continue;
      slotIndex = atlas.slots.get(evictKey)!;
      atlas.slots.delete(evictKey);
      const oldGridIdx = atlas.slotGridIdx[slotIndex];
      if (oldGridIdx >= 0) {
        atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
      }
    }

    const sx = slotIndex % atlas.slotsX;
    const sy = Math.floor(slotIndex / atlas.slotsX) % atlas.slotsY;
    const sz = Math.floor(slotIndex / (atlas.slotsX * atlas.slotsY));

    const data = new Uint16Array(chunk.data);
    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    const zOff = sz * chunkZ;
    const cw = Math.min(chunkX, levelWidth - chunk.x * chunkX);
    const ch = Math.min(chunkY, levelHeight - chunk.y * chunkY);
    const cd = Math.min(chunkZ, levelDepth - chunk.z * chunkZ);

    writeVolumeChunk(ctx.device, atlas.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);

    const gridIdx = chunk.z * atlas.gridY * atlas.gridX + chunk.y * atlas.gridX + chunk.x;
    atlas.indirectionData[gridIdx] = slotIndex;
    atlas.slotGridIdx[slotIndex] = gridIdx;
    atlas.slots.set(chunkKey, slotIndex);
    atlas.indirectionDirty = true;

    const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
    const { min, max } = sampleIntensityRange(data, perChunkSamples);
    if (min < atlas.intensityMin) { atlas.intensityMin = min; intensityChanged = true; }
    if (max > atlas.intensityMax) { atlas.intensityMax = max; intensityChanged = true; }
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId, min: atlas.intensityMin, max: atlas.intensityMax });
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
    const atlas = atlasPerDataset.get(layer.datasetId);
    const fb = fallbackPerDataset.get(layer.datasetId);
    if (!atlas && !fb) continue;

    rayHitPerDataset.set(layer.datasetId, layer.rayHitLocal);

    if (fb) {
      renderer.setFallbackVolume(fb.texture, fb.width, fb.height, fb.depth);
    } else {
      renderer.clearFallback();
    }

    if (atlas) {
      // Flush indirection data to GPU only if chunks changed since last render
      if (atlas.indirectionDirty) {
        ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
        atlas.indirectionDirty = false;
      }
      renderer.setAtlas(
        atlas.texture, atlas.indirectionBuf,
        [atlas.chunkX, atlas.chunkY, atlas.chunkZ],
        [atlas.gridX, atlas.gridY, atlas.gridZ],
        [atlas.slotsX, atlas.slotsY, atlas.slotsZ],
        [atlas.levelWidth, atlas.levelHeight, atlas.levelDepth],
      );
    } else {
      // No atlas — use dummy; set chunkDims = volumeDims so single indirection entry covers all
      renderer.setAtlas(
        ctx.getDummy3DTexture(), getDummyIndirectionBuf(ctx.device),
        [fb!.width, fb!.height, fb!.depth], [1, 1, 1], [1, 1, 1],
        [fb!.width, fb!.height, fb!.depth],
      );
    }

    const idx = renderedLayers.length;
    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(layer.opacity);
    renderer.setRenderMode(layer.renderMode === "max_intensity" ? 1 : 0);
    renderer.setMatrices(msg.invViewProj, layer.modelMatrix, layer.invModelMatrix, msg.eye, msg.viewProj, msg.camForward, msg.clipDistance, msg.clipMode);
    const depth = ensureDepthTexture(ctx.device, msg.canvasW, msg.canvasH);
    const depthView = depth.createView();
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[idx].createView(), layerEncoder, depthView, idx === 0);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: pool[idx].createView(), blendMode: layer.blendMode });
  }

  const canvasView = ctx.context.getCurrentTexture().createView();
  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(canvasView, renderedLayers, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);

  const cr = ctx.getCursorRenderer();
  if (cr.hasData() && msg.viewProj && depthTexture) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderVolume(canvasView, depthTexture.createView(), cursorEncoder, msg.viewProj, msg.fullW, msg.fullH);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }
}

export function removeVolumeResources(datasetId: string): void {
  const atlas = atlasPerDataset.get(datasetId);
  if (atlas) {
    destroyAtlas(atlas);
    atlasPerDataset.delete(datasetId);
  }
  const fb = fallbackPerDataset.get(datasetId);
  if (fb) {
    fb.texture.destroy();
    fallbackPerDataset.delete(datasetId);
  }
  rayHitPerDataset.delete(datasetId);
}

export function destroyAllVolumeResources(): void {
  for (const atlas of atlasPerDataset.values()) destroyAtlas(atlas);
  atlasPerDataset.clear();
  for (const fb of fallbackPerDataset.values()) fb.texture.destroy();
  fallbackPerDataset.clear();
  rayHitPerDataset.clear();
  depthTexture?.destroy();
  depthTexture = null;
  dummyIndirectionBuf?.destroy();
  dummyIndirectionBuf = null;
}
