/**
 * Capacity-aware admission: the part of a plan the memory budgets hold.
 *
 * A plan's requests arrive in priority order. Admission walks them in that
 * order and keeps each one whose chunk fits what its residency tier has
 * left, and declares the rest as the plan's shortfall: the coverage the view
 * goes without. Admitting only what fits is what lets a view whose demand
 * exceeds its budgets settle, covering its most important part, instead of
 * evicting one wanted chunk to make room for another forever.
 */

import type { DatasetManifest } from "../../manifestTypes.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { ChunkRequest } from "./types.ts";
import { computeAtlasGeometry } from "../../renderer/atlasSizing.ts";

/** Bytes, or chunk counts, per residency tier. */
export type PerTier = Record<ResidencyTier, number>;

export interface Admission {
  /** The admitted requests, in the order they arrived. */
  admitted: ChunkRequest[];
  /**
   * Requests of the view's own lanes that did not fit, per tier. Prefetch
   * is speculative, so a prefetch request that does not fit is dropped
   * without counting against the view's coverage.
   */
  shortfall: PerTier;
  /** What each tier has left for the next dataset's plan. */
  remaining: PerTier;
  /** Bytes the coarse tier took beyond its own capacity, from detail's room. */
  borrowed: number;
}

/**
 * Admit `requests` into `capacity`, in order. The detail tier is admitted
 * first, so that the coarse tier, which is a fallback, takes only the room
 * detail leaves: the coarse floor grows with the layout instead of stopping
 * at a fixed size while detail room sits empty. `bytesOf` is what one
 * resident chunk of a request costs, and `slotOf` the GPU slot pool it lands
 * in, when that pool has a fixed size.
 *
 * Two requests for one chunk of one tier, such as the coarse and minimap
 * lanes asking for the same chunk, are admitted or refused together and
 * charged once.
 */
export function admitRequests(
  requests: readonly ChunkRequest[],
  capacity: Readonly<PerTier>,
  bytesOf: (req: ChunkRequest) => number,
  slotOf: (req: ChunkRequest) => GpuSlot | null = () => null,
): Admission {
  const admitted = new Set<ChunkRequest>();
  // Chunks charged to a tier, and chunks its room refused. A chunk is held
  // once in the CPU cache however many lanes ask for it.
  const charged = new Set<string>();
  const noRoom = new Set<string>();
  const shortfall: PerTier = { detail: 0, coarse: 0 };
  const used: PerTier = { detail: 0, coarse: 0 };
  const slotsUsed = new Map<string, number>();
  const short = (req: ChunkRequest): void => {
    if (req.lane !== "prefetch") shortfall[req.tier]++;
  };

  const admitTier = (tier: ResidencyTier, room: number): void => {
    for (const req of requests) {
      if (req.tier !== tier) continue;
      // The tiers hold their own copies, so one key is charged once per tier.
      const key = `${tier}/${req.entityId}/${req.chunkKey}`;
      if (noRoom.has(key)) continue;
      // A full slot pool refuses this lane's upload, not the chunk: a lane
      // that never uploads, such as the minimap, can still hold it.
      const slot = slotOf(req);
      if (slot && (slotsUsed.get(slot.pool) ?? 0) >= slot.slots) {
        short(req);
        continue;
      }
      if (!charged.has(key)) {
        const bytes = bytesOf(req);
        if (used[tier] + bytes > room) {
          noRoom.add(key);
          short(req);
          continue;
        }
        used[tier] += bytes;
        charged.add(key);
      }
      if (slot) slotsUsed.set(slot.pool, (slotsUsed.get(slot.pool) ?? 0) + 1);
      admitted.add(req);
    }
  };

  admitTier("detail", capacity.detail);
  const detailLeft = Math.max(0, capacity.detail - used.detail);
  admitTier("coarse", capacity.coarse + detailLeft);
  const borrowed = Math.max(0, used.coarse - capacity.coarse);

  return {
    admitted: requests.filter((req) => admitted.has(req)),
    shortfall,
    remaining: {
      detail: detailLeft - borrowed,
      coarse: Math.max(0, capacity.coarse - used.coarse),
    },
    borrowed,
  };
}

/** The render worker's slot pool a chunk lands in, and how many slots it has. */
export interface GpuSlot {
  pool: string;
  slots: number;
}

/**
 * Where each request's chunk goes on the GPU, for a slice view: one pool
 * per dataset, tier, channel and chunk plane, sized as the worker sizes it
 * from the slice atlas budget. The worker's device can only have larger
 * texture limits than the WebGPU minimums used here, which leave a budget-
 * bound pool the same size. Prefetch and minimap chunks never enter these
 * pools, and a volume's pools grow as chunks arrive, so neither is counted.
 */
export function sliceSlotsFor(
  manifest: DatasetManifest,
  sliceAtlasBytes: number,
): (req: ChunkRequest) => GpuSlot | null {
  const limits = { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxStorageBufferBindingSize: 0, maxBufferSize: 0 };
  const planes = new Map<string, Map<number, [number, number]>>();
  for (const image of manifest.images) {
    const byLevel = new Map<number, [number, number]>();
    for (const level of image.multiscale.levels) {
      const [, , , y, x] = level.chunk_shape;
      byLevel.set(level.level_index, [x, y]);
    }
    planes.set(image.image_id, byLevel);
  }
  const slotsByPlane = new Map<string, number>();
  return (req) => {
    if (req.lane !== "detail" && req.lane !== "coarse") return null;
    const plane = planes.get(req.imageId)?.get(req.level);
    if (!plane) return null;
    const dims = `${plane[0]}x${plane[1]}`;
    let slots = slotsByPlane.get(dims);
    if (slots === undefined) {
      slots = computeAtlasGeometry(limits, plane, sliceAtlasBytes, "2d").totalSlots;
      slotsByPlane.set(dims, slots);
    }
    return { pool: `${req.datasetId}|${req.tier}|${req.c}|${dims}`, slots };
  };
}

const SAMPLE_BYTES: Record<string, number> = {
  uint8: 1,
  uint16: 2,
  uint32: 4,
  float32: 4,
  float64: 8,
};

/**
 * What one resident chunk of a request costs, from the manifest: the level's
 * chunk shape, one timepoint and one channel, at the image's sample size.
 * The server serves every chunk whole at that shape, edge chunks included,
 * so this is what the cache and the GPU hold for it.
 */
export function chunkBytesFor(manifest: DatasetManifest): (req: ChunkRequest) => number {
  const byImage = new Map<string, { levels: number[]; fallback: number }>();
  for (const image of manifest.images) {
    const sample = SAMPLE_BYTES[image.multiscale.data_type.toLowerCase()] ?? 2;
    const levels: number[] = [];
    for (const level of image.multiscale.levels) {
      const [, , z, y, x] = level.chunk_shape;
      levels[level.level_index] = z * y * x * sample;
    }
    byImage.set(image.image_id, { levels, fallback: Math.max(0, ...levels.filter(Number.isFinite)) });
  }
  return (req) => {
    const image = byImage.get(req.imageId);
    if (!image) return 0;
    return image.levels[req.level] ?? image.fallback;
  };
}
