/**
 * Slice atlas state — pool allocation, indirection sizing, per-entity
 * Z metadata, stale-on-Z-change tracking, dummy indirection buffer.
 *
 * Mutates the per-dataset registry on `ctx.state.sliceAtlases`. Composed
 * cleanups (`removeSliceResources`, `destroyAllSliceResources`) live in
 * `slice/index.ts` so this module stays free of dependencies on
 * `slice/eviction.ts` (which owns per-entity camera-UV state).
 */

import type { WorkerCtx } from "../workerContext.ts";
import { SLICE_ATLAS_BUDGET } from "../workerProtocol.ts";
import { createSliceTexture, getDeviceLimits } from "../gpuContext.ts";
import { computeAtlasGeometry } from "../atlasSizing.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";

/**
 * A label overlay's slice pool: one `r32uint` texture holding the current
 * Z-slice of the label mask at full width, plus a single-slot indirection
 * buffer so the categorical shader path reads it as one tile. Kept minimal
 * and self-contained (no shared LRU slots) because a label overlay is a
 * single member covering a bounded 2D footprint, unlike the shared
 * intensity atlas that packs many members.
 *
 * The texture is written IN PLACE as new Z/T slices arrive (never destroyed
 * on a scrub), mirroring the intensity atlas' stale-then-overwrite so a
 * label never blanks mid-scrub — the previous slice stays visible until the
 * new one lands.
 */
export interface LabelSlicePool {
  texture: GPUTexture; // r32uint, size [width, height]
  /** Single-entry indirection ([0]) so the one tile is always slot 0. */
  indirectionBuf: GPUBuffer;
  width: number;
  height: number;
  /**
   * Cached per-member entity descriptor (a persistent buffer, not a
   * per-frame allocation) + the overlay opacity it was built for. Rebuilt
   * only when the opacity changes. Populated by the render path.
   */
  descBuffer?: GPUBuffer;
  descOpacity?: number;
  /**
   * Cached declared-palette storage buffer ([id, packedRgba] pairs) + its
   * pair count, built once from the label's `image-label.colors`.
   */
  labelColorBuffer?: GPUBuffer;
  labelColorCount?: number;
}

/**
 * Get or create a label slice pool for `memberId` sized to the label
 * level's 2D dimensions (clamped to the device's max 2D texture dimension
 * so an oversized/whole-slide level can never throw at `createTexture`).
 * Reused IN PLACE when the dims are unchanged — a Z/T scrub overwrites the
 * existing texture rather than destroying + recreating it, so the overlay
 * never blanks. Recreated only when the dims actually change (a new level).
 */
export function getOrCreateLabelSlicePool(
  ctx: WorkerCtx,
  memberId: string,
  width: number,
  height: number,
): LabelSlicePool {
  const limit = getDeviceLimits(ctx.device).maxTextureDimension2D;
  const w = Math.max(1, Math.min(width, limit));
  const h = Math.max(1, Math.min(height, limit));

  const pools = ctx.state.labelSlicePools;
  const existing = pools.get(memberId);
  if (existing && existing.width === w && existing.height === h) {
    return existing;
  }
  if (existing) destroyLabelSlicePool(existing);

  const texture = createSliceTexture(ctx.device, w, h, null, "r32uint");
  const indirectionBuf = ctx.device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Single tile lives at slot 0.
  ctx.device.queue.writeBuffer(indirectionBuf, 0, new Uint32Array([0]));

  const pool: LabelSlicePool = { texture, indirectionBuf, width: w, height: h };
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

// Shared dummy 2D indirection buffer for well-as-proxy slice layers.
// Stays at module scope: it's a per-device singleton, not per-session
// state.
let dummySliceIndirectionBuf: GPUBuffer | null = null;
export function getDummySliceIndirection(device: GPUDevice): GPUBuffer {
  if (!dummySliceIndirectionBuf) {
    dummySliceIndirectionBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dummySliceIndirectionBuf, 0, new Uint32Array([0xFFFFFFFF]));
  }
  return dummySliceIndirectionBuf;
}

/** Create a shared slice pool. Indirection sized later from entityMetas. */
function createSliceAtlas(
  device: GPUDevice,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
): SliceAtlasState {
  const limits = getDeviceLimits(device);
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY],
    SLICE_ATLAS_BUDGET,
    "2d",
  );
  const { slotsX, slotsY, totalSlots, atlasW, atlasH } = geom;

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

export function destroySliceAtlas(atlas: SliceAtlasState): void {
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
}

/**
 * Get or create a shared slice pool with the given chunk dims. Stores the
 * pool in `ctx.state.sliceAtlases`. Cold state handler sets entityMetas
 * and resizes indirection afterward.
 */
export function getOrCreateSlicePool(
  ctx: WorkerCtx,
  poolKey: string,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
): SliceAtlasState {
  const atlases = ctx.state.sliceAtlases;
  const existing = atlases.get(poolKey);
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
 * Remove the atlas pool for a removed dataset (no-op if not present).
 * Composed cleanup that also clears per-entity camera-UV state lives
 * in `slice/index.ts` as `removeSliceResources`.
 */
export function removeSliceAtlas(ctx: WorkerCtx, idOrMember: string): void {
  const atlases = ctx.state.sliceAtlases;
  const atlas = atlases.get(idOrMember);
  if (atlas) {
    destroySliceAtlas(atlas);
    atlases.delete(idOrMember);
  }
}

/**
 * Destroy all slice atlases + the dummy indirection buffer. Composed
 * cleanup that also clears per-entity camera-UV state lives in
 * `slice/index.ts` as `destroyAllSliceResources`.
 */
export function destroyAllSliceAtlasResources(ctx: WorkerCtx): void {
  const atlases = ctx.state.sliceAtlases;
  for (const atlas of atlases.values()) destroySliceAtlas(atlas);
  atlases.clear();
  dummySliceIndirectionBuf?.destroy();
  dummySliceIndirectionBuf = null;
}
