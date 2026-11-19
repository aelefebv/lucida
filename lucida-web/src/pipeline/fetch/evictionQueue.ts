/**
 * A store's entries in the order its policy evicts them, sorted once and
 * kept until something the order reads changes. An insert into a full store
 * then takes its victims from the front, where sorting every entry for each
 * insert cost the whole store's size in time per arriving chunk.
 *
 * Removal is lazy: an entry that left the store is skipped where the order
 * meets it. Entries added since the sort wait in a short sorted list of
 * their own and are merged in as victims are taken. The order is sorted
 * again when the policy's inputs change (`EvictionPolicy.stamp`), when the
 * store says an entry's fields changed in place
 * ({@link EvictionQueue.invalidate}), or once additions or departures make
 * up a large share of it.
 */

import type { EvictableEntry, EvictionCompare, EvictionPolicy } from "./eviction.ts";

export interface EvictionTake<T> {
  /** In eviction order. */
  victims: T[];
  /** Whether their bytes reach what was needed; when not, every candidate is listed. */
  enough: boolean;
}

export class EvictionQueue<T extends EvictableEntry> {
  private readonly policy: EvictionPolicy<T>;
  private readonly isLive: (entry: T) => boolean;
  /** Null until sorted, and again once the order may be stale. */
  private compare: EvictionCompare<T> | null = null;
  private stamp: readonly unknown[] = [];
  private sorted: T[] = [];
  /** Entries before this index in {@link sorted} have left the store. */
  private front = 0;
  /** Entries that joined since the sort, in order. */
  private added: T[] = [];
  /** Entries known to have left from behind {@link front}. */
  private departed = 0;

  /** `isLive` tells whether an entry is still in the store. */
  constructor(policy: EvictionPolicy<T>, isLive: (entry: T) => boolean) {
    this.policy = policy;
    this.isLive = isLive;
  }

  /** `entry` joined the store. */
  add(entry: T): void {
    const compare = this.compare;
    if (compare === null) return;
    const added = this.added;
    let lo = 0;
    let hi = added.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(added[mid], entry) <= 0) lo = mid + 1;
      else hi = mid;
    }
    added.splice(lo, 0, entry);
  }

  /** An entry left the store. */
  remove(): void {
    if (this.compare !== null) this.departed++;
  }

  /** An entry's fields changed in place, or the store was emptied: sort again before the next take. */
  invalidate(): void {
    this.compare = null;
    this.sorted = [];
    this.added = [];
    this.front = 0;
    this.departed = 0;
  }

  /**
   * The entries to evict for `bytesNeeded`, in order, passing over those
   * `skip` names. Takes nothing out of the store; the caller removes what it
   * keeps. When the candidates fall short, every one is listed and `enough`
   * is false.
   */
  take(entries: () => Iterable<T>, bytesNeeded: number, skip: (entry: T) => boolean): EvictionTake<T> {
    const victims: T[] = [];
    if (bytesNeeded <= 0) return { victims, enough: true };
    const compare = this.sync(entries);
    const { sorted, added } = this;
    // What left the store from the front stays behind it.
    while (this.front < sorted.length && !this.isLive(sorted[this.front])) this.front++;
    let i = this.front;
    let j = 0;
    let freed = 0;
    const chosen = new Set<T>();
    while (freed < bytesNeeded) {
      while (i < sorted.length && !this.isLive(sorted[i])) i++;
      while (j < added.length && !this.isLive(added[j])) j++;
      let next: T;
      if (i < sorted.length && (j >= added.length || compare(sorted[i], added[j]) <= 0)) next = sorted[i++];
      else if (j < added.length) next = added[j++];
      else return { victims, enough: false };
      // An entry inserted again after leaving can sit in both lists.
      if (chosen.has(next) || skip(next)) continue;
      chosen.add(next);
      victims.push(next);
      freed += next.sizeBytes;
    }
    return { victims, enough: true };
  }

  private sync(entries: () => Iterable<T>): EvictionCompare<T> {
    const stamp = this.policy.stamp();
    const stale =
      this.compare === null ||
      !sameStamp(this.stamp, stamp) ||
      this.added.length > 64 + (this.sorted.length >> 3) ||
      this.departed > 64 + (this.sorted.length >> 2);
    if (!stale) return this.compare!;
    const compare = this.policy.comparator();
    this.compare = compare;
    this.stamp = stamp;
    this.sorted = [...entries()].sort(compare);
    this.front = 0;
    this.added = [];
    this.departed = 0;
    return compare;
  }
}

function sameStamp(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
