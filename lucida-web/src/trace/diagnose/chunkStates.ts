/**
 * The per-chunk states: for every row identity an interval recorded, where
 * its newest row stands and how many times the interval fetched it.
 *
 * This is what the overlay's phase color and churn tint paint. It is
 * derived here, beside the chunk lookup and the spatial summary, so the
 * picture in space reads the same rules as the text: a row's state is
 * {@link rowState}'s, and a fetch is a row whose wire closed, which is what
 * the steady-state refetch rule counts (`summariseRefetch`). The window
 * every count is over is the interval's span, stated on the result, because
 * a count without a denominator is not a measurement.
 *
 * Unlike the document's sections this grows with the distinct chunks an
 * interval touched, so it is not a section of the diagnostic document. It is
 * the batched form of the chunk lookup, for a surface that has to color every
 * chunk on screen at once, and it has two readers. A surface fed a document,
 * such as a test over a fixture run or the dock's linked selection, reads it
 * directly. The overlay over an interval still being written reads the same
 * shape from the recorder's identity index instead, which answers without a
 * row walk; this function is the reference that read is held to, in
 * `rowTable.test.ts` and `recorderChunkIndex.test.ts`.
 */

import type { TraceRow, TraceRun } from "../types.ts";
import { nullableUsToMs, usToMs } from "./phaseRollup.ts";
import { rowAgeUs, rowState } from "./rowState.ts";
import type { RowState } from "./types.ts";

/** What one chunk's rows say about it, as the overlay reads it. */
export interface ChunkReading {
  /** Where the newest row stands: the phase it is in, or how it ended. */
  state: RowState;
  /** Rows carrying this identity in the interval. */
  rows: number;
  /**
   * Rows whose wire closed: how many times the interval fetched the chunk.
   * The churn count, over {@link ChunkStates.windowMs}.
   */
  fetches: number;
  /** The newest row's age, or null when it reached no boundary. */
  ageMs: number | null;
}

export interface ChunkStates {
  /** The interval's span in milliseconds: the window every count here is over. */
  windowMs: number;
  /** Rows the derivation read. */
  rowCount: number;
  /** Keyed by {@link chunkIdentity}. */
  byIdentity: Map<string, ChunkReading>;
  /** Chunks fetched more than once, as the refetch finding counts them. */
  refetchedChunks: number;
  /** Fetches beyond each chunk's first. */
  refetches: number;
}

/**
 * The row identity as one string: the dataset, the entity and the chunk key
 * together, which is what makes two fetches of one member's chunk the same
 * chunk rather than two. The same key the refetch rule groups by.
 */
export function chunkIdentity(datasetId: string, entityId: string, chunkKey: string): string {
  return `${datasetId}/${entityId}/${chunkKey}`;
}

/** Whether a row counts as a fetch: its wire closed. */
export function rowFetched(row: TraceRow): boolean {
  return row.phases.wire !== undefined;
}

export function deriveChunkStates(run: TraceRun): ChunkStates {
  const closeUs = run.header.durationUs;
  const byIdentity = new Map<string, ChunkReading>();
  // Rows are appended in dispatch order, so the last row seen for an
  // identity is its newest.
  for (const row of run.rows) {
    const identity = chunkIdentity(row.datasetId, row.entityId, row.chunkKey);
    const fetched = rowFetched(row) ? 1 : 0;
    const seen = byIdentity.get(identity);
    if (seen) {
      seen.rows += 1;
      seen.fetches += fetched;
      seen.state = rowState(row);
      seen.ageMs = nullableUsToMs(rowAgeUs(row, closeUs));
    } else {
      byIdentity.set(identity, {
        state: rowState(row),
        rows: 1,
        fetches: fetched,
        ageMs: nullableUsToMs(rowAgeUs(row, closeUs)),
      });
    }
  }

  let refetchedChunks = 0;
  let refetches = 0;
  for (const reading of byIdentity.values()) {
    if (reading.fetches < 2) continue;
    refetchedChunks += 1;
    refetches += reading.fetches - 1;
  }

  return {
    windowMs: usToMs(closeUs),
    rowCount: run.rows.length,
    byIdentity,
    refetchedChunks,
    refetches,
  };
}
