/**
 * The GPU room a plan is admitted against, read from the render worker's
 * capacity report: which pool each request's chunk lands in, how many slots
 * that pool may hold, and what a slot costs of the bytes the GPU total leaves
 * the chunk pools. Slice and volume pools both grow toward a cap, so both are
 * counted the same way.
 *
 * A pool the worker has not made yet, as on a dataset's first plan, is sized
 * as the worker would size it, under the reported total and device limits.
 */

import type { DatasetManifest } from "../../manifestTypes.ts";
import type { GpuCapacityReport } from "../../renderer/workerProtocol.ts";
import type { DeviceLimits } from "../../renderer/gpuContext.ts";
import type { ChunkRequest } from "./types.ts";
import type { GpuSlot } from "./admission.ts";
import { computeAtlasGeometry, poolCapBytes } from "../../renderer/atlasSizing.ts";
import { chunkTierPoolKey } from "../../renderer/poolKeys.ts";
import { bytesPerTexel, datasetSampleFormat } from "../../renderer/dataTypeUtil.ts";
import { toPlaneFrame, type SpatialAxis } from "../../renderer/slicePlane.ts";

/**
 * The WebGPU minimums, for a plan made before the worker's first report. No
 * device has less, so a pool sized from these is never larger than the one
 * the worker makes, and the planner plans again once the report lets more in.
 */
const MIN_LIMITS: DeviceLimits = {
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
};

/** The bytes the chunk pools may hold between them. */
export function gpuChunkRoomBytes(report: GpuCapacityReport | null, fallbackTotalBytes: number): number {
  return report ? Math.max(0, report.budgetBytes - report.reservedBytes) : fallbackTotalBytes;
}

/**
 * Where each request's chunk goes on the GPU: into the pools of the mode of
 * the view that asked, a slice view's into the slice pools of the axis it
 * cuts, so each pool is admitted for every view that draws from it. Two
 * requests for different planes of one chunk take a slot each. Only the
 * detail and coarse lanes upload into chunk pools; prefetch and minimap
 * chunks never do.
 */
export function gpuSlotsFor(
  manifest: DatasetManifest,
  report: GpuCapacityReport | null,
  fallbackTotalBytes: number,
): (req: ChunkRequest) => GpuSlot | null {
  const reported = new Map(report?.pools.map((pool) => [pool.poolKey, pool]) ?? []);
  const texel = bytesPerTexel(datasetSampleFormat(manifest));
  const limits = report?.limits ?? MIN_LIMITS;
  const cap = poolCapBytes(limits, report?.budgetBytes ?? fallbackTotalBytes);
  const chunkDims = new Map<string, Map<number, [number, number, number]>>();
  for (const image of manifest.images) {
    const byLevel = new Map<number, [number, number, number]>();
    for (const level of image.multiscale.levels) {
      const [, , z, y, x] = level.chunk_shape;
      byLevel.set(level.level_index, [x, y, z]);
    }
    chunkDims.set(image.image_id, byLevel);
  }
  const sized = new Map<string, GpuSlot>();
  return (req) => {
    if (req.lane !== "detail" && req.lane !== "coarse") return null;
    const mode = req.mode;
    const xyzDims = chunkDims.get(req.imageId)?.get(req.level);
    if (!xyzDims) return null;
    const sliceAxis: SpatialAxis = req.cut?.axis ?? "z";
    // A slice pool's slots are the plane's chunk across and down the screen.
    const dims = mode === "volume" ? xyzDims : toPlaneFrame(xyzDims, sliceAxis).slice(0, 2);
    const pool = chunkTierPoolKey(req.datasetId, req.tier, req.c, dims, mode === "volume" ? "z" : sliceAxis);
    const known = reported.get(pool);
    if (known) return { pool, slots: known.maxSlots, slotBytes: known.slotBytes };
    let slot = sized.get(pool);
    if (!slot) {
      const geometry = computeAtlasGeometry(
        limits,
        dims as [number, number] | [number, number, number],
        cap,
        mode === "volume" ? "3d" : "2d",
        texel,
      );
      slot = { pool, slots: geometry.totalSlots, slotBytes: dims.reduce((a, b) => a * b, 1) * texel };
      sized.set(pool, slot);
    }
    return slot;
  };
}
