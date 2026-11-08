/**
 * The render worker's one GPU budget. Every holder counts against a total
 * fitted to the device: chunk, label, and proxy pools, the viewport's render
 * targets, and the minimap's textures.
 *
 * Chunk pools start one row or layer deep and grow while the total has room,
 * so slots the planner no longer wants stay resident as fallback for as long
 * as nothing else needs the bytes. When the total is reached:
 *
 *   1. a full pool takes the slot of a chunk the planner doesn't want, its own
 *      first (`findEvictionSlot`);
 *   2. a pool holding only wanted chunks may grow by taking bytes back from
 *      other pools, which shrink to the layers their wanted chunks need;
 *   3. otherwise it evicts its farthest wanted chunk for a nearer one, and
 *      refuses the rest (`atlas-policy`), so the view covers less and the
 *      readout shows the total at its budget.
 *
 * A device that runs out of memory under the total halves it, down to the
 * floor, and the pools give back what it no longer covers.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { GpuCapacityReport, GpuMemoryReport, GpuPoolCapacity } from "../workerProtocol.ts";
import type { RendererState } from "./state.ts";
import { halvedGpuTotal } from "../../deviceBudget.ts";
import { getDeviceLimits } from "../gpuContext.ts";
import { poolCapBytes } from "../atlasSizing.ts";
import { bytesPerTexel } from "../dataTypeUtil.ts";
import {
  labelVolumePoolBytes,
  shrinkVolumeAtlas,
  volumeAtlasBytes,
  volumeLayerBytes,
  type AtlasState,
} from "../volume/atlas.ts";
import {
  labelSlicePoolBytes,
  shrinkSliceAtlas,
  sliceAtlasBytes,
  sliceRowBytes,
  type SliceAtlasState,
} from "../slice/atlas.ts";
import { volumeEvictionParams } from "../volume/eviction.ts";
import { sliceEvictionParams } from "../slice/eviction.ts";
import { rankSlotsToKeep } from "../eviction.ts";
import { postSlotsLost } from "../chunkUploadFeedback.ts";
import { chunkPoolTier } from "../poolKeys.ts";
import { parseCompositeKey } from "../chunkKeys.ts";
import { wantedChunksFor } from "../wantedChunks.ts";
import { gpuLedgerLine } from "./gpuLedger.ts";

/** Bytes one `r16uint` proxy texel holds. */
const PROXY_BYTES_PER_TEXEL = 2;

/** What every holder has on the GPU now, against the total. */
export function measureGpuMemory(state: RendererState): GpuMemoryReport {
  let chunkBytes = 0;
  let atlases = 0;
  let slots = 0;
  let slotsHeld = 0;
  for (const atlas of state.volumeAtlases.values()) {
    chunkBytes += volumeAtlasBytes(atlas);
    slots += atlas.totalSlots;
    slotsHeld += atlas.slots.size;
    atlases++;
  }
  for (const atlas of state.sliceAtlases.values()) {
    chunkBytes += sliceAtlasBytes(atlas);
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
  let proxyBytes = 0;
  for (const pools of state.proxyPoolsByDataset.values()) {
    for (const pool of pools.values()) {
      const [dz, dy, dx] = pool.slotDims;
      proxyBytes += pool.slotsX * dx * pool.slotsY * dy * pool.slotsZ * dz * PROXY_BYTES_PER_TEXEL;
      atlases++;
    }
  }
  const targetBytes = gpuLedgerLine("viewportTargets") + gpuLedgerLine("depth");
  const minimapBytes = gpuLedgerLine("minimapTextures") + gpuLedgerLine("minimapTargets");
  return {
    budgetBytes: state.gpuTotalBytes,
    bytes: chunkBytes + labelBytes + proxyBytes + targetBytes + minimapBytes,
    chunkBytes,
    labelBytes,
    proxyBytes,
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
  const last = ctx.state.gpuMemoryPosted ?? { ...report, bytes: 0, chunkBytes: 0, labelBytes: 0, proxyBytes: 0,
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
  if (state.volumeAtlases.size + state.sliceAtlases.size === 0) {
    return { budgetBytes: state.gpuTotalBytes, reservedBytes: memory.bytes - memory.chunkBytes, pools };
  }
  // A halved total lowers what a pool made before it may grow to.
  const cap = poolCapBytes(getDeviceLimits(ctx.device), state.gpuTotalBytes);
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
  return { budgetBytes: state.gpuTotalBytes, reservedBytes: memory.bytes - memory.chunkBytes, pools };
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
interface Spare {
  poolKey: string;
  atlas: AtlasState | SliceAtlasState;
  kind: "volume" | "slice";
  stepBytes: number;
  /** Rows or layers now. */
  steps: number;
  /** The fewest rows or layers that still hold every chunk the planner wants. */
  minSteps: number;
}

/**
 * Shrink chunk pools other than `except` until `needed` bytes are free or
 * none can give more: the pool with the most to spare first, each down to the
 * rows or layers its wanted chunks need. What a pool drops is reported
 * evicted, since it went to make room.
 */
function reclaimGpuBytes(ctx: WorkerCtx, needed: number, except?: AtlasState | SliceAtlasState): void {
  const state = ctx.state;
  const spares: Spare[] = [];
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
  spares.sort((a, b) => (b.steps - b.minSteps) * b.stepBytes - (a.steps - a.minSteps) * a.stepBytes);

  const touched = new Set<string>();
  for (const spare of spares) {
    if (needed <= 0) break;
    const freeSteps = Math.min(spare.steps - spare.minSteps, Math.ceil(needed / spare.stepBytes));
    const tier = chunkPoolTier(spare.poolKey);
    let dropped: string[];
    if (spare.kind === "volume") {
      const atlas = spare.atlas as AtlasState;
      const keep = rankSlotsToKeep(volumeEvictionParams(state, atlas, tier)).map((slot) => slot.key);
      dropped = shrinkVolumeAtlas(ctx.device, atlas, spare.steps - freeSteps, keep);
    } else {
      const atlas = spare.atlas as SliceAtlasState;
      const keep = rankSlotsToKeep(sliceEvictionParams(state, atlas, tier)).map((slot) => slot.key);
      dropped = shrinkSliceAtlas(ctx.device, atlas, spare.steps - freeSteps, keep);
    }
    postSlotsLost(ctx, tier, dropped, "evicted");
    needed -= freeSteps * spare.stepBytes;
    touched.add(spare.atlas.datasetId);
  }
  // A dropped fallback slot can change the level an entity displays.
  for (const datasetId of touched) ctx.postWantedSet(datasetId);
}

function spareOf(
  state: RendererState,
  poolKey: string,
  atlas: AtlasState | SliceAtlasState,
  kind: "volume" | "slice",
): Spare | null {
  const tier = chunkPoolTier(poolKey);
  let wanted = 0;
  for (const key of atlas.slots.keys()) {
    const parsed = parseCompositeKey(key);
    if (parsed && wantedChunksFor(state, parsed.memberId, tier)?.has(parsed.chunkKey)) wanted++;
  }
  const volume = kind === "volume" ? (atlas as AtlasState) : null;
  const slice = kind === "slice" ? (atlas as SliceAtlasState) : null;
  const steps = volume ? volume.slotsZ : slice!.slotsY;
  const stepSlots = volume ? volume.slotsX * volume.slotsY : slice!.slotsX;
  const minSteps = Math.max(1, Math.ceil(wanted / stepSlots));
  if (minSteps >= steps) return null;
  const stepBytes = volume ? volumeLayerBytes(volume) : sliceRowBytes(slice!);
  return { poolKey, atlas, kind, stepBytes, steps, minSteps };
}
