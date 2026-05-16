/**
 * Volume atlas state — pool allocation, indirection sizing, depth
 * texture, dummy indirection buffer, and per-dataset registry.
 *
 * Extracted from `volumeHandlers.ts` in Slice 7. Behavior is unchanged.
 *
 * Composed cleanups (`removeVolumeResources`, `destroyAllVolumeResources`)
 * live in `volume/index.ts` so this module stays free of dependencies on
 * `volume/eviction.ts` (which owns the per-entity ray-pick state).
 */

import type { WorkerCtx } from "../workerContext.ts";
import { VOLUME_ATLAS_BUDGET } from "../workerProtocol.ts";

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

const atlasPerDataset = new Map<string, AtlasState>();

export function getVolumeAtlases(): Map<string, AtlasState> {
  return atlasPerDataset;
}

// Shared depth texture for volume rendering (used by cursor renderer for occlusion)
let depthTexture: GPUTexture | null = null;
let depthW = 0;
let depthH = 0;

// Shared dummy indirection buffer, used when binding the chunk atlas
// for `well-as-proxy` layers (which sample only the proxy texture;
// chunk bindings still need valid GPU resources).
let dummyIndirectionBuf: GPUBuffer | null = null;
export function getDummyIndirection(device: GPUDevice): GPUBuffer {
  if (!dummyIndirectionBuf) {
    dummyIndirectionBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dummyIndirectionBuf, 0, new Uint32Array([0xFFFFFFFF]));
  }
  return dummyIndirectionBuf;
}

export function ensureDepthTexture(device: GPUDevice, w: number, h: number): GPUTexture {
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

/** Current depth texture handle, used by the cursor renderer for occlusion. */
export function getDepthTexture(): GPUTexture | null {
  return depthTexture;
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

export function destroyAtlas(atlas: AtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
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

/**
 * Remove the atlas pool for a removed dataset (no-op if not present).
 * Composed cleanup that also clears per-entity ray-pick state lives in
 * `volume/index.ts` as `removeVolumeResources`.
 */
export function removeVolumeAtlas(idOrMember: string): void {
  const atlas = atlasPerDataset.get(idOrMember);
  if (atlas) {
    destroyAtlas(atlas);
    atlasPerDataset.delete(idOrMember);
  }
}

/**
 * Destroy all atlas pools + the depth texture + the dummy indirection
 * buffer. Composed cleanup that also clears per-entity ray-pick state
 * lives in `volume/index.ts` as `destroyAllVolumeResources`.
 */
export function destroyAllVolumeAtlasResources(): void {
  for (const atlas of atlasPerDataset.values()) destroyAtlas(atlas);
  atlasPerDataset.clear();
  depthTexture?.destroy();
  depthTexture = null;
  dummyIndirectionBuf?.destroy();
  dummyIndirectionBuf = null;
}
