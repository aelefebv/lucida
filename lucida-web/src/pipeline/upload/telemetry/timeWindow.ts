/**
 * A FIFO ring buffer of timestamped entries, pruned from the front by time.
 *
 * The naive form of this — an array plus `shift()` in a `while` loop — has a
 * cliff. V8 left-trims the backing store, so `shift()` is cheap right up
 * until the store outgrows a regular heap object; past that it becomes a full
 * memmove and pruning k of n entries costs O(k·n). Measured on the upload
 * event ring (#898): ~1.4 µs per prune at 1 event/tick, ~1.15 ms at 128
 * events/tick (≈15k entries resident). That curve is exactly backwards for a
 * telemetry path — it gets most expensive when the thing being measured is
 * already under load, and misattributes its own cost to that stage.
 *
 * Head/count indices over circular storage make push and prune O(1) per
 * entry with no cliff, at the price of not being a plain array.
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
    // A burst grows the storage; without this it would stay burst-sized
    // forever, which the array it replaced did not. Quarter-full against
    // doubling growth gives enough hysteresis that a steady rate never
    // oscillates between grow and shrink.
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
