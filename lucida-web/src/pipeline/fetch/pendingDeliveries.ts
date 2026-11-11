import type { CacheEntry, ReadyChunkDelivery } from "./types.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import { deliveryTarget } from "../../renderer/poolKeys.ts";

/**
 * What a resident entry stands for in the delivery order: its delivery slot,
 * and one delivery for each target that wants it and was not sent it.
 */
export interface DeliveryJudgement {
  /** {@link deliverySlot} of the entry. */
  slot: string;
  deliveries: ReadyChunkDelivery[];
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

/**
 * The deliveries waiting to go to the render worker, in delivery order, kept
 * from one read to the next. The cache tells it which entries may have
 * changed (arrived, sent, released, refreshed by a plan) and which left, and
 * a read judges those again and merges what they deliver into the order. A
 * read costs what changed since the last one, where walking every resident
 * entry would cost about a microsecond each on every tick of a load.
 */
export class PendingDeliveries {
  /** The entries a view wants, by slot, so an answer that names a slot finds its entry. */
  private readonly bySlot = new Map<string, CacheEntry>();
  private readonly slotOf = new Map<CacheEntry, string>();
  private readonly waiting = new Map<CacheEntry, ReadyChunkDelivery[]>();
  private readonly dirty = new Set<CacheEntry>();
  /** Every entry is judged again on the next read. */
  private stale = true;
  private order: ReadyChunkDelivery[] = [];
  /** Deliveries that left the order since the last read. */
  private readonly dropped = new Set<ReadyChunkDelivery>();

  /** What `entry` delivers now, or null when no view wants it this tick. */
  private readonly judge: (entry: CacheEntry) => DeliveryJudgement | null;
  /** Every resident entry a view may want, for a read after {@link invalidate}. */
  private readonly candidates: () => Iterable<CacheEntry>;

  constructor(
    judge: (entry: CacheEntry) => DeliveryJudgement | null,
    candidates: () => Iterable<CacheEntry>,
  ) {
    this.judge = judge;
    this.candidates = candidates;
  }

  /** `entry` may deliver something else now. */
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

  /** No view wants anything until a plan says so. */
  clear(): void {
    this.bySlot.clear();
    this.slotOf.clear();
    this.waiting.clear();
    this.dirty.clear();
    this.dropped.clear();
    this.order = [];
    this.stale = false;
  }

  /** Something every entry depends on changed. */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * The waiting deliveries in delivery order. The array is replaced, never
   * changed, when the order changes, so a caller may hold it across sends.
   */
  read(): readonly ReadyChunkDelivery[] {
    const added: ReadyChunkDelivery[] = [];
    if (this.stale) {
      this.clear();
      for (const entry of this.candidates()) this.admit(entry, added);
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
    return this.order;
  }

  private admit(entry: CacheEntry, added: ReadyChunkDelivery[]): void {
    const judged = this.judge(entry);
    if (!judged) return;
    this.bySlot.set(judged.slot, entry);
    this.slotOf.set(entry, judged.slot);
    if (judged.deliveries.length === 0) return;
    this.waiting.set(entry, judged.deliveries);
    for (const delivery of judged.deliveries) added.push(delivery);
  }

  private drop(entry: CacheEntry): void {
    const slot = this.slotOf.get(entry);
    if (slot !== undefined) {
      this.slotOf.delete(entry);
      if (this.bySlot.get(slot) === entry) this.bySlot.delete(slot);
    }
    const deliveries = this.waiting.get(entry);
    if (deliveries === undefined) return;
    this.waiting.delete(entry);
    for (const delivery of deliveries) this.dropped.add(delivery);
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
