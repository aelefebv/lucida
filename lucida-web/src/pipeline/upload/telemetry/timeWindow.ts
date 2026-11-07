/**
 * A FIFO ring buffer of timestamped entries, pruned from the front by time.
 *
 * Not an array with `shift()`: once V8's backing store outgrows a regular
 * heap object, `shift()` becomes a memmove and pruning k of n entries costs
 * O(k·n), worst exactly when the measured stage is under load. Head/count
 * indices over circular storage keep push and prune O(1) per entry.
 */

/** Anything the window can hold: an entry stamped with its arrival time. */
export interface Timestamped {
  at: number;
}

const INITIAL_CAPACITY = 64;

export class TimeWindow<T extends Timestamped> {
  /** Circular storage; live entries are `slots[(head + i) % capacity]`. */
  private slots: Array<T | undefined>;
  private head = 0;
  private count = 0;

  constructor(initialCapacity: number = INITIAL_CAPACITY) {
    this.slots = new Array<T | undefined>(Math.max(1, initialCapacity));
  }

  /** Number of entries currently in the window. */
  get length(): number {
    return this.count;
  }

  /** @internal Test-only accessor — slots allocated, live or not. */
  get capacity(): number {
    return this.slots.length;
  }

  /** Append an entry. Callers are expected to push in nondecreasing `at`. */
  push(item: T): void {
    if (this.count === this.slots.length) this.grow();
    this.slots[(this.head + this.count) % this.slots.length] = item;
    this.count += 1;
  }

  /** Drop leading entries stamped strictly before `cutoff`. */
  pruneBefore(cutoff: number): void {
    const capacity = this.slots.length;
    while (this.count > 0) {
      const oldest = this.slots[this.head] as T;
      if (oldest.at >= cutoff) break;
      // Release the reference so a pruned entry isn't retained by the buffer.
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % capacity;
      this.count -= 1;
    }
    // Shrink after a burst so storage doesn't stay burst-sized forever.
    // Quarter-full against doubling growth gives enough hysteresis that a
    // steady rate never oscillates between grow and shrink.
    if (capacity > INITIAL_CAPACITY && this.count * 4 <= capacity) {
      this.resize(Math.max(INITIAL_CAPACITY, capacity >> 1));
    }
  }

  /** Visit every live entry, oldest first. */
  forEach(visit: (item: T) => void): void {
    const capacity = this.slots.length;
    for (let i = 0; i < this.count; i++) {
      visit(this.slots[(this.head + i) % capacity] as T);
    }
  }

  /** Copy of the live entries, oldest first. Tests and debugging only. */
  toArray(): T[] {
    const out: T[] = [];
    this.forEach((item) => out.push(item));
    return out;
  }

  /** Double capacity. */
  private grow(): void {
    this.resize(this.slots.length * 2);
  }

  /** Move to storage of `capacity` slots, re-laid out from index 0. */
  private resize(capacity: number): void {
    const resized = new Array<T | undefined>(capacity);
    let i = 0;
    this.forEach((item) => {
      resized[i++] = item;
    });
    this.slots = resized;
    this.head = 0;
  }
}
