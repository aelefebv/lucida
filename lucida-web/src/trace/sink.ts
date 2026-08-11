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
 * One sink holds all three browser tiers a run records: the complete
 * per-chunk table, the per-tick aggregate ring, and the point-event ring.
 */

import { EventRing } from "./eventRing.ts";
import { RowTable } from "./rowTable.ts";
import { TickRing, type TickScratch } from "./tickRing.ts";
import type {
  ChunkEventSource,
  ChunkRowSource,
  PointEventIndex,
  PointEventReason,
  RowOutcomeValue,
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
  appendEvent(
    atUs: number,
    kind: PointEventIndex,
    reason: PointEventReason,
    chunk: ChunkEventSource | null,
    tier: 0 | 1,
  ): void;
  serialiseEvents(): TracePointEvent[];
  readonly length: number;
  /**
   * Whether this sink recorded nothing at all, across every tier. An
   * unlabelled interval that saw no work is not an artifact and is discarded
   * rather than retained under the cap.
   */
  readonly isEmpty: boolean;
  readonly byteLength: number;
  readonly ticksDropped: number;
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

  appendEvent(): void {}

  serialiseEvents(): TracePointEvent[] {
    return [];
  }

  get length(): number {
    return this.rows;
  }

  get isEmpty(): boolean {
    return true;
  }

  get byteLength(): number {
    return 0;
  }

  get ticksDropped(): number {
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

  get isEmpty(): boolean {
    return this.rows.length === 0 && this.ticks.length === 0 && this.events.length === 0;
  }

  /** Every tier a run holds, because the resident cap in ADR 0049 is on the run. */
  get byteLength(): number {
    return this.rows.byteLength + this.ticks.byteLength + this.events.byteLength;
  }

  get ticksDropped(): number {
    return this.ticks.dropped;
  }

  get eventsDropped(): number {
    return this.events.dropped;
  }
}

export type TraceSinkFactory = () => TraceSink;

export const tableSinkFactory: TraceSinkFactory = () => new TableTraceSink();
export const noopSinkFactory: TraceSinkFactory = () => new NoopTraceSink();
