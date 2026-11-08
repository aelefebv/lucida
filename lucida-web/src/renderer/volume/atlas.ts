/**
 * Volume atlas state: pool allocation, indirection sizing, depth texture.
 *
 * Composed cleanups (`removeVolumeResources`, `destroyAllVolumeResources`)
 * live in `volume/index.ts` so this module stays free of dependencies on
 * `volume/eviction.ts`, which owns the per-entity ray-pick state.
 */

import { Axis } from "../../axes.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { createEmptyVolumeTexture, getDeviceLimits } from "../gpuContext.ts";
import { computeAtlasGeometry } from "../atlasSizing.ts";
import { computeProxyAtlasLayout } from "../proxyAtlas.ts";
import { allocateWatched } from "../worker/gpuErrors.ts";
import { postPoolChunksLost } from "../chunkUploadFeedback.ts";
import { shrinkAtlasBudget } from "../../deviceBudget.ts";

/** Bytes one label voxel occupies in the `r32uint` atlas. */
const LABEL_VOLUME_BYTES_PER_VOXEL = 4;

/**
 * The WebGPU guaranteed floor for `maxTextureDimension3D`. Byte accounting
 * ({@link labelPaddedVolumeBytes}) packs at this floor rather than the live
 * device limit. A device with a higher limit packs the same bricks at least as
 * tightly, so the floor gives an upper bound: the accounting can over-estimate
 * the allocation but never under-count it.
 */
const GUARANTEED_MAX_TEXTURE_DIM_3D = 2048;

/** Per-LOD indirection section metadata. */
export interface LodIndirectionMeta {
  level: number;
  gridDims: [number, number, number];   // [Z, Y, X]
  chunkDims: [number, number, number];  // [Z, Y, X]
  levelDims: [number, number, number];  // [Z, Y, X] voxel dimensions
  offset: number;                       // entry offset into flat indirection buffer
}

export interface AtlasState {
  /**
   * Owning dataset id. Teardown matches on this, never on a pool-key prefix,
   * which a dataset id containing the key separator would defeat.
   */
  datasetId: string;
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  /** Composite keys "memberId:chunkKey" → slotIndex (insertion-order = LRU). */
  slots: Map<string, number>;
  /** slotIndex → globalGridIdx (for eviction cleanup). */
  slotGridIdx: Int32Array<ArrayBuffer>;
  freeSlots: number[];            // available slot indices (stack)
  /** Slots the texture holds now. */
  totalSlots: number;
  /** Shared slot pool dimensions (same chunk dims for all entities in this pool). */
  chunkX: number; chunkY: number; chunkZ: number;
  /** The texture's slot grid now. Only `slotsZ` changes, as the pool grows. */
  slotsX: number; slotsY: number; slotsZ: number;
  /** The layers the budget allows, which the pool grows toward. */
  maxSlotsZ: number;
  /** Per-entity LOD sections. memberId → array of per-LOD indirection meta with absolute offsets. */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /** Current T and C — shared across all entities in this pool (one cold state per dataset). */
  t: number; c: number;
  intensityMin: number; intensityMax: number;
  indirectionDirty: boolean;
}

/**
 * A label overlay's volume pool: a bricked slot-grid `r32uint` 3D atlas
 * holding the chosen level as fixed-size chunks, plus a per-cell indirection
 * buffer. It mirrors the intensity proxy-atlas layout so a level larger than
 * the monolithic texture limit still renders as a compact slot grid.
 *
 * Ids are read with `textureLoad` (nearest only), so a sampled id is always
 * the id its cell stored, never a blend across bricks. Chunks are written in
 * place on a T scrub so the label never blanks mid-scrub.
 */
export interface LabelVolumePool {
  /**
   * r32uint 3D slot-grid atlas, size
   * `[slotsX*chunkX, slotsY*chunkY, slotsZ*chunkZ]`. Each axis is
   * `<= device.maxTextureDimension3D`.
   */
  texture: GPUTexture;
  /**
   * Per level-chunk-cell indirection: one entry per `[z][y][x]` cell at flat
   * `gridIdx = z*gridY*gridX + y*gridX + x`. A resident chunk's entry is its
   * slot index; an absent chunk's entry is the sentinel `0xFFFFFFFF`.
   */
  indirectionBuf: GPUBuffer;
  /** CPU mirror of {@link indirectionBuf} (uploaded after each delivery). */
  indirectionData: Uint32Array<ArrayBuffer>;
  /** Level chunk-grid dims (cells per axis). */
  gridX: number; gridY: number; gridZ: number;
  /** Per-slot voxel dims (one brick). */
  chunkX: number; chunkY: number; chunkZ: number;
  /** Slot-grid dims of the atlas texture. */
  slotsX: number; slotsY: number; slotsZ: number;
  totalSlots: number;
  /** Resident cells: `gridIdx` → slot index (insertion order = LRU). */
  slots: Map<number, number>;
  /** Available slot indices (stack). */
  freeSlots: number[];
  /** slot index → `gridIdx` it currently holds (or `-1` when free). */
  slotGridIdx: Int32Array<ArrayBuffer>;
  /**
   * Owning dataset id. The pool is keyed by the label image id, which dataset
   * removal never sees, so {@link removeLabelVolumePoolsForDataset} matches
   * on this instead.
   */
  datasetId: string;
  /**
   * The chosen level's voxel extent, not the atlas texture dims. Feeds the
   * descriptor's `volumeDims` and the shader's ray-to-voxel mapping.
   */
  width: number;
  height: number;
  depth: number;
  /**
   * Single-entity descriptor buffer, rewritten every frame. Unlike the 2D
   * label descriptor it carries the source member's model matrix, which can
   * change on a layout epoch, so it cannot be cached by opacity.
   */
  descBuffer?: GPUBuffer;
  /** Declared-palette storage buffer ([id, packedRgba] pairs), built once from `image-label.colors`. */
  labelColorBuffer?: GPUBuffer;
  labelColorCount?: number;
}

/** Warn once per member when its label volume texture can't be allocated,
 *  so a failing device doesn't spam the console each delivery. */
const warnedLabelVolumeAlloc = new Set<string>();

/** Ceil-divide a level extent into its chunk-grid cell count (>= 1). */
function gridCells(extent: number, chunk: number): number {
  return chunk > 0 ? Math.max(1, Math.ceil(extent / chunk)) : 1;
}

/**
 * The brick dims and chunk grid a label level packs into. Shared by the atlas
 * allocation and its byte accounting so the two never disagree on a level's
 * padded footprint.
 */
interface LabelBrickGrid {
  /** Brick dims clamped to the level extent (a brick never exceeds the level). */
  chunkX: number; chunkY: number; chunkZ: number;
  /** Level chunk-grid dims (cells per axis). */
  gridX: number; gridY: number; gridZ: number;
  gridCellCount: number;
}

function labelBrickGrid(
  width: number, height: number, depth: number,
  chunkX: number, chunkY: number, chunkZ: number,
): LabelBrickGrid {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const d = Math.max(1, Math.floor(depth));
  // A `chunk_shape` larger than the level collapses to one cell. Clamping keeps
  // the slot within the level extent, and so within the device limit.
  const cx = Math.max(1, Math.min(Math.floor(chunkX), w));
  const cy = Math.max(1, Math.min(Math.floor(chunkY), h));
  const cz = Math.max(1, Math.min(Math.floor(chunkZ), d));
  const gridX = gridCells(w, cx);
  const gridY = gridCells(h, cy);
  const gridZ = gridCells(d, cz);
  return { chunkX: cx, chunkY: cy, chunkZ: cz, gridX, gridY, gridZ, gridCellCount: gridX * gridY * gridZ };
}

/**
 * The bytes the bricked atlas actually allocates for a label level: the full
 * texture voxel count times 4 B, not `w*h*d*4`. A rectangular slot grid can
 * overshoot the chunk grid by up to a row or plane of slots, and eligibility
 * and the total-mask failsafe must count that overshoot or masks could OOM.
 *
 * Uses the same packing as the atlas, at the guaranteed device floor, so it is
 * an upper bound on any device. Shapes are canonical TCZYX. Callers must have
 * passed the per-brick cap, because an oversized brick makes the packing throw.
 */
export function labelPaddedVolumeBytes(
  levelShape: readonly number[],
  chunkShape: readonly number[],
): number {
  const sizing = computeLabelVolumeSizing(
    levelShape[Axis.X], levelShape[Axis.Y], levelShape[Axis.Z],
    chunkShape[Axis.X], chunkShape[Axis.Y], chunkShape[Axis.Z],
    GUARANTEED_MAX_TEXTURE_DIM_3D,
  );
  const [texW, texH, texD] = sizing.textureSize;
  return texW * texH * texD * LABEL_VOLUME_BYTES_PER_VOXEL;
}

/**
 * Slot-grid sizing for a label volume atlas. Pure geometry, so the residency
 * invariant (the whole grid stays resident) is testable without a device.
 */
export interface LabelVolumeSizing {
  /** Brick dims clamped to the level extent (a brick never exceeds the level). */
  chunkX: number; chunkY: number; chunkZ: number;
  /** Level chunk-grid dims (cells per axis). */
  gridX: number; gridY: number; gridZ: number;
  /** Total chunk-grid cells: the whole eligible grid. */
  gridCellCount: number;
  slotsX: number; slotsY: number; slotsZ: number;
  /**
   * Slot capacity, clamped only by the device 3D texture limit, never by a byte
   * budget. Equals {@link gridCellCount} for every grid the eligibility caps
   * admit, and the atlas depends on that.
   */
  capacity: number;
  /** Total atlas slots (`slotsX*slotsY*slotsZ`), always `>= capacity`. */
  totalSlots: number;
  /** Atlas texture dims `[x, y, z]`, each `<= maxTextureDimension3D`. */
  textureSize: [number, number, number];
}

/**
 * Size a label volume atlas to hold a level's whole chunk grid, clamped only by
 * the device's max 3D texture dimension. Do not clamp by a byte budget: chunk
 * shapes rarely divide a level evenly, so the padded total can exceed the
 * budget while the true volume fits, and fewer slots than cells would render
 * the mask with holes. Eligibility (`chooseLabelLevel`) already bounds the grid.
 *
 * Throws only when a single brick exceeds the device limit.
 */
export function computeLabelVolumeSizing(
  width: number,
  height: number,
  depth: number,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
  maxTextureDimension3D: number,
): LabelVolumeSizing {
  const { chunkX: cx, chunkY: cy, chunkZ: cz, gridX, gridY, gridZ, gridCellCount } =
    labelBrickGrid(width, height, depth, chunkX, chunkY, chunkZ);

  // Request the whole grid; computeProxyAtlasLayout clamps only to the device
  // limit and packs the slots so no atlas axis exceeds it.
  const layout = computeProxyAtlasLayout([cz, cy, cx], gridCellCount, maxTextureDimension3D);

  return {
    chunkX: cx, chunkY: cy, chunkZ: cz,
    gridX, gridY, gridZ,
    gridCellCount,
    slotsX: layout.slotsX,
    slotsY: layout.slotsY,
    slotsZ: layout.slotsZ,
    capacity: layout.capacity,
    totalSlots: layout.slotsX * layout.slotsY * layout.slotsZ,
    textureSize: layout.textureSize,
  };
}

/**
 * Get or create the bricked label volume pool for `memberId`, sized to the
 * level's whole chunk grid. Reused in place while the level and chunk dims are
 * unchanged, so a T scrub overwrites slots and the overlay never blanks.
 *
 * Returns `null` (and warns once) when the atlas can't be sized or allocated,
 * so the caller skips the label instead of throwing through the upload path,
 * and for a size the device ran out of memory on.
 */
export function getOrCreateLabelVolumePool(
  ctx: WorkerCtx,
  memberId: string,
  datasetId: string,
  width: number,
  height: number,
  depth: number,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
): LabelVolumePool | null {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const d = Math.max(1, Math.floor(depth));
  // Clamp the brick to the level extent up front so the existing-pool check
  // compares normalized dims (the same clamp {@link computeLabelVolumeSizing}
  // applies when it sizes the atlas below).
  const cx = Math.max(1, Math.min(Math.floor(chunkX), w));
  const cy = Math.max(1, Math.min(Math.floor(chunkY), h));
  const cz = Math.max(1, Math.min(Math.floor(chunkZ), d));

  const pools = ctx.state.labelVolumePools;
  const existing = pools.get(memberId);
  if (
    existing &&
    existing.width === w && existing.height === h && existing.depth === d &&
    existing.chunkX === cx && existing.chunkY === cy && existing.chunkZ === cz
  ) {
    existing.datasetId = datasetId;
    return existing;
  }
  if (existing) destroyLabelVolumePool(existing);

  const sizeKey = `${memberId}|${w}x${h}x${d}`;
  if (ctx.state.labelSizesOutOfMemory.has(sizeKey)) return null;
  const limit = getDeviceLimits(ctx.device).maxTextureDimension3D;

  let sizing: LabelVolumeSizing;
  let texture: GPUTexture;
  try {
    sizing = computeLabelVolumeSizing(w, h, d, cx, cy, cz, limit);
    const [texW, texH, texD] = sizing.textureSize;
    texture = allocateWatched(
      ctx,
      () => createEmptyVolumeTexture(ctx.device, texW, texH, texD, "r32uint"),
      (lost) => {
        // A size that ran out of memory once would again on every delivery.
        ctx.state.labelSizesOutOfMemory.add(sizeKey);
        const pool = ctx.state.labelVolumePools.get(memberId);
        if (pool?.texture === lost) removeLabelVolumePool(ctx, memberId);
      },
    );
  } catch (err) {
    if (!warnedLabelVolumeAlloc.has(memberId)) {
      warnedLabelVolumeAlloc.add(memberId);
      console.warn(
        `[labels] skipping "${memberId}": could not allocate a bricked ` +
        `${w}×${h}×${d} r32uint volume atlas ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return null;
  }

  const indirectionData = new Uint32Array(sizing.gridCellCount);
  indirectionData.fill(0xFFFFFFFF);
  const indirectionBuf = ctx.device.createBuffer({
    size: Math.max(sizing.gridCellCount * 4, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  ctx.device.queue.writeBuffer(indirectionBuf, 0, indirectionData);

  const freeSlots: number[] = [];
  for (let i = sizing.totalSlots - 1; i >= 0; i--) freeSlots.push(i);
  const slotGridIdx = new Int32Array(sizing.totalSlots);
  slotGridIdx.fill(-1);

  const pool: LabelVolumePool = {
    texture,
    indirectionBuf,
    indirectionData,
    gridX: sizing.gridX, gridY: sizing.gridY, gridZ: sizing.gridZ,
    chunkX: cx, chunkY: cy, chunkZ: cz,
    slotsX: sizing.slotsX, slotsY: sizing.slotsY, slotsZ: sizing.slotsZ,
    totalSlots: sizing.totalSlots,
    slots: new Map(),
    freeSlots,
    slotGridIdx,
    datasetId,
    width: w, height: h, depth: d,
  };
  pools.set(memberId, pool);
  return pool;
}

/**
 * Resolve the atlas slot for a level chunk cell, allocating on first arrival
 * and reusing it on a T scrub. An eligible level never evicts because the atlas
 * holds the whole grid. Returns `null` when no slot is available.
 */
export function acquireLabelSlot(
  pool: LabelVolumePool,
  gridIdx: number,
): { slot: number; origin: [number, number, number] } | null {
  let slot = pool.slots.get(gridIdx);
  if (slot === undefined) {
    if (pool.freeSlots.length > 0) {
      slot = pool.freeSlots.pop()!;
    } else {
      // Never fires for an eligible level. Defense in depth for an over-limit
      // grid: evict the LRU head.
      const victim = pool.slots.keys().next();
      if (victim.done) return null;
      slot = pool.slots.get(victim.value)!;
      pool.slots.delete(victim.value);
      const oldGrid = pool.slotGridIdx[slot];
      if (oldGrid >= 0 && oldGrid < pool.indirectionData.length) {
        pool.indirectionData[oldGrid] = 0xFFFFFFFF;
      }
    }
    pool.slots.set(gridIdx, slot);
    pool.slotGridIdx[slot] = gridIdx;
  } else {
    // Refresh LRU recency: re-insert so a re-delivered cell isn't the next
    // eviction victim if the inert fallback ever runs.
    pool.slots.delete(gridIdx);
    pool.slots.set(gridIdx, slot);
  }
  const sx = slot % pool.slotsX;
  const sy = Math.floor(slot / pool.slotsX) % pool.slotsY;
  const sz = Math.floor(slot / (pool.slotsX * pool.slotsY));
  return {
    slot,
    origin: [sx * pool.chunkX, sy * pool.chunkY, sz * pool.chunkZ],
  };
}

export function destroyLabelVolumePool(pool: LabelVolumePool): void {
  pool.texture.destroy();
  pool.indirectionBuf.destroy();
  pool.descBuffer?.destroy();
  pool.labelColorBuffer?.destroy();
}

/** Remove a member's label volume pool (no-op if absent). */
export function removeLabelVolumePool(ctx: WorkerCtx, memberId: string): void {
  const pool = ctx.state.labelVolumePools.get(memberId);
  if (pool) {
    destroyLabelVolumePool(pool);
    ctx.state.labelVolumePools.delete(memberId);
  }
}

/**
 * Free every label volume pool whose member key or owning `datasetId` matches
 * `idOrDataset`. Dataset removal passes the dataset id, which never equals a
 * pool key, so the `datasetId` match is what frees the texture.
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

function createAtlasTexture(
  device: GPUDevice,
  chunkX: number, chunkY: number, chunkZ: number,
  slotsX: number, slotsY: number, slotsZ: number,
): GPUTexture {
  return device.createTexture({
    size: [slotsX * chunkX, slotsY * chunkY, slotsZ * chunkZ],
    format: "r16uint",
    dimension: "3d",
    // COPY_SRC so a growing pool can copy its chunks into the larger texture.
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
}

/**
 * Create a shared atlas pool one layer of slots deep. It grows
 * toward the budget's grid only as chunks fill it, so a small volume never
 * holds the whole budget. Indirection is sized later from entityMetas.
 */
function createVolumeAtlas(
  device: GPUDevice,
  datasetId: string,
  budgetBytes: number,
  chunkX: number, chunkY: number, chunkZ: number,
  t: number, c: number,
): AtlasState {
  const limits = getDeviceLimits(device);
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY, chunkZ],
    budgetBytes,
    "3d",
  );
  const { slotsX, slotsY } = geom;
  const maxSlotsZ = geom.slotsZ!;
  const slotsZ = Math.min(1, maxSlotsZ);
  const totalSlots = slotsX * slotsY * slotsZ;

  const texture = createAtlasTexture(device, chunkX, chunkY, chunkZ, slotsX, slotsY, slotsZ);

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
    datasetId,
    texture, indirectionBuf, indirectionData,
    slots: new Map(), slotGridIdx, freeSlots, totalSlots,
    chunkX, chunkY, chunkZ,
    slotsX, slotsY, slotsZ,
    maxSlotsZ,
    entityMetas: new Map(),
    t, c,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: true,
  };
}

/**
 * Double a full pool's layers, up to the budget's. False when it is already
 * there, so the caller evicts instead.
 *
 * A slot's position depends on `slotsX` and `slotsY` alone, which never
 * change, so every resident slot keeps its texels and its index. Growing is
 * one copy of the old texture into the new one's front layers, and the
 * indirection, which holds slot indices, stays valid.
 */
export function growVolumeAtlas(device: GPUDevice, atlas: AtlasState): boolean {
  if (atlas.slotsZ >= atlas.maxSlotsZ) return false;
  const slotsZ = Math.min(atlas.maxSlotsZ, atlas.slotsZ * 2);
  const totalSlots = atlas.slotsX * atlas.slotsY * slotsZ;

  const texture = createAtlasTexture(
    device, atlas.chunkX, atlas.chunkY, atlas.chunkZ, atlas.slotsX, atlas.slotsY, slotsZ,
  );
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: atlas.texture },
    { texture },
    [atlas.slotsX * atlas.chunkX, atlas.slotsY * atlas.chunkY, atlas.slotsZ * atlas.chunkZ],
  );
  device.queue.submit([encoder.finish()]);
  // Destruction waits for the copy just submitted.
  atlas.texture.destroy();
  atlas.texture = texture;

  const slotGridIdx = new Int32Array(totalSlots);
  slotGridIdx.fill(-1);
  slotGridIdx.set(atlas.slotGridIdx);
  atlas.slotGridIdx = slotGridIdx;
  for (let i = totalSlots - 1; i >= atlas.totalSlots; i--) atlas.freeSlots.push(i);
  atlas.slotsZ = slotsZ;
  atlas.totalSlots = totalSlots;
  return true;
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
  datasetId: string,
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
  const newAtlas = createWatchedVolumeAtlas(ctx, poolKey, datasetId, chunkX, chunkY, chunkZ, t, c);
  atlases.set(poolKey, newAtlas);
  return newAtlas;
}

function createWatchedVolumeAtlas(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number, chunkZ: number,
  t: number, c: number,
): AtlasState {
  return allocateWatched(
    ctx,
    () => createVolumeAtlas(ctx.device, datasetId, ctx.state.atlasBudgets.volumeAtlasBytes, chunkX, chunkY, chunkZ, t, c),
    (lost) => replaceLostVolumeAtlas(ctx, poolKey, lost),
  );
}

/** {@link growVolumeAtlas}, where a grow the device can't allocate loses the pool. */
export function growVolumeAtlasWatched(ctx: WorkerCtx, poolKey: string, atlas: AtlasState): boolean {
  return allocateWatched(
    ctx,
    () => growVolumeAtlas(ctx.device, atlas),
    () => replaceLostVolumeAtlas(ctx, poolKey, atlas),
  );
}

/**
 * A pool whose texture the device could not allocate holds nothing and can't
 * be bound. Its chunks go back to the page, and a pool with the same sections
 * takes its place under half the budget. At the floor budget the pool is
 * dropped, and the next cold state tries again.
 */
export function replaceLostVolumeAtlas(ctx: WorkerCtx, poolKey: string, lost: AtlasState): void {
  const atlases = ctx.state.volumeAtlases;
  if (atlases.get(poolKey) !== lost) return;
  postPoolChunksLost(ctx, lost.slots.keys(), "out-of-memory");
  destroyAtlas(lost);
  atlases.delete(poolKey);
  if (shrinkAtlasBudget(ctx.state.atlasBudgets, "volumeAtlasBytes")) {
    const atlas = createWatchedVolumeAtlas(
      ctx, poolKey, lost.datasetId, lost.chunkX, lost.chunkY, lost.chunkZ, lost.t, lost.c,
    );
    atlas.entityMetas = lost.entityMetas;
    resizeIndirection(ctx, atlas, lost.indirectionData.length);
    atlas.indirectionData.fill(0xFFFFFFFF);
    atlas.indirectionDirty = true;
    atlases.set(poolKey, atlas);
  }
  ctx.postWantedSet(lost.datasetId);
}

/** Resize the indirection buffer to the sum of all entity LOD sections. */
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
 * Free every volume pool `datasetId` owns, except the keys in `keep`.
 * Composed cleanup that also clears per-entity ray-pick state lives in
 * `volume/index.ts` as `removeVolumeResources`.
 */
export function removeVolumeAtlasesForDataset(
  ctx: WorkerCtx,
  datasetId: string,
  keep?: ReadonlySet<string>,
): void {
  const atlases = ctx.state.volumeAtlases;
  for (const [poolKey, atlas] of atlases) {
    if (atlas.datasetId !== datasetId || keep?.has(poolKey)) continue;
    destroyAtlas(atlas);
    atlases.delete(poolKey);
  }
}

/**
 * Destroy all atlas pools + the depth texture. Composed cleanup that
 * also clears per-entity ray-pick state lives in `volume/index.ts` as
 * `destroyAllVolumeResources`.
 */
export function destroyAllVolumeAtlasResources(ctx: WorkerCtx): void {
  const atlases = ctx.state.volumeAtlases;
  for (const atlas of atlases.values()) destroyAtlas(atlas);
  atlases.clear();
  depthTexture?.destroy();
  depthTexture = null;
}
