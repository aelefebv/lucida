/**
 * Slot bookkeeping shared by the two steady-state rings.
 *
 * Both tier two and tier three are drop-oldest streams with no privileged
 * start, and both have to say how much they dropped — so the wrap arithmetic
 * and the oldest-first walk live here once rather than in each ring. The
 * per-chunk table is deliberately not built on this: it never drops, because
 * the chunk that stalled at the start of a run is the one worth naming.
 */
export class RingSlots {
  readonly capacity: number;
  /** Total appended, including records already overwritten. */
  private written = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  /** Records the ring overwrote. Zero means what is here is the whole stream. */
  get dropped(): number {
    return Math.max(0, this.written - this.capacity);
  }

  get length(): number {
    return Math.min(this.written, this.capacity);
  }

  /** Claim the next slot, wrapping over the oldest record. */
  claim(): number {
    const slot = this.written % this.capacity;
    this.written++;
    return slot;
  }

  /** The live slots, oldest first, so a reader walks the ring as it happened. */
  *ordered(): Generator<number> {
    const first = this.written > this.capacity ? this.written - this.capacity : 0;
    for (let n = first; n < this.written; n++) yield n % this.capacity;
  }
}
