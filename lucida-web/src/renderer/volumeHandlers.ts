import type { WorkerCtx } from "./workerContext.ts";
import type {
  VolumeChunkDataMessage,
  VolumeRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { VOLUME_ATLAS_BUDGET } from "./workerProtocol.ts";
import { writeVolumeChunk } from "./gpuContext.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";
import type { PlanningEpochs } from "../pipeline/planning.ts";
import { isStaleDelivery } from "./epochCheck.ts";
import { asUint16 } from "./dataTypeUtil.ts";

/** Per-LOD indirection section metadata. */
export interface LodIndirectionMeta {
  level: number;
  gridDims: [number, number, number];   // [Z, Y, X]
  chunkDims: [number, number, number];  // [Z, Y, X]
  levelDims: [number, number, number];  // [Z, Y, X] voxel dimensions
  offset: number;                       // entry offset into flat indirection buffer
}

export interface AtlasState {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  slots: Map<string, number>;     // chunkKey → slotIndex (insertion-order = LRU)
  slotGridIdx: Int32Array<ArrayBuffer>;        // slotIndex → globalGridIdx (for eviction cleanup)
  freeSlots: number[];            // available slot indices (stack)
  totalSlots: number;
  chunkX: number; chunkY: number; chunkZ: number;
  slotsX: number; slotsY: number; slotsZ: number;
  /** Per-LOD indirection sections. Sorted finest→coarsest. */
  lodMetas: LodIndirectionMeta[];
  /** Target LOD's grid dims (convenience for chunk data handler). */
  gridX: number; gridY: number; gridZ: number;
  levelWidth: number; levelHeight: number; levelDepth: number;
  level: number; t: number; c: number;
  intensityMin: number; intensityMax: number;
  indirectionDirty: boolean;
}

/** Parse a chunk key "level/t/c/z/y/x" into its components. */
export function parseChunkKey(key: string): { level: number; t: number; c: number; z: number; y: number; x: number } | null {
  const parts = key.split("/");
  if (parts.length !== 6) return null;
  return {
    level: parseInt(parts[0], 10),
    t: parseInt(parts[1], 10),
    c: parseInt(parts[2], 10),
    z: parseInt(parts[3], 10),
    y: parseInt(parts[4], 10),
    x: parseInt(parts[5], 10),
  };
}

/**
 * Remap the indirection buffer to show only chunks matching the current state.
 * Writes chunks into the correct per-LOD section based on lodMetas.
 * Chunks for other T/C or levels not in lodMetas remain in atlas.slots but are unmapped.
 */
export function remapIndirection(
  atlas: AtlasState,
  currentT: number,
  currentC: number,
): void {
  atlas.indirectionData.fill(0xFFFFFFFF);
  atlas.slotGridIdx.fill(-1);

  const metaByLevel = new Map(atlas.lodMetas.map(m => [m.level, m]));

  for (const [key, slotIndex] of atlas.slots) {
    const parsed = parseChunkKey(key);
    if (!parsed) continue;
    if (parsed.t !== currentT) continue;
    if (parsed.c !== currentC) continue;

    const meta = metaByLevel.get(parsed.level);
    if (!meta) continue;

    const [gridZ, gridY, gridX] = meta.gridDims;
    const globalIdx = meta.offset + parsed.z * gridY * gridX + parsed.y * gridX + parsed.x;
    if (globalIdx >= 0 && globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
  }

  atlas.indirectionDirty = true;
}

const atlasPerDataset = new Map<string, AtlasState>();

export function getVolumeAtlases(): Map<string, AtlasState> {
  return atlasPerDataset;
}

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

  const lodMetas: LodIndirectionMeta[] = [{
    level, gridDims: [gridZ, gridY, gridX],
    chunkDims: [chunkZ, chunkY, chunkX],
    levelDims: [levelD, levelH, levelW],
    offset: 0,
  }];

  return {
    texture, indirectionBuf, indirectionData,
    slots: new Map(), slotGridIdx, freeSlots, totalSlots,
    chunkX, chunkY, chunkZ,
    lodMetas,
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

/** Find the best eviction candidate: prefer stale (unmapped) chunks, then farthest mapped chunk. */
function findFarthestSlot(atlas: AtlasState, cam: [number, number, number]): { key: string; dist: number } {
  let farthestKey = "";
  let maxDist = -1;

  for (const [key, slotIdx] of atlas.slots) {
    const gridIdx = atlas.slotGridIdx[slotIdx];
    if (gridIdx < 0) {
      // Stale chunk (not mapped in indirection) — always prefer for eviction
      return { key, dist: Infinity };
    }

    // Parse chunk key for coordinates — works correctly with multi-LOD indirection
    const parsed = parseChunkKey(key);
    if (!parsed) continue;

    const dist = chunkDistSq(atlas, parsed.x, parsed.y, parsed.z, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = key;
    }
  }

  return { key: farthestKey, dist: maxDist };
}

export function handleVolumeAtlasConfig(ctx: WorkerCtx, msg: {
  datasetId: string; level: number; t: number; c: number;
  levelWidth: number; levelHeight: number; levelDepth: number;
  chunkX: number; chunkY: number; chunkZ: number;
}): void {
  const { datasetId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  const atlas = atlasPerDataset.get(datasetId);

  if (atlas && atlas.chunkX === chunkX && atlas.chunkY === chunkY && atlas.chunkZ === chunkZ) {
    // Chunk dims match — remap instead of rebuild. Atlas slots stay intact.
    atlas.level = level;
    atlas.t = t;
    atlas.c = c;
    atlas.levelWidth = levelWidth;
    atlas.levelHeight = levelHeight;
    atlas.levelDepth = levelDepth;

    const newGridX = Math.ceil(levelWidth / chunkX);
    const newGridY = Math.ceil(levelHeight / chunkY);
    const newGridZ = Math.ceil(levelDepth / chunkZ);
    const newGridSize = newGridX * newGridY * newGridZ;

    // Resize indirection if grid dims changed (different LOD = different grid)
    if (newGridSize !== atlas.gridX * atlas.gridY * atlas.gridZ) {
      atlas.indirectionData = new Uint32Array(newGridSize);
      atlas.indirectionBuf.destroy();
      atlas.indirectionBuf = ctx.device.createBuffer({
        size: Math.max(newGridSize * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    atlas.gridX = newGridX;
    atlas.gridY = newGridY;
    atlas.gridZ = newGridZ;

    remapIndirection(atlas, t, c);
    return;
  }

  // No atlas or chunk dims changed — create new
  if (atlas) destroyAtlas(atlas);
  const newAtlas = createVolumeAtlas(ctx.device, levelWidth, levelHeight, levelDepth,
    chunkX, chunkY, chunkZ, level, t, c);
  atlasPerDataset.set(datasetId, newAtlas);
}

export function handleVolumeChunkData(ctx: WorkerCtx, msg: VolumeChunkDataMessage, currentEpochs: PlanningEpochs | null): void {
  const { datasetId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

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

  // Debug: detect chunk dims mismatch (atlas created for different chunk size)
  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
    console.warn(`[volumeChunkData] chunkDims mismatch for ${datasetId}: atlas=[${atlas.chunkX},${atlas.chunkY},${atlas.chunkZ}] msg=[${chunkX},${chunkY},${chunkZ}] level=${level}`);
  }
  // Debug: ensure this level has an indirection section
  if (!atlas.lodMetas.some(m => m.level === level)) {
    console.warn(`[volumeChunkData] no lodMeta for level ${level} in ${datasetId}, atlas has levels [${atlas.lodMetas.map(m => m.level).join(",")}]`);
  }

  rayHitPerDataset.set(datasetId, msg.hitLocal);

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;
  const evictedKeys: string[] = [];

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
      evictedKeys.push(evictKey);
      const oldGridIdx = atlas.slotGridIdx[slotIndex];
      if (oldGridIdx >= 0) {
        atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
      }
    }

    const sx = slotIndex % atlas.slotsX;
    const sy = Math.floor(slotIndex / atlas.slotsX) % atlas.slotsY;
    const sz = Math.floor(slotIndex / (atlas.slotsX * atlas.slotsY));

    const data = asUint16(chunk.data, chunk.dataType);
    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    const zOff = sz * chunkZ;
    const cw = Math.min(chunkX, levelWidth - chunk.x * chunkX);
    const ch = Math.min(chunkY, levelHeight - chunk.y * chunkY);
    const cd = Math.min(chunkZ, levelDepth - chunk.z * chunkZ);

    writeVolumeChunk(ctx.device, atlas.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);

    // Find the correct LOD section in the indirection buffer
    const lodMeta = atlas.lodMetas.find(m => m.level === level);
    const [, lodGridY, lodGridX] = lodMeta ? lodMeta.gridDims : [atlas.gridZ, atlas.gridY, atlas.gridX];
    const lodOffset = lodMeta ? lodMeta.offset : 0;
    const globalIdx = lodOffset + chunk.z * lodGridY * lodGridX + chunk.y * lodGridX + chunk.x;
    if (globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
    atlas.slots.set(chunkKey, slotIndex);
    atlas.indirectionDirty = true;

    const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
    const { min, max } = sampleIntensityRange(data, perChunkSamples);
    if (min < atlas.intensityMin) { atlas.intensityMin = min; intensityChanged = true; }
    if (max > atlas.intensityMax) { atlas.intensityMax = max; intensityChanged = true; }
  }

  // Report chunks from the batch that the atlas did not keep (rejected as too far, etc.)
  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    if (!atlas.slots.has(chunk.key)) {
      skippedKeys.push(chunk.key);
    }
  }

  if (evictedKeys.length > 0 || skippedKeys.length > 0) {
    ctx.post({ type: "chunksEvicted", datasetId, keys: evictedKeys, skipped: skippedKeys });
    ctx.postWantedSet();
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
  // Only 1 offscreen texture needed — render and composite each layer incrementally
  const pool = ctx.ensureOffscreenPool(1, msg.canvasW, msg.canvasH);

  const canvasView = ctx.context.getCurrentTexture().createView();
  let isFirstLayer = true;

  for (const layer of msg.layers) {
    const atlas = atlasPerDataset.get(layer.datasetId);
    if (!atlas) continue;

    rayHitPerDataset.set(layer.datasetId, layer.rayHitLocal);

    const lutTex = ctx.getOrCreateLUT(layer.colormap ?? "gray");
    renderer.setColormapTexture(lutTex);

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
      atlas.lodMetas,
    );

    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(layer.opacity);
    renderer.setRenderMode(layer.renderMode === "max_intensity" ? 1 : 0);
    renderer.setMatrices(msg.invViewProj, layer.modelMatrix, layer.invModelMatrix, msg.eye, msg.viewProj, msg.camForward, msg.clipDistance, msg.clipMode);
    const depth = ensureDepthTexture(ctx.device, msg.canvasW, msg.canvasH);
    const depthView = depth.createView();

    // Render volume to single offscreen texture, then composite onto canvas
    const encoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[0].createView(), encoder, depthView, isFirstLayer, undefined, undefined, layer.scissorRect);
    comp.composite(canvasView, [{ view: pool[0].createView(), blendMode: layer.blendMode }], encoder, isFirstLayer);
    ctx.device.queue.submit([encoder.finish()]);

    isFirstLayer = false;
  }

  // If no layers were rendered, clear the canvas
  if (isFirstLayer) {
    const clearEncoder = ctx.device.createCommandEncoder();
    comp.composite(canvasView, [], clearEncoder);
    ctx.device.queue.submit([clearEncoder.finish()]);
  }

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
  rayHitPerDataset.delete(datasetId);
}

export function destroyAllVolumeResources(): void {
  for (const atlas of atlasPerDataset.values()) destroyAtlas(atlas);
  atlasPerDataset.clear();
  rayHitPerDataset.clear();
  depthTexture?.destroy();
  depthTexture = null;
}
