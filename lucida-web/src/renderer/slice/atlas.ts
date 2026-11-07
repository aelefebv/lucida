/**
 * Slice atlas state: pool allocation, indirection sizing, per-entity Z
 * metadata, and the plane each slot was cut from.
 *
 * Composed cleanups (`removeSliceResources`, `destroyAllSliceResources`) live
 * in `slice/index.ts` so this module stays free of dependencies on
 * `slice/eviction.ts`, which owns per-entity camera-UV state.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { createSliceTexture, getDeviceLimits } from "../gpuContext.ts";
import { computeAtlasGeometry } from "../atlasSizing.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { atlasTextureFormat, bytesPerTexel, type SampleFormat } from "../dataTypeUtil.ts";

/**
 * A label overlay's slice pool: one `r32uint` texture holding the current
 * Z-slice of the mask, plus a single-slot indirection buffer so the
 * categorical shader reads it as one tile. No shared LRU slots, because a
 * label overlay is one member with a bounded 2D footprint.
 *
 * The texture is written in place as Z/T slices arrive, so a label never
 * blanks mid-scrub.
 */
export interface LabelSlicePool {
  texture: GPUTexture; // r32uint, size [width, height]
  /** Single-entry indirection ([0]) so the one tile is always slot 0. */
  indirectionBuf: GPUBuffer;
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
 * after unwinding any partial allocation, so the caller skips the label.
 */
export function getOrCreateLabelSlicePool(
  ctx: WorkerCtx,
  memberId: string,
  datasetId: string,
  width: number,
  height: number,
): LabelSlicePool | null {
  const limit = getDeviceLimits(ctx.device).maxTextureDimension2D;
  const w = Math.max(1, Math.min(width, limit));
  const h = Math.max(1, Math.min(height, limit));

  const pools = ctx.state.labelSlicePools;
  const existing = pools.get(memberId);
  if (existing && existing.width === w && existing.height === h) {
    existing.datasetId = datasetId;
    return existing;
  }
  if (existing) destroyLabelSlicePool(existing);

  let texture: GPUTexture | undefined;
  let indirectionBuf: GPUBuffer;
  try {
    texture = createSliceTexture(ctx.device, w, h, null, "r32uint");
    indirectionBuf = ctx.device.createBuffer({
      size: 4,
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
  ctx.device.queue.writeBuffer(indirectionBuf, 0, new Uint32Array([0]));

  const pool: LabelSlicePool = { texture, indirectionBuf, datasetId, width: w, height: h };
  pools.set(memberId, pool);
  return pool;
}

export function destroyLabelSlicePool(pool: LabelSlicePool): void {
  pool.texture.destroy();
  pool.indirectionBuf.destroy();
  pool.descBuffer?.destroy();
  pool.labelColorBuffer?.destroy();
}

/** Remove a member's label pool (no-op if absent). */
export function removeLabelSlicePool(ctx: WorkerCtx, memberId: string): void {
  const pool = ctx.state.labelSlicePools.get(memberId);
  if (pool) {
    destroyLabelSlicePool(pool);
    ctx.state.labelSlicePools.delete(memberId);
  }
}

/**
 * Free every label slice pool whose member key or owning `datasetId` matches
 * `idOrDataset`. Dataset removal passes the dataset id, which never equals a
 * pool key, so the `datasetId` match is what frees the texture.
 */
export function removeLabelSlicePoolsForDataset(ctx: WorkerCtx, idOrDataset: string): void {
  for (const [memberId, pool] of ctx.state.labelSlicePools) {
    if (memberId === idOrDataset || pool.datasetId === idOrDataset) {
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
  totalSlots: number;
  chunkX: number; chunkY: number;
  slotsX: number; slotsY: number;
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
  intensityMin: number; intensityMax: number;
  indirectionDirty: boolean;
}

/** Create a shared slice pool. Indirection sized later from entityMetas. */
function createSliceAtlas(
  device: GPUDevice,
  datasetId: string,
  budgetBytes: number,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
  format: SampleFormat,
): SliceAtlasState {
  const limits = getDeviceLimits(device);
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY],
    budgetBytes,
    "2d",
    bytesPerTexel(format),
  );
  const { slotsX, slotsY, totalSlots, atlasW, atlasH } = geom;

  const texture = createSliceTexture(device, atlasW, atlasH, null, atlasTextureFormat(format));

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
    slotsX, slotsY,
    entityMetas: new Map(),
    entityZInfo: new Map(),
    z, t, c,
    slotLevelZ: new Int32Array(totalSlots).fill(-1),
    intensityMin: Infinity, intensityMax: -Infinity,
    indirectionDirty: true,
  };
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
  const newAtlas = createSliceAtlas(
    ctx.device, datasetId, ctx.state.atlasBudgets.sliceAtlasBytes, chunkX, chunkY, z, t, c, format,
  );
  atlases.set(poolKey, newAtlas);
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
