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
import { computeAtlasGeometry, poolCapBytes } from "../atlasSizing.ts";
import { atlasTextureFormat, bytesPerTexel, type SampleFormat } from "../dataTypeUtil.ts";
import { allocateWatched } from "../worker/gpuErrors.ts";
import { postChunkResidency, postSlotsLost, LABEL_TIER } from "../chunkUploadFeedback.ts";
import { chunkPoolTier } from "../poolKeys.ts";
import { chunkPoolUsage, grantGrowth, handleGpuOutOfMemory, reserveGpuBytes, wantedSlotsOf } from "../worker/gpuBudget.ts";
import { planCompaction } from "../poolCompaction.ts";
import {
  compactViewSlots,
  destroyViewIndirection,
  emptyViewIndirections,
  growViewSlots,
  viewIndirectionBytes,
  type ViewIndirection,
} from "../viewIndirection.ts";
import type { ChunkFeedbackReason } from "../workerProtocol.ts";
import { applyFailedMarks, failedCellsAt, failedKeysForImage } from "../failedCells.ts";
import { INDIRECTION_MISS } from "../remap.ts";
import { labelVolumePoolKey } from "../labelPools.ts";

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
  /** How the texture holds samples; the dataset's, fixed for the pool's life. */
  format: SampleFormat;
  /**
   * Composite keys "memberId|chunkKey" → slotIndex (insertion-order = LRU).
   * The chunk key names the timepoint, so the pool holds every timepoint its
   * views draw, each in slots of its own.
   */
  slots: Map<string, number>;
  /** view id → the view's indirection over the pool, mapping the bricks of its own T. */
  views: Map<number, ViewIndirection>;
  freeSlots: number[];            // available slot indices (stack)
  /** Slots the texture holds now. */
  totalSlots: number;
  /** Shared slot pool dimensions (same chunk dims for all entities in this pool). */
  chunkX: number; chunkY: number; chunkZ: number;
  /**
   * The texture's slot grid: `slotsX` by `slotsY` slots a layer, `slotsZ`
   * layers. Slot `i` lies at column `i % slotsX` and row
   * `floor(i / slotsX) % slotsY` of layer `floor(i / (slotsX * slotsY))`.
   * Neither `slotsX` nor `slotsY` changes, so a slot keeps its place as the
   * pool grows or shrinks.
   */
  slotsX: number; slotsY: number; slotsZ: number;
  /**
   * The rows of slots the first layer holds now: all `slotsY` of them once
   * the pool is more than one layer deep. A pool starts one row deep, so a
   * view that wants a few chunks, such as a slice view's tilted cut, holds
   * rows for those alone.
   */
  rowsY: number;
  /** The layers the pool's cap allows, which it grows toward while the GPU total has room. */
  maxSlotsZ: number;
  /** The channel every slot holds, which the pool key names. */
  c: number;
}

/**
 * A label overlay's volume pool: a bricked slot-grid `r32uint` 3D atlas
 * holding the chosen level as fixed-size chunks, plus a per-cell indirection
 * buffer. Its slots tile a 3-D grid so a level larger than the monolithic
 * texture limit still renders as a compact slot grid.
 *
 * Ids are read with `textureLoad` (nearest only), so a sampled id is always
 * the id its cell stored, never a blend across bricks. Chunks are written in
 * place on a T scrub so the label never blanks mid-scrub.
 */
export interface LabelVolumePool {
  /** The label overlay's member id. */
  memberId: string;
  /** The chunk-T the pool holds (its form, `labelPools.ts`). */
  t: number;
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
  /** Cells whose entry reads FAILED because their chunk failed for good. */
  markedFailed: Set<number>;
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
   * `gridIdx` → the chunk key its slot holds. A cell is rewritten in place on
   * a T scrub, so the key it held is reported lost then, and every key is
   * reported lost when the pool goes. The page resends only what it hears is
   * gone.
   */
  keys: Map<number, string>;
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

  // Request the whole grid; packSlotGrid clamps only to the device limit and
  // packs the slots so no atlas axis exceeds it.
  const layout = packSlotGrid([cz, cy, cx], gridCellCount, maxTextureDimension3D);

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

interface SlotGridLayout {
  capacity: number;
  slotsX: number;
  slotsY: number;
  slotsZ: number;
  textureSize: [number, number, number];
}

/**
 * The 3-D slot grid holding `requestedCapacity` slots of `slotDims`
 * (`[Z, Y, X]`) under the device's max 3D texture dimension. Capacity is
 * clamped to what fits. Among grids that fit, the fewest allocated slots
 * win, then the shortest longest axis, so the texture stays near cubic.
 */
function packSlotGrid(
  slotDims: [number, number, number],
  requestedCapacity: number,
  maxTextureDimension3D: number,
): SlotGridLayout {
  const [slotZ, slotY, slotX] = slotDims;
  if (slotX <= 0 || slotY <= 0 || slotZ <= 0) {
    throw new Error(`[volumeAtlas] invalid slotDims=${slotDims.join(",")}`);
  }

  const maxSlotsX = Math.floor(maxTextureDimension3D / slotX);
  const maxSlotsY = Math.floor(maxTextureDimension3D / slotY);
  const maxSlotsZ = Math.floor(maxTextureDimension3D / slotZ);
  if (maxSlotsX < 1 || maxSlotsY < 1 || maxSlotsZ < 1) {
    throw new Error(
      `[volumeAtlas] slotDims=${slotDims.join(",")} exceed maxTextureDimension3D=${maxTextureDimension3D}`,
    );
  }

  const maxCapacity = maxSlotsX * maxSlotsY * maxSlotsZ;
  const capacity = Math.min(
    Math.max(1, Math.floor(requestedCapacity)),
    maxCapacity,
  );

  let best: SlotGridLayout | null = null;
  const maxCandidateX = Math.min(maxSlotsX, capacity);
  for (let slotsX = 1; slotsX <= maxCandidateX; slotsX++) {
    const maxCandidateY = Math.min(maxSlotsY, Math.ceil(capacity / slotsX));
    for (let slotsY = 1; slotsY <= maxCandidateY; slotsY++) {
      const slotsZ = Math.ceil(capacity / (slotsX * slotsY));
      if (slotsZ < 1 || slotsZ > maxSlotsZ) continue;

      const textureSize: [number, number, number] = [
        slotsX * slotX,
        slotsY * slotY,
        slotsZ * slotZ,
      ];
      const candidate: SlotGridLayout = {
        capacity,
        slotsX,
        slotsY,
        slotsZ,
        textureSize,
      };
      if (!best || compareSlotGrids(candidate, best) < 0) best = candidate;
    }
  }

  if (!best) {
    throw new Error(
      `[volumeAtlas] cannot pack capacity=${capacity} slotDims=${slotDims.join(",")} ` +
        `under maxTextureDimension3D=${maxTextureDimension3D}`,
    );
  }
  return best;
}

function compareSlotGrids(a: SlotGridLayout, b: SlotGridLayout): number {
  const aAllocated = a.slotsX * a.slotsY * a.slotsZ;
  const bAllocated = b.slotsX * b.slotsY * b.slotsZ;
  if (aAllocated !== bAllocated) return aAllocated - bAllocated;

  const aMaxAxis = Math.max(...a.textureSize);
  const bMaxAxis = Math.max(...b.textureSize);
  if (aMaxAxis !== bMaxAxis) return aMaxAxis - bMaxAxis;

  const aMinAxis = Math.min(...a.textureSize);
  const bMinAxis = Math.min(...b.textureSize);
  if (aMinAxis !== bMinAxis) return bMinAxis - aMinAxis;

  const aArea = a.textureSize[0] * a.textureSize[1] * a.textureSize[2];
  const bArea = b.textureSize[0] * b.textureSize[1] * b.textureSize[2];
  return aArea - bArea;
}

/**
 * Get or create the bricked label volume pool for `memberId`, sized to the
 * level's whole chunk grid. Reused in place while the level and chunk dims are
 * unchanged, so a T scrub overwrites slots and the overlay never blanks.
 *
 * Returns `null` (and warns once) when the atlas can't be sized or allocated,
 * so the caller skips the label instead of throwing through the upload path,
 * for a size the device ran out of memory on, and when the GPU total has no
 * room for it.
 */
export function getOrCreateLabelVolumePool(
  ctx: WorkerCtx,
  memberId: string,
  datasetId: string,
  t: number,
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
  const poolKey = labelVolumePoolKey(memberId, t);
  const existing = pools.get(poolKey);
  if (
    existing &&
    existing.width === w && existing.height === h && existing.depth === d &&
    existing.chunkX === cx && existing.chunkY === cy && existing.chunkZ === cz
  ) {
    existing.datasetId = datasetId;
    return existing;
  }
  if (existing) removeLabelVolumePool(ctx, poolKey, "freed");

  const sizeKey = `${memberId}|${w}x${h}x${d}`;
  if (ctx.state.labelSizesOutOfMemory.has(sizeKey)) return null;
  const limit = getDeviceLimits(ctx.device).maxTextureDimension3D;

  let sizing: LabelVolumeSizing;
  let texture: GPUTexture;
  try {
    sizing = computeLabelVolumeSizing(w, h, d, cx, cy, cz, limit);
    const [texW, texH, texD] = sizing.textureSize;
    if (!reserveGpuBytes(ctx, texW * texH * texD * LABEL_VOLUME_BYTES_PER_VOXEL + sizing.gridCellCount * 4)) {
      return null;
    }
    texture = allocateWatched(
      ctx,
      () => createEmptyVolumeTexture(ctx.device, texW, texH, texD, "r32uint"),
      (lost) => {
        // A size that ran out of memory once would again on every delivery.
        ctx.state.labelSizesOutOfMemory.add(sizeKey);
        for (const [key, pool] of ctx.state.labelVolumePools) {
          if (pool.texture === lost) removeLabelVolumePool(ctx, key, "out-of-memory");
        }
        handleGpuOutOfMemory(ctx);
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
    markedFailed: new Set(),
    gridX: sizing.gridX, gridY: sizing.gridY, gridZ: sizing.gridZ,
    chunkX: cx, chunkY: cy, chunkZ: cz,
    slotsX: sizing.slotsX, slotsY: sizing.slotsY, slotsZ: sizing.slotsZ,
    totalSlots: sizing.totalSlots,
    slots: new Map(),
    freeSlots,
    slotGridIdx,
    keys: new Map(),
    datasetId,
    width: w, height: h, depth: d,
    memberId,
    t,
  };
  pools.set(poolKey, pool);
  return pool;
}

/** The bytes a label volume pool holds on the GPU: everything {@link destroyLabelVolumePool} frees. */
export function labelVolumePoolBytes(pool: LabelVolumePool): number {
  return pool.slotsX * pool.chunkX * pool.slotsY * pool.chunkY * pool.slotsZ * pool.chunkZ * LABEL_VOLUME_BYTES_PER_VOXEL
    + pool.indirectionData.length * 4 + (pool.descBuffer?.size ?? 0) + (pool.labelColorBuffer?.size ?? 0);
}

/**
 * Resolve the atlas slot for a level chunk cell, allocating on first arrival
 * and reusing it on a T scrub. An eligible level never evicts because the atlas
 * holds the whole grid. Returns `null` when no slot is available.
 */
export function acquireLabelSlot(
  pool: LabelVolumePool,
  gridIdx: number,
): { slot: number; origin: [number, number, number]; evictedKey?: string } | null {
  let slot = pool.slots.get(gridIdx);
  let evictedKey: string | undefined;
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
      evictedKey = pool.keys.get(victim.value);
      pool.keys.delete(victim.value);
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
    evictedKey,
  };
}

/**
 * Mark the cells of the level and timepoint `at` whose chunk failed for
 * good, unless a slot holds that very chunk. A ray that reaches one draws the
 * hatch, where it would otherwise pass through as background, or stop at a
 * cell still holding another timepoint. Returns whether the marks changed.
 */
export function markLabelVolumeFailed(
  ctx: WorkerCtx,
  memberId: string,
  pool: LabelVolumePool,
  at: { level: number; t: number },
): boolean {
  const grid = { x: pool.gridX, y: pool.gridY, z: pool.gridZ };
  const failed = failedCellsAt(failedKeysForImage(ctx.state, memberId), grid, { ...at, c: 0 });
  const changed = applyFailedMarks(
    pool.indirectionData,
    pool.markedFailed,
    failed,
    (cell, key) => pool.slots.has(cell) && pool.keys.get(cell) === key,
    (cell) => pool.slots.get(cell) ?? INDIRECTION_MISS,
  );
  if (changed) ctx.device.queue.writeBuffer(pool.indirectionBuf, 0, pool.indirectionData);
  return changed;
}

export function destroyLabelVolumePool(pool: LabelVolumePool): void {
  pool.texture.destroy();
  pool.indirectionBuf.destroy();
  pool.descBuffer?.destroy();
  pool.labelColorBuffer?.destroy();
}

/**
 * Remove the label volume pool keyed `poolKey` (no-op if absent), reporting
 * every chunk it held lost for `reason` so the page sends what it still wants.
 */
export function removeLabelVolumePool(ctx: WorkerCtx, poolKey: string, reason: ChunkFeedbackReason): void {
  const pool = ctx.state.labelVolumePools.get(poolKey);
  if (pool) {
    postChunkResidency(ctx, pool.memberId, "volume", LABEL_TIER, "lost", [...pool.keys.values()], reason);
    destroyLabelVolumePool(pool);
    ctx.state.labelVolumePools.delete(poolKey);
  }
}

/**
 * Free every label volume pool whose member or owning `datasetId` matches
 * `idOrDataset`. Dataset removal passes the dataset id, which never equals a
 * member id, so the `datasetId` match is what frees the texture. With a
 * `reason`, the chunks they held are reported lost; a removed dataset's
 * delivery record goes with it, so removal passes none.
 */
export function removeLabelVolumePoolsForDataset(
  ctx: WorkerCtx,
  idOrDataset: string,
  reason?: ChunkFeedbackReason,
): void {
  for (const [poolKey, pool] of ctx.state.labelVolumePools) {
    if (pool.memberId === idOrDataset || pool.datasetId === idOrDataset) {
      if (reason) postChunkResidency(ctx, pool.memberId, "volume", LABEL_TIER, "lost", [...pool.keys.values()], reason);
      destroyLabelVolumePool(pool);
      ctx.state.labelVolumePools.delete(poolKey);
    }
  }
}

/** Destroy every label volume pool. */
export function destroyAllLabelVolumePools(ctx: WorkerCtx): void {
  for (const pool of ctx.state.labelVolumePools.values()) destroyLabelVolumePool(pool);
  ctx.state.labelVolumePools.clear();
}

function createAtlasTexture(
  device: GPUDevice,
  chunkX: number, chunkY: number, chunkZ: number,
  slotsX: number, rowsY: number, slotsZ: number,
  format: SampleFormat,
): GPUTexture {
  return device.createTexture({
    size: [slotsX * chunkX, rowsY * chunkY, slotsZ * chunkZ],
    format: atlasTextureFormat(format),
    dimension: "3d",
    usage: chunkPoolUsage(),
  });
}

/**
 * Create a shared atlas pool one row of slots deep. It grows toward the grid
 * its cap allows only as chunks fill it and the GPU total has room, so a
 * small volume, or a view that wants a few of a large one's chunks, never
 * holds more than it needs. Each view that draws from it adds its
 * indirection.
 */
function createVolumeAtlas(
  device: GPUDevice,
  datasetId: string,
  capBytes: number,
  chunkX: number, chunkY: number, chunkZ: number,
  c: number,
  format: SampleFormat,
): AtlasState {
  const limits = getDeviceLimits(device);
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY, chunkZ],
    capBytes,
    "3d",
    bytesPerTexel(format),
  );
  const { slotsX, slotsY } = geom;
  const maxSlotsZ = geom.slotsZ!;
  const slotsZ = 1;
  const rowsY = 1;
  const totalSlots = slotsX * rowsY * slotsZ;

  const texture = createAtlasTexture(device, chunkX, chunkY, chunkZ, slotsX, rowsY, slotsZ, format);

  const freeSlots: number[] = [];
  for (let i = totalSlots - 1; i >= 0; i--) freeSlots.push(i);

  return {
    datasetId,
    texture, format,
    slots: new Map(), views: new Map(), freeSlots, totalSlots,
    chunkX, chunkY, chunkZ,
    slotsX, slotsY, slotsZ, rowsY,
    maxSlotsZ,
    c,
  };
}

/** The rows of slots a pool holds now, every layer past the first counting `slotsY`. */
export function volumeRows(atlas: AtlasState): number {
  return atlas.rowsY + (atlas.slotsZ - 1) * atlas.slotsY;
}

/**
 * The extent a pool takes to hold `rows` rows: within the first layer, those
 * rows of it; past it, whole layers, since every layer of a texture is as
 * tall as the first.
 */
export function volumeExtentFor(atlas: AtlasState, rows: number): { rowsY: number; slotsZ: number } {
  const wanted = Math.max(1, Math.ceil(rows));
  if (wanted <= atlas.slotsY) return { rowsY: wanted, slotsZ: 1 };
  return { rowsY: atlas.slotsY, slotsZ: Math.min(atlas.maxSlotsZ, Math.ceil(wanted / atlas.slotsY)) };
}

/** The bytes a volume pool's texture and every view's indirection over it hold now. */
export function volumeAtlasBytes(atlas: AtlasState): number {
  return volumeRowBytes(atlas) * volumeRows(atlas) + viewIndirectionBytes(atlas);
}

/** The bytes one row of a volume pool's slots holds: the step it grows and shrinks by in its first layer. */
export function volumeRowBytes(atlas: AtlasState): number {
  return atlas.slotsX * atlas.chunkX * atlas.chunkY * atlas.chunkZ * bytesPerTexel(atlas.format);
}

/** The bytes one layer of a volume pool's slots holds: the step it grows and shrinks by past its first layer. */
export function volumeLayerBytes(atlas: AtlasState): number {
  return volumeRowBytes(atlas) * atlas.slotsY;
}

/**
 * Grow a full pool to hold `toRows` rows, up to its cap's layers. False when
 * it already holds them, so the caller evicts instead. The caller has
 * checked the GPU total.
 *
 * A slot's position depends on `slotsX` and `slotsY` alone, which never
 * change, so every resident slot keeps its texels and its index. Growing is
 * one copy of the old texture into the new one's front, and the indirection,
 * which holds slot indices, stays valid.
 */
export function growVolumeAtlas(device: GPUDevice, atlas: AtlasState, toRows: number): boolean {
  const { rowsY, slotsZ } = volumeExtentFor(atlas, toRows);
  if (rowsY + (slotsZ - 1) * atlas.slotsY <= volumeRows(atlas)) return false;
  const totalSlots = atlas.slotsX * rowsY * slotsZ;

  const texture = createAtlasTexture(
    device, atlas.chunkX, atlas.chunkY, atlas.chunkZ, atlas.slotsX, rowsY, slotsZ, atlas.format,
  );
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: atlas.texture },
    { texture },
    [atlas.slotsX * atlas.chunkX, atlas.rowsY * atlas.chunkY, atlas.slotsZ * atlas.chunkZ],
  );
  device.queue.submit([encoder.finish()]);
  // Destruction waits for the copy just submitted.
  atlas.texture.destroy();
  atlas.texture = texture;

  growViewSlots(atlas, totalSlots);
  for (let i = totalSlots - 1; i >= atlas.totalSlots; i--) atlas.freeSlots.push(i);
  atlas.rowsY = rowsY;
  atlas.slotsZ = slotsZ;
  atlas.totalSlots = totalSlots;
  return true;
}

/**
 * Shrink a pool to hold `toRows` rows, giving their bytes back to the GPU
 * total. It keeps the first chunks of `keep` that fit, moving any that lay
 * in a dropped row or layer into a slot that stays, and returns the
 * composite keys it no longer holds, for the caller to report lost.
 */
export function shrinkVolumeAtlas(
  device: GPUDevice,
  atlas: AtlasState,
  toRows: number,
  keep: Iterable<string>,
): string[] {
  const { rowsY, slotsZ } = volumeExtentFor(atlas, toRows);
  if (rowsY + (slotsZ - 1) * atlas.slotsY >= volumeRows(atlas)) return [];
  const layer = atlas.slotsX * atlas.slotsY;
  const totalSlots = atlas.slotsX * rowsY * slotsZ;
  const plan = planCompaction(atlas.slots, totalSlots, keep);

  const texture = createAtlasTexture(
    device, atlas.chunkX, atlas.chunkY, atlas.chunkZ, atlas.slotsX, rowsY, slotsZ, atlas.format,
  );
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: atlas.texture },
    { texture },
    [atlas.slotsX * atlas.chunkX, Math.min(atlas.rowsY, rowsY) * atlas.chunkY, slotsZ * atlas.chunkZ],
  );
  const origin = (slot: number) => ({
    x: (slot % atlas.slotsX) * atlas.chunkX,
    y: (Math.floor(slot / atlas.slotsX) % atlas.slotsY) * atlas.chunkY,
    z: Math.floor(slot / layer) * atlas.chunkZ,
  });
  for (const { from, to } of plan.moves) {
    encoder.copyTextureToTexture(
      { texture: atlas.texture, origin: origin(from) },
      { texture, origin: origin(to) },
      [atlas.chunkX, atlas.chunkY, atlas.chunkZ],
    );
  }
  device.queue.submit([encoder.finish()]);
  // Destruction waits for the copies just submitted.
  atlas.texture.destroy();
  atlas.texture = texture;

  compactViewSlots(atlas, atlas.slots, plan, totalSlots);
  atlas.slots = plan.slots;
  atlas.freeSlots = plan.freeSlots;
  atlas.rowsY = rowsY;
  atlas.slotsZ = slotsZ;
  atlas.totalSlots = totalSlots;
  return plan.dropped;
}

export function destroyAtlas(atlas: AtlasState): void {
  atlas.texture.destroy();
  for (const view of atlas.views.values()) destroyViewIndirection(view);
  atlas.views.clear();
}

/**
 * Get or create a shared volume atlas pool for the given (poolKey, chunk dims).
 * Stores the pool in `ctx.state.volumeAtlases`. The cold state handler adds
 * the view's indirection and lays out its sections afterward.
 */
export function getOrCreateVolumePool(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number, chunkZ: number,
  c: number,
  format: SampleFormat,
): AtlasState {
  const atlases = ctx.state.volumeAtlases;
  const existing = atlases.get(poolKey);
  if (
    existing && existing.chunkX === chunkX && existing.chunkY === chunkY && existing.chunkZ === chunkZ
    && existing.format === format
  ) {
    existing.c = c;
    return existing;
  }
  if (existing) destroyAtlas(existing);
  const newAtlas = createWatchedVolumeAtlas(ctx, poolKey, datasetId, chunkX, chunkY, chunkZ, c, format);
  atlases.set(poolKey, newAtlas);
  return newAtlas;
}

function createWatchedVolumeAtlas(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number, chunkZ: number,
  c: number,
  format: SampleFormat,
): AtlasState {
  return allocateWatched(
    ctx,
    () => createVolumeAtlas(
      ctx.device, datasetId, poolCapBytes(getDeviceLimits(ctx.device), ctx.state.gpuTotalBytes),
      chunkX, chunkY, chunkZ, c, format,
    ),
    (lost) => replaceLostVolumeAtlas(ctx, poolKey, lost),
  );
}

/** {@link growVolumeAtlas}, where a grow the device can't allocate loses the pool. */
export function growVolumeAtlasWatched(
  ctx: WorkerCtx,
  poolKey: string,
  atlas: AtlasState,
  toRows: number,
): boolean {
  return allocateWatched(
    ctx,
    () => growVolumeAtlas(ctx.device, atlas, toRows),
    () => replaceLostVolumeAtlas(ctx, poolKey, atlas),
  );
}

/**
 * Grow a full pool as far as the GPU total has room for, toward what holds
 * every chunk the planner wants, in one copy. While those chunks and a row
 * more fit its first layer, it grows to them: the extra row is room for a
 * step of a slice view's tilted cut without trading its bricks away. Past
 * that it grows whole layers, the wanted ones or double its own if that is
 * more, so a volume view that keeps asking for more grows in few copies.
 * With `reclaim`, grow by one step even when the total has none, if other
 * pools can give it back from chunks the planner doesn't want.
 */
export function growVolumePoolWithin(
  ctx: WorkerCtx,
  poolKey: string,
  atlas: AtlasState,
  reclaim: boolean,
): boolean {
  const wantedRows = Math.ceil(wantedSlotsOf(poolKey, atlas) / atlas.slotsX);
  const rows = volumeRows(atlas);
  const inFirstLayer = rows < atlas.slotsY;
  const targetRows = inFirstLayer && wantedRows < atlas.slotsY
    ? Math.max(rows + 1, wantedRows + 1)
    : atlas.slotsY * Math.min(atlas.maxSlotsZ, Math.max(atlas.slotsZ * 2, Math.ceil(wantedRows / atlas.slotsY)));
  // A first layer's grant comes in rows, and past that layer the texture
  // takes whole layers, so rows granted past it round down to them.
  const stepRows = inFirstLayer ? 1 : atlas.slotsY;
  const maxSteps = Math.max(0, Math.floor((targetRows - rows) / stepRows));
  const granted = rows + grantGrowth(ctx, atlas, volumeRowBytes(atlas) * stepRows, maxSteps, reclaim) * stepRows;
  const toRows = granted <= atlas.slotsY ? granted : atlas.slotsY * Math.floor(granted / atlas.slotsY);
  return toRows > rows && growVolumeAtlasWatched(ctx, poolKey, atlas, toRows);
}

/**
 * A pool whose texture the device could not allocate holds nothing and can't
 * be bound. Its chunks go back to the page, the GPU total halves, and a pool
 * with the same sections takes its place one row deep. At the floor total
 * the pool is dropped, and the next cold state tries again.
 */
export function replaceLostVolumeAtlas(ctx: WorkerCtx, poolKey: string, lost: AtlasState): void {
  const atlases = ctx.state.volumeAtlases;
  if (atlases.get(poolKey) !== lost) return;
  postSlotsLost(ctx, "volume", chunkPoolTier(poolKey), lost.slots.keys(), "out-of-memory");
  // The views' indirection buffers are their own, so a replacement keeps
  // them, emptied, rather than freeing them with the lost texture.
  const views = lost.views;
  lost.views = new Map();
  destroyAtlas(lost);
  atlases.delete(poolKey);
  if (handleGpuOutOfMemory(ctx)) {
    const atlas = createWatchedVolumeAtlas(
      ctx, poolKey, lost.datasetId, lost.chunkX, lost.chunkY, lost.chunkZ, lost.c, lost.format,
    );
    atlas.views = views;
    emptyViewIndirections(atlas, atlas.totalSlots);
    atlases.set(poolKey, atlas);
  } else {
    for (const view of views.values()) destroyViewIndirection(view);
  }
  ctx.postWantedSet(lost.datasetId, "volume");
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
}
