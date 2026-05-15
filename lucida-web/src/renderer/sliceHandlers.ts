import type { WorkerCtx } from "./workerContext.ts";
import type {
  SliceChunkDataMessage,
  SliceRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { SLICE_ATLAS_BUDGET } from "./workerProtocol.ts";
import { createSliceTexture, writeSliceRegion } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";
import type { PlanningEpochs } from "../pipeline/planning/index.ts";
import { isStaleDelivery } from "./epochCheck.ts";
import { asUint16Slice } from "./dataTypeUtil.ts";
import { parseChunkKey, parseCompositeKey, makeCompositeKey, type LodIndirectionMeta } from "./volumeHandlers.ts";

/** Per-entity Z metadata for slice mode (drives Z-chunk filtering and re-slice detection). */
export interface SliceEntityZInfo {
  chunkZ: number;
  fullResDepth: number;
  levelDepth: number;
}

export interface SliceAtlasState {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  /** Composite keys "memberId|chunkKey" → slotIndex (insertion-order = LRU). */
  slots: Map<string, number>;
  /** slotIndex → globalGridIdx (for eviction cleanup). */
  slotGridIdx: Int32Array<ArrayBuffer>;
  freeSlots: number[];
  totalSlots: number;
  /** Shared slot pool dimensions. */
  chunkX: number; chunkY: number;
  slotsX: number; slotsY: number;
  /** Per-entity LOD sections (absolute offsets into the shared flat indirection buffer). */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /** Per-entity Z info (chunkZ, fullResDepth, levelDepth) — set from first chunk arrival per entity. */
  entityZInfo: Map<string, SliceEntityZInfo>;
  /** Current T, C, full-res Z — pool-wide. */
  z: number; t: number; c: number;
  /** Composite keys with stale 2D slice data after a Z change. */
  staleSliceKeys: Set<string> | null;
  intensityMin: number; intensityMax: number;
  indirectionDirty: boolean;
}

const atlasPerDataset = new Map<string, SliceAtlasState>();

// S8: shared dummy 2D indirection buffer for well-as-proxy slice layers
// (chunk bindings still need valid GPU resources even though the shader
// short-circuits to the proxy texture).
let dummySliceIndirectionBuf: GPUBuffer | null = null;
function getDummySliceIndirection(device: GPUDevice): GPUBuffer {
  if (!dummySliceIndirectionBuf) {
    dummySliceIndirectionBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dummySliceIndirectionBuf, 0, new Uint32Array([0xFFFFFFFF]));
  }
  return dummySliceIndirectionBuf;
}

export function getSliceAtlases(): Map<string, SliceAtlasState> {
  return atlasPerDataset;
}

/** Last known viewport center in [0,1] UV space per ENTITY (memberId). */
const cameraUVPerEntity = new Map<string, [number, number]>();

/** Compute target chunk Z for an entity given current full-res Z. */
function computeTargetChunkZ(zInfo: SliceEntityZInfo | undefined, currentZ: number): number | null {
  if (!zInfo || zInfo.chunkZ <= 0) return null;
  const levelZ = Math.min(
    Math.floor((currentZ / Math.max(zInfo.fullResDepth - 1, 1)) * Math.max(zInfo.levelDepth - 1, 1)),
    zInfo.levelDepth - 1,
  );
  return Math.floor(levelZ / zInfo.chunkZ);
}

/**
 * Remap the 2D indirection buffer for the current state.
 * Walks composite slot keys, looks up each entity's lodMetas + Z info,
 * and writes chunks matching current T/C and target Z into per-entity sections.
 */
export function remapSliceIndirection(
  atlas: SliceAtlasState,
  currentT: number,
  currentC: number,
  currentZ: number,
): void {
  atlas.indirectionData.fill(0xFFFFFFFF);
  atlas.slotGridIdx.fill(-1);

  for (const [compositeKey, slotIndex] of atlas.slots) {
    const parsedComposite = parseCompositeKey(compositeKey);
    if (!parsedComposite) continue;

    const lodMetas = atlas.entityMetas.get(parsedComposite.memberId);
    if (!lodMetas) continue; // entity no longer in active set

    const chunk = parseChunkKey(parsedComposite.chunkKey);
    if (!chunk) continue;
    if (chunk.t !== currentT) continue;
    if (chunk.c !== currentC) continue;

    // Z filter (per entity)
    const targetChunkZ = computeTargetChunkZ(atlas.entityZInfo.get(parsedComposite.memberId), currentZ);
    if (targetChunkZ !== null && chunk.z !== targetChunkZ) continue;

    const meta = lodMetas.find(m => m.level === chunk.level);
    if (!meta) continue;

    const [, , lodGridX] = meta.gridDims;
    const globalIdx = meta.offset + chunk.y * lodGridX + chunk.x;
    if (globalIdx >= 0 && globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
  }

  atlas.indirectionDirty = true;
}

/** Create a shared slice pool. Indirection sized later from entityMetas. */
function createSliceAtlas(
  device: GPUDevice,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
): SliceAtlasState {
  const chunkTexels = chunkX * chunkY;
  const maxSlots = Math.floor(SLICE_ATLAS_BUDGET / (chunkTexels * 2));
  const slotsPerAxis = Math.floor(Math.sqrt(maxSlots));
  const slotsX = Math.min(slotsPerAxis, Math.floor(8192 / chunkX));
  const slotsY = Math.min(slotsPerAxis, Math.floor(8192 / chunkY));
  const totalSlots = slotsX * slotsY;

  const atlasW = slotsX * chunkX;
  const atlasH = slotsY * chunkY;

  const texture = createSliceTexture(device, atlasW, atlasH, null);

  // Indirection sized later by cold state handler
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
    chunkX, chunkY,
    slotsX, slotsY,
    entityMetas: new Map(),
    entityZInfo: new Map(),
    z, t, c,
    staleSliceKeys: null,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: true,
  };
}

function destroySliceAtlas(atlas: SliceAtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/**
 * Get or create a shared slice pool with the given chunk dims.
 * Cold state handler sets entityMetas and resizes indirection afterward.
 */
export function getOrCreateSlicePool(
  ctx: WorkerCtx,
  poolKey: string,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
): SliceAtlasState {
  const existing = atlasPerDataset.get(poolKey);
  if (existing && existing.chunkX === chunkX && existing.chunkY === chunkY) {
    // Mark stale on Z change before updating z
    if (z !== existing.z && existing.slots.size > 0) {
      existing.staleSliceKeys = new Set(existing.slots.keys());
    }
    existing.z = z;
    existing.t = t;
    existing.c = c;
    return existing;
  }
  if (existing) destroySliceAtlas(existing);
  const newAtlas = createSliceAtlas(ctx.device, chunkX, chunkY, z, t, c);
  atlasPerDataset.set(poolKey, newAtlas);
  return newAtlas;
}

/** Resize the slice pool's indirection to the new total size. */
export function resizeSliceIndirection(ctx: WorkerCtx, atlas: SliceAtlasState, totalEntries: number): void {
  if (totalEntries === atlas.indirectionData.length) return;
  atlas.indirectionData = new Uint32Array(totalEntries);
  atlas.indirectionBuf.destroy();
  atlas.indirectionBuf = ctx.device.createBuffer({
    size: Math.max(totalEntries * 4, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

/** Squared distance from a chunk grid coordinate to a reference UV. Uses entity-specific level dims. */
function chunkDistSq2D(
  lodMeta: LodIndirectionMeta,
  cx: number, cy: number,
  cam: [number, number],
): number {
  const [, levelH, levelW] = lodMeta.levelDims;
  const [, , chunkX] = lodMeta.chunkDims;
  const [, chunkY] = lodMeta.chunkDims;
  const px = (cx + 0.5) * chunkX / Math.max(levelW, 1);
  const py = (cy + 0.5) * chunkY / Math.max(levelH, 1);
  const dx = px - cam[0];
  const dy = py - cam[1];
  return dx * dx + dy * dy;
}

/** Find the best eviction candidate: prefer stale, then farthest. Per-entity distance reference. */
function findFarthestSlot2D(atlas: SliceAtlasState): { key: string; dist: number } {
  let farthestKey = "";
  let maxDist = -1;

  for (const [compositeKey, slotIdx] of atlas.slots) {
    const gridIdx = atlas.slotGridIdx[slotIdx];
    if (gridIdx < 0) {
      return { key: compositeKey, dist: Infinity };
    }

    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const lodMetas = atlas.entityMetas.get(parsed.memberId);
    if (!lodMetas) {
      return { key: compositeKey, dist: Infinity };
    }
    const chunk = parseChunkKey(parsed.chunkKey);
    if (!chunk) continue;
    const lodMeta = lodMetas.find(m => m.level === chunk.level);
    if (!lodMeta) continue;

    const cam = cameraUVPerEntity.get(parsed.memberId) ?? [0.5, 0.5];
    const dist = chunkDistSq2D(lodMeta, chunk.x, chunk.y, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = compositeKey;
    }
  }

  return { key: farthestKey, dist: maxDist };
}

export function handleSliceChunkData(
  ctx: WorkerCtx,
  msg: SliceChunkDataMessage,
  currentEpochs: PlanningEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    const skippedKeys = msg.chunks.map(c => c.key);
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", datasetId: memberId, keys: [], skipped: skippedKeys });
    }
    return;
  }

  const atlas = atlasPerDataset.get(poolKey);
  if (!atlas) return;

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    console.warn(`[sliceChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY}] msg=[${chunkX},${chunkY}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[sliceChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[sliceChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    return;
  }

  // Store per-entity Z metadata on first arrival
  if (!atlas.entityZInfo.has(memberId)) {
    atlas.entityZInfo.set(memberId, { chunkZ, fullResDepth, levelDepth });
  }

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
    if (chunk.z !== targetChunkZ) continue;
    const compositeKey = makeCompositeKey(memberId, chunk.key);

    const existingSlot = atlas.slots.get(compositeKey);
    if (existingSlot !== undefined) {
      if (!atlas.staleSliceKeys?.has(compositeKey)) continue;
      atlas.staleSliceKeys.delete(compositeKey);
    }

    const isU8 = chunk.dataType === "uint8" || chunk.dataType === "Uint8";
    if (!isU8 && chunk.data.byteLength % 2 !== 0) {
      throw new Error(
        `slice chunk ${chunk.key}: byteLength ${chunk.data.byteLength} is not a multiple of 2 ` +
        `(server likely returned a compressed or wrong-shape chunk)`,
      );
    }
    const rawView = isU8 ? new Uint8Array(chunk.data) : new Uint16Array(chunk.data);
    const r = sampleIntensityRange(rawView, perChunkSamples);
    if (r.min < atlas.intensityMin) { atlas.intensityMin = r.min; intensityChanged = true; }
    if (r.max > atlas.intensityMax) { atlas.intensityMax = r.max; intensityChanged = true; }

    let slotIndex: number;
    if (existingSlot !== undefined) {
      slotIndex = existingSlot;
    } else if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      const { key: evictKey, dist: farthestDist } = findFarthestSlot2D(atlas);
      if (!evictKey) continue;
      const cam = cameraUVPerEntity.get(memberId) ?? [0.5, 0.5];
      const incomingDist = chunkDistSq2D(lodMeta, chunk.x, chunk.y, cam);
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
    const sliceData = asUint16Slice(chunk.data, chunk.dataType, sliceOffset, chunkY * chunkX);

    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    writeSliceRegion(ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, chunkW, chunkH);

    // Write to entity's per-LOD section
    const [, , lodGridX] = lodMeta.gridDims;
    const globalIdx = lodMeta.offset + chunk.y * lodGridX + chunk.x;
    if (globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
    atlas.slots.set(compositeKey, slotIndex);
    atlas.indirectionDirty = true;
  }

  // Report evicted/skipped, demuxed by member
  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key);
    }
  }

  if (evictedKeys.length > 0 || skippedKeys.length > 0) {
    const evictedByMember = new Map<string, string[]>();
    for (const ck of evictedKeys) {
      const parsed = parseCompositeKey(ck);
      if (!parsed) continue;
      const arr = evictedByMember.get(parsed.memberId) ?? [];
      arr.push(parsed.chunkKey);
      evictedByMember.set(parsed.memberId, arr);
    }
    for (const [evMember, evKeys] of evictedByMember) {
      ctx.post({ type: "chunksEvicted", datasetId: evMember, keys: evKeys, skipped: [] });
    }
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", datasetId: memberId, keys: [], skipped: skippedKeys });
    }
    ctx.postWantedSet();
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId: memberId, min: atlas.intensityMin, max: atlas.intensityMax });
  }
}

export function handleSliceRenderMultiPass(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layerToPool: (memberId: string) => { poolKey: string | null; datasetId: string | null } | null,
): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  const pool = ctx.ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;
    const resolved = layerToPool(memberId);
    if (!resolved) continue;

    // M1+M2: per-dataset descriptor + entity index (orchestrator-
    // computed; converges with the worker's descriptor build by
    // canonical iteration order).
    const descIndex = resolved.datasetId
      ? ctx.lookupEntityDescriptor(resolved.datasetId)
      : null;
    if (!descIndex) continue;
    const entityIndex = layer.entityIndex;

    // Detect "no detail" via descriptor-derived state: the canonical
    // signal that this entity has no chunks in the pool. Drives the
    // dummy chunk atlas binding + skip-render guard below.
    const atlas = resolved.poolKey ? atlasPerDataset.get(resolved.poolKey) ?? null : null;
    let entityLodMetas: LodIndirectionMeta[] | null = null;
    if (atlas) {
      entityLodMetas = atlas.entityMetas.get(memberId) ?? null;
    }
    const hasDetail = entityLodMetas != null && entityLodMetas.length > 0;

    const ox = layer.offsetX ?? 0;
    const oy = layer.offsetY ?? 0;
    if (hasDetail) {
      cameraUVPerEntity.set(memberId, [
        (msg.cx - ox) / layer.dataW,
        (msg.cy - oy) / layer.dataH,
      ]);
    }

    const idx = renderedLayers.length;

    if (atlas && atlas.indirectionDirty) {
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      atlas.indirectionDirty = false;
    }

    // M1: resolve proxy texture handles via the descriptor's dense pool
    // array. Slot indices + dims come from the GPU descriptor.
    const desc = layer.entityId
      ? ctx.lookupProxyDescriptor(layer.entityId)
      : null;
    let fieldProxyTexture: GPUTexture | null = null;
    let wellProxyTexture: GPUTexture | null = null;
    let wellProxySlotResident = false;

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
          wellProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
          wellProxySlotResident = true;
        }
      }
    }

    // Skip when the layer has nothing renderable: no detail chunks AND
    // no resident well proxy. Entities with detail OR a resident proxy
    // continue rendering — the unified fallback chain handles the rest.
    if (!hasDetail && !wellProxySlotResident) continue;

    renderer.setProxyTextures(fieldProxyTexture, wellProxyTexture);

    if (hasDetail && atlas) {
      renderer.setAtlas(
        atlas.texture, atlas.indirectionBuf,
        [atlas.slotsX, atlas.slotsY],
      );
    } else {
      // No detail — bind the slice renderer's own dummy chunk +
      // indirection so the bind group is valid. The unified shader chain
      // falls through to the proxy via the descriptor.
      renderer.setAtlas(
        ctx.getDummyTexture(), getDummySliceIndirection(ctx.device),
        [1, 1],
      );
    }

    // M2: colormap from descriptor's CPU mirror; contrast/gamma/opacity
    // are read by the shader straight from the descriptor.
    const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
    const lutTex = ctx.getOrCreateLUT(colormapName);
    renderer.setColormapTexture(lutTex);
    renderer.setTransform(msg.zoom, msg.cx - ox, msg.cy - oy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
    renderer.setDescriptorBinding(descIndex.buffer, entityIndex);
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

export function removeSliceResources(idOrMember: string): void {
  const atlas = atlasPerDataset.get(idOrMember);
  if (atlas) {
    destroySliceAtlas(atlas);
    atlasPerDataset.delete(idOrMember);
  }
  cameraUVPerEntity.delete(idOrMember);
}

export function destroyAllSliceResources(): void {
  for (const atlas of atlasPerDataset.values()) destroySliceAtlas(atlas);
  atlasPerDataset.clear();
  cameraUVPerEntity.clear();
  dummySliceIndirectionBuf?.destroy();
  dummySliceIndirectionBuf = null;
}
