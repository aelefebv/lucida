import type { WorkerCtx } from "./workerContext.ts";
import type {
  VolumeChunkDataMessage,
  VolumeRenderMultiPassMessage,
  ViewHotStateMessage,
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

// S8: shared dummy indirection buffer, used when binding the chunk atlas
// for `well-as-proxy` layers (which sample only the proxy texture; chunk
// bindings still need valid GPU resources).
let dummyIndirectionBuf: GPUBuffer | null = null;
function getDummyIndirection(device: GPUDevice): GPUBuffer {
  if (!dummyIndirectionBuf) {
    dummyIndirectionBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dummyIndirectionBuf, 0, new Uint32Array([0xFFFFFFFF]));
  }
  return dummyIndirectionBuf;
}

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
// Populated by `applyViewHotState` on viewEpoch advance (M3); chunk-data
// and render handlers read it for `findFarthestSlot` distance metrics.
const rayHitPerEntity = new Map<string, [number, number, number]>();

/**
 * M3 (DOMAINS step 8a): apply a viewEpoch hot-state message. Updates the
 * `rayHitPerEntity` map so chunk eviction prioritization stays in sync
 * with the camera ray-pick. Latest message wins per entity.
 */
export function applyViewHotState(msg: ViewHotStateMessage): void {
  for (const [entityId, hit] of msg.rayHitsByEntity) {
    rayHitPerEntity.set(entityId, hit);
  }
}

/** Test-only: read the per-entity ray-pick map. */
export function getRayHitForMember(memberId: string): [number, number, number] | undefined {
  return rayHitPerEntity.get(memberId);
}

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
  layerToPool: (memberId: string) => { poolKey: string | null; datasetId: string | null } | null,
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

    // M1+M2: descriptor buffer covers all members for this dataset;
    // entity index is computed by the orchestrator (and threaded into
    // the layer params) — both sides converge by construction.
    const descIndex = resolved.datasetId
      ? ctx.lookupEntityDescriptor(resolved.datasetId)
      : null;
    if (!descIndex) continue;
    const entityIndex = layer.entityIndex;

    // S8: well-as-proxy entries don't have a chunk pool — we render with
    // a dummy chunk atlas + indirection but a real proxy texture binding.
    const isWellAsProxy = layer.mode === "well-as-proxy";
    const atlas = resolved.poolKey ? atlasPerDataset.get(resolved.poolKey) ?? null : null;
    let entityLodMetas: LodIndirectionMeta[] | null = null;
    if (atlas) {
      entityLodMetas = atlas.entityMetas.get(memberId) ?? null;
    }
    if (!isWellAsProxy) {
      // Field-mode: chunk atlas + per-entity LOD meta required.
      if (!atlas || !entityLodMetas) continue;
    }

    // M2: colormap name lives in the descriptor's CPU mirror (set by
    // cold state). Resolve it per draw to bind the right LUT texture.
    const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
    const lutTex = ctx.getOrCreateLUT(colormapName);
    renderer.setColormapTexture(lutTex);

    if (atlas && atlas.indirectionDirty) {
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      atlas.indirectionDirty = false;
    }

    // M1: pool index + slot index live in the descriptor; CPU side only
    // needs the texture handle for binding. Read the pool by walking the
    // dense `proxyPoolsByIndex` array (resolved via the entity's CPU-side
    // proxy descriptor mirror).
    const desc = layer.entityId
      ? ctx.lookupProxyDescriptor(layer.entityId)
      : null;
    let renderModeProxy = 0; // 0 = legacy chunk-only
    let fieldProxyTexture: GPUTexture | null = null;
    let wellProxyTexture: GPUTexture | null = null;
    let wellProxySlotResident = false;
    let wellSlotDimsForVolumeFallback: [number, number, number] = [1, 1, 1];

    if (layer.mode === "well-as-proxy") {
      renderModeProxy = 1;
    } else if (
      layer.mode === "fields-with-proxy-fallback" ||
      layer.mode === "fields-with-detail"
    ) {
      renderModeProxy = 2;
    }

    if (desc) {
      if (desc.fieldProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.fieldProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          fieldProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
        }
      }
      if (desc.wellProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.wellProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          const pool = descIndex.proxyPoolsByIndex[poolIdx];
          wellProxyTexture = pool.texture;
          wellProxySlotResident = true;
          wellSlotDimsForVolumeFallback = pool.slotDims;
        }
      }
    }

    // For well-as-proxy mode, if no well proxy is resident yet, the
    // shader returns 0xFFFFFFFFu (transparent) — skip the draw to avoid
    // a flashing empty rect.
    if (renderModeProxy === 1 && !wellProxySlotResident) {
      isFirstLayer = false;
      continue;
    }

    renderer.setProxyParams(renderModeProxy, fieldProxyTexture, wellProxyTexture);

    if (atlas && entityLodMetas) {
      // Field-mode (or fallback) path: real chunk atlas + LOD metadata.
      const targetMeta = entityLodMetas[0]; // first is target (finest)
      const [tLevelD, tLevelH, tLevelW] = targetMeta.levelDims;
      renderer.setAtlas(
        atlas.texture, atlas.indirectionBuf,
        [atlas.slotsX, atlas.slotsY, atlas.slotsZ],
        [tLevelW, tLevelH, tLevelD],
        entityLodMetas,
      );
    } else {
      // S8: well-as-proxy with no chunk atlas — bind dummies for the
      // shader's chunk path (short-circuited by renderMode==1).
      // volumeDims must reflect the proxy's voxel resolution: the volume
      // renderer derives ray-march stepSize from it, and [1,1,1] yields
      // ~3 samples/ray → alpha barely accumulates in translucent
      // compositing → proxy renders dim/desaturated.
      const dummyChunk = ctx.getDummy3DTexture();
      // wellSlotDimsForVolumeFallback is [Z, Y, X]; setAtlas takes
      // volumeDims as [X, Y, Z].
      const proxyVolumeDims: [number, number, number] = [
        wellSlotDimsForVolumeFallback[2],
        wellSlotDimsForVolumeFallback[1],
        wellSlotDimsForVolumeFallback[0],
      ];
      renderer.setAtlas(
        dummyChunk, getDummyIndirection(ctx.device),
        [1, 1, 1], proxyVolumeDims,
        [],
      );
    }

    renderer.setRenderMode(layer.renderMode === "max_intensity" ? 1 : 0);
    renderer.setMatrices(msg.invViewProj, msg.eye, msg.viewProj, msg.camForward, msg.clipDistance, msg.clipMode);
    renderer.setDescriptorBinding(descIndex.buffer, entityIndex);
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
  dummyIndirectionBuf?.destroy();
  dummyIndirectionBuf = null;
}
