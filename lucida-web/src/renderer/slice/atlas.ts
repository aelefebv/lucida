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
import { planCompaction } from "../poolCompaction.ts";
import type { SpatialAxis } from "../slicePlane.ts";
import { makeCompositeKey, makeSliceSlotKey, parseCompositeKey } from "../chunkKeys.ts";
import { labelSlicePoolKey } from "../labelPools.ts";
import {
  compactViewSlots,
  destroyViewIndirection,
  emptyViewIndirections,
  growViewSlots,
  viewIndirectionBytes,
  type ViewIndirection,
} from "../viewIndirection.ts";

/**
 * A label overlay's slice pool: one `r32uint` texture holding one plane of the
 * mask at one chunk-T (its form, `labelPools.ts`), with each chunk at its
 * place in the plane. No shared LRU slots, because a label overlay is one
 * member with a bounded 2D footprint.
 *
 * A view moving to another plane takes the pool of the form it left when no
 * other view draws that form, and the texture is written in place as the new
 * plane arrives, so a label never blanks mid-scrub.
 */
export interface LabelSlicePool {
  /** The label overlay's member id. */
  memberId: string;
  /** The chunk-T and the plane of the label level the pool holds. */
  t: number;
  plane: number;
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
 * Get or create the label slice pool for `memberId`'s plane `plane` at
 * chunk-T `t`, sized to the level's 2D dims clamped to the device's max 2D
 * texture dimension. Reused in place while the dims are unchanged.
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
  t: number,
  plane: number,
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
  const poolKey = labelSlicePoolKey(memberId, t, plane);
  const existing = pools.get(poolKey);
  if (existing && existing.width === w && existing.height === h && existing.chunkX === cx && existing.chunkY === cy) {
    existing.datasetId = datasetId;
    return existing;
  }
  if (existing) removeLabelSlicePool(ctx, poolKey, "freed");

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
        for (const [key, pool] of pools) {
          if (pool.texture === lost) removeLabelSlicePool(ctx, key, "out-of-memory");
        }
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
    memberId, t, plane,
    texture, indirectionBuf, indirection, markedFailed: new Set(),
    chunkX: cx, chunkY: cy, grid,
    keys: new Map(), planes: new Map(), datasetId, width: w, height: h,
  };
  pools.set(poolKey, pool);
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

export function destroyLabelSlicePool(pool: LabelSlicePool): void {
  pool.texture.destroy();
  pool.indirectionBuf.destroy();
  pool.descBuffer?.destroy();
  pool.labelColorBuffer?.destroy();
}

/**
 * Remove the label pool keyed `poolKey` (no-op if absent), reporting every
 * chunk it held lost for `reason` so the page sends what it still wants.
 */
export function removeLabelSlicePool(ctx: WorkerCtx, poolKey: string, reason: ChunkFeedbackReason): void {
  const pool = ctx.state.labelSlicePools.get(poolKey);
  if (pool) {
    postLabelSliceLost(ctx, pool, reason);
    destroyLabelSlicePool(pool);
    ctx.state.labelSlicePools.delete(poolKey);
  }
}

function postLabelSliceLost(ctx: WorkerCtx, pool: LabelSlicePool, reason: ChunkFeedbackReason): void {
  postChunkResidency(
    ctx, pool.memberId, "slice", LABEL_TIER, "lost", [...pool.keys.values()], reason, { axis: "z", plane: pool.plane },
  );
}

/**
 * Free every label slice pool whose member or owning `datasetId` matches
 * `idOrDataset`. Dataset removal passes the dataset id, which never equals a
 * member id, so the `datasetId` match is what frees the texture. With a
 * `reason`, the chunks they held are reported lost; a removed dataset's
 * delivery record goes with it, so removal passes none.
 */
export function removeLabelSlicePoolsForDataset(
  ctx: WorkerCtx,
  idOrDataset: string,
  reason?: ChunkFeedbackReason,
): void {
  for (const [poolKey, pool] of ctx.state.labelSlicePools) {
    if (pool.memberId === idOrDataset || pool.datasetId === idOrDataset) {
      if (reason) postLabelSliceLost(ctx, pool, reason);
      destroyLabelSlicePool(pool);
      ctx.state.labelSlicePools.delete(poolKey);
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
  /**
   * Slot keys `"memberId|chunkKey|plane"` (`makeSliceSlotKey`) → slot index,
   * insertion order = LRU. The plane is the level plane along {@link axis}
   * the slot's 2D data was cut from, so one chunk can be held at several
   * planes. Changed only through {@link holdSliceSlot} and
   * {@link dropSliceSlot}, which keep {@link planesByChunk} in step.
   */
  slots: Map<string, number>;
  /**
   * `"memberId|chunkKey"` → plane → slot index: the planes of each chunk the
   * pool holds, so an upload finds them without walking every slot.
   */
  planesByChunk: Map<string, Map<number, number>>;
  /** view id → the view's indirection over the pool, cutting its own plane at its own T. */
  views: Map<number, ViewIndirection>;
  freeSlots: number[];
  /** Slots the texture holds now. */
  totalSlots: number;
  chunkX: number; chunkY: number;
  /** The texture's slot grid now. Only `slotsY` changes, as the pool grows or shrinks. */
  slotsX: number; slotsY: number;
  /** The rows the pool's cap allows, which it grows toward while the GPU total has room. */
  maxSlotsY: number;
  /**
   * memberId → level → Z geometry, set from the first chunk that arrives
   * at that level. Per level, not per member: the levels sharing a pool
   * can differ in depth and chunk Z, so each maps a view's plane to its own
   * chunk-Z target.
   */
  entityZInfo: Map<string, Map<number, SliceEntityZInfo>>;
  /** The channel every slot holds, which the pool key names. */
  c: number;
  /**
   * The axis this pool's slots are cut along, which its pool key names, so
   * it never changes. Its "Z" (a view's Z, `entityZInfo`, a slot's plane) is
   * that axis, and slot keys read in its frame (`parsePlaneChunkKey`). A view
   * maps only the slots of the plane its Z cuts.
   */
  axis: SpatialAxis;
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
 * its cap allows only as chunks fill it and the GPU total has room. Each view
 * that draws from it adds its indirection.
 */
function createSliceAtlas(
  device: GPUDevice,
  datasetId: string,
  capBytes: number,
  chunkX: number, chunkY: number,
  c: number,
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

  const freeSlots: number[] = [];
  for (let i = totalSlots - 1; i >= 0; i--) freeSlots.push(i);

  return {
    datasetId,
    texture, format,
    slots: new Map(), planesByChunk: new Map(), views: new Map(), freeSlots, totalSlots,
    chunkX, chunkY,
    slotsX, slotsY, maxSlotsY,
    entityZInfo: new Map(),
    c,
    axis: "z",
  };
}

/** The bytes a slice pool's texture and every view's indirection over it hold now. */
export function sliceAtlasBytes(atlas: SliceAtlasState): number {
  return sliceRowBytes(atlas) * atlas.slotsY + viewIndirectionBytes(atlas);
}

/** The bytes one row of a slice pool's slots holds: the step it grows and shrinks by. */
export function sliceRowBytes(atlas: SliceAtlasState): number {
  return atlas.slotsX * atlas.chunkX * atlas.chunkY * bytesPerTexel(atlas.format);
}

/** The planes of a member's chunk the pool holds, each with its slot. */
export function heldPlanesOf(
  atlas: SliceAtlasState,
  memberId: string,
  chunkKey: string,
): ReadonlyMap<number, number> | undefined {
  return atlas.planesByChunk.get(makeCompositeKey(memberId, chunkKey));
}

/** Record that `slot` holds plane `plane` of a member's chunk. */
export function holdSliceSlot(
  atlas: SliceAtlasState,
  memberId: string,
  chunkKey: string,
  plane: number,
  slot: number,
): void {
  holdSliceSlotKey(atlas, makeSliceSlotKey(memberId, chunkKey, plane), slot);
}

function holdSliceSlotKey(atlas: SliceAtlasState, key: string, slot: number): void {
  const parsed = parseCompositeKey(key);
  if (!parsed || parsed.plane === null) return;
  atlas.slots.set(key, slot);
  const chunk = makeCompositeKey(parsed.memberId, parsed.chunkKey);
  let planes = atlas.planesByChunk.get(chunk);
  if (!planes) {
    planes = new Map();
    atlas.planesByChunk.set(chunk, planes);
  }
  planes.set(parsed.plane, slot);
}

/** Forget the slot a slot key names. Its slot index is the caller's to reuse. */
export function dropSliceSlot(atlas: SliceAtlasState, key: string): void {
  if (!atlas.slots.delete(key)) return;
  const parsed = parseCompositeKey(key);
  if (!parsed || parsed.plane === null) return;
  const chunk = makeCompositeKey(parsed.memberId, parsed.chunkKey);
  const planes = atlas.planesByChunk.get(chunk);
  planes?.delete(parsed.plane);
  if (planes?.size === 0) atlas.planesByChunk.delete(chunk);
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

  growViewSlots(atlas, totalSlots);
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
  const wantedRows = Math.ceil(wantedSlotsOf(poolKey, atlas) / atlas.slotsX);
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

  compactViewSlots(atlas, atlas.slots, plan, capacity);
  atlas.slots = new Map();
  atlas.planesByChunk = new Map();
  for (const [key, slot] of plan.slots) holdSliceSlotKey(atlas, key, slot);
  atlas.freeSlots = plan.freeSlots;
  atlas.slotsY = slotsY;
  atlas.totalSlots = capacity;
  return plan.dropped;
}

export function destroySliceAtlas(atlas: SliceAtlasState): void {
  atlas.texture.destroy();
  for (const view of atlas.views.values()) destroyViewIndirection(view);
  atlas.views.clear();
}

/**
 * Get or create a shared slice pool with the given chunk dims. The cold state
 * handler adds the view's indirection and lays out its sections afterward.
 */
export function getOrCreateSlicePool(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number,
  c: number,
  format: SampleFormat,
): SliceAtlasState {
  const atlases = ctx.state.sliceAtlases;
  const existing = atlases.get(poolKey);
  if (existing && existing.chunkX === chunkX && existing.chunkY === chunkY && existing.format === format) {
    existing.c = c;
    return existing;
  }
  if (existing) destroySliceAtlas(existing);
  const newAtlas = createWatchedSliceAtlas(ctx, poolKey, datasetId, chunkX, chunkY, c, format);
  atlases.set(poolKey, newAtlas);
  return newAtlas;
}

function createWatchedSliceAtlas(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number,
  c: number,
  format: SampleFormat,
): SliceAtlasState {
  return allocateWatched(
    ctx,
    () => createSliceAtlas(
      ctx.device, datasetId, poolCapBytes(getDeviceLimits(ctx.device), ctx.state.gpuTotalBytes),
      chunkX, chunkY, c, format,
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
  postSlotsLost(ctx, "slice", chunkPoolTier(poolKey), lost.slots.keys(), "out-of-memory", lost.axis);
  // The views' indirection buffers are their own, so a replacement keeps
  // them, emptied, rather than freeing them with the lost texture.
  const views = lost.views;
  lost.views = new Map();
  destroySliceAtlas(lost);
  atlases.delete(poolKey);
  if (handleGpuOutOfMemory(ctx)) {
    const atlas = createWatchedSliceAtlas(ctx, poolKey, lost.datasetId, lost.chunkX, lost.chunkY, lost.c, lost.format);
    atlas.entityZInfo = lost.entityZInfo;
    atlas.axis = lost.axis;
    atlas.views = views;
    emptyViewIndirections(atlas, atlas.totalSlots);
    atlases.set(poolKey, atlas);
  } else {
    for (const view of views.values()) destroyViewIndirection(view);
  }
  ctx.postWantedSet(lost.datasetId, "slice");
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
