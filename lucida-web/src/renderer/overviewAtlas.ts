/**
 * The overview atlases the minimap and the explore thumbnails draw from. An
 * overview is one member's channel at the level the minimap shows, at one
 * timepoint. A dataset's overviews share an atlas: one texture of
 * chunk-sized slots, and one indirection buffer in which each overview owns
 * a run of cells, as a chunk pool's entities do. So every overview of a
 * collection binds the same texture and buffer, and a member batch draws a
 * channel of all of them in one pass (`overviewDraw.ts`).
 *
 * An atlas is laid out as the chunk pools are, slot grid, indirection and
 * all, so a volume view's draw could bind one as its coarse pool.
 */

import type { WorkerCtx } from "./workerContext.ts";
import type { Chunk } from "./workerProtocol.ts";
import type { VolumePoolBinding } from "./volumeRenderer.ts";
import { getDeviceLimits, writeVolumeChunk } from "./gpuContext.ts";
import { computeAtlasGeometry } from "./atlasSizing.ts";
import { atlasTexels, atlasTextureFormat, bytesPerTexel, type SampleFormat } from "./dataTypeUtil.ts";
import { allocateWatched } from "./worker/gpuErrors.ts";
import { chunkPoolUsage, handleGpuOutOfMemory, reserveGpuBytes } from "./worker/gpuBudget.ts";
import { setGpuLedgerLine } from "./worker/gpuLedger.ts";
import { applyFailedMarks, cellIndex, failedCellsAt, failedKeysForImage, type CellGrid } from "./failedCells.ts";
import { INDIRECTION_MISS } from "./remap.ts";

/**
 * The share of the GPU total the overview atlases may hold together. A
 * collection of thousands of members would otherwise take the bytes the
 * view's own chunks need.
 */
export const MINIMAP_OVERVIEW_SHARE = 1 / 16;

/** What a grown atlas takes beyond what it needs, so overviews arriving one at a time grow it a few times, not once each. */
const GROWTH = 1.5;

type Dims = [number, number, number];

/** An overview's level, which its chunk keys name. */
export interface OverviewSpec {
  /** The dataset the member belongs to. Its overviews share an atlas, which goes when it does. */
  datasetId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  /** The level's extent, `[X, Y, Z]`. */
  levelDims: Dims;
  /** The level's chunk, `[X, Y, Z]`. */
  chunkDims: Dims;
  format: SampleFormat;
}

export interface Overview {
  key: string;
  atlas: OverviewAtlas;
  imageId: string;
  level: number;
  t: number;
  c: number;
  levelDims: Dims;
  chunkDims: Dims;
  grid: CellGrid;
  /** Its first cell in the atlas's indirection. */
  offset: number;
  /** The slot each of its cells holds, taken when it opened so every chunk that arrives has a place. */
  slots: Uint32Array;
  uploaded: Set<string>;
  /** Cells reading FAILED because their chunk failed for good. */
  markedFailed: Set<number>;
}

export interface OverviewAtlas {
  /** Its key in {@link OverviewAtlases.byKey}: the dataset, format and slot shape. */
  key: string;
  datasetId: string;
  format: SampleFormat;
  /**
   * One slot's texels, `[X, Y, Z]`: the level's chunk, or along an axis one
   * chunk covers, the power of two at or above the level ({@link slotSpan}).
   * The descriptor names it as the chunk, which samples the same texels.
   */
  slotDims: Dims;
  texture: GPUTexture;
  /**
   * Every texture the atlas's texels have passed through, the current one
   * last. A growth copies from a texture whose out-of-memory report may not
   * have arrived yet, and if any of them failed the texels never were.
   */
  lineage: Set<GPUTexture>;
  /**
   * Slot `i` lies at column `i % slotsX`, row `floor(i / slotsX) % slotsY`,
   * layer `floor(i / (slotsX * slotsY))`, as the shader reads it. Fixed for
   * the atlas's life, so a slot never moves.
   */
  slotsX: number;
  slotsY: number;
  /**
   * The slots the texture holds, the first `capacity` in slot order: part of
   * a row, then rows of the first layer, then whole layers. So a new atlas
   * takes only what its first overviews need, and a growth copies the old
   * texture into the new one's front.
   */
  capacity: number;
  /** The most slots the layout holds within the device's texture limits and the overviews' share. */
  maxCapacity: number;
  /** Free slots, a stack. */
  freeSlots: number[];
  indirection: Uint32Array<ArrayBuffer>;
  indirectionBuf: GPUBuffer;
  /** Cells past the end of the last run any overview took. */
  cellsUsed: number;
  /** Runs of cells dropped overviews gave back, by length. A dataset's overviews are mostly one length. */
  freeRuns: Map<number, number[]>;
  overviews: Set<Overview>;
}

export interface OverviewAtlases {
  byKey: Map<string, OverviewAtlas>;
  overviews: Map<string, Overview>;
  bytes: number;
  /** Bumped when an overview opens or goes, so a draw knows to read again which it can draw. */
  version: number;
}

export function createOverviewAtlases(): OverviewAtlases {
  return { byKey: new Map(), overviews: new Map(), bytes: 0, version: 0 };
}

function atlasKey(spec: OverviewSpec, slotDims: Dims): string {
  return `${spec.datasetId}\n${spec.format}\n${slotDims.join("x")}`;
}

/**
 * A slot's extent along an axis: the chunk's, or where the level is under
 * one chunk, the power of two at or above the level. Members of a collection
 * whose levels differ in size then share a few atlases, and so a few runs of
 * a batch, at no more than twice the level's extent.
 */
function slotSpan(level: number, chunk: number): number {
  return level >= chunk ? chunk : Math.min(chunk, 2 ** Math.ceil(Math.log2(Math.max(1, level))));
}

type Layout = Pick<OverviewAtlas, "slotsX" | "slotsY">;

function slotsPerLayer(atlas: Layout): number {
  return atlas.slotsX * atlas.slotsY;
}

/** The texture's extent in slots, `[X, Y, Z]`, when it holds the first `capacity` slots of `atlas`'s layout. */
function slotExtent(atlas: Layout, capacity: number): Dims {
  if (capacity <= atlas.slotsX) return [Math.max(1, capacity), 1, 1];
  if (capacity <= slotsPerLayer(atlas)) return [atlas.slotsX, Math.ceil(capacity / atlas.slotsX), 1];
  return [atlas.slotsX, atlas.slotsY, Math.ceil(capacity / slotsPerLayer(atlas))];
}

/** `capacity` rounded up to the slots of the extent that holds it. */
function fullCapacity(atlas: Layout, capacity: number): number {
  const [x, y, z] = slotExtent(atlas, capacity);
  return x * y * z;
}

function slotBytes(atlas: Pick<OverviewAtlas, "slotDims" | "format">): number {
  const [x, y, z] = atlas.slotDims;
  return x * y * z * bytesPerTexel(atlas.format);
}

function atlasBytes(atlas: OverviewAtlas): number {
  return atlas.capacity * slotBytes(atlas) + atlas.indirection.byteLength;
}

function noteBytes(atlases: OverviewAtlases): void {
  let bytes = 0;
  for (const atlas of atlases.byKey.values()) bytes += atlasBytes(atlas);
  atlases.bytes = bytes;
  setGpuLedgerLine("minimapTextures", bytes);
}

/** The atlas as a volume draw binds it. */
export function overviewBinding(atlas: OverviewAtlas): VolumePoolBinding {
  return {
    texture: atlas.texture,
    indirectionBuf: atlas.indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
    slotsZ: slotExtent(atlas, atlas.capacity)[2],
  };
}

/** The selection a refused overview stays refused for. */
export function overviewSelection(spec: Pick<OverviewSpec, "level" | "t" | "c" | "format">): string {
  return `${spec.level}/${spec.t}/${spec.c}/${spec.format}`;
}

/** Whether `overview` holds the level, timepoint, channel and format `spec` names. */
export function overviewHolds(overview: Overview, spec: OverviewSpec): boolean {
  return overview.level === spec.level && overview.t === spec.t && overview.c === spec.c &&
    overview.atlas.format === spec.format && overview.atlas.datasetId === spec.datasetId;
}

/**
 * Open an overview: a slot for each of its chunk cells and a run of cells in
 * its dataset's atlas, made or grown to hold them. Null when the overviews'
 * share of the GPU total, or the total, has no room for them; the caller
 * refuses it.
 */
export function openOverview(ctx: WorkerCtx, atlases: OverviewAtlases, key: string, spec: OverviewSpec): Overview | null {
  const [levelX, levelY, levelZ] = spec.levelDims;
  const [chunkX, chunkY, chunkZ] = spec.chunkDims;
  const slotDims: Dims = [slotSpan(levelX, chunkX), slotSpan(levelY, chunkY), slotSpan(levelZ, chunkZ)];
  const grid: CellGrid = { x: Math.ceil(levelX / chunkX), y: Math.ceil(levelY / chunkY), z: Math.ceil(levelZ / chunkZ) };
  const cells = Math.max(1, grid.x * grid.y * grid.z);
  const atlasId = atlasKey(spec, slotDims);
  const existing = atlases.byKey.get(atlasId);
  const atlas = existing ? (growAtlas(ctx, atlases, existing, cells) ? existing : null) : createAtlas(ctx, atlases, atlasId, spec, slotDims, cells);
  if (!atlas) return null;

  const run = atlas.freeRuns.get(cells)?.pop();
  const offset = run ?? atlas.cellsUsed;
  if (run === undefined) atlas.cellsUsed += cells;
  const slots = new Uint32Array(cells);
  for (let i = 0; i < cells; i++) slots[i] = atlas.freeSlots.pop()!;
  atlas.indirection.fill(INDIRECTION_MISS, offset, offset + cells);
  const overview: Overview = {
    key, atlas,
    imageId: spec.imageId, level: spec.level, t: spec.t, c: spec.c,
    levelDims: spec.levelDims, chunkDims: spec.chunkDims, grid,
    offset, slots, uploaded: new Set(), markedFailed: new Set(),
  };
  atlas.overviews.add(overview);
  atlases.overviews.set(key, overview);
  atlases.version++;
  markFailed(ctx, overview);
  flushCells(ctx, overview);
  return overview;
}

/** Write chunks of `overview` into its slots, and point its cells at them. */
export function writeOverviewChunks(ctx: WorkerCtx, overview: Overview, chunks: readonly Chunk[]): void {
  const { atlas, grid } = overview;
  const [levelX, levelY, levelZ] = overview.levelDims;
  const [chunkX, chunkY, chunkZ] = overview.chunkDims;
  const [slotX, slotY, slotZ] = atlas.slotDims;
  const format = atlasTextureFormat(atlas.format);
  const layer = slotsPerLayer(atlas);
  let wrote = false;
  for (const chunk of chunks) {
    if (overview.uploaded.has(chunk.key)) continue;
    const cell = cellIndex(grid, chunk.x, chunk.y, chunk.z);
    if (cell < 0 || cell >= overview.slots.length) continue;
    const slot = overview.slots[cell];
    writeVolumeChunk(
      ctx.device, atlas.texture, atlasTexels(chunk.data, chunk.dataType, atlas.format), chunkX, chunkY,
      Math.min(chunkX, levelX - chunk.x * chunkX),
      Math.min(chunkY, levelY - chunk.y * chunkY),
      Math.min(chunkZ, levelZ - chunk.z * chunkZ),
      (slot % atlas.slotsX) * slotX,
      (Math.floor(slot / atlas.slotsX) % atlas.slotsY) * slotY,
      Math.floor(slot / layer) * slotZ,
      format,
    );
    atlas.indirection[overview.offset + cell] = slot;
    overview.uploaded.add(chunk.key);
    wrote = true;
  }
  if (wrote) flushCells(ctx, overview);
}

/** Give an overview's slots and cells back to its atlas, and the atlas back to the GPU when it holds no other. */
export function dropOverview(atlases: OverviewAtlases, key: string): void {
  const overview = atlases.overviews.get(key);
  if (!overview) return;
  const { atlas } = overview;
  atlases.overviews.delete(key);
  atlases.version++;
  atlas.overviews.delete(overview);
  if (atlas.overviews.size === 0) {
    removeAtlas(atlases, atlas);
    return;
  }
  for (let i = overview.slots.length - 1; i >= 0; i--) atlas.freeSlots.push(overview.slots[i]);
  const runs = atlas.freeRuns.get(overview.slots.length) ?? [];
  runs.push(overview.offset);
  atlas.freeRuns.set(overview.slots.length, runs);
}

/** Drop every overview of the member `imageId`. */
export function dropMemberOverviews(atlases: OverviewAtlases, imageId: string): void {
  for (const overview of [...atlases.overviews.values()]) {
    if (overview.imageId === imageId) dropOverview(atlases, overview.key);
  }
}

/** Free every atlas of `datasetId`. */
export function dropDatasetOverviews(atlases: OverviewAtlases, datasetId: string): void {
  for (const atlas of [...atlases.byKey.values()]) {
    if (atlas.datasetId === datasetId) removeAtlas(atlases, atlas);
  }
}

/** Free every atlas, as on a lost device or a destroyed worker. */
export function dropAllOverviews(atlases: OverviewAtlases): void {
  for (const atlas of [...atlases.byKey.values()]) removeAtlas(atlases, atlas);
}

/** Mark the cells of every overview whose chunk failed for good, as the page last listed them. */
export function markOverviewsFailed(ctx: WorkerCtx, atlases: OverviewAtlases): void {
  for (const overview of atlases.overviews.values()) {
    if (markFailed(ctx, overview)) flushCells(ctx, overview);
  }
}

function markFailed(ctx: WorkerCtx, overview: Overview): boolean {
  const failed = failedCellsAt(
    failedKeysForImage(ctx.state, overview.imageId),
    overview.grid,
    { level: overview.level, t: overview.t, c: overview.c },
  );
  const cells = overview.atlas.indirection.subarray(overview.offset, overview.offset + overview.slots.length);
  return applyFailedMarks(cells, overview.markedFailed, failed, (_cell, key) => overview.uploaded.has(key), () => INDIRECTION_MISS);
}

/** Write an overview's run of cells to the GPU. */
function flushCells(ctx: WorkerCtx, overview: Overview): void {
  const { atlas, offset } = overview;
  ctx.device.queue.writeBuffer(atlas.indirectionBuf, offset * 4, atlas.indirection, offset, overview.slots.length);
}

function removeAtlas(atlases: OverviewAtlases, atlas: OverviewAtlas): void {
  for (const overview of atlas.overviews) atlases.overviews.delete(overview.key);
  atlas.overviews.clear();
  atlas.texture.destroy();
  atlas.indirectionBuf.destroy();
  if (atlases.byKey.get(atlas.key) === atlas) atlases.byKey.delete(atlas.key);
  atlases.version++;
  noteBytes(atlases);
}

/** Whether `extra` bytes more fit the overviews' share and the GPU total. */
function roomFor(ctx: WorkerCtx, atlases: OverviewAtlases, extra: number): boolean {
  return atlases.bytes + extra <= ctx.state.gpuTotalBytes * MINIMAP_OVERVIEW_SHARE && reserveGpuBytes(ctx, extra);
}

function createAtlas(
  ctx: WorkerCtx,
  atlases: OverviewAtlases,
  key: string,
  spec: OverviewSpec,
  slotDims: Dims,
  cells: number,
): OverviewAtlas | null {
  // The layout is the one the whole share would take, so the atlas can grow
  // to it without moving a slot; the texture starts at what `cells` need.
  const geometry = computeAtlasGeometry(
    getDeviceLimits(ctx.device), slotDims, ctx.state.gpuTotalBytes * MINIMAP_OVERVIEW_SHARE, "3d", bytesPerTexel(spec.format),
  );
  const shape = { slotsX: geometry.slotsX, slotsY: geometry.slotsY, slotDims, format: spec.format };
  const maxCapacity = slotsPerLayer(shape) * geometry.slotsZ!;
  const capacity = fullCapacity(shape, cells);
  if (capacity > maxCapacity || !roomFor(ctx, atlases, capacity * slotBytes(shape) + cells * 4)) return null;

  const indirection = new Uint32Array(cells).fill(INDIRECTION_MISS);
  const indirectionBuf = ctx.device.createBuffer({
    size: indirection.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const texture = watchedTexture(ctx, atlases, shape, capacity, () => atlas);
  const atlas: OverviewAtlas = {
    key,
    datasetId: spec.datasetId,
    format: spec.format,
    slotDims,
    texture,
    lineage: new Set([texture]),
    slotsX: geometry.slotsX,
    slotsY: geometry.slotsY,
    capacity: 0,
    maxCapacity,
    freeSlots: [],
    indirection,
    indirectionBuf,
    cellsUsed: 0,
    freeRuns: new Map(),
    overviews: new Set(),
  };
  addSlots(atlas, capacity);
  atlases.byKey.set(key, atlas);
  noteBytes(atlases);
  return atlas;
}

/** Grow `atlas` to hold `cells` more slots and cells. False, with the atlas as it was, when there is no room. */
function growAtlas(ctx: WorkerCtx, atlases: OverviewAtlases, atlas: OverviewAtlas, cells: number): boolean {
  const need = atlas.capacity + Math.max(0, cells - atlas.freeSlots.length);
  const needCells = atlas.freeRuns.get(cells)?.length ? 0 : Math.max(0, atlas.cellsUsed + cells - atlas.indirection.length);
  if (need === atlas.capacity && needCells === 0) return true;
  if (need > atlas.maxCapacity) return false;

  const cost = (capacity: number, moreCells: number) => (capacity - atlas.capacity) * slotBytes(atlas) + moreCells * 4;
  let toCapacity = need === atlas.capacity
    ? need
    : fullCapacity(atlas, Math.min(atlas.maxCapacity, Math.max(need, Math.ceil(atlas.capacity * GROWTH))));
  let toCells = needCells === 0 ? 0 : Math.max(needCells, Math.ceil(atlas.indirection.length * (GROWTH - 1)));
  if (!roomFor(ctx, atlases, cost(toCapacity, toCells))) {
    toCapacity = need === atlas.capacity ? need : fullCapacity(atlas, need);
    toCells = needCells;
    if (!roomFor(ctx, atlases, cost(toCapacity, toCells))) return false;
  }

  if (toCells > 0) {
    const indirection = new Uint32Array(atlas.indirection.length + toCells).fill(INDIRECTION_MISS);
    indirection.set(atlas.indirection);
    atlas.indirectionBuf.destroy();
    atlas.indirection = indirection;
    atlas.indirectionBuf = ctx.device.createBuffer({
      size: indirection.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, indirection);
  }
  if (toCapacity > atlas.capacity) {
    // A slot's place depends on `slotsX` and `slotsY` alone, which never
    // change, and the slots held come first, so the old texture copies into
    // the new one's front and every cell keeps its slot.
    const old = atlas.texture;
    const texture = watchedTexture(ctx, atlases, atlas, toCapacity, () => atlas);
    const encoder = ctx.device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: old }, { texture }, texelExtent(atlas, atlas.capacity));
    ctx.device.queue.submit([encoder.finish()]);
    // Destruction waits for the copy just submitted.
    old.destroy();
    atlas.texture = texture;
    atlas.lineage.add(texture);
    addSlots(atlas, toCapacity);
  }
  noteBytes(atlases);
  return true;
}

/** Add the slots up to `toCapacity`, lowest on top of the free stack. */
function addSlots(atlas: OverviewAtlas, toCapacity: number): void {
  const added: number[] = [];
  for (let slot = toCapacity - 1; slot >= atlas.capacity; slot--) added.push(slot);
  atlas.freeSlots = [...added, ...atlas.freeSlots];
  atlas.capacity = toCapacity;
}

/** The texture's extent in texels when it holds the first `capacity` slots of `shape`'s layout. */
function texelExtent(shape: Layout & Pick<OverviewAtlas, "slotDims">, capacity: number): Dims {
  const [sx, sy, sz] = slotExtent(shape, capacity);
  const [x, y, z] = shape.slotDims;
  return [sx * x, sy * y, sz * z];
}

/**
 * A texture holding the first `capacity` of `shape`'s slots, for the atlas
 * `owner` names. If the device cannot allocate it, or any texture the atlas's
 * texels passed through, the atlas goes with every overview it holds. Under a
 * halved total the page sends them again; at the floor they would only fail
 * again, so they are refused.
 */
function watchedTexture(
  ctx: WorkerCtx,
  atlases: OverviewAtlases,
  shape: Layout & Pick<OverviewAtlas, "slotDims" | "format">,
  capacity: number,
  owner: () => OverviewAtlas,
): GPUTexture {
  return allocateWatched(
    ctx,
    () => ctx.device.createTexture({
      size: texelExtent(shape, capacity),
      format: atlasTextureFormat(shape.format),
      dimension: "3d",
      usage: chunkPoolUsage(),
    }),
    (lost) => {
      const atlas = owner();
      if (!atlas.lineage.has(lost) || atlases.byKey.get(atlas.key) !== atlas) return;
      const lostOverviews = [...atlas.overviews];
      removeAtlas(atlases, atlas);
      if (handleGpuOutOfMemory(ctx)) {
        ctx.post({ type: "minimapOverviewsLost", memberIds: lostOverviews.map((overview) => overview.key) });
      } else {
        for (const overview of lostOverviews) {
          ctx.state.overviewsRefused.set(overview.key, {
            selection: overviewSelection({ ...overview, format: atlas.format }),
            datasetId: atlas.datasetId,
            imageId: overview.imageId,
          });
        }
      }
    },
  );
}
