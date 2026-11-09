/**
 * Slice atlas state: pool allocation, indirection sizing, per-entity Z
 * metadata, and the plane each slot was cut from.
 *
 * Composed cleanups (`removeSliceResources`, `destroyAllSliceResources`) live
 * in `slice/index.ts` so this module stays free of dependencies on
 * `slice/eviction.ts`, which owns per-entity camera-UV state.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ChunkFeedbackReason } from "../workerProtocol.ts";
import { createSliceTexture, getDeviceLimits } from "../gpuContext.ts";
import { computeAtlasGeometry, poolCapBytes } from "../atlasSizing.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import {
  applyFailedMarks,
  failedCellsAt,
  failedKeysForImage,
  identityIndirection,
  type CellGrid,
} from "../failedCells.ts";
import { atlasTextureFormat, bytesPerTexel, type SampleFormat } from "../dataTypeUtil.ts";
import { allocateWatched } from "../worker/gpuErrors.ts";
import { LABEL_TIER, postChunkResidency, postSlotsLost } from "../chunkUploadFeedback.ts";
import { chunkPoolTier } from "../poolKeys.ts";
import { chunkPoolUsage, grantGrowth, handleGpuOutOfMemory, reserveGpuBytes, wantedSlotsOf } from "../worker/gpuBudget.ts";
import { planCompaction, remapSlotEntries } from "../poolCompaction.ts";

/**
 * A label overlay's slice pool: one `r32uint` texture holding the current
 * Z-slice of the mask, with each chunk at its place in the plane. No shared
 * LRU slots, because a label overlay is one member with a bounded 2D
 * footprint.
 *
 * The texture is written in place as Z/T slices arrive, so a label never
 * blanks mid-scrub.
 */
export interface LabelSlicePool {
  texture: GPUTexture; // r32uint, size [width, height]
  /**
   * One entry per chunk cell of the plane, mapping the cell to itself, so a
   * cell whose chunk failed for good can read FAILED instead of the texture,
   * which still holds whatever plane was there before.
   */
  indirectionBuf: GPUBuffer;
  indirection: Uint32Array<ArrayBuffer>;
  markedFailed: Set<number>;
  chunkX: number;
  chunkY: number;
  grid: CellGrid;
  /**
   * Chunk cell (`labelCellKey`) → the chunk key written there. A cell is
   * rewritten in place on a T scrub, so the key it held is reported lost
   * then, and every key is reported lost when the pool goes. The page
   * resends only what it hears is gone.
   */
  keys: Map<number, string>;
  /**
   * Chunk cell → the plane of the label level its texels were cut from,
   * which a cell keeps drawing after its chunk is handed back.
   */
  planes: Map<number, number>;
  /**
   * Owning dataset id. The pool is keyed by the label image id, which dataset
   * removal never sees, so {@link removeLabelSlicePoolsForDataset} matches on
   * this instead.
   */
  datasetId: string;
  width: number;
  height: number;
  /** Cached entity descriptor and the opacity it was built for. Rebuilt only when the opacity changes. */
  descBuffer?: GPUBuffer;
  descOpacity?: number;
  /** Declared-palette storage buffer ([id, packedRgba] pairs), built once from `image-label.colors`. */
  labelColorBuffer?: GPUBuffer;
  labelColorCount?: number;
}

/** Warn once per member when its label slice texture can't be allocated,
 *  so a failing device doesn't spam the console each delivery. */
const warnedLabelSliceAlloc = new Set<string>();

/** Clear the alloc-failure warn-once set. Test-only, so one case's failure doesn't hide a later case's warning. */
export function resetLabelSliceAllocWarnings(): void {
  warnedLabelSliceAlloc.clear();
}

/**
 * Get or create the label slice pool for `memberId`, sized to the level's 2D
 * dims clamped to the device's max 2D texture dimension. Reused in place while
 * the dims are unchanged, so a Z/T scrub never blanks the overlay.
 *
 * Returns `null` when the texture or indirection buffer fails to allocate,
 * after unwinding any partial allocation, so the caller skips the label, for
 * a size the device ran out of memory on, and when the GPU total has no room
 * for it.
 */
export function getOrCreateLabelSlicePool(
  ctx: WorkerCtx,
  memberId: string,
  datasetId: string,
  width: number,
  height: number,
  chunkX: number,
  chunkY: number,
): LabelSlicePool | null {
  const limit = getDeviceLimits(ctx.device).maxTextureDimension2D;
  const w = Math.max(1, Math.min(width, limit));
  const h = Math.max(1, Math.min(height, limit));
  const cx = Math.max(1, chunkX);
  const cy = Math.max(1, chunkY);

  const pools = ctx.state.labelSlicePools;
  const existing = pools.get(memberId);
  if (existing && existing.width === w && existing.height === h && existing.chunkX === cx && existing.chunkY === cy) {
    existing.datasetId = datasetId;
    return existing;
  }
  if (existing) removeLabelSlicePool(ctx, memberId, "freed");

  const sizeKey = `${memberId}|${w}x${h}`;
  if (ctx.state.labelSizesOutOfMemory.has(sizeKey)) return null;
  if (!reserveGpuBytes(ctx, w * h * LABEL_SLICE_BYTES_PER_TEXEL)) return null;

  const grid: CellGrid = { x: Math.ceil(w / cx), y: Math.ceil(h / cy), z: 1 };
  const indirection = identityIndirection(grid.x * grid.y);
  let texture: GPUTexture | undefined;
  let indirectionBuf: GPUBuffer;
  try {
    texture = allocateWatched(
      ctx,
      () => createSliceTexture(ctx.device, w, h, null, "r32uint"),
      (lost) => {
        // A size that ran out of memory once would again on every delivery.
        ctx.state.labelSizesOutOfMemory.add(sizeKey);
        if (pools.get(memberId)?.texture === lost) removeLabelSlicePool(ctx, memberId, "out-of-memory");
        handleGpuOutOfMemory(ctx);
      },
    );
    indirectionBuf = ctx.device.createBuffer({
      size: indirection.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  } catch (err) {
    // Free the texture if a later step failed, so it can't be orphaned.
    texture?.destroy();
    if (!warnedLabelSliceAlloc.has(memberId)) {
      warnedLabelSliceAlloc.add(memberId);
      const failed = texture
        ? "an indirection buffer"
        : `a ${w}×${h} r32uint slice texture`;
      console.warn(
        `[labels] skipping "${memberId}": could not allocate ${failed} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return null;
  }
  ctx.device.queue.writeBuffer(indirectionBuf, 0, indirection);

  const pool: LabelSlicePool = {
    texture, indirectionBuf, indirection, markedFailed: new Set(),
    chunkX: cx, chunkY: cy, grid,
    keys: new Map(), planes: new Map(), datasetId, width: w, height: h,
  };
  pools.set(memberId, pool);
  return pool;
}

/** Bytes one `r32uint` label texel holds. */
const LABEL_SLICE_BYTES_PER_TEXEL = 4;

/** The bytes a label slice pool's texture holds. */
export function labelSlicePoolBytes(pool: LabelSlicePool): number {
  return pool.width * pool.height * LABEL_SLICE_BYTES_PER_TEXEL;
}

/** The cell a label slice chunk at grid `(x, y)` is written to, as {@link LabelSlicePool.keys} keys it. */
export function labelCellKey(x: number, y: number): number {
  return y * 0x10000 + x;
}

/**
 * Mark the cells of the plane `at` whose chunk failed for good, unless the
 * pool holds that very chunk there. Without the mark such a cell would show
 * the plane it last held, or nothing. Returns whether the marks changed.
 */
export function markLabelSliceFailed(
  ctx: WorkerCtx,
  memberId: string,
  pool: LabelSlicePool,
  at: { level: number; t: number; z: number },
): boolean {
  const failed = failedCellsAt(failedKeysForImage(ctx.state, memberId), pool.grid, { ...at, c: 0 });
  const changed = applyFailedMarks(
    pool.indirection,
    pool.markedFailed,
    failed,
    (cell, key) => pool.keys.get(labelCellKey(cell % pool.grid.x, Math.floor(cell / pool.grid.x))) === key,
    (cell) => cell,
  );
  if (changed) ctx.device.queue.writeBuffer(pool.indirectionBuf, 0, pool.indirection);
  return changed;
}

/**
 * Report lost each chunk whose cell holds another plane than `plane`, the one
 * the view draws now. A Z move inside one chunk along Z keeps the chunk key,
 * and the page sends a key it holds as delivered only once it hears the key
 * is gone. The cell draws its old plane until the new one lands, as on a T
 * scrub.
 */
export function retireOtherLabelPlanes(
  ctx: WorkerCtx,
  memberId: string,
  pool: LabelSlicePool,
  plane: number,
): void {
  const lost: string[] = [];
  for (const [cell, drawn] of pool.planes) {
    const key = pool.keys.get(cell);
    if (drawn === plane || key === undefined) continue;
    lost.push(key);
    pool.keys.delete(cell);
  }
  postChunkResidency(ctx, memberId, LABEL_TIER, "lost", lost, "replaced");
}

export function destroyLabelSlicePool(pool: LabelSlicePool): void {
  pool.texture.destroy();
  pool.indirectionBuf.destroy();
  pool.descBuffer?.destroy();
  pool.labelColorBuffer?.destroy();
}

/**
 * Remove a member's label pool (no-op if absent), reporting every chunk it
 * held lost for `reason` so the page sends what it still wants.
 */
export function removeLabelSlicePool(ctx: WorkerCtx, memberId: string, reason: ChunkFeedbackReason): void {
  const pool = ctx.state.labelSlicePools.get(memberId);
  if (pool) {
    postChunkResidency(ctx, memberId, LABEL_TIER, "lost", [...pool.keys.values()], reason);
    destroyLabelSlicePool(pool);
    ctx.state.labelSlicePools.delete(memberId);
  }
}

/**
 * Free every label slice pool whose member key or owning `datasetId` matches
 * `idOrDataset`. Dataset removal passes the dataset id, which never equals a
 * pool key, so the `datasetId` match is what frees the texture. With a
 * `reason`, the chunks they held are reported lost; a removed dataset's
 * delivery record goes with it, so removal passes none.
 */
export function removeLabelSlicePoolsForDataset(
  ctx: WorkerCtx,
  idOrDataset: string,
  reason?: ChunkFeedbackReason,
): void {
  for (const [memberId, pool] of ctx.state.labelSlicePools) {
    if (memberId === idOrDataset || pool.datasetId === idOrDataset) {
      if (reason) postChunkResidency(ctx, memberId, LABEL_TIER, "lost", [...pool.keys.values()], reason);
      destroyLabelSlicePool(pool);
      ctx.state.labelSlicePools.delete(memberId);
    }
  }
}

/** Destroy every label pool. */
export function destroyAllLabelSlicePools(ctx: WorkerCtx): void {
  for (const pool of ctx.state.labelSlicePools.values()) destroyLabelSlicePool(pool);
  ctx.state.labelSlicePools.clear();
}

/** Per-entity Z metadata for slice mode (drives Z-chunk filtering and re-slice detection). */
export interface SliceEntityZInfo {
  chunkZ: number;
  fullResDepth: number;
  levelDepth: number;
}

export interface SliceAtlasState {
  /**
   * Owning dataset id. Teardown matches on this, never on a pool-key prefix,
   * which a dataset id containing the key separator would defeat.
   */
  datasetId: string;
  texture: GPUTexture;
  /** How the texture holds samples; the dataset's, fixed for the pool's life. */
  format: SampleFormat;
  indirectionBuf: GPUBuffer;
  indirectionData: Uint32Array<ArrayBuffer>;
  /** Composite keys "memberId|chunkKey" → slotIndex (insertion-order = LRU). */
  slots: Map<string, number>;
  /** slotIndex → globalGridIdx (for eviction cleanup). */
  slotGridIdx: Int32Array<ArrayBuffer>;
  freeSlots: number[];
  /** Slots the texture holds now. */
  totalSlots: number;
  chunkX: number; chunkY: number;
  /** The texture's slot grid now. Only `slotsY` changes, as the pool grows or shrinks. */
  slotsX: number; slotsY: number;
  /** The rows the pool's cap allows, which it grows toward while the GPU total has room. */
  maxSlotsY: number;
  /** Per-entity LOD sections (absolute offsets into the shared flat indirection buffer). */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /**
   * memberId → level → Z geometry, set from the first chunk that arrives
   * at that level. Per level, not per member: the levels sharing a pool
   * can differ in depth and chunk Z, so each maps the current plane to
   * its own chunk-Z target.
   */
  entityZInfo: Map<string, Map<number, SliceEntityZInfo>>;
  /** Current T, C, full-res Z — pool-wide. */
  z: number; t: number; c: number;
  /**
   * slotIndex → the level plane its 2D data was cut from, -1 when empty. A
   * slot whose plane is not the one the current Z maps to is stale: the remap
   * leaves it unmapped and the wanted set reports it missing.
   */
  slotLevelZ: Int32Array<ArrayBuffer>;
  indirectionDirty: boolean;
}

function createSliceAtlasTexture(
  device: GPUDevice,
  chunkX: number, chunkY: number,
  slotsX: number, slotsY: number,
  format: SampleFormat,
): GPUTexture {
  return device.createTexture({
    size: [slotsX * chunkX, slotsY * chunkY],
    format: atlasTextureFormat(format),
    usage: chunkPoolUsage(),
  });
}

/**
 * Create a shared slice pool one row of slots deep. It grows toward the grid
 * its cap allows only as chunks fill it and the GPU total has room.
 * Indirection is sized later from entityMetas.
 */
function createSliceAtlas(
  device: GPUDevice,
  datasetId: string,
  capBytes: number,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
  format: SampleFormat,
): SliceAtlasState {
  const limits = getDeviceLimits(device);
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY],
    capBytes,
    "2d",
    bytesPerTexel(format),
  );
  const { slotsX } = geom;
  const maxSlotsY = geom.slotsY;
  const slotsY = 1;
  const totalSlots = slotsX * slotsY;

  const texture = createSliceAtlasTexture(device, chunkX, chunkY, slotsX, slotsY, format);

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
    texture, format, indirectionBuf, indirectionData,
    slots: new Map(), slotGridIdx, freeSlots, totalSlots,
    chunkX, chunkY,
    slotsX, slotsY, maxSlotsY,
    entityMetas: new Map(),
    entityZInfo: new Map(),
    z, t, c,
    slotLevelZ: new Int32Array(totalSlots).fill(-1),
    indirectionDirty: true,
  };
}

/** The bytes a slice pool's texture and indirection hold now. */
export function sliceAtlasBytes(atlas: SliceAtlasState): number {
  return sliceRowBytes(atlas) * atlas.slotsY + atlas.indirectionData.length * 4;
}

/** The bytes one row of a slice pool's slots holds: the step it grows and shrinks by. */
export function sliceRowBytes(atlas: SliceAtlasState): number {
  return atlas.slotsX * atlas.chunkX * atlas.chunkY * bytesPerTexel(atlas.format);
}

/**
 * Grow a full pool to `toSlotsY` rows, by default double its rows, up to its
 * cap's. False when it is already there, so the caller evicts instead. The
 * caller has checked the GPU total.
 *
 * A slot's position depends on `slotsX` alone, which never changes, so every
 * resident slot keeps its texels and its index: growing is one copy of the
 * old texture into the new one's top rows.
 */
export function growSliceAtlas(
  device: GPUDevice,
  atlas: SliceAtlasState,
  toSlotsY: number = atlas.slotsY * 2,
): boolean {
  const slotsY = Math.min(atlas.maxSlotsY, toSlotsY);
  if (slotsY <= atlas.slotsY) return false;
  const totalSlots = atlas.slotsX * slotsY;
  const texture = createSliceAtlasTexture(device, atlas.chunkX, atlas.chunkY, atlas.slotsX, slotsY, atlas.format);
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: atlas.texture },
    { texture },
    [atlas.slotsX * atlas.chunkX, atlas.slotsY * atlas.chunkY, 1],
  );
  device.queue.submit([encoder.finish()]);
  // Destruction waits for the copy just submitted.
  atlas.texture.destroy();
  atlas.texture = texture;

  const slotGridIdx = new Int32Array(totalSlots).fill(-1);
  slotGridIdx.set(atlas.slotGridIdx);
  atlas.slotGridIdx = slotGridIdx;
  const slotLevelZ = new Int32Array(totalSlots).fill(-1);
  slotLevelZ.set(atlas.slotLevelZ);
  atlas.slotLevelZ = slotLevelZ;
  for (let i = totalSlots - 1; i >= atlas.totalSlots; i--) atlas.freeSlots.push(i);
  atlas.slotsY = slotsY;
  atlas.totalSlots = totalSlots;
  return true;
}

/** {@link growSliceAtlas}, where a grow the device can't allocate loses the pool. */
export function growSliceAtlasWatched(
  ctx: WorkerCtx,
  poolKey: string,
  atlas: SliceAtlasState,
  toSlotsY?: number,
): boolean {
  return allocateWatched(
    ctx,
    () => growSliceAtlas(ctx.device, atlas, toSlotsY),
    () => replaceLostSliceAtlas(ctx, poolKey, atlas),
  );
}

/**
 * Grow a full pool as far as the GPU total has room for, toward the rows
 * that hold every chunk the planner wants, or double its rows if that is
 * more. With `reclaim`, grow by one row even when the total has none, if
 * other pools can give it back from chunks the planner doesn't want.
 */
export function growSlicePoolWithin(
  ctx: WorkerCtx,
  poolKey: string,
  atlas: SliceAtlasState,
  reclaim: boolean,
): boolean {
  const wantedRows = Math.ceil(wantedSlotsOf(ctx.state, poolKey, atlas) / atlas.slotsX);
  const maxSteps = Math.min(atlas.maxSlotsY, Math.max(atlas.slotsY * 2, wantedRows)) - atlas.slotsY;
  const steps = grantGrowth(ctx, atlas, sliceRowBytes(atlas), maxSteps, reclaim);
  return steps > 0 && growSliceAtlasWatched(ctx, poolKey, atlas, atlas.slotsY + steps);
}

/**
 * Shrink a pool to `slotsY` rows, giving their bytes back to the GPU total.
 * It keeps the first chunks of `keep` that fit, moving any that lay in a
 * dropped row into a slot that stays, and returns the composite keys it no
 * longer holds, for the caller to report lost.
 */
export function shrinkSliceAtlas(
  device: GPUDevice,
  atlas: SliceAtlasState,
  slotsY: number,
  keep: Iterable<string>,
): string[] {
  if (slotsY >= atlas.slotsY || slotsY < 1) return [];
  const capacity = atlas.slotsX * slotsY;
  const plan = planCompaction(atlas.slots, capacity, keep);

  const texture = createSliceAtlasTexture(device, atlas.chunkX, atlas.chunkY, atlas.slotsX, slotsY, atlas.format);
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: atlas.texture },
    { texture },
    [atlas.slotsX * atlas.chunkX, slotsY * atlas.chunkY, 1],
  );
  const origin = (slot: number) => ({
    x: (slot % atlas.slotsX) * atlas.chunkX,
    y: Math.floor(slot / atlas.slotsX) * atlas.chunkY,
    z: 0,
  });
  for (const { from, to } of plan.moves) {
    encoder.copyTextureToTexture(
      { texture: atlas.texture, origin: origin(from) },
      { texture, origin: origin(to) },
      [atlas.chunkX, atlas.chunkY, 1],
    );
  }
  device.queue.submit([encoder.finish()]);
  // Destruction waits for the copies just submitted.
  atlas.texture.destroy();
  atlas.texture = texture;

  const slotLevelZ = new Int32Array(capacity).fill(-1);
  for (const [key, slot] of plan.slots) slotLevelZ[slot] = atlas.slotLevelZ[atlas.slots.get(key)!];
  atlas.slotGridIdx = remapSlotEntries(atlas.slots, atlas.slotGridIdx, atlas.indirectionData, plan, capacity);
  atlas.slotLevelZ = slotLevelZ;
  atlas.slots = plan.slots;
  atlas.freeSlots = plan.freeSlots;
  atlas.slotsY = slotsY;
  atlas.totalSlots = capacity;
  atlas.indirectionDirty = true;
  return plan.dropped;
}

export function destroySliceAtlas(atlas: SliceAtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/**
 * Get or create a shared slice pool with the given chunk dims. The cold state
 * handler sets entityMetas and resizes indirection afterward.
 */
export function getOrCreateSlicePool(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
  format: SampleFormat,
): SliceAtlasState {
  const atlases = ctx.state.sliceAtlases;
  const existing = atlases.get(poolKey);
  if (existing && existing.chunkX === chunkX && existing.chunkY === chunkY && existing.format === format) {
    existing.z = z;
    existing.t = t;
    existing.c = c;
    return existing;
  }
  if (existing) destroySliceAtlas(existing);
  const newAtlas = createWatchedSliceAtlas(ctx, poolKey, datasetId, chunkX, chunkY, z, t, c, format);
  atlases.set(poolKey, newAtlas);
  return newAtlas;
}

function createWatchedSliceAtlas(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
  format: SampleFormat,
): SliceAtlasState {
  return allocateWatched(
    ctx,
    () => createSliceAtlas(
      ctx.device, datasetId, poolCapBytes(getDeviceLimits(ctx.device), ctx.state.gpuTotalBytes),
      chunkX, chunkY, z, t, c, format,
    ),
    (lost) => replaceLostSliceAtlas(ctx, poolKey, lost),
  );
}

/**
 * A pool whose texture the device could not allocate holds nothing and can't
 * be bound. Its chunks go back to the page, the GPU total halves, and a pool
 * with the same sections takes its place one row deep. At the floor total
 * the pool is dropped, and the next cold state tries again.
 */
export function replaceLostSliceAtlas(ctx: WorkerCtx, poolKey: string, lost: SliceAtlasState): void {
  const atlases = ctx.state.sliceAtlases;
  if (atlases.get(poolKey) !== lost) return;
  postSlotsLost(ctx, chunkPoolTier(poolKey), lost.slots.keys(), "out-of-memory");
  destroySliceAtlas(lost);
  atlases.delete(poolKey);
  if (handleGpuOutOfMemory(ctx)) {
    const atlas = createWatchedSliceAtlas(
      ctx, poolKey, lost.datasetId, lost.chunkX, lost.chunkY, lost.z, lost.t, lost.c, lost.format,
    );
    atlas.entityMetas = lost.entityMetas;
    atlas.entityZInfo = lost.entityZInfo;
    resizeSliceIndirection(ctx, atlas, lost.indirectionData.length);
    atlas.indirectionData.fill(0xFFFFFFFF);
    atlas.indirectionDirty = true;
    atlases.set(poolKey, atlas);
  }
  ctx.postWantedSet(lost.datasetId);
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

/**
 * Free every slice pool `datasetId` owns, except the keys in `keep`.
 * Composed cleanup that also clears per-entity camera-UV state lives in
 * `slice/index.ts` as `removeSliceResources`.
 */
export function removeSliceAtlasesForDataset(
  ctx: WorkerCtx,
  datasetId: string,
  keep?: ReadonlySet<string>,
): void {
  const atlases = ctx.state.sliceAtlases;
  for (const [poolKey, atlas] of atlases) {
    if (atlas.datasetId !== datasetId || keep?.has(poolKey)) continue;
    destroySliceAtlas(atlas);
    atlases.delete(poolKey);
  }
}

/**
 * Destroy all slice atlases. Composed cleanup that also clears
 * per-entity camera-UV state lives in `slice/index.ts` as
 * `destroyAllSliceResources`.
 */
export function destroyAllSliceAtlasResources(ctx: WorkerCtx): void {
  const atlases = ctx.state.sliceAtlases;
  for (const atlas of atlases.values()) destroySliceAtlas(atlas);
  atlases.clear();
}
