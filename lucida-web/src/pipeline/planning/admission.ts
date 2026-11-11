/**
 * Capacity-aware admission: the part of a plan the memory budgets hold.
 *
 * A plan's requests arrive in priority order. Admission walks them in that
 * order and keeps each one whose chunk fits what its residency tier has
 * left, and declares the rest as the plan's shortfall: the coverage the view
 * goes without. Admitting only what fits is what lets a view whose demand
 * exceeds its budgets settle, covering its most important part, instead of
 * evicting one wanted chunk to make room for another forever.
 *
 * Several views share the budgets. When they want more than the room holds,
 * each first gets a share of it weighed by its area on screen, and only what
 * the shares leave is taken in priority order. Priority alone would hand the
 * room to whichever view's requests rank first, and a volume view, which
 * wants every chunk along its depth, would leave the slice views beside it
 * nothing past their coarse tier.
 */

import type { DatasetManifest } from "../../manifestTypes.ts";
import { decodedBytesPerSample } from "../../renderer/dataTypeUtil.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { ChunkRequest } from "./types.ts";
import { planesKeySuffix } from "../fetch/contentSource.ts";
import type { SpatialAxis } from "../../renderer/slicePlane.ts";

/** Bytes, or chunk counts, per residency tier. */
export type PerTier = Record<ResidencyTier, number>;

/** One dataset's plan, and what its chunks cost. */
export interface PlanToAdmit {
  /** The plan's requests, in priority order. */
  requests: readonly ChunkRequest[];
  /** What one resident chunk of a request costs, or its whole chunk with `whole`. */
  bytesOf: (req: ChunkRequest, whole?: boolean) => number;
  /**
   * Whether the CPU cache holds a request's chunk whole. A request for some
   * of its planes is then charged the whole chunk, since the whole is what
   * stays resident to serve it.
   */
  heldWhole?: (req: ChunkRequest) => boolean;
  /** The GPU slot pool a request's chunk lands in, or null for a lane that never uploads. */
  slotOf?: (req: ChunkRequest) => GpuSlot | null;
  /**
   * The views that asked for one of the plan's detail or coarse requests,
   * when several views share the budgets. Prefetch and the minimap belong to
   * no view, and take what the views leave.
   */
  viewsOf?: (req: ChunkRequest) => readonly number[];
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
 * admission per plan, in the order given. `viewAreas` gives each view's area
 * on screen when several views share the room; see {@link fairShares}.
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
 * charged once. A request for some planes of a chunk and one for all of it
 * are charged apart, since either may be what the cache ends up holding,
 * unless the cache already holds the chunk whole: then the whole is what
 * serves the planes, and both are charged it once.
 */
export function admitPlans(
  plans: readonly PlanToAdmit[],
  capacity: Readonly<PerTier>,
  gpuRoom: number = Infinity,
  viewAreas: ReadonlyMap<number, number> = new Map(),
): Admission[] {
  const used: PerTier = { detail: 0, coarse: 0 };
  const slotsUsed = new Map<string, number>();
  let gpuUsed = 0;
  const states = plans.map((plan) => {
    // Whether each request costs its whole chunk, its charge key, and its
    // slot pool. The tiers hold their own copies, so one key is charged once
    // per tier.
    const whole = plan.requests.map((req) => req.planes === undefined || (plan.heldWhole?.(req) ?? false));
    return {
      plan,
      whole,
      keys: plan.requests.map((req, i) =>
        `${req.tier}/${req.entityId}/${req.chunkKey}${whole[i] ? "" : planesKeySuffix(req.planes, req.planeAxis)}`),
      slots: plan.requests.map((req) => plan.slotOf?.(req) ?? null),
      admitted: new Set<ChunkRequest>(),
      // Chunks charged to a tier, and chunks its room refused. A chunk is
      // held once in the CPU cache however many lanes ask for it.
      charged: new Set<string>(),
      noRoom: new Set<string>(),
      shortfall: { detail: 0, coarse: 0 } as PerTier,
      coarseBytes: 0,
    };
  });
  type State = (typeof states)[number];
  const bytesOf = (state: State, i: number): number => state.plan.bytesOf(state.plan.requests[i], state.whole[i]);
  const poolFull = (slot: GpuSlot | null): boolean =>
    slot !== null && ((slotsUsed.get(slot.pool) ?? 0) >= slot.slots || gpuUsed + slot.slotBytes > gpuRoom);
  /** Charge request `i` of `state` to its tier, its slot pool and the GPU room, and admit it. */
  const take = (state: State, i: number, bytes: number): void => {
    const req = state.plan.requests[i];
    const key = state.keys[i];
    const slot = state.slots[i];
    if (!state.charged.has(key)) {
      used[req.tier] += bytes;
      if (req.tier === "coarse") state.coarseBytes += bytes;
      state.charged.add(key);
    }
    if (slot) {
      slotsUsed.set(slot.pool, (slotsUsed.get(slot.pool) ?? 0) + 1);
      gpuUsed += slot.slotBytes;
    }
    state.admitted.add(req);
  };

  /**
   * Admit the views' shares of a tier's room, when several views want more
   * than it holds. Each view takes its own requests in priority order until
   * its share of the CPU room or of the GPU room is spent. A request two
   * views asked for counts toward the first's demand, and is charged to the
   * first with room for it; a chunk two requests share counts toward each,
   * which only overstates a demand by the few chunks views share. What the
   * shares leave, the greedy pass below takes in priority order.
   */
  const admitShares = (tier: ResidencyTier, room: number, wanted: (req: ChunkRequest) => boolean): void => {
    if (viewAreas.size < 2) return;
    const candidate = (state: State, req: ChunkRequest): boolean =>
      req.tier === tier && wanted(req) && !state.admitted.has(req);
    const cpuDemand = new Map<number, number>();
    const gpuDemand = new Map<number, number>();
    for (const state of states) {
      state.plan.requests.forEach((req, i) => {
        if (!candidate(state, req)) return;
        const view = state.plan.viewsOf?.(req)[0];
        if (view === undefined) return;
        cpuDemand.set(view, (cpuDemand.get(view) ?? 0) + bytesOf(state, i));
        gpuDemand.set(view, (gpuDemand.get(view) ?? 0) + (state.slots[i]?.slotBytes ?? 0));
      });
    }
    const cpuRoom = room - used[tier];
    const gpuLeft = gpuRoom - gpuUsed;
    if (sum(cpuDemand) <= cpuRoom && sum(gpuDemand) <= gpuLeft) return;
    const cpuShare = fairShares(cpuDemand, viewAreas, cpuRoom);
    const gpuShare = fairShares(gpuDemand, viewAreas, gpuLeft);
    const cpuSpent = new Map<number, number>();
    const gpuSpent = new Map<number, number>();
    for (const state of states) {
      state.plan.requests.forEach((req, i) => {
        if (!candidate(state, req)) return;
        const slot = state.slots[i];
        if (poolFull(slot)) return;
        const bytes = state.charged.has(state.keys[i]) ? 0 : bytesOf(state, i);
        if (used[tier] + bytes > room) return;
        const slotBytes = slot?.slotBytes ?? 0;
        const owner = (state.plan.viewsOf?.(req) ?? []).find((view) =>
          (cpuSpent.get(view) ?? 0) + bytes <= (cpuShare.get(view) ?? 0) &&
          (gpuSpent.get(view) ?? 0) + slotBytes <= (gpuShare.get(view) ?? 0));
        if (owner === undefined) return;
        cpuSpent.set(owner, (cpuSpent.get(owner) ?? 0) + bytes);
        gpuSpent.set(owner, (gpuSpent.get(owner) ?? 0) + slotBytes);
        take(state, i, bytes);
      });
    }
  };

  const admit = (state: State, tier: ResidencyTier, room: number, wanted: (req: ChunkRequest) => boolean): void => {
    const { plan, admitted, charged, noRoom, shortfall } = state;
    const short = (req: ChunkRequest): void => {
      if (req.lane !== "prefetch") shortfall[req.tier]++;
    };
    plan.requests.forEach((req, i) => {
      if (req.tier !== tier || !wanted(req) || admitted.has(req)) return;
      const key = state.keys[i];
      if (noRoom.has(key)) return;
      // A full slot pool refuses this lane's upload, not the chunk: a lane
      // that never uploads, such as the minimap, can still hold it.
      if (poolFull(state.slots[i])) {
        short(req);
        return;
      }
      const bytes = charged.has(key) ? 0 : bytesOf(state, i);
      if (used[tier] + bytes > room) {
        noRoom.add(key);
        short(req);
        return;
      }
      take(state, i, bytes);
    });
  };

  const speculative = (req: ChunkRequest): boolean => req.lane === "prefetch";
  admitShares("detail", capacity.detail, (req) => !speculative(req));
  for (const state of states) admit(state, "detail", capacity.detail, (req) => !speculative(req));
  const coarseRoom = capacity.coarse + Math.max(0, capacity.detail - used.detail);
  admitShares("coarse", coarseRoom, () => true);
  for (const state of states) admit(state, "coarse", coarseRoom, () => true);
  const borrowed = Math.max(0, used.coarse - capacity.coarse);
  for (const state of states) admit(state, "detail", capacity.detail - borrowed, speculative);

  // What each plan's coarse chunks took beyond the coarse tier's own room,
  // its charges counted after the plans before it.
  let coarseSoFar = 0;
  return states.map((state) => {
    const loanBefore = Math.max(0, coarseSoFar - capacity.coarse);
    coarseSoFar += state.coarseBytes;
    return {
      admitted: state.plan.requests.filter((req) => state.admitted.has(req)),
      shortfall: state.shortfall,
      borrowed: Math.max(0, coarseSoFar - capacity.coarse) - loanBefore,
    };
  });
}

/**
 * Divide `room` among claims in proportion to their weights, max-min fair: a
 * claim that wants less than its share takes only what it wants, and what it
 * leaves is divided again among the rest.
 *
 * A view's weight is its area on screen, so it gets room for what it can
 * show, however much it asks for. Room in proportion to what each view asks
 * for would favour a volume view, which asks for every chunk along its
 * depth, and a fixed floor per view would be a guess at what a view needs.
 */
export function fairShares(
  demand: ReadonlyMap<number, number>,
  weights: ReadonlyMap<number, number>,
  room: number,
): Map<number, number> {
  const shares = new Map<number, number>();
  const weightOf = (view: number): number => Math.max(weights.get(view) ?? 0, 0);
  let open = [...demand].filter(([, wants]) => wants > 0);
  let left = Math.max(0, room);
  while (open.length > 0) {
    const total = open.reduce((sum, [view]) => sum + weightOf(view), 0);
    const shareOf = (view: number): number => (total > 0 ? (left * weightOf(view)) / total : left / open.length);
    const met = open.filter(([view, wants]) => wants <= shareOf(view));
    if (met.length === 0) {
      for (const [view] of open) shares.set(view, shareOf(view));
      break;
    }
    for (const [view, wants] of met) {
      shares.set(view, wants);
      left -= wants;
    }
    open = open.filter((claim) => !met.includes(claim));
  }
  return shares;
}

function sum(values: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
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
 * so this is what the cache and the GPU hold for it. A request for some of
 * a chunk's planes costs those planes. A label's chunks are priced too,
 * though admission never sees them, since the bytes a fetch holds in flight
 * are charged at this price. With `whole`, a request for planes costs its
 * whole chunk.
 */
export function chunkBytesFor(manifest: DatasetManifest): (req: ChunkRequest, whole?: boolean) => number {
  const byImage = new Map<string, { levels: number[]; depths: Record<SpatialAxis, number>[]; fallback: number }>();
  for (const image of [...manifest.images, ...(manifest.labels ?? []).map((label) => label.image)]) {
    const sample = decodedBytesPerSample(image.multiscale.data_type);
    const levels: number[] = [];
    const depths: Record<SpatialAxis, number>[] = [];
    for (const level of image.multiscale.levels) {
      const [, , z, y, x] = level.chunk_shape;
      levels[level.level_index] = z * y * x * sample;
      depths[level.level_index] = { x: Math.max(x, 1), y: Math.max(y, 1), z: Math.max(z, 1) };
    }
    byImage.set(image.image_id, { levels, depths, fallback: Math.max(0, ...levels.filter(Number.isFinite)) });
  }
  return (req, whole = false) => {
    const image = byImage.get(req.imageId);
    if (!image) return 0;
    const chunk = image.levels[req.level] ?? image.fallback;
    const depth = image.depths[req.level]?.[req.planeAxis ?? "z"];
    if (whole || !req.planes || depth === undefined) return chunk;
    return (chunk / depth) * (req.planes[1] - req.planes[0]);
  };
}
