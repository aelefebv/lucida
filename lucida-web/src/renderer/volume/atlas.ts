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
import { getDeviceLimits } from "../gpuContext.ts";
import {
  computeAtlasGeometry,
  computeLabelVolumeSizing,
  type LabelVolumeSizing,
} from "../atlasSizing.ts";
import type { TrackedGpuResource } from "../gpuResourceBudget.ts";
import { labelPoolKey } from "../labelPoolKey.ts";

/** Per-LOD indirection section metadata. */
export interface LodIndirectionMeta {
  level: number;
  gridDims: [number, number, number];   // [Z, Y, X]
  chunkDims: [number, number, number];  // [Z, Y, X]
  levelDims: [number, number, number];  // [Z, Y, X] voxel dimensions
  offset: number;                       // entry offset into flat indirection buffer
}

export interface AtlasState {
  /** Explicit owner used for dataset-wide reconciliation (never inferred from a key). */
  datasetId?: string;
  poolKey?: string;
  texture: GPUTexture;
  textureAllocation?: TrackedGpuResource<GPUTexture>;
  indirectionBuf: GPUBuffer;
  indirectionAllocation?: TrackedGpuResource<GPUBuffer>;
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
 * slot. Uses the shared 3-D texture-atlas layout so the categorical shader
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
 * a T scrub when the level dims are unchanged), but residency is
 * selection-owned. Renderers hide the old volume until current chunks land;
 * the uploader invalidates the old indirection map before a partial refresh so
 * old and new timepoints can never be sampled together.
 */
export interface LabelVolumePool {
  memberId: string;
  /**
   * r32uint 3D slot-grid atlas, size
   * `[slotsX*chunkX, slotsY*chunkY, slotsZ*chunkZ]`. Each axis is
   * `<= device.maxTextureDimension3D`.
   */
  texture: GPUTexture;
  textureAllocation?: TrackedGpuResource<GPUTexture>;
  /**
   * Per level-chunk-cell indirection: one entry per `[z][y][x]` cell at flat
   * `gridIdx = z*gridY*gridX + y*gridX + x`. A resident chunk's entry is its
   * slot index; an absent chunk's entry is the sentinel `0xFFFFFFFF`.
   */
  indirectionBuf: GPUBuffer;
  indirectionAllocation?: TrackedGpuResource<GPUBuffer>;
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
  /** Content/selection identity of the indirection entries safe to render. */
  residentContentEpoch?: number;
  residentSelectionEpoch?: number;
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
  descAllocation?: TrackedGpuResource<GPUBuffer>;
  /**
   * Cached declared-palette storage buffer ([id, packedRgba] pairs) + its
   * pair count, built once from the label's `image-label.colors`.
   */
  labelColorBuffer?: GPUBuffer;
  labelColorAllocation?: TrackedGpuResource<GPUBuffer>;
  labelColorCount?: number;
}

/** Warn once per member when its label volume texture can't be allocated,
 *  so a failing device doesn't spam the console each delivery. */
const warnedLabelVolumeAlloc = new Set<string>();

/** Clear allocation warn-once state between deterministic tests. */
export function resetLabelVolumeAllocWarnings(): void {
  warnedLabelVolumeAlloc.clear();
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
 * larger than the device limit) — the caller skips the label rather than
 * throwing through the upload path. Level selection already bounds the size, so
 * this is defense in depth.
 *
 * A brick that exceeds the device dimension limit is caught synchronously:
 * {@link computeLabelVolumeSizing} (via `computeTextureAtlasLayout`) throws, and
 * the budgeted texture owner throws on a descriptor overflow — both are wrapped
 * in one `try/catch` that returns `null` and warns once, so a bad size skips the
 * label instead of throwing through the upload path.
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
  const key = labelPoolKey(datasetId, memberId);
  const existing = pools.get(key);
  if (
    existing &&
    existing.width === w && existing.height === h && existing.depth === d &&
    existing.chunkX === cx && existing.chunkY === cy && existing.chunkZ === cz &&
    existing.datasetId === datasetId
  ) {
    return existing;
  }
  if (existing) destroyLabelVolumePool(existing);

  const limit = getDeviceLimits(ctx.device).maxTextureDimension3D;

  let sizing: LabelVolumeSizing;
  let texture: GPUTexture | undefined;
  let textureAllocation: TrackedGpuResource<GPUTexture> | undefined;
  let indirectionBuf: GPUBuffer | undefined;
  let indirectionAllocation: TrackedGpuResource<GPUBuffer> | undefined;
  try {
    // Size the atlas to the WHOLE chunk grid (no byte-budget clamp) and pack
    // the slots under the device limit; throws if a single brick exceeds it.
    sizing = computeLabelVolumeSizing(w, h, d, cx, cy, cz, limit);
    const [texW, texH, texD] = sizing.textureSize;
    textureAllocation = ctx.gpuResources.createTexture(
      ctx.device,
      { key: `label-volume:${key}:texture`, kind: "label-volume", datasetId },
      {
        size: [texW, texH, texD],
        format: "r32uint",
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      },
    );
    texture = textureAllocation.resource;

    const indirectionBytes = Math.max(sizing.gridCellCount * 4, 4);
    indirectionAllocation = ctx.gpuResources.createBuffer(
      ctx.device,
      { key: `label-volume:${key}:indirection`, kind: "buffer", datasetId },
      {
        size: indirectionBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      },
    );
    indirectionBuf = indirectionAllocation.resource;
  } catch (err) {
    indirectionAllocation?.destroy();
    if (!indirectionAllocation) indirectionBuf?.destroy();
    textureAllocation?.destroy();
    if (!textureAllocation) texture?.destroy();
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
  ctx.device.queue.writeBuffer(indirectionBuf, 0, indirectionData);

  const freeSlots: number[] = [];
  for (let i = sizing.totalSlots - 1; i >= 0; i--) freeSlots.push(i);
  const slotGridIdx = new Int32Array(sizing.totalSlots);
  slotGridIdx.fill(-1);

  const pool: LabelVolumePool = {
    memberId,
    texture,
    textureAllocation,
    indirectionBuf,
    indirectionAllocation,
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
  pools.set(key, pool);
  return pool;
}

/** Whether a label pool contains indirection entries for this render. */
export function labelVolumePoolMatchesEpochs(
  pool: LabelVolumePool,
  epochs: { content: number; selection: number },
): boolean {
  return pool.residentContentEpoch === epochs.content &&
    pool.residentSelectionEpoch === epochs.selection;
}

/**
 * Resolve the atlas slot for a level chunk cell, allocating one on first
 * arrival and reusing it on a T scrub (so a re-delivered cell overwrites its
 * own brick in place). An eligible level never evicts: the atlas is sized to
 * the whole grid, so every cell has its own slot. If that invariant is broken,
 * fail closed with `null` instead of evicting a resident cell and rendering a
 * transparent hole elsewhere in the label.
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
      return null;
    }
    pool.slots.set(gridIdx, slot);
    pool.slotGridIdx[slot] = gridIdx;
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
  pool.textureAllocation?.destroy();
  if (!pool.textureAllocation) pool.texture.destroy();
  pool.indirectionAllocation?.destroy();
  if (!pool.indirectionAllocation) pool.indirectionBuf.destroy();
  pool.descAllocation?.destroy();
  if (!pool.descAllocation) pool.descBuffer?.destroy();
  pool.labelColorAllocation?.destroy();
  if (!pool.labelColorAllocation) pool.labelColorBuffer?.destroy();
}

/** Remove one dataset-scoped member's label volume pool (no-op if absent). */
export function removeLabelVolumePool(
  ctx: WorkerCtx,
  datasetId: string,
  memberId: string,
): void {
  const key = labelPoolKey(datasetId, memberId);
  const pool = ctx.state.labelVolumePools.get(key);
  if (pool) {
    destroyLabelVolumePool(pool);
    ctx.state.labelVolumePools.delete(key);
  }
}

/**
 * Free every label volume pool owned by `datasetId`. A bare member id is not a
 * valid cleanup identity because image ids may be reused across datasets.
 */
export function removeLabelVolumePoolsForDataset(ctx: WorkerCtx, datasetId: string): void {
  for (const [key, pool] of ctx.state.labelVolumePools) {
    if (pool.datasetId === datasetId) {
      destroyLabelVolumePool(pool);
      ctx.state.labelVolumePools.delete(key);
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
let depthAllocation: TrackedGpuResource<GPUTexture> | null = null;
let depthW = 0;
let depthH = 0;

export function ensureDepthTexture(ctx: WorkerCtx, w: number, h: number): GPUTexture {
  if (depthTexture && depthW === w && depthH === h) return depthTexture;
  depthAllocation?.destroy();
  depthAllocation = ctx.gpuResources.createTexture(
    ctx.device,
    { key: "session:volume-depth", kind: "depth" },
    {
    size: [w, h],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    },
  );
  depthTexture = depthAllocation.resource;
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
  ctx: WorkerCtx,
  poolKey: string,
  datasetId: string,
  chunkX: number, chunkY: number, chunkZ: number,
  t: number, c: number,
): AtlasState {
  const device = ctx.device;
  const limits = getDeviceLimits(device);
  const geometryBudget = ctx.gpuResources.availableUpTo(VOLUME_ATLAS_BUDGET);
  const slotBytes = chunkX * chunkY * chunkZ * 2;
  if (geometryBudget < slotBytes) {
    throw new Error(
      `WebGPU budget cannot fit one volume chunk for ${poolKey} ` +
        `(need ${slotBytes}, available ${geometryBudget})`,
    );
  }
  const geom = computeAtlasGeometry(
    limits,
    [chunkX, chunkY, chunkZ],
    geometryBudget,
    "3d",
  );
  const { slotsX, slotsY, totalSlots, atlasW, atlasH } = geom;
  const slotsZ = geom.slotsZ!;
  const atlasD = geom.atlasD!;
  if (totalSlots < 1) {
    throw new Error(`volume atlas ${poolKey} has zero slots`);
  }

  const textureAllocation = ctx.gpuResources.createTexture(
    device,
    { key: `volume:${poolKey}:texture`, kind: "volume-atlas", datasetId },
    {
      size: [atlasW, atlasH, atlasD],
      format: "r16uint",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    },
  );
  const texture = textureAllocation.resource;

  // Indirection starts at minimum size; cold state handler resizes after computing entityMetas.
  const indirectionData = new Uint32Array(1);
  indirectionData[0] = 0xFFFFFFFF;
  let indirectionAllocation: TrackedGpuResource<GPUBuffer> | undefined;
  let indirectionBuf: GPUBuffer;
  try {
    indirectionAllocation = ctx.gpuResources.createBuffer(
      device,
      { key: `volume:${poolKey}:indirection:1`, kind: "buffer", datasetId },
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
    chunkX, chunkY, chunkZ,
    slotsX, slotsY, slotsZ,
    entityMetas: new Map(),
    t, c,
    intensityMin: 65535, intensityMax: 0,
    indirectionDirty: true,
  };
}

export function destroyAtlas(atlas: AtlasState): void {
  atlas.textureAllocation?.destroy();
  if (!atlas.textureAllocation) atlas.texture.destroy();
  atlas.indirectionAllocation?.destroy();
  if (!atlas.indirectionAllocation) atlas.indirectionBuf.destroy();
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
  datasetId: string = poolKey,
): AtlasState {
  const atlases = ctx.state.volumeAtlases;
  const existing = atlases.get(poolKey);
  if (
    existing && existing.datasetId === datasetId &&
    existing.chunkX === chunkX && existing.chunkY === chunkY && existing.chunkZ === chunkZ
  ) {
    existing.t = t;
    existing.c = c;
    return existing;
  }
  if (existing) destroyAtlas(existing);
  const newAtlas = createVolumeAtlas(ctx, poolKey, datasetId, chunkX, chunkY, chunkZ, t, c);
  atlases.set(poolKey, newAtlas);
  return newAtlas;
}

/**
 * Resize the indirection buffer to match a new total size (sum of all entity LOD sections).
 * Called by cold state handler after computing entityMetas with absolute offsets.
 */
export function resizeIndirection(ctx: WorkerCtx, atlas: AtlasState, totalEntries: number): void {
  if (totalEntries === atlas.indirectionData.length) return;
  const size = Math.max(totalEntries * 4, 4);
  const nextAllocation = ctx.gpuResources.createBuffer(
    ctx.device,
    {
      key: `volume:${atlas.poolKey ?? "legacy"}:indirection:${totalEntries}`,
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
 * Composed cleanup that also clears per-entity ray-pick state lives in
 * `volume/index.ts` as `removeVolumeResources`.
 */
export function removeVolumeAtlas(ctx: WorkerCtx, idOrMember: string): void {
  const atlases = ctx.state.volumeAtlases;
  for (const [poolKey, atlas] of atlases) {
    if (poolKey === idOrMember || atlas.datasetId === idOrMember) {
      destroyAtlas(atlas);
      atlases.delete(poolKey);
    }
  }
}

/**
 * Destroy all atlas pools and the depth texture. Composed cleanup that
 * also clears per-entity ray-pick state
 * lives in `volume/index.ts` as `destroyAllVolumeResources`.
 */
export function destroyAllVolumeAtlasResources(ctx: WorkerCtx): void {
  const atlases = ctx.state.volumeAtlases;
  for (const atlas of atlases.values()) destroyAtlas(atlas);
  atlases.clear();
  depthAllocation?.destroy();
  depthAllocation = null;
  depthTexture = null;
}
