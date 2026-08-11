/**
 * Tier two: per-tick aggregates, on a drop-oldest ring.
 *
 * The per-chunk tier is complete and never drops, because a chunk that
 * stalled at the start of a run is exactly the one worth naming. A tick
 * stream has no privileged start — it is steady state, and the ticks worth
 * reading during a stall are the recent ones — so this ring wraps and says
 * how many samples it wrapped over.
 *
 * A sample is one planning pass's aggregate for one dataset: the shapes the
 * debug panel carries today, recorded with a timestamp and recorded whether
 * or not anybody is looking. A tick that hits the planner's epoch cache
 * produces no plan and so no sample — gaps in the stream are cache hits, and
 * the counted phases that accrued during them ride on the next sample.
 *
 * The buffers are allocated once at their final size and the emit site fills
 * a reusable {@link TickScratch}, so recording a tick allocates nothing.
 */

import { RingSlots } from "./ring.ts";
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

/**
 * How many samples a run keeps. A sample costs one planning pass, not one
 * frame — a tick that hit the epoch cache re-plans nothing — so this is
 * thousands of camera moves rather than seventeen seconds of wall clock.
 */
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
   * Count one planned chunk against its level. Incremental rather than
   * assigned, so the caller walks the plan once and needs no tally array of
   * its own.
   */
  addPlanned(level: number): void {
    if (!this.inSpan(level)) return;
    this.levels[level * LEVEL_COLUMNS]++;
  }

  /** Set what the cache holds and has out for a level. */
  setResidency(level: number, cached: number, inFlight: number): void {
    if (!this.inSpan(level)) return;
    const base = level * LEVEL_COLUMNS;
    this.levels[base + 1] = cached;
    this.levels[base + 2] = inFlight;
  }

  /**
   * A level past the fixed span is counted as dropped rather than folded into
   * the last slot, which would silently overstate whichever level it landed
   * on. The tally counts writes that could not land, so it reads as "this
   * sample is incomplete", not as a count of distinct levels.
   */
  private inSpan(level: number): boolean {
    if (Number.isInteger(level) && level >= 0 && level < TICK_LEVEL_SLOTS) return true;
    this.levelsDropped++;
    return false;
  }
}

export class TickRing {
  /** One interned dataset id, one timestamp, one dropped-level count, plus the columns. */
  static readonly BYTES_PER_TICK =
    (3 + COUNTERS_PER_TICK + COUNTED_PER_TICK + LEVELS_PER_TICK) * 4;

  private readonly strings = new StringPool();
  private readonly slots: RingSlots;
  private readonly capacity: number;
  private readonly atUs: Uint32Array;
  private readonly datasetIds: Uint32Array;
  private readonly levelsDropped: Uint32Array;
  private readonly counters: Uint32Array;
  private readonly counted: Uint32Array;
  private readonly levels: Uint32Array;

  constructor(capacity = DEFAULT_TICK_CAPACITY) {
    this.slots = new RingSlots(capacity);
    this.capacity = this.slots.capacity;
    this.atUs = new Uint32Array(this.capacity);
    this.datasetIds = new Uint32Array(this.capacity);
    this.levelsDropped = new Uint32Array(this.capacity);
    this.counters = new Uint32Array(this.capacity * COUNTERS_PER_TICK);
    this.counted = new Uint32Array(this.capacity * COUNTED_PER_TICK);
    this.levels = new Uint32Array(this.capacity * LEVELS_PER_TICK);
  }

  get dropped(): number {
    return this.slots.dropped;
  }

  get length(): number {
    return this.slots.length;
  }

  get byteLength(): number {
    return this.capacity * TickRing.BYTES_PER_TICK;
  }

  /** `counted` is the counted-not-timed phase tally since the previous sample. */
  append(atUs: number, scratch: TickScratch, counted: Uint32Array): void {
    const slot = this.slots.claim();

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
    for (const slot of this.slots.ordered()) {
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
