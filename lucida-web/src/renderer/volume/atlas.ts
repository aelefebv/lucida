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
import { computeProxyAtlasLayout } from "../proxyAtlas.ts";

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
 * A label overlay's volume pool: a bricked slot-grid `r32uint` 3D atlas
 * holding the label mask's chosen level as fixed-size chunks, plus a
 * per-cell indirection buffer mapping each level chunk to its resident
 * slot. Mirrors the intensity proxy-atlas layout so the categorical shader
 * path walks the same brick indirection instead of a single monolithic
 * tile — a level whose full extent would exceed the monolithic texture
 * limit still renders because its chunks repack into a compact slot grid.
 *
 * Ids are sampled NEAREST only (the shader reads `texture_3d<u32>` via
 * `textureLoad`); each chunk lands in exactly the slot its indirection
 * entry names, so a sampled id is always the id its cell stored — never a
 * blend across brick or level boundaries.
 *
 * Chunks are written IN PLACE as they arrive (the pool is never destroyed on
 * a T scrub when the level dims are unchanged), so a label never blanks
 * mid-scrub — the previous volume stays visible until the new one lands.
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
  /** Total slots the atlas can hold. */
  totalSlots: number;
  /** Resident cells: `gridIdx` → slot index (insertion order = LRU). */
  slots: Map<number, number>;
  /** Available slot indices (stack). */
  freeSlots: number[];
  /** slot index → `gridIdx` it currently holds (or `-1` when free). */
  slotGridIdx: Int32Array<ArrayBuffer>;
  /**
   * Owning dataset id (the `removeLayerResources` id). The pool is keyed by
   * the label image id — which dataset removal never sees — so this is how
   * {@link removeLabelVolumePoolsForDataset} finds + frees it on removal.
   */
  datasetId: string;
  /**
   * The chosen LEVEL voxel extent (NOT the atlas texture dims) — the
   * descriptor's `volumeDims` and the shader's ray→voxel mapping. Kept
   * separate from the slot-grid texture, which is sized to the brick layout.
   */
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

/** Ceil-divide a level extent into its chunk-grid cell count (>= 1). */
function gridCells(extent: number, chunk: number): number {
  return chunk > 0 ? Math.max(1, Math.ceil(extent / chunk)) : 1;
}

/**
 * The slot-grid sizing for a label volume atlas: the chunk grid the level
 * covers and the slot grid the atlas packs it into. Pure geometry — no GPU
 * allocation — so the residency invariant (the whole grid stays resident) is
 * unit-testable without a device.
 */
export interface LabelVolumeSizing {
  /** Brick dims clamped to the level extent (a brick never exceeds the level). */
  chunkX: number; chunkY: number; chunkZ: number;
  /** Level chunk-grid dims (cells per axis). */
  gridX: number; gridY: number; gridZ: number;
  /** Total chunk-grid cells (`gridX*gridY*gridZ`) — the WHOLE eligible grid. */
  gridCellCount: number;
  /** Atlas slot-grid dims. */
  slotsX: number; slotsY: number; slotsZ: number;
  /**
   * Slot capacity requested for the atlas, clamped ONLY by the device 3D
   * texture limit (never by a byte budget). Equals {@link gridCellCount} for
   * any grid the device limit can hold — i.e. the whole eligible grid — which
   * is the residency invariant the atlas depends on. It is smaller only for a
   * pathological grid whose packing would overflow the device limit, which the
   * eligibility caps preclude.
   */
  capacity: number;
  /** Total atlas slots (`slotsX*slotsY*slotsZ`), always `>= capacity`. */
  totalSlots: number;
  /** Atlas texture dims `[x, y, z]`, each `<= maxTextureDimension3D`. */
  textureSize: [number, number, number];
}

/**
 * Size a label volume atlas to hold a level's WHOLE chunk grid.
 *
 * The atlas capacity is the full grid, clamped ONLY by the device's max 3D
 * texture dimension (via {@link computeProxyAtlasLayout}) — never by a byte
 * budget. A byte-budget clamp would be wrong here: a level's chunk shape rarely
 * divides its extent evenly (the norm for real downsampled levels), so the
 * PADDED brick total (`gridCellCount * paddedChunkBytes`) can exceed the budget
 * while the TRUE volume fits it. Clamping capacity on the padded total would
 * leave fewer slots than grid cells, so delivered bricks would be evicted and
 * the mask would render with transparent holes where real data exists.
 *
 * Eligibility (`chooseLabelLevel`) already bounds the grid to
 * `maxChunksPerVolume` cells and the true bytes to the per-mask budget, so the
 * whole grid is a bounded, packable allocation whose natural grid-shaped
 * packing keeps each atlas axis ~= the level extent and thus within the device
 * limit. The byte-budget accounting + eviction that a streaming residency path
 * would add belong to that later capability, not here.
 *
 * Throws (via {@link computeProxyAtlasLayout}) only when a single brick exceeds
 * the device limit — the caller treats that as an allocation failure and skips
 * the label rather than truncating it.
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
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const d = Math.max(1, Math.floor(depth));
  // A brick never needs to exceed the level extent: a `chunk_shape` larger than
  // the level (a small level with a coarse declared chunk) collapses to a
  // single cell, so the slot only ever holds the in-bounds region. Clamping
  // keeps a slot within the level extent (and thus the device limit) instead of
  // allocating an oversized brick that a monolithic texture never would.
  const cx = Math.max(1, Math.min(Math.floor(chunkX), w));
  const cy = Math.max(1, Math.min(Math.floor(chunkY), h));
  const cz = Math.max(1, Math.min(Math.floor(chunkZ), d));

  const gridX = gridCells(w, cx);
  const gridY = gridCells(h, cy);
  const gridZ = gridCells(d, cz);
  const gridCellCount = gridX * gridY * gridZ;

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
 * Get or create a bricked label volume pool for `memberId` covering the
 * label level's chunk grid. The atlas is a slot-grid `r32uint` texture sized
 * (via {@link computeLabelVolumeSizing}) to hold the level's WHOLE chunk grid,
 * packed under the device's max 3D texture dimension so no atlas axis exceeds
 * the limit and a level whose full extent would overflow a monolithic texture
 * still fits as bricks. The slot count is NOT clamped to a byte budget — an
 * eligible level's whole grid always stays resident, so the mask never renders
 * with transparent holes from padding waste. Reused IN PLACE when the level +
 * chunk dims are unchanged — a T scrub overwrites resident slots rather than
 * recreating the atlas, so the overlay never blanks. Recreated only when the
 * level or chunk dims change. `datasetId` is stamped so dataset removal can
 * free it (the pool is keyed by the label image id).
 *
 * Returns `null` when the atlas can't be sized/allocated (e.g. a single chunk
 * larger than the device limit, or an out-of-budget device) — the caller
 * skips the label rather than throwing through the upload path. Level
 * selection already bounds the size, so this is defense in depth.
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

  const limit = getDeviceLimits(ctx.device).maxTextureDimension3D;

  let sizing: LabelVolumeSizing;
  let texture: GPUTexture;
  try {
    // Size the atlas to the WHOLE chunk grid (no byte-budget clamp) and pack
    // the slots under the device limit; throws if a single brick exceeds it.
    sizing = computeLabelVolumeSizing(w, h, d, cx, cy, cz, limit);
    const [texW, texH, texD] = sizing.textureSize;
    texture = createEmptyVolumeTexture(ctx.device, texW, texH, texD, "r32uint");
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
 * Resolve the atlas slot for a level chunk cell, allocating one on first
 * arrival and reusing it on a T scrub (so a re-delivered cell overwrites its
 * own brick in place). An eligible level never evicts — the atlas is sized to
 * the whole grid, so every cell has its own slot; the LRU fallback is inert
 * defense in depth for a pathological over-limit grid the eligibility caps
 * preclude. Returns the slot index and its origin, or `null` when no slot is
 * available.
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
      // Inert fallback: an eligible level's atlas holds the whole grid, so
      // this never fires. It stays as defense in depth for a pathological
      // over-limit grid — evict the oldest resident cell (LRU head).
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

// Shared dummy indirection buffer for `group-as-proxy` chunk bindings.
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
