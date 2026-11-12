/**
 * The render worker's one GPU budget. Every holder counts against a total
 * fitted to the device: chunk pools and each view's indirection over them,
 * label pools, the viewport's render targets, and the minimap's textures.
 *
 * Chunk pools start one row or layer deep and grow while the total has room,
 * so slots the planner no longer wants stay resident as fallback for as long
 * as nothing else needs the bytes. So do the pools of a dataset no view
 * plans, its label pools among them. When the total is reached:
 *
 *   1. a full pool takes the slot of one of its own chunks the planner
 *      doesn't want (`findEvictionSlot`);
 *   2. a pool holding only wanted chunks may grow by taking bytes back from
 *      other holders: first what datasets no view plans hold, whose label
 *      pools go whole, then other pools' fallback, each pool shrinking to
 *      the layers its wanted chunks need;
 *   3. otherwise it evicts its farthest wanted chunk for a nearer one, and
 *      refuses the rest (`atlas-policy`), so the view covers less and the
 *      readout shows the total at its budget.
 *
 * A device that runs out of memory under the total halves it, down to the
 * floor, and the pools give back what it no longer covers.
 *
 * The page admits each plan against the capacities posted here
 * (`pipeline/planning/gpuCapacity.ts`), so the wanted set fits the pools and
 * step 3 is the exception rather than the steady state.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { GpuCapacityReport, GpuMemoryReport, GpuPoolCapacity, PoolMode } from "../workerProtocol.ts";
import type { RendererState } from "./state.ts";
import { halvedGpuTotal } from "../../deviceBudget.ts";
import { getDeviceLimits } from "../gpuContext.ts";
import { poolCapBytes } from "../atlasSizing.ts";
import { bytesPerTexel } from "../dataTypeUtil.ts";
import {
  labelVolumePoolBytes,
  removeLabelVolumePool,
  shrinkVolumeAtlas,
  volumeAtlasBytes,
  volumeExtentFor,
  volumeRowBytes,
  volumeRows,
  type AtlasState,
} from "../volume/atlas.ts";
import {
  labelSlicePoolBytes,
  removeLabelSlicePool,
  shrinkSliceAtlas,
  sliceAtlasBytes,
  sliceRowBytes,
  type SliceAtlasState,
} from "../slice/atlas.ts";
import { volumeEvictionParams } from "../volume/eviction.ts";
import { sliceEvictionParams } from "../slice/eviction.ts";
import { rankSlotsToKeep } from "../eviction.ts";
import { postSlotsLost } from "../chunkUploadFeedback.ts";
import { chunkPoolTier, datasetModeKey } from "../poolKeys.ts";
import { viewIndirectionBytes } from "../viewIndirection.ts";
import { wantedCountIn } from "./draws.ts";
import { gpuLedgerLine } from "./gpuLedger.ts";


/**
 * Every chunk pool texture's usage. COPY_SRC so a pool that grows or shrinks
 * can copy its chunks into the new texture. Nothing renders to a pool, but
 * RENDER_ATTACHMENT lets the implementation zero a new texture with a clear
 * rather than by copying zeros into it from a staging buffer, which for a
 * pool of a gigabyte held the GPU for a quarter of a second at each growth.
 */
export function chunkPoolUsage(): GPUTextureUsageFlags {
  return GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.RENDER_ATTACHMENT;
}

/**
 * The slots that hold every chunk the views drawing from `atlas` want of its
 * members in its tier. A full pool grows straight to them: each growth
 * allocates a texture of the new size and copies the old one into it, so
 * doubling toward them repeats that cost. A member whose levels differ in
 * chunk shape has chunks in another pool counted too, which the GPU total
 * bounds like any growth.
 */
export function wantedSlotsOf(poolKey: string, atlas: AtlasState | SliceAtlasState): number {
  const tier = chunkPoolTier(poolKey);
  const members = new Set<string>();
  for (const view of atlas.views.values()) for (const memberId of view.entityMetas.keys()) members.add(memberId);
  let slots = 0;
  for (const memberId of members) slots += wantedCountIn(atlas, memberId, tier);
  return slots;
}

/** What every holder has on the GPU now, against the total. */
export function measureGpuMemory(state: RendererState): GpuMemoryReport {
  let chunkBytes = 0;
  let indirectionBytes = 0;
  let atlases = 0;
  let slots = 0;
  let slotsHeld = 0;
  for (const atlas of state.volumeAtlases.values()) {
    chunkBytes += volumeAtlasBytes(atlas);
    indirectionBytes += viewIndirectionBytes(atlas);
    slots += atlas.totalSlots;
    slotsHeld += atlas.slots.size;
    atlases++;
  }
  for (const atlas of state.sliceAtlases.values()) {
    chunkBytes += sliceAtlasBytes(atlas);
    indirectionBytes += viewIndirectionBytes(atlas);
    slots += atlas.totalSlots;
    slotsHeld += atlas.slots.size;
    atlases++;
  }
  let labelBytes = 0;
  for (const pool of state.labelVolumePools.values()) {
    labelBytes += labelVolumePoolBytes(pool);
    atlases++;
  }
  for (const pool of state.labelSlicePools.values()) {
    labelBytes += labelSlicePoolBytes(pool);
    atlases++;
  }

  const targetBytes = gpuLedgerLine("viewportTargets") + gpuLedgerLine("depth") + gpuLedgerLine("viewFrames");
  const minimapBytes = gpuLedgerLine("minimapTextures") + gpuLedgerLine("minimapTargets");
  return {
    budgetBytes: state.gpuTotalBytes,
    bytes: chunkBytes + labelBytes + targetBytes + minimapBytes,
    chunkBytes,
    indirectionBytes,
    labelBytes,
    targetBytes,
    minimapBytes,
    atlases,
    slotsHeld,
    slots,
    overviewsRefused: state.overviewsRefused.size,
  };
}

/**
 * Post the memory report when any number differs from the last one posted.
 * The dispatcher checks after cold states, removals, and frames rather than
 * after each upload: an upload that grows or fills a pool always leads to a
 * frame.
 */
export function postGpuMemoryIfChanged(ctx: WorkerCtx): void {
  const report = measureGpuMemory(ctx.state);
  // Until the first report the page knows of nothing held, which a worker
  // holding nothing has no reason to repeat.
  const last = ctx.state.gpuMemoryPosted ?? { ...report, bytes: 0, chunkBytes: 0, indirectionBytes: 0, labelBytes: 0,
    targetBytes: 0, minimapBytes: 0, atlases: 0, slotsHeld: 0, slots: 0, overviewsRefused: 0 };
  if (!(Object.keys(report) as Array<keyof GpuMemoryReport>).every((key) => last[key] === report[key])) {
    ctx.state.gpuMemoryPosted = report;
    ctx.post({ type: "gpuMemory", ...report });
  }
  const capacity = measureGpuCapacity(ctx, report);
  const signature = JSON.stringify(capacity);
  const unposted = ctx.state.gpuCapacityPosted === null && capacity.pools.length === 0 && capacity.reservedBytes === 0;
  if (!unposted && signature !== ctx.state.gpuCapacityPosted) {
    ctx.state.gpuCapacityPosted = signature;
    ctx.post({ type: "gpuCapacity", ...capacity });
  }
}

/** Each chunk pool's slots now and at its cap, and what the total leaves them. */
export function measureGpuCapacity(ctx: WorkerCtx, memory: GpuMemoryReport = measureGpuMemory(ctx.state)): GpuCapacityReport {
  const state = ctx.state;
  const pools: GpuPoolCapacity[] = [];
  const limits = getDeviceLimits(ctx.device);
  let reservedBytes = memory.bytes - memory.chunkBytes;
  for (const spare of unplannedLabelPools(state)) reservedBytes -= spare.bytes;
  if (state.volumeAtlases.size + state.sliceAtlases.size === 0) {
    return { budgetBytes: state.gpuTotalBytes, reservedBytes, pools, limits };
  }
  // A halved total lowers what a pool made before it may grow to.
  const cap = poolCapBytes(limits, state.gpuTotalBytes);
  for (const [poolKey, atlas] of state.volumeAtlases) {
    const slotBytes = atlas.chunkX * atlas.chunkY * atlas.chunkZ * bytesPerTexel(atlas.format);
    pools.push({
      poolKey,
      datasetId: atlas.datasetId,
      tier: chunkPoolTier(poolKey),
      slotBytes,
      slots: atlas.totalSlots,
      maxSlots: Math.max(atlas.totalSlots, Math.min(atlas.slotsX * atlas.slotsY * atlas.maxSlotsZ, Math.floor(cap / slotBytes))),
    });
  }
  for (const [poolKey, atlas] of state.sliceAtlases) {
    const slotBytes = atlas.chunkX * atlas.chunkY * bytesPerTexel(atlas.format);
    pools.push({
      poolKey,
      datasetId: atlas.datasetId,
      tier: chunkPoolTier(poolKey),
      slotBytes,
      slots: atlas.totalSlots,
      maxSlots: Math.max(atlas.totalSlots, Math.min(atlas.slotsX * atlas.maxSlotsY, Math.floor(cap / slotBytes))),
    });
  }
  return { budgetBytes: state.gpuTotalBytes, reservedBytes, pools, limits };
}

/** Bytes the total has left, negative when it is overspent. */
export function gpuBytesFree(state: RendererState): number {
  return state.gpuTotalBytes - measureGpuMemory(state).bytes;
}

/**
 * Whether `bytes` more fit the total, after taking back from the chunk pools
 * other than `requester` what they hold beyond the planner's wanted chunks.
 */
export function reserveGpuBytes(
  ctx: WorkerCtx,
  bytes: number,
  requester?: AtlasState | SliceAtlasState,
): boolean {
  const short = bytes - gpuBytesFree(ctx.state);
  if (short <= 0) return true;
  reclaimGpuBytes(ctx, short, requester);
  return bytes <= gpuBytesFree(ctx.state);
}

/**
 * Steps of `stepBytes` a pool may grow by now, at most `maxSteps`: as many as
 * the total has room for. With `reclaim`, one step even when it has none, if
 * other pools can give the bytes back from chunks the planner doesn't want.
 */
export function grantGrowth(
  ctx: WorkerCtx,
  requester: AtlasState | SliceAtlasState,
  stepBytes: number,
  maxSteps: number,
  reclaim: boolean,
): number {
  if (maxSteps < 1 || stepBytes <= 0) return 0;
  const steps = Math.min(maxSteps, Math.floor(gpuBytesFree(ctx.state) / stepBytes));
  if (steps >= 1) return steps;
  return reclaim && reserveGpuBytes(ctx, stepBytes, requester) ? 1 : 0;
}

/**
 * The device ran out of memory under the total: halve it, down to the floor,
 * and have the pools give back what it no longer covers. False when it was
 * already at the floor, so the caller doesn't try the same allocation again.
 */
export function handleGpuOutOfMemory(ctx: WorkerCtx): boolean {
  const before = ctx.state.gpuTotalBytes;
  ctx.state.gpuTotalBytes = halvedGpuTotal(before);
  const over = -gpuBytesFree(ctx.state);
  if (over > 0) reclaimGpuBytes(ctx, over);
  return ctx.state.gpuTotalBytes < before;
}

/** A chunk pool that could shrink, and by how much. */
interface PoolSpare {
  poolKey: string;
  atlas: AtlasState | SliceAtlasState;
  kind: "volume" | "slice";
  stepBytes: number;
  /** Rows now. */
  steps: number;
  /** The fewest rows that still hold every chunk the planner wants. */
  minSteps: number;
}

/** A label pool of a dataset no view plans. It holds one form whole, so it goes whole. */
interface LabelSpare {
  poolKey: string;
  kind: "label";
  mode: PoolMode;
  datasetId: string;
  bytes: number;
}

type Spare = PoolSpare | LabelSpare;

function spareBytes(spare: Spare): number {
  return spare.kind === "label" ? spare.bytes : (spare.steps - spare.minSteps) * spare.stepBytes;
}

function spareDataset(spare: Spare): string {
  return spare.kind === "label" ? spare.datasetId : spare.atlas.datasetId;
}

/** The label pools of datasets no view plans: each gives its bytes back whole. */
function* unplannedLabelPools(state: RendererState): Generator<LabelSpare> {
  const unplanned = state.unplannedDatasets;
  for (const [poolKey, pool] of state.labelSlicePools) {
    if (!unplanned.has(pool.datasetId)) continue;
    yield { poolKey, kind: "label", mode: "slice", datasetId: pool.datasetId, bytes: labelSlicePoolBytes(pool) };
  }
  for (const [poolKey, pool] of state.labelVolumePools) {
    if (!unplanned.has(pool.datasetId)) continue;
    yield { poolKey, kind: "label", mode: "volume", datasetId: pool.datasetId, bytes: labelVolumePoolBytes(pool) };
  }
}

/**
 * Take bytes back from holders other than `except` until `needed` bytes are
 * free or none can give more. What datasets no view plans hold goes before
 * the fallback of a dataset on screen, and within each the holder with the
 * most to spare goes first. A chunk pool shrinks to the rows or layers its
 * wanted chunks need, and an unplanned dataset's label pool goes whole.
 * What a holder drops is reported evicted, since it went to make room.
 */
function reclaimGpuBytes(ctx: WorkerCtx, needed: number, except?: AtlasState | SliceAtlasState): void {
  const state = ctx.state;
  const spares: Spare[] = [...unplannedLabelPools(state)];
  for (const [poolKey, atlas] of state.volumeAtlases) {
    if (atlas === except) continue;
    const spare = spareOf(state, poolKey, atlas, "volume");
    if (spare) spares.push(spare);
  }
  for (const [poolKey, atlas] of state.sliceAtlases) {
    if (atlas === except) continue;
    const spare = spareOf(state, poolKey, atlas, "slice");
    if (spare) spares.push(spare);
  }
  const unplanned = (spare: Spare) => (state.unplannedDatasets.has(spareDataset(spare)) ? 1 : 0);
  spares.sort((a, b) => unplanned(b) - unplanned(a) || spareBytes(b) - spareBytes(a));

  const touched = new Map<string, { datasetId: string; mode: PoolMode }>();
  for (const spare of spares) {
    if (needed <= 0) break;
    if (spare.kind === "label") {
      if (spare.mode === "slice") removeLabelSlicePool(ctx, spare.poolKey, "evicted");
      else removeLabelVolumePool(ctx, spare.poolKey, "evicted");
      needed -= spare.bytes;
      continue;
    }
    let freeSteps = Math.min(spare.steps - spare.minSteps, Math.ceil(needed / spare.stepBytes));
    const tier = chunkPoolTier(spare.poolKey);
    let dropped: string[];
    if (spare.kind === "volume") {
      const atlas = spare.atlas as AtlasState;
      // Past its first layer a pool gives back whole layers: as many as
      // free what is needed, short of the rows its wanted chunks need.
      const rows = spare.steps - freeSteps;
      const kept = rows > atlas.slotsY ? Math.floor(rows / atlas.slotsY) * atlas.slotsY : rows;
      freeSteps = spare.steps - Math.max(spare.minSteps, kept);
      if (freeSteps <= 0) continue;
      const keep = rankSlotsToKeep(volumeEvictionParams(state, atlas, tier)).map((slot) => slot.key);
      dropped = shrinkVolumeAtlas(ctx.device, atlas, spare.steps - freeSteps, keep);
    } else {
      const atlas = spare.atlas as SliceAtlasState;
      const keep = rankSlotsToKeep(sliceEvictionParams(state, atlas, tier)).map((slot) => slot.key);
      dropped = shrinkSliceAtlas(ctx.device, atlas, spare.steps - freeSteps, keep);
    }
    postSlotsLost(ctx, spare.kind, tier, dropped, "evicted", "axis" in spare.atlas ? spare.atlas.axis : undefined);
    needed -= freeSteps * spare.stepBytes;
    const { datasetId } = spare.atlas;
    touched.set(datasetModeKey(datasetId, spare.kind), { datasetId, mode: spare.kind });
  }
  // A dropped fallback slot can change the level an entity displays.
  for (const { datasetId, mode } of touched.values()) ctx.postWantedSet(datasetId, mode);
}

function spareOf(
  state: RendererState,
  poolKey: string,
  atlas: AtlasState | SliceAtlasState,
  kind: "volume" | "slice",
): PoolSpare | null {
  const tier = chunkPoolTier(poolKey);
  // Both kinds give back rows: a slice pool's, and a volume pool's in its
  // first layer and whole layers past it.
  const volume = kind === "volume" ? (atlas as AtlasState) : null;
  const slice = kind === "slice" ? (atlas as SliceAtlasState) : null;
  // A full pool asks for room on every chunk it can't place, so the count
  // comes from the order rather than from reading every slot.
  const params = volume ? volumeEvictionParams(state, volume, tier) : sliceEvictionParams(state, slice!, tier);
  const wanted = atlas.order.wantedHeld(params);
  const steps = volume ? volumeRows(volume) : slice!.slotsY;
  const stepSlots = volume ? volume.slotsX : slice!.slotsX;
  const wantedSteps = Math.max(1, Math.ceil(wanted / stepSlots));
  const minSteps = volume ? extentRows(volume, wantedSteps) : wantedSteps;
  if (minSteps >= steps) return null;
  const stepBytes = volume ? volumeRowBytes(volume) : sliceRowBytes(slice!);
  return { poolKey, atlas, kind, stepBytes, steps, minSteps };
}

/** The rows a volume pool holds once sized to hold `rows` rows. */
function extentRows(atlas: AtlasState, rows: number): number {
  const { rowsY, slotsZ } = volumeExtentFor(atlas, rows);
  return rowsY + (slotsZ - 1) * atlas.slotsY;
}
