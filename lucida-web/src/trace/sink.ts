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

import type { ChunkReading } from "./diagnose/chunkStates.ts";
import { EventRing } from "./eventRing.ts";
import { ReadingRing } from "./readingRing.ts";
import { RowTable, type LiveTally } from "./rowTable.ts";
import { TickRing, type TickScratch } from "./tickRing.ts";
import {
  NEVER_ADMITTED,
  NOT_DISPATCHED,
  type AdmissionColumns,
  type ChunkCoordinates,
  type ChunkEventSource,
  type ChunkRowSource,
  type LevelChangeReason,
  type MatchedRow,
  type PointEventIndex,
  type PointEventReason,
  type RowOutcomeValue,
  type TraceReading,
  type TracePointEvent,
  type TraceRow,
  type TraceTick,
  type WireLabel,
} from "./types.ts";

export interface TraceSink {
  /** Returns the row's index within this sink. */
  append(src: ChunkRowSource, tier: 0 | 1): number;
  setLabel(index: number, label: WireLabel): void;
  stamp(index: number, boundary: number, offsetUs: number): void;
  /** The payload bytes the wire delivered for the row. */
  setBytes(index: number, bytes: number): void;
  setOutcome(index: number, outcome: RowOutcomeValue): void;
  /**
   * The rows so far, tallied for the live view (#937). The one read that
   * happens while the interval is still open.
   */
  liveTally(occupancy: Uint32Array): LiveTally;
  serialise(): TraceRow[];
  /**
   * `counted` is the counted-not-timed phase tally since the previous tick,
   * and `sent` the client's sends since then, by message type.
   */
  appendTick(atUs: number, scratch: TickScratch, counted: Uint32Array, sent: Uint32Array): void;
  serialiseTicks(): TraceTick[];
  /**
   * The tick samples from `startUs` on, led by the one before it. A live
   * read, like {@link serialiseReadingsFrom}: the dock's live charts draw the
   * per-tick tiers of an open run from these and walk no row.
   */
  serialiseTicksFrom(startUs: number): TraceTick[];
  /**
   * `values` is one reading, in `READING_NAMES` order. `gpuPassUs` is the GPU
   * pass time that arrived since the previous reading, or null when none did.
   */
  appendReading(atUs: number, values: Float64Array, gpuPassUs: number | null): void;
  serialiseReadings(): TraceReading[];
  /**
   * The readings from `startUs` on, led by the one in force at that instant
   * (#1057). The other read that happens while the interval is still open:
   * a provisional reading over a trailing window is derived from these and
   * from the live tally, and from no row.
   */
  serialiseReadingsFrom(startUs: number): TraceReading[];
  appendEvent(
    atUs: number,
    kind: PointEventIndex,
    reason: PointEventReason,
    chunk: ChunkEventSource | null,
    tier: 0 | 1,
  ): void;
  /** A `level-change` point event: the dataset's target moved from one range to another. */
  appendLevelChange(
    atUs: number,
    reason: LevelChangeReason,
    datasetId: string,
    fromMin: number,
    fromMax: number,
    toMin: number,
    toMax: number,
  ): void;
  serialiseEvents(): TracePointEvent[];
  /** The point events from `startUs` on. A live read, for the same surface as {@link serialiseTicksFrom}. */
  serialiseEventsFrom(startUs: number): TracePointEvent[];
  /**
   * One chunk's reading from the row table's identity index (#1062): its
   * newest row's state and age, its row count and its fetch count. The
   * third read that happens while the interval is still open, and like the
   * other two it walks no row. Null when the interval holds no row for it.
   */
  readChunk(chunk: ChunkCoordinates, closeUs: number): ChunkReading | null;
  /** Every row of one chunk, oldest first, each with its index in the table. */
  chunkRows(chunk: ChunkCoordinates): MatchedRow[];
  /** The admission columns the chunk lookup ranks a row against. */
  admissionColumns(): AdmissionColumns;
  readonly length: number;
  /**
   * Whether this sink recorded nothing at all, across every tier. An
   * unlabelled interval that saw no work is not an artifact and is discarded
   * rather than retained under the cap.
   */
  readonly isEmpty: boolean;
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

  setBytes(): void {}

  setOutcome(): void {}

  liveTally(occupancy: Uint32Array): LiveTally {
    occupancy.fill(0);
    return { complete: 0, retired: 0, inFlight: 0, unstamped: 0 };
  }

  serialise(): TraceRow[] {
    return [];
  }

  appendTick(): void {}

  serialiseTicks(): TraceTick[] {
    return [];
  }

  serialiseTicksFrom(): TraceTick[] {
    return [];
  }

  appendReading(): void {}

  serialiseReadings(): TraceReading[] {
    return [];
  }

  serialiseReadingsFrom(): TraceReading[] {
    return [];
  }

  appendEvent(): void {}

  appendLevelChange(): void {}

  serialiseEvents(): TracePointEvent[] {
    return [];
  }

  serialiseEventsFrom(): TracePointEvent[] {
    return [];
  }

  readChunk(): ChunkReading | null {
    return null;
  }

  chunkRows(): MatchedRow[] {
    return [];
  }

  admissionColumns(): AdmissionColumns {
    return { length: 0, admittedUs: () => NEVER_ADMITTED, dispatchedUs: () => NOT_DISPATCHED };
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

  setBytes(index: number, bytes: number): void {
    this.rows.setBytes(index, bytes);
  }

  setOutcome(index: number, outcome: RowOutcomeValue): void {
    this.rows.setOutcome(index, outcome);
  }

  liveTally(occupancy: Uint32Array): LiveTally {
    return this.rows.liveTally(occupancy);
  }

  serialise(): TraceRow[] {
    return this.rows.serialise();
  }

  appendTick(atUs: number, scratch: TickScratch, counted: Uint32Array, sent: Uint32Array): void {
    this.ticks.append(atUs, scratch, counted, sent);
  }

  serialiseTicks(): TraceTick[] {
    return this.ticks.serialise();
  }

  serialiseTicksFrom(startUs: number): TraceTick[] {
    return this.ticks.serialiseFrom(startUs);
  }

  appendReading(atUs: number, values: Float64Array, gpuPassUs: number | null): void {
    this.readings.append(atUs, values, gpuPassUs);
  }

  serialiseReadings(): TraceReading[] {
    return this.readings.serialise();
  }

  serialiseReadingsFrom(startUs: number): TraceReading[] {
    return this.readings.serialiseFrom(startUs);
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

  appendLevelChange(
    atUs: number,
    reason: LevelChangeReason,
    datasetId: string,
    fromMin: number,
    fromMax: number,
    toMin: number,
    toMax: number,
  ): void {
    this.events.appendLevelChange(atUs, reason, datasetId, fromMin, fromMax, toMin, toMax);
  }

  serialiseEvents(): TracePointEvent[] {
    return this.events.serialise();
  }

  serialiseEventsFrom(startUs: number): TracePointEvent[] {
    return this.events.serialiseFrom(startUs);
  }

  readChunk(chunk: ChunkCoordinates, closeUs: number): ChunkReading | null {
    return this.rows.readChunk(chunk, closeUs);
  }

  chunkRows(chunk: ChunkCoordinates): MatchedRow[] {
    const newest = this.rows.newestRowOf(chunk);
    if (newest < 0) return [];
    return this.rows.rowsOf(newest).map((index) => ({ row: this.rows.rowAt(index), index }));
  }

  admissionColumns(): AdmissionColumns {
    return this.rows.admissionColumns();
  }

  get length(): number {
    return this.rows.length;
  }

  get isEmpty(): boolean {
    return (
      this.rows.length === 0 &&
      this.ticks.length === 0 &&
      this.readings.length === 0 &&
      this.events.length === 0
    );
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
