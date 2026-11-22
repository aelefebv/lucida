/**
 * Capacity-aware admission: the part of a plan the memory budgets hold.
 *
 * The detail lane is the level selection, which fits the budgets by
 * construction and shares them out among views, so admission takes it whole
 * and a settled view holds its selection. Admission is the check behind
 * that: it walks a plan's requests in priority order, keeps each one whose
 * chunk fits what its residency tier and its GPU pool have left, and
 * declares the rest as the plan's shortfall, the coverage the view goes
 * without. That is what still lets a view settle when a pool's slots, the
 * coarse tier, or prefetch would otherwise evict one wanted chunk for
 * another forever.
 *
 * A replan during a gesture changes a few of a plan's thousands of
 * requests, and a plan that fits is admitted whole. So the
 * {@link AdmissionLedger} keeps what the last admission charged, and when
 * it admitted everything, it charges and refunds only what each plan's
 * {@link RequestDelta} changed: when everything still fits, the walk in
 * priority order would admit everything too.
 */

import type { DatasetManifest } from "../../manifestTypes.ts";
import { decodedBytesPerSample } from "../../renderer/dataTypeUtil.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { ChunkRequest, RequestDelta } from "./types.ts";
import { planesKeySuffix } from "../fetch/contentSource.ts";
import { requestChunkKey } from "./requestKeys.ts";
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
  /** How `requests` differ from those of the plan admitted last in its place, when the planner carried them. */
  delta?: RequestDelta;
}

export interface Admission {
  /** The admitted requests, in the order they arrived: the plan's own array when it admitted all of them. */
  admitted: readonly ChunkRequest[];
  /**
   * How `admitted` differs from what the last admission admitted of the
   * plan in its place, when both admitted the whole plan and the plan says
   * how it changed.
   */
  delta?: RequestDelta;
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
 * charged once. A request for some planes of a chunk and one for all of it
 * are charged apart, since either may be what the cache ends up holding,
 * unless the cache already holds the chunk whole: then the whole is what
 * serves the planes, and both are charged it once.
 */
export function admitPlans(
  plans: readonly PlanToAdmit[],
  capacity: Readonly<PerTier>,
  gpuRoom: number = Infinity,
): Admission[] {
  return admitWhole(plans, capacity, gpuRoom).admissions;
}

/** {@link admitPlans}, and, when it admitted every request, the charges it made, for a ledger to carry. */
function admitWhole(
  plans: readonly PlanToAdmit[],
  capacity: Readonly<PerTier>,
  gpuRoom: number,
): { admissions: Admission[]; charges: Charges | null } {
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
      keys: plan.requests.map((req, i) => chargeKey(req, whole[i])),
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
  for (const state of states) admit(state, "detail", capacity.detail, (req) => !speculative(req));
  const coarseRoom = capacity.coarse + Math.max(0, capacity.detail - used.detail);
  for (const state of states) admit(state, "coarse", coarseRoom, () => true);
  const borrowed = Math.max(0, used.coarse - capacity.coarse);
  for (const state of states) admit(state, "detail", capacity.detail - borrowed, speculative);

  const loans = borrowedByPlan(states.map((state) => state.coarseBytes), capacity.coarse);
  const admissions = states.map((state, i): Admission => {
    const whole = state.admitted.size === state.plan.requests.length;
    return {
      admitted: whole ? state.plan.requests : state.plan.requests.filter((req) => state.admitted.has(req)),
      shortfall: state.shortfall,
      borrowed: loans[i],
    };
  });
  if (admissions.some((admission, i) => admission.admitted !== plans[i].requests)) return { admissions, charges: null };

  const charges = new Charges(plans.length);
  states.forEach((state, plan) => {
    state.plan.requests.forEach((req, i) => {
      charges.charge(plan, req, state.keys[i], state.slots[i], bytesOf(state, i));
    });
  });
  return { admissions, charges };
}

/**
 * What a tier charges `req` under: its chunk, and the planes it asks for
 * unless it costs the whole chunk.
 */
function chargeKey(req: ChunkRequest, whole: boolean): string {
  return whole ? requestChunkKey(req) : requestChunkKey(req) + planesKeySuffix(req.planes, req.planeAxis);
}

/**
 * What each plan's coarse chunks took beyond the coarse tier's own room,
 * its charges counted after the plans before it.
 */
function borrowedByPlan(coarseBytes: readonly number[], coarseCapacity: number): number[] {
  let coarseSoFar = 0;
  return coarseBytes.map((bytes) => {
    const loanBefore = Math.max(0, coarseSoFar - coarseCapacity);
    coarseSoFar += bytes;
    return Math.max(0, coarseSoFar - coarseCapacity) - loanBefore;
  });
}

/** One chunk charged to a tier, and how many admitted requests hold it there. */
interface Charge {
  tier: ResidencyTier;
  bytes: number;
  /** Requests of the view's own lanes, which the detail pass charges before prefetch. */
  view: number;
  all: number;
}

/**
 * What an admission of every request charged: each chunk once per tier, each
 * request's slot, and the totals the passes check, kept so that a request
 * added or removed charges or refunds its share alone.
 */
class Charges {
  /** Per plan, its chunks by charge key. */
  private readonly byKey: Map<string, Charge>[];
  private readonly held = new Map<ChunkRequest, { plan: number; key: string; slot: GpuSlot | null }>();
  private readonly slotsUsed = new Map<string, { used: number; slots: number }>();
  /** Pools holding more than their slots. */
  private overfull = 0;
  private gpuUsed = 0;
  /** The view's detail chunks, what the detail pass checks. */
  private detailView = 0;
  /** Every detail chunk, prefetch included, what the prefetch pass checks. */
  private detailAll = 0;
  private coarse = 0;
  private readonly coarseByPlan: number[];

  constructor(plans: number) {
    this.coarseByPlan = new Array<number>(plans).fill(0);
    this.byKey = Array.from({ length: plans }, () => new Map<string, Charge>());
  }

  charge(plan: number, req: ChunkRequest, key: string, slot: GpuSlot | null, bytes: number): void {
    const byKey = this.byKey[plan];
    let charge = byKey.get(key);
    if (charge === undefined) {
      charge = { tier: req.tier, bytes, view: 0, all: 0 };
      byKey.set(key, charge);
      if (req.tier === "coarse") {
        this.coarse += bytes;
        this.coarseByPlan[plan] += bytes;
      } else {
        this.detailAll += bytes;
      }
    }
    if (req.tier === "detail" && req.lane !== "prefetch" && charge.view++ === 0) this.detailView += charge.bytes;
    charge.all++;
    if (slot !== null) {
      let pool = this.slotsUsed.get(slot.pool);
      if (pool === undefined) this.slotsUsed.set(slot.pool, (pool = { used: 0, slots: slot.slots }));
      if (++pool.used === pool.slots + 1) this.overfull++;
      this.gpuUsed += slot.slotBytes;
    }
    this.held.set(req, { plan, key, slot });
  }

  /** Refund what `req` was charged; false when it was never charged. */
  refund(req: ChunkRequest): boolean {
    const held = this.held.get(req);
    if (held === undefined) return false;
    this.held.delete(req);
    const byKey = this.byKey[held.plan];
    const charge = byKey.get(held.key)!;
    if (req.tier === "detail" && req.lane !== "prefetch" && --charge.view === 0) this.detailView -= charge.bytes;
    if (--charge.all === 0) {
      byKey.delete(held.key);
      if (charge.tier === "coarse") {
        this.coarse -= charge.bytes;
        this.coarseByPlan[held.plan] -= charge.bytes;
      } else {
        this.detailAll -= charge.bytes;
      }
    }
    if (held.slot !== null) {
      const pool = this.slotsUsed.get(held.slot.pool)!;
      if (pool.used-- === pool.slots + 1) this.overfull--;
      this.gpuUsed -= held.slot.slotBytes;
    }
    return true;
  }

  /** Whether the walk in priority order would admit everything charged, as {@link admitPlans} passes over it. */
  fits(capacity: Readonly<PerTier>, gpuRoom: number): boolean {
    const borrowed = Math.max(0, this.coarse - capacity.coarse);
    return (
      this.overfull === 0 &&
      this.gpuUsed <= gpuRoom &&
      this.detailView <= capacity.detail &&
      this.coarse <= capacity.coarse + Math.max(0, capacity.detail - this.detailView) &&
      this.detailAll <= capacity.detail - borrowed
    );
  }

  borrowed(capacity: Readonly<PerTier>): number[] {
    return borrowedByPlan(this.coarseByPlan, capacity.coarse);
  }
}

/**
 * Admission carried from one replan to the next. While the last admission
 * took every request, a plan that says how it changed is charged for what
 * it added and refunded for what it removed, and when everything still fits
 * the room it has now, it is admitted whole without walking it. Anything
 * else, new pools, a plan with no delta, or a change that no longer fits,
 * admits every plan again.
 */
export class AdmissionLedger {
  private held: {
    charges: Charges;
    sources: readonly unknown[];
    admitted: readonly (readonly ChunkRequest[])[];
  } | null = null;

  /**
   * {@link admitPlans}, carried from the last call. `sources` are what the
   * plans' bytes and slots are read from, such as the manifests and what
   * the worker reports of its pools; the ledger carries only while every
   * one is the same. The capacity and the GPU room may move: what is
   * charged is checked against them as they are now.
   */
  admit(
    plans: readonly PlanToAdmit[],
    capacity: Readonly<PerTier>,
    gpuRoom: number,
    sources: readonly unknown[],
  ): Admission[] {
    const before = this.held;
    let admissions = before !== null && sameSources(before.sources, sources)
      ? applyDeltas(before.charges, before.admitted, plans, capacity, gpuRoom)
      : null;
    if (admissions !== null) {
      this.held = { ...before!, admitted: plans.map((plan) => plan.requests) };
    } else {
      const whole = admitWhole(plans, capacity, gpuRoom);
      admissions = whole.admissions;
      this.held = whole.charges === null ? null : {
        charges: whole.charges, sources, admitted: admissions.map((admission) => admission.admitted),
      };
    }
    return admissions.map((admission, i) => {
      const delta = plans[i].delta;
      const carried = delta !== undefined && admission.admitted === plans[i].requests && before?.admitted[i] === delta.base;
      return carried ? { ...admission, delta } : admission;
    });
  }
}

function sameSources(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((source, i) => source === b[i]);
}

/**
 * Charge each plan's delta to `charges`, which admitted `admitted` whole,
 * and the admissions when everything fits after; null when a plan says
 * nothing of how it changed from what was admitted, or it no longer fits.
 * `charges` is then in no state to carry, and the caller admits again.
 */
function applyDeltas(
  charges: Charges,
  admitted: readonly (readonly ChunkRequest[])[],
  plans: readonly PlanToAdmit[],
  capacity: Readonly<PerTier>,
  gpuRoom: number,
): Admission[] | null {
  if (plans.length !== admitted.length) return null;
  for (let i = 0; i < plans.length; i++) {
    const delta = plans[i].delta;
    if (delta === undefined || delta.base !== admitted[i]) return null;
  }
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const delta = plan.delta!;
    for (const req of delta.removed) if (!charges.refund(req)) return null;
    for (const req of delta.added) {
      const whole = req.planes === undefined || (plan.heldWhole?.(req) ?? false);
      charges.charge(i, req, chargeKey(req, whole), plan.slotOf?.(req) ?? null, plan.bytesOf(req, whole));
    }
  }
  if (!charges.fits(capacity, gpuRoom)) return null;
  const borrowed = charges.borrowed(capacity);
  return plans.map((plan, i) => ({ admitted: plan.requests, shortfall: { detail: 0, coarse: 0 }, borrowed: borrowed[i] }));
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
  let bytesOf = chunkBytesByManifest.get(manifest);
  if (bytesOf === undefined) chunkBytesByManifest.set(manifest, (bytesOf = priceChunks(manifest)));
  return bytesOf;
}

/**
 * {@link chunkBytesFor} by manifest. A replan prices every dataset's chunks
 * twice, and a collection's manifest holds hundreds of images; a manifest is
 * replaced, never changed, so its prices hold while it does.
 */
const chunkBytesByManifest = new WeakMap<DatasetManifest, (req: ChunkRequest, whole?: boolean) => number>();

function priceChunks(manifest: DatasetManifest): (req: ChunkRequest, whole?: boolean) => number {
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
