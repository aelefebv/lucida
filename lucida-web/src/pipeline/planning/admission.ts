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
import { decodedBytesPerSample } from "../../renderer/dataTypeUtil.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { ChunkRequest } from "./types.ts";

/** Bytes, or chunk counts, per residency tier. */
export type PerTier = Record<ResidencyTier, number>;

/** One dataset's plan, and what its chunks cost. */
export interface PlanToAdmit {
  /** The plan's requests, in priority order. */
  requests: readonly ChunkRequest[];
  /** What one resident chunk of a request costs. */
  bytesOf: (req: ChunkRequest) => number;
  /** The GPU slot pool a request's chunk lands in, or null for a lane that never uploads. */
  slotOf?: (req: ChunkRequest) => GpuSlot | null;
}

export interface Admission {
  /** The admitted requests, in the order they arrived. */
  admitted: ChunkRequest[];
  /**
   * Requests of the view's own lanes that did not fit, per tier. Prefetch
   * is speculative, so a prefetch request that does not fit is dropped
   * without counting against the view's coverage.
   */
  shortfall: PerTier;
  /** Bytes the coarse tier took beyond its own capacity, from detail's room. */
  borrowed: number;
}

/**
 * Admit every dataset's plan into one `capacity`, and into `gpuRoom`, the
 * bytes the render worker's chunk pools may hold between them. Returns one
 * admission per plan, in the order given.
 *
 * The view's detail requests go first, across every plan. The coarse tier
 * goes next: it is a fallback and takes only the room detail leaves, so the
 * coarse floor grows with the layout instead of stopping at a fixed size
 * while detail room sits empty. Prefetch goes last, into what the view
 * leaves, because the coarse tier borrows from the detail tier's room
 * before prefetch may. Each pass takes requests in priority order.
 *
 * Two requests for one chunk of one tier, such as the coarse and minimap
 * lanes asking for the same chunk, are admitted or refused together and
 * charged once.
 */
export function admitPlans(
  plans: readonly PlanToAdmit[],
  capacity: Readonly<PerTier>,
  gpuRoom: number = Infinity,
): Admission[] {
  const used: PerTier = { detail: 0, coarse: 0 };
  const slotsUsed = new Map<string, number>();
  let gpuUsed = 0;
  const states = plans.map((plan) => ({
    plan,
    admitted: new Set<ChunkRequest>(),
    // Chunks charged to a tier, and chunks its room refused. A chunk is held
    // once in the CPU cache however many lanes ask for it.
    charged: new Set<string>(),
    noRoom: new Set<string>(),
    shortfall: { detail: 0, coarse: 0 } as PerTier,
    borrowed: 0,
  }));

  const admit = (
    state: (typeof states)[number],
    tier: ResidencyTier,
    room: number,
    take: (req: ChunkRequest) => boolean,
  ): void => {
    const { plan, admitted, charged, noRoom, shortfall } = state;
    const short = (req: ChunkRequest): void => {
      if (req.lane !== "prefetch") shortfall[req.tier]++;
    };
    for (const req of plan.requests) {
      if (req.tier !== tier || !take(req)) continue;
      // The tiers hold their own copies, so one key is charged once per tier.
      const key = `${tier}/${req.entityId}/${req.chunkKey}`;
      if (noRoom.has(key)) continue;
      // A full slot pool refuses this lane's upload, not the chunk: a lane
      // that never uploads, such as the minimap, can still hold it.
      const slot = plan.slotOf?.(req) ?? null;
      if (slot && ((slotsUsed.get(slot.pool) ?? 0) >= slot.slots || gpuUsed + slot.slotBytes > gpuRoom)) {
        short(req);
        continue;
      }
      if (!charged.has(key)) {
        const bytes = plan.bytesOf(req);
        if (used[tier] + bytes > room) {
          noRoom.add(key);
          short(req);
          continue;
        }
        used[tier] += bytes;
        charged.add(key);
      }
      if (slot) {
        slotsUsed.set(slot.pool, (slotsUsed.get(slot.pool) ?? 0) + 1);
        gpuUsed += slot.slotBytes;
      }
      admitted.add(req);
    }
  };

  const speculative = (req: ChunkRequest): boolean => req.lane === "prefetch";
  for (const state of states) admit(state, "detail", capacity.detail, (req) => !speculative(req));
  const coarseRoom = capacity.coarse + Math.max(0, capacity.detail - used.detail);
  for (const state of states) {
    const loanBefore = Math.max(0, used.coarse - capacity.coarse);
    admit(state, "coarse", coarseRoom, () => true);
    state.borrowed = Math.max(0, used.coarse - capacity.coarse) - loanBefore;
  }
  const borrowed = Math.max(0, used.coarse - capacity.coarse);
  for (const state of states) admit(state, "detail", capacity.detail - borrowed, speculative);

  return states.map((state) => ({
    admitted: state.plan.requests.filter((req) => state.admitted.has(req)),
    shortfall: state.shortfall,
    borrowed: state.borrowed,
  }));
}

/**
 * The render worker's chunk pool a chunk lands in, the slots it may hold,
 * and the bytes one slot takes of the GPU total (`gpuCapacity.ts`).
 */
export interface GpuSlot {
  pool: string;
  slots: number;
  slotBytes: number;
}

/**
 * What one resident chunk of a request costs, from the manifest: the level's
 * chunk shape, one timepoint and one channel, at the image's decoded sample
 * size, which is float32 for every type that draws as one.
 * The server serves every chunk whole at that shape, edge chunks included,
 * so this is what the cache and the GPU hold for it.
 */
export function chunkBytesFor(manifest: DatasetManifest): (req: ChunkRequest) => number {
  const byImage = new Map<string, { levels: number[]; fallback: number }>();
  for (const image of manifest.images) {
    const sample = decodedBytesPerSample(image.multiscale.data_type);
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
