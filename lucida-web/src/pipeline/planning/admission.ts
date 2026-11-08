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
 * resident chunk of a request costs.
 *
 * Two requests for one chunk of one tier, such as the coarse and minimap
 * lanes asking for the same chunk, are admitted or refused together and
 * charged once.
 */
export function admitRequests(
  requests: readonly ChunkRequest[],
  capacity: Readonly<PerTier>,
  bytesOf: (req: ChunkRequest) => number,
): Admission {
  const admittedKeys = new Set<string>();
  const refusedKeys = new Set<string>();
  const shortfall: PerTier = { detail: 0, coarse: 0 };
  const used: PerTier = { detail: 0, coarse: 0 };

  const admitTier = (tier: ResidencyTier, room: number): void => {
    for (const req of requests) {
      if (req.tier !== tier) continue;
      const key = `${req.entityId}/${req.chunkKey}`;
      if (admittedKeys.has(`${tier}/${key}`) || refusedKeys.has(`${tier}/${key}`)) continue;
      const bytes = bytesOf(req);
      if (used[tier] + bytes <= room) {
        used[tier] += bytes;
        admittedKeys.add(`${tier}/${key}`);
      } else {
        refusedKeys.add(`${tier}/${key}`);
        if (req.lane !== "prefetch") shortfall[tier]++;
      }
    }
  };

  admitTier("detail", capacity.detail);
  const detailLeft = Math.max(0, capacity.detail - used.detail);
  admitTier("coarse", capacity.coarse + detailLeft);
  const borrowed = Math.max(0, used.coarse - capacity.coarse);

  return {
    admitted: requests.filter((req) => admittedKeys.has(`${req.tier}/${req.entityId}/${req.chunkKey}`)),
    shortfall,
    remaining: {
      detail: detailLeft - borrowed,
      coarse: Math.max(0, capacity.coarse - used.coarse),
    },
    borrowed,
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
