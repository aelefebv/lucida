import type { WorkerCtx } from "./workerContext.ts";
import type {
  SliceAtlasConfigMessage,
  SliceChunkDataMessage,
  SliceRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { SLICE_ATLAS_BUDGET } from "./workerProtocol.ts";
import { createSliceTexture, writeSliceRegion } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";
import type { PlanningEpochs } from "../pipeline/planning.ts";
import { isStaleDelivery } from "./epochCheck.ts";
import { asUint16, asUint16Slice } from "./dataTypeUtil.ts";

interface SliceAtlasState {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  slots: Map<string, number>;     // chunkKey → slotIndex (insertion-order = LRU)
  slotGridIdx: Int32Array<ArrayBuffer>;        // slotIndex → gridIdx (for eviction cleanup)
  freeSlots: number[];
  totalSlots: number;
  chunkX: number; chunkY: number;
  gridX: number; gridY: number;
  slotsX: number; slotsY: number;
  levelWidth: number; levelHeight: number;
  level: number; z: number; t: number; c: number;
  intensityMin: number; intensityMax: number;
  indirectionDirty: boolean;
}

const atlasPerDataset = new Map<string, SliceAtlasState>();

// Last known viewport center in [0,1] UV space per dataset
const cameraUVPerDataset = new Map<string, [number, number]>();

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
    indirectionDirty: true,
  };
}

function destroySliceAtlas(atlas: SliceAtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/** Squared distance from a chunk grid coordinate to a reference point in [0,1] UV space. */
function chunkDistSq2D(
  atlas: SliceAtlasState, cx: number, cy: number,
  cam: [number, number],
): number {
  const px = (cx + 0.5) * atlas.chunkX / atlas.levelWidth;
  const py = (cy + 0.5) * atlas.chunkY / atlas.levelHeight;
  const dx = px - cam[0];
  const dy = py - cam[1];
  return dx * dx + dy * dy;
}

/** Find the occupied slot whose chunk center is farthest from the viewport center. */
function findFarthestSlot2D(atlas: SliceAtlasState, cam: [number, number]): { key: string; dist: number } {
  let farthestKey = "";
  let maxDist = -1;

  for (const [key, slotIdx] of atlas.slots) {
    const gridIdx = atlas.slotGridIdx[slotIdx];
    if (gridIdx < 0) continue;

    const cx = gridIdx % atlas.gridX;
    const cy = Math.floor(gridIdx / atlas.gridX);
    const dist = chunkDistSq2D(atlas, cx, cy, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = key;
    }
  }

  return { key: farthestKey, dist: maxDist };
}

export function handleSliceAtlasConfig(ctx: WorkerCtx, msg: SliceAtlasConfigMessage): void {
  const { datasetId, level, z, t, c, levelWidth, levelHeight, chunkX, chunkY } = msg;

  const atlas = atlasPerDataset.get(datasetId);
  if (atlas) destroySliceAtlas(atlas);
  const newAtlas = createSliceAtlas(ctx.device, levelWidth, levelHeight, chunkX, chunkY, level, z, t, c);
  atlasPerDataset.set(datasetId, newAtlas);
}

export function handleSliceChunkData(ctx: WorkerCtx, msg: SliceChunkDataMessage, currentEpochs: PlanningEpochs | null): void {
  const { datasetId, level, z, t, c, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

  // Drop entire batch if stale
  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    const skippedKeys = msg.chunks.map(c => c.key);
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", datasetId: msg.datasetId, keys: [], skipped: skippedKeys });
    }
    return;
  }

  let atlas = atlasPerDataset.get(datasetId);
  if (!atlas) return; // No atlas config received yet — wait for it

  // Map full-res Z to level Z
  const levelZ = Math.min(
    Math.floor((fullResZ / Math.max(fullResDepth - 1, 1)) * Math.max(levelDepth - 1, 1)),
    levelDepth - 1,
  );
  const targetChunkZ = Math.floor(levelZ / chunkZ);
  const localZ = levelZ - targetChunkZ * chunkZ;

  let intensityChanged = false;
  const perChunkSamples = Math.floor(10000 / Math.max(1, msg.chunks.length));
  const evictedKeys: string[] = [];

  for (const chunk of msg.chunks) {
    if (atlas.slots.has(chunk.key)) continue;
    if (chunk.z !== targetChunkZ) continue;

    // Sample intensity from raw data (works for both uint8 and uint16)
    const isU8 = chunk.dataType === "uint8" || chunk.dataType === "Uint8";
    const rawView = isU8 ? new Uint8Array(chunk.data) : new Uint16Array(chunk.data);
    const r = sampleIntensityRange(rawView, perChunkSamples);
    if (r.min < atlas.intensityMin) { atlas.intensityMin = r.min; intensityChanged = true; }
    if (r.max > atlas.intensityMax) { atlas.intensityMax = r.max; intensityChanged = true; }

    // Allocate a slot
    let slotIndex: number;
    if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      // Only evict if the incoming chunk is closer than the farthest in the atlas.
      const cam = cameraUVPerDataset.get(datasetId) ?? [0.5, 0.5];
      const { key: evictKey, dist: farthestDist } = findFarthestSlot2D(atlas, cam);
      if (!evictKey) continue;
      const incomingDist = chunkDistSq2D(atlas, chunk.x, chunk.y, cam);
      if (incomingDist >= farthestDist) continue;
      slotIndex = atlas.slots.get(evictKey)!;
      atlas.slots.delete(evictKey);
      evictedKeys.push(evictKey);
      const oldGridIdx = atlas.slotGridIdx[slotIndex];
      if (oldGridIdx >= 0) {
        atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
      }
    }

    const sx = slotIndex % atlas.slotsX;
    const sy = Math.floor(slotIndex / atlas.slotsX);

    const chunkW = Math.min(chunkX, levelWidth - chunk.x * chunkX);
    const chunkH = Math.min(chunkY, levelHeight - chunk.y * chunkY);
    const sliceOffset = localZ * chunkY * chunkX;
    // Convert only the 2D slice to uint16 for GPU upload (small allocation)
    const sliceData = asUint16Slice(chunk.data, chunk.dataType, sliceOffset, chunkY * chunkX);

    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    writeSliceRegion(ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, chunkW, chunkH);

    const gridIdx = chunk.y * atlas.gridX + chunk.x;
    atlas.indirectionData[gridIdx] = slotIndex;
    atlas.slotGridIdx[slotIndex] = gridIdx;
    atlas.slots.set(chunk.key, slotIndex);
    atlas.indirectionDirty = true;
  }

  // Report chunks from the batch that the atlas did not keep (rejected as too far, wrong Z, etc.)
  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    if (!atlas.slots.has(chunk.key)) {
      skippedKeys.push(chunk.key);
    }
  }

  if (evictedKeys.length > 0 || skippedKeys.length > 0) {
    ctx.post({ type: "chunksEvicted", datasetId, keys: evictedKeys, skipped: skippedKeys });
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId, min: atlas.intensityMin, max: atlas.intensityMax });
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
    if (!atlas) continue;

    // Update viewport center in [0,1] UV space for distance-based eviction.
    // Adjust by member position offset so the atlas eviction sees member-local coords.
    const ox = layer.offsetX ?? 0;
    const oy = layer.offsetY ?? 0;
    cameraUVPerDataset.set(layer.datasetId, [
      (msg.cx - ox) / layer.dataW,
      (msg.cy - oy) / layer.dataH,
    ]);

    const idx = renderedLayers.length;

    // Flush indirection data to GPU only if chunks changed since last render
    if (atlas.indirectionDirty) {
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      atlas.indirectionDirty = false;
    }
    renderer.setAtlas(
      atlas.texture, atlas.indirectionBuf,
      [atlas.chunkX, atlas.chunkY],
      [atlas.gridX, atlas.gridY],
      [atlas.slotsX, atlas.slotsY],
      [atlas.levelWidth, atlas.levelHeight],
    );

    const lutTex = ctx.getOrCreateLUT(layer.colormap ?? "gray");
    renderer.setColormapTexture(lutTex);
    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(layer.opacity);
    renderer.setTransform(msg.zoom, msg.cx - ox, msg.cy - oy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[idx].createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: pool[idx].createView(), blendMode: layer.blendMode });
  }

  const canvasView = ctx.context.getCurrentTexture().createView();
  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(canvasView, renderedLayers, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);

  const cr = ctx.getCursorRenderer();
  if (cr.hasData()) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderSlice(canvasView, cursorEncoder, msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }
}

export function removeSliceResources(datasetId: string): void {
  const atlas = atlasPerDataset.get(datasetId);
  if (atlas) {
    destroySliceAtlas(atlas);
    atlasPerDataset.delete(datasetId);
  }
  cameraUVPerDataset.delete(datasetId);
}

export function destroyAllSliceResources(): void {
  for (const atlas of atlasPerDataset.values()) destroySliceAtlas(atlas);
  atlasPerDataset.clear();
  cameraUVPerDataset.clear();
}
