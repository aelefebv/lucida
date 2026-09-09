/**
 * The reading tier: four process-wide quantities, one sample per tick, on a
 * drop-oldest ring.
 *
 * Separate from the per-tick aggregates because the cadences differ. A tick
 * sample is published per *planning pass*, and the planner's epoch cache means
 * a run can fetch for seconds without re-planning once — readings carried there
 * came out as a cluster of readings in a run's first few milliseconds and
 * nothing after. These are sampled where they can actually change: at the end
 * of every tick, alongside the published quiescence.
 *
 * Drop-oldest for the same reason the tick ring is: a reading stream is steady
 * state, and the readings worth having during a stall are the recent ones.
 */

import { RingSlots } from "./ring.ts";
import { READING_NAMES, type TraceReading } from "./types.ts";

const COLUMNS = READING_NAMES.length;

/**
 * How many readings a run keeps. One per tick, and a tick is dirty-driven, so
 * this is about seventeen seconds of continuous animation and unbounded idle
 * time — an idle viewer does not tick and so records nothing.
 */
export const DEFAULT_READING_CAPACITY = 1024;

export class ReadingRing {
  /** One timestamp, the columns, and the optional GPU pass time, all doubles. */
  static readonly BYTES_PER_SAMPLE = (1 + COLUMNS + 1) * 8;

  private readonly slots: RingSlots;
  private readonly capacity: number;
  private readonly atUs: Float64Array;
  private readonly values: Float64Array;
  /**
   * NaN where the reading has none. Its own column rather than a fifth
   * {@link READING_NAMES} entry because the named readings are always present
   * and this one is optional: `serialise` omits it rather than writing a zero.
   */
  private readonly gpuPassUs: Float64Array;

  constructor(capacity = DEFAULT_READING_CAPACITY) {
    this.slots = new RingSlots(capacity);
    this.capacity = this.slots.capacity;
    this.atUs = new Float64Array(this.capacity);
    this.values = new Float64Array(this.capacity * COLUMNS);
    this.gpuPassUs = new Float64Array(this.capacity).fill(NaN);
  }

  get dropped(): number {
    return this.slots.dropped;
  }

  get length(): number {
    return this.slots.length;
  }

  get byteLength(): number {
    return this.capacity * ReadingRing.BYTES_PER_SAMPLE;
  }

  /**
   * `values` is the reading in {@link READING_NAMES} order. `gpuPassUs` is
   * the GPU pass time that arrived since the previous reading, or null when
   * none did.
   */
  append(atUs: number, values: Float64Array, gpuPassUs: number | null): void {
    const slot = this.slots.claim();
    this.atUs[slot] = atUs;
    this.values.set(values, slot * COLUMNS);
    this.gpuPassUs[slot] = gpuPassUs ?? NaN;
  }

  /** Oldest-first, so a reader walks the ring the way the run happened. */
  serialise(): TraceReading[] {
    const out: TraceReading[] = [];
    for (const slot of this.slots.ordered()) {
      const sample = { atUs: this.atUs[slot] } as TraceReading;
      for (let i = 0; i < COLUMNS; i++) {
        sample[READING_NAMES[i]] = this.values[slot * COLUMNS + i];
      }
      const gpuPassUs = this.gpuPassUs[slot];
      if (!Number.isNaN(gpuPassUs)) sample.gpuPassUs = gpuPassUs;
      out.push(sample);
    }
    return out;
  }
}
