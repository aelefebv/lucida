/**
 * The recorder's write path, behind an interface so a bench can substitute
 * a no-op (ADR 0049).
 *
 * This is a test seam, not a product surface. There is no toggle at any
 * scope: recording is unconditional in every build, and the only reason
 * this indirection exists is so "always-on is free" can be a measurement —
 * real sink against no-op sink, same call sites — rather than a claim. A
 * build-time flag that dead-code-eliminates the recorder was rejected as
 * the opt-out wearing a lab coat.
 *
 * One sink holds every browser tier a run records: the complete per-chunk
 * table, the per-tick aggregate ring, the reading ring, and the point-event ring.
 */

import { EventRing } from "./eventRing.ts";
import { ReadingRing } from "./readingRing.ts";
import { RowTable } from "./rowTable.ts";
import { TickRing, type TickScratch } from "./tickRing.ts";
import type {
  ChunkEventSource,
  ChunkRowSource,
  PointEventIndex,
  PointEventReason,
  RowOutcomeValue,
  TraceReading,
  TracePointEvent,
  TraceRow,
  TraceTick,
  WireLabel,
} from "./types.ts";

export interface TraceSink {
  /** Returns the row's index within this sink. */
  append(src: ChunkRowSource, tier: 0 | 1): number;
  setLabel(index: number, label: WireLabel): void;
  stamp(index: number, boundary: number, offsetUs: number): void;
  setOutcome(index: number, outcome: RowOutcomeValue): void;
  serialise(): TraceRow[];
  /** `counted` is the counted-not-timed phase tally since the previous tick. */
  appendTick(atUs: number, scratch: TickScratch, counted: Uint32Array): void;
  serialiseTicks(): TraceTick[];
  /** `values` is one reading, in `READING_NAMES` order. */
  appendReading(atUs: number, values: Float64Array): void;
  serialiseReadings(): TraceReading[];
  appendEvent(
    atUs: number,
    kind: PointEventIndex,
    reason: PointEventReason,
    chunk: ChunkEventSource | null,
    tier: 0 | 1,
  ): void;
  serialiseEvents(): TracePointEvent[];
  readonly length: number;
  readonly byteLength: number;
  readonly ticksDropped: number;
  readonly readingsDropped: number;
  readonly eventsDropped: number;
}

/**
 * Keeps nothing and measures the call sites alone. Still hands back
 * increasing indices so the emit path takes exactly the branches it takes
 * with the real sink.
 */
export class NoopTraceSink implements TraceSink {
  private rows = 0;

  append(): number {
    return this.rows++;
  }

  setLabel(): void {}

  stamp(): void {}

  setOutcome(): void {}

  serialise(): TraceRow[] {
    return [];
  }

  appendTick(): void {}

  serialiseTicks(): TraceTick[] {
    return [];
  }

  appendReading(): void {}

  serialiseReadings(): TraceReading[] {
    return [];
  }

  appendEvent(): void {}

  serialiseEvents(): TracePointEvent[] {
    return [];
  }

  get length(): number {
    return this.rows;
  }

  get byteLength(): number {
    return 0;
  }

  get ticksDropped(): number {
    return 0;
  }

  get readingsDropped(): number {
    return 0;
  }

  get eventsDropped(): number {
    return 0;
  }
}

/** The real sink: the per-chunk table plus the two steady-state rings. */
export class TableTraceSink implements TraceSink {
  private readonly rows = new RowTable();
  private readonly ticks = new TickRing();
  private readonly readings = new ReadingRing();
  private readonly events = new EventRing();

  append(src: ChunkRowSource, tier: 0 | 1): number {
    return this.rows.append(src, tier);
  }

  setLabel(index: number, label: WireLabel): void {
    this.rows.setLabel(index, label);
  }

  stamp(index: number, boundary: number, offsetUs: number): void {
    this.rows.stamp(index, boundary, offsetUs);
  }

  setOutcome(index: number, outcome: RowOutcomeValue): void {
    this.rows.setOutcome(index, outcome);
  }

  serialise(): TraceRow[] {
    return this.rows.serialise();
  }

  appendTick(atUs: number, scratch: TickScratch, counted: Uint32Array): void {
    this.ticks.append(atUs, scratch, counted);
  }

  serialiseTicks(): TraceTick[] {
    return this.ticks.serialise();
  }

  appendReading(atUs: number, values: Float64Array): void {
    this.readings.append(atUs, values);
  }

  serialiseReadings(): TraceReading[] {
    return this.readings.serialise();
  }

  appendEvent(
    atUs: number,
    kind: PointEventIndex,
    reason: PointEventReason,
    chunk: ChunkEventSource | null,
    tier: 0 | 1,
  ): void {
    this.events.append(atUs, kind, reason, chunk, tier);
  }

  serialiseEvents(): TracePointEvent[] {
    return this.events.serialise();
  }

  get length(): number {
    return this.rows.length;
  }

  /** Every tier a run holds, because the resident cap in ADR 0049 is on the run. */
  get byteLength(): number {
    return (
      this.rows.byteLength +
      this.ticks.byteLength +
      this.readings.byteLength +
      this.events.byteLength
    );
  }

  get ticksDropped(): number {
    return this.ticks.dropped;
  }

  get readingsDropped(): number {
    return this.readings.dropped;
  }

  get eventsDropped(): number {
    return this.events.dropped;
  }
}

export type TraceSinkFactory = () => TraceSink;

export const tableSinkFactory: TraceSinkFactory = () => new TableTraceSink();
export const noopSinkFactory: TraceSinkFactory = () => new NoopTraceSink();
