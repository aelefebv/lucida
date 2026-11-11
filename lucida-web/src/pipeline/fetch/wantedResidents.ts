import type { CacheEntry, ReadyChunkDelivery } from "./types.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import { deliveryTarget } from "../../renderer/poolKeys.ts";

/** What the current plans make of one resident entry. */
export interface ResidentJudgement {
  /** The tier the entry counts in as wanted and resident, or null when it counts in neither. */
  wantedIn: ResidencyTier | null;
  /** {@link deliverySlot} of the entry when a view wants it delivered, else null. */
  slot: string | null;
  /** One delivery for each target that wants the entry and was not sent it. */
  deliveries: ReadyChunkDelivery[];
}

/** The wanted chunks resident in each tier, and their bytes. */
export interface WantedResidency {
  detailChunks: number;
  detailBytes: number;
  coarseChunks: number;
  coarseBytes: number;
}

/**
 * The page's name for a chunk the render worker answers for, less the
 * target. The delivery ledger's answers arrive by these parts, and a chunk's
 * image and key name one resident entry per tier.
 */
export function deliverySlot(imageId: string, c: number, tier: ResidencyTier, chunkKey: string): string {
  return `${imageId}|${c}|${tier}|${chunkKey}`;
}

/**
 * Priority first, then a total order on what a delivery is, so the order
 * never depends on the order deliveries were found in.
 */
export function compareDeliveries(a: ReadyChunkDelivery, b: ReadyChunkDelivery): number {
  return (
    (a.priority ?? 0) - (b.priority ?? 0) ||
    a.imageId.localeCompare(b.imageId) ||
    a.level - b.level ||
    a.t - b.t ||
    a.z - b.z ||
    a.y - b.y ||
    a.x - b.x ||
    a.c - b.c ||
    a.chunkKey.localeCompare(b.chunkKey) ||
    deliveryTarget(a.mode, a.cut).localeCompare(deliveryTarget(b.mode, b.cut)) ||
    (a.residencyTier === b.residencyTier ? 0 : a.residencyTier === "detail" ? -1 : 1)
  );
}

interface Judged {
  wantedIn: ResidencyTier | null;
  bytes: number;
  slot: string | null;
  deliveries: ReadyChunkDelivery[];
}

/**
 * The resident chunks the current plans want, kept from one tick to the
 * next: how many each tier holds, which settling reads, and the deliveries
 * still waiting to go to the render worker, in delivery order.
 *
 * The cache says which entries may have changed (arrived, sent, answered for
 * by the worker, refreshed by a plan) and which left, and a read judges those
 * again. A read costs what changed since the last one, where judging every
 * resident entry would cost about a microsecond each on every tick of a load.
 */
export class WantedResidents {
  private readonly judged = new Map<CacheEntry, Judged>();
  /** The entries a view wants delivered, by slot, so an answer that names a slot finds its entry. */
  private readonly bySlot = new Map<string, CacheEntry>();
  private readonly dirty = new Set<CacheEntry>();
  /** Every entry is judged again on the next read. */
  private stale = true;
  private readonly counts: WantedResidency = { detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0 };
  private order: ReadyChunkDelivery[] = [];
  /** Deliveries that left the order since the last read. */
  private readonly dropped = new Set<ReadyChunkDelivery>();

  /** What the plans make of `entry` now, or null when they want nothing of it. */
  private readonly judge: (entry: CacheEntry) => ResidentJudgement | null;
  /** Every resident entry, for a read after {@link invalidate}. */
  private readonly residents: () => Iterable<CacheEntry>;

  constructor(
    judge: (entry: CacheEntry) => ResidentJudgement | null,
    residents: () => Iterable<CacheEntry>,
  ) {
    this.judge = judge;
    this.residents = residents;
  }

  /** `entry` may count or deliver differently now. */
  touch(entry: CacheEntry): void {
    this.dirty.add(entry);
  }

  /** The ledger's answer for a slot changed, so its entry may deliver again. */
  touchSlot(slot: string): void {
    const entry = this.bySlot.get(slot);
    if (entry) this.dirty.add(entry);
  }

  /** `entry` is no longer resident. */
  forget(entry: CacheEntry): void {
    this.dirty.delete(entry);
    this.drop(entry);
  }

  /** No plan wants anything until one says so. */
  clear(): void {
    this.judged.clear();
    this.bySlot.clear();
    this.dirty.clear();
    this.dropped.clear();
    this.order = [];
    this.counts.detailChunks = 0;
    this.counts.detailBytes = 0;
    this.counts.coarseChunks = 0;
    this.counts.coarseBytes = 0;
    this.stale = false;
  }

  /** Something every entry depends on changed. */
  invalidate(): void {
    this.stale = true;
  }

  /** The wanted chunks resident in each tier. The object is reused; read it before the next change. */
  residency(): Readonly<WantedResidency> {
    this.update();
    return this.counts;
  }

  /**
   * The waiting deliveries in delivery order. The array is replaced, never
   * changed, when the order changes, so a caller may hold it across sends.
   */
  deliveries(): readonly ReadyChunkDelivery[] {
    this.update();
    return this.order;
  }

  private update(): void {
    const added: ReadyChunkDelivery[] = [];
    if (this.stale) {
      this.clear();
      for (const entry of this.residents()) this.admit(entry, added);
    } else if (this.dirty.size > 0) {
      for (const entry of this.dirty) {
        this.drop(entry);
        this.admit(entry, added);
      }
      this.dirty.clear();
    }
    if (this.dropped.size > 0) {
      this.order = this.order.filter((delivery) => !this.dropped.has(delivery));
      this.dropped.clear();
    }
    if (added.length > 0) {
      added.sort(compareDeliveries);
      this.order = merge(this.order, added);
    }
  }

  private admit(entry: CacheEntry, added: ReadyChunkDelivery[]): void {
    const judgement = this.judge(entry);
    if (!judgement) return;
    const judged: Judged = { ...judgement, bytes: entry.sizeBytes };
    this.judged.set(entry, judged);
    this.count(judged, 1);
    if (judged.slot !== null) this.bySlot.set(judged.slot, entry);
    for (const delivery of judged.deliveries) added.push(delivery);
  }

  private drop(entry: CacheEntry): void {
    const judged = this.judged.get(entry);
    if (judged === undefined) return;
    this.judged.delete(entry);
    this.count(judged, -1);
    if (judged.slot !== null && this.bySlot.get(judged.slot) === entry) this.bySlot.delete(judged.slot);
    for (const delivery of judged.deliveries) this.dropped.add(delivery);
  }

  private count(judged: Judged, sign: 1 | -1): void {
    if (judged.wantedIn === "detail") {
      this.counts.detailChunks += sign;
      this.counts.detailBytes += sign * judged.bytes;
    } else if (judged.wantedIn === "coarse") {
      this.counts.coarseChunks += sign;
      this.counts.coarseBytes += sign * judged.bytes;
    }
  }
}

/** Two arrays each in delivery order, as one. */
function merge(a: readonly ReadyChunkDelivery[], b: readonly ReadyChunkDelivery[]): ReadyChunkDelivery[] {
  if (a.length === 0) return b.slice();
  const out = new Array<ReadyChunkDelivery>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compareDeliveries(b[j], a[i]) < 0 ? b[j++] : a[i++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}
