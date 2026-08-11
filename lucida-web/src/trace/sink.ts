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
import type { ChunkRowSource, RowOutcomeValue, TraceRow, WireLabel } from "./types.ts";

export interface RowSink {
  /** Returns the row's index within this sink. */
  append(src: ChunkRowSource, tier: 0 | 1): number;
  setLabel(index: number, label: WireLabel): void;
  stamp(index: number, boundary: number, offsetUs: number): void;
  setOutcome(index: number, outcome: RowOutcomeValue): void;
  serialise(): TraceRow[];
  readonly length: number;
  readonly byteLength: number;
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

  setLabel(): void {}

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

/** The real sink: one fixed-width row per chunk in a growable columnar table. */
export const tableRowSinkFactory: RowSinkFactory = () => new RowTable();
export const noopRowSinkFactory: RowSinkFactory = () => new NoopRowSink();
