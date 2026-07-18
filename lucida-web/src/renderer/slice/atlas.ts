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
import { getDeviceLimits } from "../gpuContext.ts";
import { computeAtlasGeometry } from "../atlasSizing.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import type { TrackedGpuResource } from "../gpuResourceBudget.ts";
import { labelPoolKey } from "../labelPoolKey.ts";

/**
 * A label overlay's slice pool: one `r32uint` texture holding the current
 * Z-slice of the label mask at full width, plus a single-slot indirection
 * buffer so the categorical shader path reads it as one tile. Kept minimal
 * and self-contained (no shared LRU slots) because a label overlay is a
 * single member covering a bounded 2D footprint, unlike the shared
 * intensity atlas that packs many members.
 *
 * The texture allocation is reused as new Z/T slices arrive. Residency is
 * nevertheless selection-owned: renderers must not sample it until chunks for
 * the current content + selection epochs have landed. On an epoch change the
 * uploader clears the regions written by the previous selection before it
 * accepts the first current chunk, preventing a partial refresh from mixing
 * old and new categorical ids.
 */
export interface LabelSlicePool {
  memberId: string;
  texture: GPUTexture; // r32uint, size [width, height]
  textureAllocation?: TrackedGpuResource<GPUTexture>;
  /** Single-entry indirection ([0]) so the one tile is always slot 0. */
  indirectionBuf: GPUBuffer;
  indirectionAllocation?: TrackedGpuResource<GPUBuffer>;
  /**
   * Owning dataset id (the `removeLayerResources` id). The pool is keyed by
   * the label image id — which dataset removal never sees — so this is how
   * {@link removeLabelSlicePoolsForDataset} finds + frees it on removal.
   */
  datasetId: string;
  width: number;
  height: number;
  /** Content/selection identity of the pixels currently safe to render. */
  residentContentEpoch?: number;
  residentSelectionEpoch?: number;
  /** Regions written for that identity, cleared before the next one lands. */
  writtenRegions: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  /**
   * Cached per-member entity descriptor (a persistent buffer, not a
   * per-frame allocation) + the overlay opacity it was built for. Rebuilt
   * only when the opacity changes. Populated by the render path.
   */
  descBuffer?: GPUBuffer;
  descAllocation?: TrackedGpuResource<GPUBuffer>;
  descOpacity?: number;
  /**
   * Cached declared-palette storage buffer ([id, packedRgba] pairs) + its
   * pair count, built once from the label's `image-label.colors`.
   */
  labelColorBuffer?: GPUBuffer;
  labelColorAllocation?: TrackedGpuResource<GPUBuffer>;
  labelColorCount?: number;
}

/** Warn once per member when its label slice texture can't be allocated,
 *  so a failing device doesn't spam the console each delivery. */
const warnedLabelSliceAlloc = new Set<string>();

/**
 * Clear the per-member alloc-failure warn-once set. Test-only, so a case
 * that provokes an allocation failure doesn't suppress the warning (and the
 * skip path it guards) for a later case reusing the same member id.
 */
export function resetLabelSliceAllocWarnings(): void {
  warnedLabelSliceAlloc.clear();
}

/**
 * Get or create a label slice pool for `memberId` sized to the label
 * level's 2D dimensions (clamped to the device's max 2D texture dimension
 * so an oversized/whole-slide level can never exceed the limit). Reused IN
 * PLACE when the dims are unchanged — a Z/T scrub overwrites the existing
 * texture rather than destroying + recreating it. The render path hides a
 * reused texture until it belongs to the current selection. Recreated only
 * when the dims actually change (a new level).
 * `datasetId` is stamped on the pool so dataset removal can free it (the
 * pool is keyed by the label image id).
 *
 * Returns `null` when either the texture or its indirection buffer fails to
 * allocate (e.g. an out-of-budget device) — a partial allocation is unwound
 * so nothing leaks, and the caller skips the label rather than throwing
 * through the upload path. Level selection already bounds the size, so this
 * is defense in depth.
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
  const key = labelPoolKey(datasetId, memberId);
  const existing = pools.get(key);
  if (
    existing && existing.width === w && existing.height === h &&
    existing.datasetId === datasetId
  ) {
    return existing;
  }
  if (existing) destroyLabelSlicePool(existing);

  let texture: GPUTexture | undefined;
  let textureAllocation: TrackedGpuResource<GPUTexture> | undefined;
  let indirectionBuf: GPUBuffer | undefined;
  let indirectionAllocation: TrackedGpuResource<GPUBuffer> | undefined;
  try {
    textureAllocation = ctx.gpuResources.createTexture(
      ctx.device,
      { key: `label-slice:${key}:texture`, kind: "label-slice", datasetId },
      {
        size: [w, h],
        format: "r32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      },
    );
    texture = textureAllocation.resource;
    indirectionAllocation = ctx.gpuResources.createBuffer(
      ctx.device,
      { key: `label-slice:${key}:indirection`, kind: "buffer", datasetId },
      {
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      },
    );
    indirectionBuf = indirectionAllocation.resource;
  } catch (err) {
    // Free an already-created texture so a later-step failure (e.g. the
    // indirection buffer) can't orphan it. If the texture itself failed,
    // `texture` is still undefined and this is a no-op.
    indirectionAllocation?.destroy();
    if (!indirectionAllocation) indirectionBuf?.destroy();
    textureAllocation?.destroy();
    if (!textureAllocation) texture?.destroy();
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
  // Single tile lives at slot 0.
  ctx.device.queue.writeBuffer(indirectionBuf, 0, new Uint32Array([0]));

  const pool: LabelSlicePool = {
    memberId,
    texture,
    textureAllocation,
    indirectionBuf,
    indirectionAllocation,
    datasetId,
    width: w,
    height: h,
    writtenRegions: new Map(),
  };
  pools.set(key, pool);
  return pool;
}

/** Whether a label pool contains pixels for the render's data identity. */
export function labelSlicePoolMatchesEpochs(
  pool: LabelSlicePool,
  epochs: { content: number; selection: number },
): boolean {
  return pool.residentContentEpoch === epochs.content &&
    pool.residentSelectionEpoch === epochs.selection;
}

export function destroyLabelSlicePool(pool: LabelSlicePool): void {
  pool.textureAllocation?.destroy();
  if (!pool.textureAllocation) pool.texture.destroy();
  pool.indirectionAllocation?.destroy();
  if (!pool.indirectionAllocation) pool.indirectionBuf.destroy();
  pool.descAllocation?.destroy();
  if (!pool.descAllocation) pool.descBuffer?.destroy();
  pool.labelColorAllocation?.destroy();
  if (!pool.labelColorAllocation) pool.labelColorBuffer?.destroy();
}

/** Remove one dataset-scoped member's label pool (no-op if absent). */
export function removeLabelSlicePool(
  ctx: WorkerCtx,
  datasetId: string,
  memberId: string,
): void {
  const key = labelPoolKey(datasetId, memberId);
  const pool = ctx.state.labelSlicePools.get(key);
  if (pool) {
    destroyLabelSlicePool(pool);
    ctx.state.labelSlicePools.delete(key);
  }
}

/**
 * Free every label slice pool owned by `datasetId`. Member-only cleanup must
 * never pass through this function: image ids are legal to reuse across open
 * datasets, so a bare member id cannot identify a label pool.
 */
export function removeLabelSlicePoolsForDataset(ctx: WorkerCtx, datasetId: string): void {
  for (const [key, pool] of ctx.state.labelSlicePools) {
    if (pool.datasetId === datasetId) {
      destroyLabelSlicePool(pool);
      ctx.state.labelSlicePools.delete(key);
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
  /** Explicit owner used for dataset-wide reconciliation. */
  datasetId?: string;
  poolKey?: string;
  texture: GPUTexture;
  textureAllocation?: TrackedGpuResource<GPUTexture>;
  indirectionBuf: GPUBuffer;
  indirectionAllocation?: TrackedGpuResource<GPUBuffer>;
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

/** Create a shared slice pool. Indirection sized later from entityMetas. */
function createSliceAtlas(
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number,
  z: number, t: number, c: number,
): SliceAtlasState {
  const device = ctx.device;
  const limits = getDeviceLimits(device);
  const geometryBudget = ctx.gpuResources.availableUpTo(SLICE_ATLAS_BUDGET);
  const slotBytes = chunkX * chunkY * 2;
  if (geometryBudget < slotBytes) {
    throw new Error(
      `WebGPU budget cannot fit one slice chunk for ${poolKey} ` +
        `(need ${slotBytes}, available ${geometryBudget})`,
    );
  }
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY],
    geometryBudget,
    "2d",
  );
  const { slotsX, slotsY, totalSlots, atlasW, atlasH } = geom;
  if (totalSlots < 1) throw new Error(`slice atlas ${poolKey} has zero slots`);

  const textureAllocation = ctx.gpuResources.createTexture(
    device,
    { key: `slice:${poolKey}:texture`, kind: "slice-atlas", datasetId },
    {
      size: [atlasW, atlasH],
      format: "r16uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    },
  );
  const texture = textureAllocation.resource;

  // Indirection sized later by cold state handler
  const indirectionData = new Uint32Array(1);
  indirectionData[0] = 0xFFFFFFFF;
  let indirectionAllocation: TrackedGpuResource<GPUBuffer> | undefined;
  let indirectionBuf: GPUBuffer;
  try {
    indirectionAllocation = ctx.gpuResources.createBuffer(
      device,
      { key: `slice:${poolKey}:indirection:1`, kind: "buffer", datasetId },
      {
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      },
    );
    indirectionBuf = indirectionAllocation.resource;
  } catch (err) {
    textureAllocation?.destroy();
    if (!textureAllocation) texture.destroy();
    throw err;
  }
  device.queue.writeBuffer(indirectionBuf, 0, indirectionData);

  const freeSlots: number[] = [];
  for (let i = totalSlots - 1; i >= 0; i--) freeSlots.push(i);

  const slotGridIdx = new Int32Array(totalSlots);
  slotGridIdx.fill(-1);

  return {
    datasetId, poolKey,
    texture, textureAllocation,
    indirectionBuf, indirectionAllocation, indirectionData,
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
  atlas.textureAllocation?.destroy();
  if (!atlas.textureAllocation) atlas.texture.destroy();
  atlas.indirectionAllocation?.destroy();
  if (!atlas.indirectionAllocation) atlas.indirectionBuf.destroy();
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
  datasetId: string = poolKey,
): SliceAtlasState {
  const atlases = ctx.state.sliceAtlases;
  const existing = atlases.get(poolKey);
  if (
    existing && existing.datasetId === datasetId &&
    existing.chunkX === chunkX && existing.chunkY === chunkY
  ) {
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
  const newAtlas = createSliceAtlas(ctx, poolKey, datasetId, chunkX, chunkY, z, t, c);
  atlases.set(poolKey, newAtlas);
  return newAtlas;
}

/** Resize the slice pool's indirection to the new total size. */
export function resizeSliceIndirection(ctx: WorkerCtx, atlas: SliceAtlasState, totalEntries: number): void {
  if (totalEntries === atlas.indirectionData.length) return;
  const size = Math.max(totalEntries * 4, 4);
  const nextAllocation = ctx.gpuResources.createBuffer(
    ctx.device,
    {
      key: `slice:${atlas.poolKey ?? "legacy"}:indirection:${totalEntries}`,
      kind: "buffer",
      datasetId: atlas.datasetId,
    },
    {
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    },
  );
  const nextBuffer = nextAllocation.resource;
  atlas.indirectionAllocation?.destroy();
  if (!atlas.indirectionAllocation) atlas.indirectionBuf.destroy();
  atlas.indirectionData = new Uint32Array(totalEntries);
  atlas.indirectionBuf = nextBuffer;
  atlas.indirectionAllocation = nextAllocation;
}

/**
 * Remove the atlas pool for a removed dataset (no-op if not present).
 * Composed cleanup that also clears per-entity camera-UV state lives
 * in `slice/index.ts` as `removeSliceResources`.
 */
export function removeSliceAtlas(ctx: WorkerCtx, idOrMember: string): void {
  const atlases = ctx.state.sliceAtlases;
  for (const [poolKey, atlas] of atlases) {
    if (poolKey === idOrMember || atlas.datasetId === idOrMember) {
      destroySliceAtlas(atlas);
      atlases.delete(poolKey);
    }
  }
}

/**
 * Destroy all slice atlases. Composed cleanup that also clears
 * per-entity camera-UV state lives in
 * `slice/index.ts` as `destroyAllSliceResources`.
 */
export function destroyAllSliceAtlasResources(ctx: WorkerCtx): void {
  const atlases = ctx.state.sliceAtlases;
  for (const atlas of atlases.values()) destroySliceAtlas(atlas);
  atlases.clear();
}
