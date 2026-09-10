/**
 * What one lifecycle row says about itself: where it stood when the run
 * closed, when it was first seen, and how long it has been alive.
 *
 * Shared by the chunk lookup and the spatial summary, so "in the queue" means
 * one thing in both. A row carries only the phases it finished (spans exist
 * only at export), so the phase a row is *in* is the one after the last it
 * finished, and a row that finished nothing has no position at all.
 */

import { PHASES, type TraceRow } from "../types.ts";
import type { RowState } from "./types.ts";

const STATE_ORDER: readonly RowState[] = ["unstamped", ...PHASES, "complete", "retired"];

export function rowState(row: TraceRow): RowState {
  if (row.outcome === "complete") return "complete";
  if (row.outcome === "retired") return "retired";
  let last = -1;
  for (let i = 0; i < PHASES.length; i += 1) if (row.phases[PHASES[i]]) last = i;
  if (last < 0) return "unstamped";
  // A row that finished `present` but is still marked in flight has no next
  // phase; it stays at the table's end.
  return PHASES[Math.min(last + 1, PHASES.length - 1)];
}

/** Where a state sorts: rows still in flight before rows that ended. */
export function stateRank(state: RowState): number {
  return STATE_ORDER.indexOf(state);
}

/** A state as prose: a phase reads as "in wire", an ending as itself. */
export function describeState(state: RowState): string {
  return state === "complete" || state === "retired" || state === "unstamped" ? state : `in ${state}`;
}

/** Run-relative microseconds of the row's first boundary, or null when it reached none. */
export function firstBoundaryUs(row: TraceRow): number | null {
  let first: number | null = null;
  for (const timing of Object.values(row.phases)) {
    if (first === null || timing.startUs < first) first = timing.startUs;
  }
  return first;
}

/** Run-relative microseconds of the row's last boundary, or null when it reached none. */
export function lastBoundaryUs(row: TraceRow): number | null {
  let last: number | null = null;
  for (const timing of Object.values(row.phases)) {
    if (last === null || timing.endUs > last) last = timing.endUs;
  }
  return last;
}

/**
 * The stretch of the run's clock a row was alive for: first boundary to
 * last for a row that ended, and first boundary to run close for one still
 * in flight. Null when the row reached no boundary, because a position from
 * nowhere is a number with no row behind it. The age is this stretch's
 * length, and a window sees the row when it overlaps this stretch.
 */
export function rowSpanUs(row: TraceRow, closeUs: number): { startUs: number; endUs: number } | null {
  const first = firstBoundaryUs(row);
  if (first === null) return null;
  const end = row.outcome === "in-flight" ? closeUs : (lastBoundaryUs(row) ?? closeUs);
  return { startUs: first, endUs: Math.max(first, end) };
}

/** How long the row has been alive, or null when it reached no boundary. */
export function rowAgeUs(row: TraceRow, closeUs: number): number | null {
  const span = rowSpanUs(row, closeUs);
  return span === null ? null : span.endUs - span.startUs;
}
