/**
 * Volume atlas state — pool allocation, indirection sizing, depth
 * texture, dummy indirection buffer.
 *
 * Mutates the per-dataset registry on `ctx.state.volumeAtlases`. Composed
 * cleanups (`removeVolumeResources`, `destroyAllVolumeResources`) live in
 * `volume/index.ts` so this module stays free of dependencies on
 * `volume/eviction.ts` (which owns the per-entity ray-pick state).
 */

import type { WorkerCtx } from "../workerContext.ts";
import { VOLUME_ATLAS_BUDGET } from "../workerProtocol.ts";
import { createEmptyVolumeTexture, getDeviceLimits } from "../gpuContext.ts";
import { computeAtlasGeometry } from "../atlasSizing.ts";

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

/**
 * A label overlay's volume pool: one `r32uint` 3D texture holding the label
 * mask at its chosen level's full extent, plus a single-slot indirection
 * buffer so the categorical shader path reads it as one tile. The 3D analog
 * of {@link import("../slice/atlas.ts").LabelSlicePool}: kept minimal and
 * self-contained (no shared LRU slots) because a label overlay is a single
 * member covering a bounded footprint, unlike the shared intensity atlas
 * that packs many members.
 *
 * The texture is written IN PLACE as chunks arrive (never destroyed on a
 * T scrub), mirroring the intensity atlas' overwrite so a label never blanks
 * mid-scrub — the previous volume stays visible until the new one lands.
 */
export interface LabelVolumePool {
  texture: GPUTexture; // r32uint 3D, size [width, height, depth]
  /** Single-entry indirection ([0]) so the one tile is always slot 0. */
  indirectionBuf: GPUBuffer;
  /**
   * Owning dataset id (the `removeLayerResources` id). The pool is keyed by
   * the label image id — which dataset removal never sees — so this is how
   * {@link removeLabelVolumePoolsForDataset} finds + frees it on removal.
   */
  datasetId: string;
  width: number;
  height: number;
  depth: number;
  /**
   * Reused single-entity descriptor buffer (allocated once, rewritten in
   * place each frame). Unlike the 2D label descriptor — cacheable by opacity
   * because it uses an identity transform — the volume label descriptor
   * carries the source member's model matrix (for the ray transform + frag
   * depth), which can change on a layout epoch, so its contents are refreshed
   * per frame rather than cached. Populated by the render path.
   */
  descBuffer?: GPUBuffer;
  /**
   * Cached declared-palette storage buffer ([id, packedRgba] pairs) + its
   * pair count, built once from the label's `image-label.colors`.
   */
  labelColorBuffer?: GPUBuffer;
  labelColorCount?: number;
}

/** Warn once per member when its label volume texture can't be allocated,
 *  so a failing device doesn't spam the console each delivery. */
const warnedLabelVolumeAlloc = new Set<string>();

/**
 * Get or create a label volume pool for `memberId` sized to the label
 * level's 3D dimensions (clamped to the device's max 3D texture dimension
 * so an oversized level can never exceed the limit). Reused IN PLACE when the
 * dims are unchanged — a T scrub overwrites the existing texture rather than
 * destroying + recreating it, so the overlay never blanks. Recreated only when
 * the dims actually change (a new level). `datasetId` is stamped on the pool so
 * dataset removal can free it (the pool is keyed by the label image id).
 *
 * Returns `null` when the texture allocation fails (e.g. an out-of-budget
 * device) — the caller skips the label rather than throwing through the upload
 * path. Level selection already bounds the size, so this is defense in depth.
 */
export function getOrCreateLabelVolumePool(
  ctx: WorkerCtx,
  memberId: string,
  datasetId: string,
  width: number,
  height: number,
  depth: number,
): LabelVolumePool | null {
  const limit = getDeviceLimits(ctx.device).maxTextureDimension3D;
  const w = Math.max(1, Math.min(width, limit));
  const h = Math.max(1, Math.min(height, limit));
  const d = Math.max(1, Math.min(depth, limit));

  const pools = ctx.state.labelVolumePools;
  const existing = pools.get(memberId);
  if (existing && existing.width === w && existing.height === h && existing.depth === d) {
    existing.datasetId = datasetId;
    return existing;
  }
  if (existing) destroyLabelVolumePool(existing);

  let texture: GPUTexture;
  try {
    texture = createEmptyVolumeTexture(ctx.device, w, h, d, "r32uint");
  } catch (err) {
    if (!warnedLabelVolumeAlloc.has(memberId)) {
      warnedLabelVolumeAlloc.add(memberId);
      console.warn(
        `[labels] skipping "${memberId}": could not allocate a ${w}×${h}×${d} ` +
        `r32uint volume texture (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return null;
  }
  const indirectionBuf = ctx.device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Single tile lives at slot 0.
  ctx.device.queue.writeBuffer(indirectionBuf, 0, new Uint32Array([0]));

  const pool: LabelVolumePool = { texture, indirectionBuf, datasetId, width: w, height: h, depth: d };
  pools.set(memberId, pool);
  return pool;
}

export function destroyLabelVolumePool(pool: LabelVolumePool): void {
  pool.texture.destroy();
  pool.indirectionBuf.destroy();
  pool.descBuffer?.destroy();
  pool.labelColorBuffer?.destroy();
}

/**
 * Free every label volume pool matching `idOrDataset`, matched EITHER by the
 * pool's member key (the label image id) OR by its owning `datasetId`. Dataset
 * removal calls `removeLayerResources` with the dataset id, which never equals
 * a label pool's key — so matching on the stamped `datasetId` is what actually
 * frees the (large) 3D label texture. Also accepts a member id so a per-member
 * removal still works.
 */
export function removeLabelVolumePoolsForDataset(ctx: WorkerCtx, idOrDataset: string): void {
  for (const [memberId, pool] of ctx.state.labelVolumePools) {
    if (memberId === idOrDataset || pool.datasetId === idOrDataset) {
      destroyLabelVolumePool(pool);
      ctx.state.labelVolumePools.delete(memberId);
    }
  }
}

/** Destroy every label volume pool. */
export function destroyAllLabelVolumePools(ctx: WorkerCtx): void {
  for (const pool of ctx.state.labelVolumePools.values()) destroyLabelVolumePool(pool);
  ctx.state.labelVolumePools.clear();
}

// Shared depth texture for volume rendering (used by cursor renderer for occlusion).
// Stays at module scope: it's a per-canvas resource (not per-session) that
// `ensureDepthTexture` resizes when canvas dims change.
let depthTexture: GPUTexture | null = null;
let depthW = 0;
let depthH = 0;

// Shared dummy indirection buffer for `well-as-proxy` chunk bindings.
// Same reasoning as `depthTexture`: not per-session state.
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
  const limits = getDeviceLimits(device);
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY, chunkZ],
    VOLUME_ATLAS_BUDGET,
    "3d",
  );
  const { slotsX, slotsY, totalSlots, atlasW, atlasH } = geom;
  const slotsZ = geom.slotsZ!;
  const atlasD = geom.atlasD!;

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
 * Stores the pool in `ctx.state.volumeAtlases`. Cold state handler is responsible
 * for setting entityMetas and resizing the indirection buffer afterward.
 */
export function getOrCreateVolumePool(
  ctx: WorkerCtx,
  poolKey: string,
  chunkX: number, chunkY: number, chunkZ: number,
  t: number, c: number,
): AtlasState {
  const atlases = ctx.state.volumeAtlases;
  const existing = atlases.get(poolKey);
  if (existing && existing.chunkX === chunkX && existing.chunkY === chunkY && existing.chunkZ === chunkZ) {
    existing.t = t;
    existing.c = c;
    return existing;
  }
  if (existing) destroyAtlas(existing);
  const newAtlas = createVolumeAtlas(ctx.device, chunkX, chunkY, chunkZ, t, c);
  atlases.set(poolKey, newAtlas);
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
export function removeVolumeAtlas(ctx: WorkerCtx, idOrMember: string): void {
  const atlases = ctx.state.volumeAtlases;
  const atlas = atlases.get(idOrMember);
  if (atlas) {
    destroyAtlas(atlas);
    atlases.delete(idOrMember);
  }
}

/**
 * Destroy all atlas pools + the depth texture + the dummy indirection
 * buffer. Composed cleanup that also clears per-entity ray-pick state
 * lives in `volume/index.ts` as `destroyAllVolumeResources`.
 */
export function destroyAllVolumeAtlasResources(ctx: WorkerCtx): void {
  const atlases = ctx.state.volumeAtlases;
  for (const atlas of atlases.values()) destroyAtlas(atlas);
  atlases.clear();
  depthTexture?.destroy();
  depthTexture = null;
  dummyIndirectionBuf?.destroy();
  dummyIndirectionBuf = null;
}
