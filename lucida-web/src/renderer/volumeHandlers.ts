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
  /** Composite keys "memberId:chunkKey" → slotIndex (insertion-order = LRU). */
  slots: Map<string, number>;
  /** slotIndex → globalGridIdx (for eviction cleanup). */
  slotGridIdx: Int32Array<ArrayBuffer>;
  freeSlots: number[];            // available slot indices (stack)
  totalSlots: number;
  /** Shared slot pool dimensions (same chunk dims for all entities in this pool). */
  chunkX: number; chunkY: number; chunkZ: number;
  slotsX: number; slotsY: number; slotsZ: number;
  /** Per-entity LOD sections. memberId → array of per-LOD indirection meta with absolute offsets. */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /** Current T and C — shared across all entities in this pool (one cold state per dataset). */
  t: number; c: number;
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

/** Build composite slot key "memberId|chunkKey" for shared pool. */
export function makeCompositeKey(memberId: string, chunkKey: string): string {
  return `${memberId}|${chunkKey}`;
}

/**
 * Derive the shared pool key from a memberId and its datasetId.
 * Single-channel: memberId="imageId", poolKey="datasetId"
 * Multi-channel: memberId="imageId:chN", poolKey="datasetId:chN"
 */
export function derivePoolKey(memberId: string, datasetId: string): string {
  const colonIdx = memberId.indexOf(":");
  if (colonIdx >= 0) {
    return `${datasetId}${memberId.substring(colonIdx)}`;
  }
  return datasetId;
}

/** Parse composite slot key. Returns null if not a composite key. */
export function parseCompositeKey(key: string): { memberId: string; chunkKey: string } | null {
  const sep = key.indexOf("|");
  if (sep < 0) return null;
  return { memberId: key.substring(0, sep), chunkKey: key.substring(sep + 1) };
}

/**
 * Remap the indirection buffer to show only chunks matching the current state.
 * Iterates composite slot keys, looks up each entity's lodMetas, and writes
 * chunks into the correct per-entity per-LOD section. Chunks for other T/C
 * or entities not in entityMetas remain in atlas.slots but are unmapped.
 */
export function remapIndirection(
  atlas: AtlasState,
  currentT: number,
  currentC: number,
): void {
  atlas.indirectionData.fill(0xFFFFFFFF);
  atlas.slotGridIdx.fill(-1);

  for (const [compositeKey, slotIndex] of atlas.slots) {
    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;

    const lodMetas = atlas.entityMetas.get(parsed.memberId);
    if (!lodMetas) continue; // entity no longer in active set

    const chunk = parseChunkKey(parsed.chunkKey);
    if (!chunk) continue;
    if (chunk.t !== currentT) continue;
    if (chunk.c !== currentC) continue;

    const meta = lodMetas.find(m => m.level === chunk.level);
    if (!meta) continue;

    const [, gridY, gridX] = meta.gridDims;
    const globalIdx = meta.offset + chunk.z * gridY * gridX + chunk.y * gridX + chunk.x;
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
// Last known ray-volume hit point in local [0,1]³ space per ENTITY (memberId).
// Chunks closest to this point are kept; farthest are evicted first.
const rayHitPerEntity = new Map<string, [number, number, number]>();

/** Create a shared atlas pool. Indirection is sized later from entityMetas. */
function createVolumeAtlas(
  device: GPUDevice,
  chunkX: number, chunkY: number, chunkZ: number,
  t: number, c: number,
): AtlasState {
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

  // Indirection starts at minimum size; cold state handler resizes after computing entityMetas.
  const indirectionData = new Uint32Array(1);
  indirectionData[0] = 0xFFFFFFFF;
  const indirectionBuf = device.createBuffer({
    size: 4,
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
    slotsX, slotsY, slotsZ,
    entityMetas: new Map(),
    t, c,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: true,
  };
}

function destroyAtlas(atlas: AtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/**
 * Squared distance from a chunk grid coordinate to a reference point in [0,1] entity-local space.
 * Uses the chunk's own LOD dims (from lodMeta) for normalization since LODs may have different grids.
 */
function chunkDistSq(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number, cz: number,
  cam: [number, number, number],
): number {
  const [, levelH, levelW] = lodMeta.levelDims;
  const [, , chunkX] = lodMeta.chunkDims;
  const [, chunkY] = lodMeta.chunkDims;
  const [chunkZ] = lodMeta.chunkDims;
  const levelD = lodMeta.levelDims[0];
  const px = (cx + 0.5) * chunkX / Math.max(levelW, 1);
  const py = (cy + 0.5) * chunkY / Math.max(levelH, 1);
  const pz = (cz + 0.5) * chunkZ / Math.max(levelD, 1);
  const dx = px - cam[0];
  const dy = py - cam[1];
  const dz = pz - cam[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Find the best eviction candidate: prefer stale (unmapped) chunks, then farthest mapped chunk.
 * Distance reference is per-entity (rayHitPerEntity).
 */
function findFarthestSlot(atlas: AtlasState): { key: string; dist: number } {
  let farthestKey = "";
  let maxDist = -1;

  for (const [compositeKey, slotIdx] of atlas.slots) {
    const gridIdx = atlas.slotGridIdx[slotIdx];
    if (gridIdx < 0) {
      // Stale chunk (not mapped in indirection) — always prefer for eviction
      return { key: compositeKey, dist: Infinity };
    }

    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const lodMetas = atlas.entityMetas.get(parsed.memberId);
    if (!lodMetas) {
      // Entity gone from active set — prefer for eviction
      return { key: compositeKey, dist: Infinity };
    }
    const chunk = parseChunkKey(parsed.chunkKey);
    if (!chunk) continue;
    const lodMeta = lodMetas.find(m => m.level === chunk.level);
    if (!lodMeta) continue;

    const cam = rayHitPerEntity.get(parsed.memberId) ?? [0.5, 0.5, 0.5];
    const dist = chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = compositeKey;
    }
  }

  return { key: farthestKey, dist: maxDist };
}

/**
 * Get or create a shared volume atlas pool for the given (poolKey, chunk dims).
 * Returns the pool. Cold state handler is responsible for setting entityMetas
 * and resizing the indirection buffer afterward.
 */
export function getOrCreateVolumePool(
  ctx: WorkerCtx,
  poolKey: string,
  chunkX: number, chunkY: number, chunkZ: number,
  t: number, c: number,
): AtlasState {
  const existing = atlasPerDataset.get(poolKey);
  if (existing && existing.chunkX === chunkX && existing.chunkY === chunkY && existing.chunkZ === chunkZ) {
    existing.t = t;
    existing.c = c;
    return existing;
  }
  if (existing) destroyAtlas(existing);
  const newAtlas = createVolumeAtlas(ctx.device, chunkX, chunkY, chunkZ, t, c);
  atlasPerDataset.set(poolKey, newAtlas);
  return newAtlas;
}

/**
 * Resize the indirection buffer to match a new total size (sum of all entity LOD sections).
 * Called by cold state handler after computing entityMetas with absolute offsets.
 */
export function resizeIndirection(ctx: WorkerCtx, atlas: AtlasState, totalEntries: number): void {
  if (totalEntries === atlas.indirectionData.length) return;
  atlas.indirectionData = new Uint32Array(totalEntries);
  atlas.indirectionBuf.destroy();
  atlas.indirectionBuf = ctx.device.createBuffer({
    size: Math.max(totalEntries * 4, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

export function handleVolumeChunkData(
  ctx: WorkerCtx,
  msg: VolumeChunkDataMessage,
  currentEpochs: PlanningEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  // Drop entire batch if stale
  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    const skippedKeys = msg.chunks.map(c => c.key);
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", datasetId: memberId, keys: [], skipped: skippedKeys });
    }
    return;
  }

  const atlas = atlasPerDataset.get(poolKey);
  if (!atlas) return; // pool not yet created by cold state handler

  // Debug: detect chunk dims mismatch (pool created for different chunk size)
  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
    console.warn(`[volumeChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY},${atlas.chunkZ}] msg=[${chunkX},${chunkY},${chunkZ}] level=${level}`);
  }
  // Look up entity's lodMetas
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[volumeChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[volumeChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    return;
  }

  rayHitPerEntity.set(memberId, msg.hitLocal);

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;
  const evictedKeys: string[] = [];
  const insertedKeys: string[] = []; // composite keys we successfully inserted

  for (const chunk of msg.chunks) {
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (atlas.slots.has(compositeKey)) continue;

    let slotIndex: number;
    if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      const { key: evictKey, dist: farthestDist } = findFarthestSlot(atlas);
      if (!evictKey) continue;
      const cam = rayHitPerEntity.get(memberId) ?? [0.5, 0.5, 0.5];
      const incomingDist = chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam);
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

    // Write to entity's per-LOD indirection section (absolute offset)
    const [, lodGridY, lodGridX] = lodMeta.gridDims;
    const globalIdx = lodMeta.offset + chunk.z * lodGridY * lodGridX + chunk.y * lodGridX + chunk.x;
    if (globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
    atlas.slots.set(compositeKey, slotIndex);
    insertedKeys.push(compositeKey);
    atlas.indirectionDirty = true;

    const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
    const { min, max } = sampleIntensityRange(data, perChunkSamples);
    if (min < atlas.intensityMin) { atlas.intensityMin = min; intensityChanged = true; }
    if (max > atlas.intensityMax) { atlas.intensityMax = max; intensityChanged = true; }
  }

  // Report chunks from the batch that the pool did not keep
  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key); // report bare chunk key (not composite) for orchestrator
    }
  }

  // Report evicted/skipped chunks. Convert composite eviction keys back to (memberId, chunkKey)
  // so the orchestrator can clear the right delivery tracking.
  if (evictedKeys.length > 0 || skippedKeys.length > 0) {
    // Group evicted keys by memberId (each entity has its own delivery tracking)
    const evictedByMember = new Map<string, string[]>();
    for (const ck of evictedKeys) {
      const parsed = parseCompositeKey(ck);
      if (!parsed) continue;
      const arr = evictedByMember.get(parsed.memberId) ?? [];
      arr.push(parsed.chunkKey);
      evictedByMember.set(parsed.memberId, arr);
    }
    // Report evictions per member
    for (const [evMember, evKeys] of evictedByMember) {
      ctx.post({ type: "chunksEvicted", datasetId: evMember, keys: evKeys, skipped: [] });
    }
    // Report skipped (this batch's member only)
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", datasetId: memberId, keys: [], skipped: skippedKeys });
    }
    ctx.postWantedSet();
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId: memberId, min: atlas.intensityMin, max: atlas.intensityMax });
  }
}

export function handleVolumeRenderMultiPass(
  ctx: WorkerCtx,
  msg: VolumeRenderMultiPassMessage,
  layerToPool: (memberId: string) => { poolKey: string } | null,
): void {
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
    const memberId = layer.datasetId;
    const resolved = layerToPool(memberId);
    if (!resolved) continue;
    const atlas = atlasPerDataset.get(resolved.poolKey);
    if (!atlas) continue;
    const entityLodMetas = atlas.entityMetas.get(memberId);
    if (!entityLodMetas) continue;

    rayHitPerEntity.set(memberId, layer.rayHitLocal);

    const lutTex = ctx.getOrCreateLUT(layer.colormap ?? "gray");
    renderer.setColormapTexture(lutTex);

    if (atlas.indirectionDirty) {
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      atlas.indirectionDirty = false;
    }
    // Use target LOD's dims for the legacy single-LOD uniforms (gridX/Y/Z, levelWidth/Height/Depth).
    // Multi-LOD fallback uses entityLodMetas which has per-LOD info.
    const targetMeta = entityLodMetas[0]; // first is target (finest)
    const [tGridZ, tGridY, tGridX] = targetMeta.gridDims;
    const [tLevelD, tLevelH, tLevelW] = targetMeta.levelDims;
    renderer.setAtlas(
      atlas.texture, atlas.indirectionBuf,
      [atlas.chunkX, atlas.chunkY, atlas.chunkZ],
      [tGridX, tGridY, tGridZ],
      [atlas.slotsX, atlas.slotsY, atlas.slotsZ],
      [tLevelW, tLevelH, tLevelD],
      entityLodMetas,
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

/**
 * Remove resources for a removed entity or dataset.
 * Pass either a poolKey (removes the whole pool) or a memberId (removes per-entity state).
 */
export function removeVolumeResources(idOrMember: string): void {
  const atlas = atlasPerDataset.get(idOrMember);
  if (atlas) {
    destroyAtlas(atlas);
    atlasPerDataset.delete(idOrMember);
  }
  rayHitPerEntity.delete(idOrMember);
}

export function destroyAllVolumeResources(): void {
  for (const atlas of atlasPerDataset.values()) destroyAtlas(atlas);
  atlasPerDataset.clear();
  rayHitPerEntity.clear();
  depthTexture?.destroy();
  depthTexture = null;
}
