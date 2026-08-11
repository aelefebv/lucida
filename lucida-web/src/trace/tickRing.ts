/**
 * Tier two: per-tick aggregates, on a drop-oldest ring.
 *
 * The per-chunk tier is complete and never drops, because a chunk that
 * stalled at the start of a run is exactly the one worth naming. A tick
 * stream has no privileged start — it is steady state, and the ticks worth
 * reading during a stall are the recent ones — so this ring wraps and says
 * how many samples it wrapped over.
 *
 * A sample is one tick's planning aggregate for one dataset: the shapes the
 * debug panel carries today, recorded with a timestamp and recorded whether
 * or not anybody is looking.
 *
 * The buffers are allocated once at their final size and the emit site fills
 * a reusable {@link TickScratch}, so recording a tick allocates nothing.
 */

import { StringPool } from "./stringPool.ts";
import {
  COUNTED_PHASES,
  LEVEL_COLUMNS,
  TICK_COUNTER_NAMES,
  TICK_LEVEL_SLOTS,
  type CountedPhase,
  type TickCounterName,
  type TraceTick,
  type TraceTickLevel,
} from "./types.ts";

const COUNTERS_PER_TICK = TICK_COUNTER_NAMES.length;
const COUNTED_PER_TICK = COUNTED_PHASES.length;
const LEVELS_PER_TICK = TICK_LEVEL_SLOTS * LEVEL_COLUMNS;

/** How many tick samples a run keeps. At a 60 Hz cadence, about 17 seconds. */
export const DEFAULT_TICK_CAPACITY = 1024;

/**
 * The mutable sample an emit site fills in place. Owned by the recorder and
 * reused for every tick: a fresh object per tick would be an allocation on
 * the pipeline's hottest path, and an allocating recorder produces GC pauses
 * that appear as stalls in its own trace.
 */
export class TickScratch {
  readonly counters = new Uint32Array(COUNTERS_PER_TICK);
  readonly levels = new Uint32Array(LEVELS_PER_TICK);
  datasetId = "";
  levelsDropped = 0;

  reset(datasetId: string): void {
    this.counters.fill(0);
    this.levels.fill(0);
    this.datasetId = datasetId;
    this.levelsDropped = 0;
  }

  /**
   * Record one level's planning and residency counts. A level past the fixed
   * span is counted as dropped rather than folded into the last slot, which
   * would silently overstate whichever level it landed on.
   */
  addLevel(level: number, planned: number, cached: number, inFlight: number): void {
    if (!Number.isInteger(level) || level < 0 || level >= TICK_LEVEL_SLOTS) {
      this.levelsDropped++;
      return;
    }
    const base = level * LEVEL_COLUMNS;
    this.levels[base] = planned;
    this.levels[base + 1] = cached;
    this.levels[base + 2] = inFlight;
  }
}

export class TickRing {
  /** One interned dataset id, one timestamp, one dropped-level count, plus the columns. */
  static readonly BYTES_PER_TICK =
    (3 + COUNTERS_PER_TICK + COUNTED_PER_TICK + LEVELS_PER_TICK) * 4;

  private readonly strings = new StringPool();
  private readonly capacity: number;
  private readonly atUs: Uint32Array;
  private readonly datasetIds: Uint32Array;
  private readonly levelsDropped: Uint32Array;
  private readonly counters: Uint32Array;
  private readonly counted: Uint32Array;
  private readonly levels: Uint32Array;

  /** Total appended, including samples already overwritten. */
  private written = 0;

  constructor(capacity = DEFAULT_TICK_CAPACITY) {
    this.capacity = Math.max(1, capacity);
    this.atUs = new Uint32Array(this.capacity);
    this.datasetIds = new Uint32Array(this.capacity);
    this.levelsDropped = new Uint32Array(this.capacity);
    this.counters = new Uint32Array(this.capacity * COUNTERS_PER_TICK);
    this.counted = new Uint32Array(this.capacity * COUNTED_PER_TICK);
    this.levels = new Uint32Array(this.capacity * LEVELS_PER_TICK);
  }

  /** Samples the ring overwrote. Zero means what is here is the whole stream. */
  get dropped(): number {
    return Math.max(0, this.written - this.capacity);
  }

  get length(): number {
    return Math.min(this.written, this.capacity);
  }

  get byteLength(): number {
    return this.capacity * TickRing.BYTES_PER_TICK;
  }

  /** `counted` is the counted-not-timed phase tally since the previous tick. */
  append(atUs: number, scratch: TickScratch, counted: Uint32Array): void {
    const slot = this.written % this.capacity;
    this.written++;

    this.atUs[slot] = atUs;
    this.datasetIds[slot] = this.strings.intern(scratch.datasetId);
    this.levelsDropped[slot] = scratch.levelsDropped;
    this.counters.set(scratch.counters, slot * COUNTERS_PER_TICK);
    this.counted.set(counted, slot * COUNTED_PER_TICK);
    this.levels.set(scratch.levels, slot * LEVELS_PER_TICK);
  }

  /** Oldest-first, so a reader walks the ring the way the run happened. */
  serialise(): TraceTick[] {
    const out: TraceTick[] = [];
    const first = this.written > this.capacity ? this.written - this.capacity : 0;
    for (let n = first; n < this.written; n++) {
      const slot = n % this.capacity;

      const counters = {} as Record<TickCounterName, number>;
      for (let i = 0; i < COUNTERS_PER_TICK; i++) {
        counters[TICK_COUNTER_NAMES[i]] = this.counters[slot * COUNTERS_PER_TICK + i];
      }

      const counted = {} as Record<CountedPhase, number>;
      for (let i = 0; i < COUNTED_PER_TICK; i++) {
        counted[COUNTED_PHASES[i]] = this.counted[slot * COUNTED_PER_TICK + i];
      }

      const levels: TraceTickLevel[] = [];
      for (let level = 0; level < TICK_LEVEL_SLOTS; level++) {
        const base = slot * LEVELS_PER_TICK + level * LEVEL_COLUMNS;
        const planned = this.levels[base];
        const cached = this.levels[base + 1];
        const inFlight = this.levels[base + 2];
        if (planned === 0 && cached === 0 && inFlight === 0) continue;
        levels.push({ level, planned, cached, inFlight });
      }

      out.push({
        atUs: this.atUs[slot],
        datasetId: this.strings.get(this.datasetIds[slot]),
        counters,
        counted,
        levels,
        levelsDropped: this.levelsDropped[slot],
      });
    }
    return out;
  }
}
