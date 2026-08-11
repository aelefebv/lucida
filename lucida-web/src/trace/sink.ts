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
 */

import { RowTable } from "./rowTable.ts";
import type { ChunkRowSource, RowOutcomeValue, TraceRow } from "./types.ts";

export interface RowSink {
  /** Returns the row's index within this sink, or -1 if it kept nothing. */
  append(src: ChunkRowSource, tier: 0 | 1): number;
  stamp(index: number, boundary: number, offsetUs: number): void;
  setOutcome(index: number, outcome: RowOutcomeValue): void;
  serialise(): TraceRow[];
  readonly length: number;
  readonly byteLength: number;
}

/** The real sink: one fixed-width row per chunk in a growable columnar table. */
export class TableRowSink implements RowSink {
  private readonly table: RowTable;

  constructor(initialCapacity?: number) {
    this.table = new RowTable(initialCapacity);
  }

  append(src: ChunkRowSource, tier: 0 | 1): number {
    return this.table.append(src, tier);
  }

  stamp(index: number, boundary: number, offsetUs: number): void {
    this.table.stamp(index, boundary, offsetUs);
  }

  setOutcome(index: number, outcome: RowOutcomeValue): void {
    this.table.setOutcome(index, outcome);
  }

  serialise(): TraceRow[] {
    return this.table.serialise();
  }

  get length(): number {
    return this.table.length;
  }

  get byteLength(): number {
    return this.table.byteLength;
  }
}

/**
 * Keeps nothing and measures the call sites alone. Still hands back
 * increasing indices so the emit path takes exactly the branches it takes
 * with the real sink.
 */
export class NoopRowSink implements RowSink {
  private rows = 0;

  append(): number {
    return this.rows++;
  }

  stamp(): void {}

  setOutcome(): void {}

  serialise(): TraceRow[] {
    return [];
  }

  get length(): number {
    return this.rows;
  }

  get byteLength(): number {
    return 0;
  }
}

export type RowSinkFactory = () => RowSink;

export const tableRowSinkFactory: RowSinkFactory = () => new TableRowSink();
export const noopRowSinkFactory: RowSinkFactory = () => new NoopRowSink();
