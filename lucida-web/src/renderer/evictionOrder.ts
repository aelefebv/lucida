/**
 * A pool's held slots in the order eviction takes them, kept as chunks land
 * and leave. Classifying every slot for each arriving chunk costs a full pool
 * time in proportion to its size per chunk, which caps how fast it refills;
 * here a pick costs a heap's logarithm.
 *
 * It picks what `findEvictionSlot` picks over the same params. A newly held
 * slot is classified at the next pick, and every slot again once something
 * the classes read has changed: the pool's slot map or views, a view's slot
 * map or sections, or what its `sources` name. Those are replaced rather than
 * changed in place, so comparing them by identity tells. A remap rewrites a
 * view's slot map in place, so it calls {@link EvictionOrder.invalidate}.
 */

import type { SpatialAxis } from "./slicePlane.ts";
import {
  classifySlot,
  evictsBefore,
  isEvictionCandidate,
  readSlotKey,
  type EvictionCandidate,
  type FindEvictionParams,
  type SlotIdentity,
} from "./eviction.ts";

interface HeldSlot extends EvictionCandidate {
  slot: number;
  /** Undefined until first classified; null for a key that doesn't parse. */
  identity: SlotIdentity | null | undefined;
  /** Not classified since it was held. */
  pending: boolean;
  /** Some view of the pool wants the chunk, whether or not that view samples it. */
  anyViewWants: boolean;
  /** Index in the heap, or -1 outside it. */
  at: number;
}

export class EvictionOrder {
  private bySlot: Array<HeldSlot | undefined> = [];
  private held = 0;
  /** Candidates, the first to evict at the root. */
  private readonly heap: HeldSlot[] = [];
  private pending: HeldSlot[] = [];
  private wanted = 0;
  /** What the classes were last read from, or null to read them again. */
  private stamp: unknown[] | null = null;
  /** The axis cached identities were read in. */
  private axis: SpatialAxis | undefined;

  /** `slot` holds the chunk `key` now. */
  hold(slot: number, key: string): void {
    if (this.bySlot[slot]) this.release(slot);
    const entry: HeldSlot = {
      slot, key, class: "unsampled", dist: Infinity, identity: undefined, pending: true, anyViewWants: false, at: -1,
    };
    this.bySlot[slot] = entry;
    this.held++;
    this.pending.push(entry);
    // A pool with free slots picks nothing, so nothing drains the list; keep
    // it to the slots still held.
    if (this.pending.length > 2 * this.held + 32) this.pending = this.pending.filter((e) => this.bySlot[e.slot] === e);
  }

  /** `slot` holds nothing now. */
  release(slot: number): void {
    const entry = this.bySlot[slot];
    if (!entry) return;
    this.bySlot[slot] = undefined;
    this.held--;
    // A pending one is skipped when the pending list drains.
    if (entry.pending) return;
    if (entry.anyViewWants) this.wanted--;
    if (entry.at >= 0) this.removeAt(entry.at);
  }

  /** A view's slot map changed in place: classify every slot again before the next pick. */
  invalidate(): void {
    this.stamp = null;
  }

  /** The slot to evict first, as `findEvictionSlot(params)` picks it, or null when the pool holds none. */
  next(params: FindEvictionParams): EvictionCandidate | null {
    this.sync(params);
    const first = this.heap[0];
    return first ? { key: first.key, class: first.class, dist: first.dist } : null;
  }

  /** How many held slots some view of the pool wants, sampled or not. */
  wantedHeld(params: FindEvictionParams): number {
    this.sync(params);
    return this.wanted;
  }

  private sync(params: FindEvictionParams): void {
    const stamp = stampOf(params);
    if (this.stamp === null || !sameStamp(this.stamp, stamp) || this.held !== params.slots.size) {
      this.rebuild(params);
      this.stamp = stamp;
      return;
    }
    for (const entry of this.pending) {
      if (this.bySlot[entry.slot] !== entry) continue;
      this.classify(params, entry);
      if (entry.at >= 0) this.up(entry.at);
    }
    this.pending = [];
  }

  /** Classify every slot the pool holds and order them anew, keeping the keys already read. */
  private rebuild(params: FindEvictionParams): void {
    const previous = this.bySlot;
    const sameAxis = this.axis === params.sliceAxis;
    this.axis = params.sliceAxis;
    this.bySlot = [];
    this.held = 0;
    this.heap.length = 0;
    this.pending = [];
    this.wanted = 0;
    for (const [key, slot] of params.slots) {
      const prior = previous[slot];
      const entry: HeldSlot = {
        slot, key, class: "unsampled", dist: Infinity,
        identity: sameAxis && prior?.key === key ? prior.identity : undefined,
        pending: true, anyViewWants: false, at: -1,
      };
      this.bySlot[slot] = entry;
      this.held++;
      this.classify(params, entry);
    }
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.down(i);
  }

  /** Classify one held slot and append it to the heap, unordered, when it is a candidate. */
  private classify(params: FindEvictionParams, entry: HeldSlot): void {
    if (entry.identity === undefined) entry.identity = readSlotKey(entry.key, params.sliceAxis);
    entry.pending = false;
    const identity = entry.identity;
    if (identity === null) return;
    entry.anyViewWants = params.views.some((view) => view.isWanted(identity.memberId, identity.chunkKey));
    if (entry.anyViewWants) this.wanted++;
    if (identity.chunk === null) return;
    const classified = classifySlot(params, entry.key, identity, entry.slot, true);
    entry.class = classified.class;
    entry.dist = classified.dist;
    if (!isEvictionCandidate(entry)) return;
    entry.at = this.heap.length;
    this.heap.push(entry);
  }

  private removeAt(at: number): void {
    const removed = this.heap[at];
    const last = this.heap.pop()!;
    removed.at = -1;
    if (last === removed) return;
    this.heap[at] = last;
    last.at = at;
    this.down(at);
    this.up(last.at);
  }

  private up(at: number): void {
    const heap = this.heap;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!evictsBefore(heap[at], heap[parent])) return;
      this.swap(at, parent);
      at = parent;
    }
  }

  private down(at: number): void {
    const heap = this.heap;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let first = at;
      if (left < heap.length && evictsBefore(heap[left], heap[first])) first = left;
      if (right < heap.length && evictsBefore(heap[right], heap[first])) first = right;
      if (first === at) return;
      this.swap(at, first);
      at = first;
    }
  }

  private swap(a: number, b: number): void {
    const heap = this.heap;
    const held = heap[a];
    heap[a] = heap[b];
    heap[b] = held;
    heap[a].at = a;
    heap[b].at = b;
  }
}

/** Everything the classes read, by identity. */
function stampOf(params: FindEvictionParams): unknown[] {
  const stamp: unknown[] = [params.slots, params.is3D, params.sliceAxis, params.views.length];
  for (const view of params.views) stamp.push(view.slotGridIdx, view.entityMetas, view.sources.length, ...view.sources);
  return stamp;
}

function sameStamp(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
