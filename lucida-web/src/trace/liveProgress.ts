/**
 * What a run in progress can honestly say about itself (#937).
 *
 * Not a small verdict. A verdict is derived from a closed interval — the
 * attribution back-walk needs an end to walk back from, and a headline that
 * changes while you read it is not a headline. What a run *can* say mid-flight
 * is how much work it has made, how much of that has reached the screen, and
 * where the rest of it is sitting; that is this object, and nothing here is a
 * judgement.
 *
 * Read without exporting. Every other way into the recording concludes the
 * interval it is asked about, which is exactly what a live view must not do.
 */

import type { Phase, RunCause } from "./types.ts";

export interface LiveProgress {
  /**
   * The run being watched. Carried so the surface can read *this* run when it
   * closes: the export closes a fresh steady-state interval of its own, so
   * "the newest run in the document" is the export's artifact rather than the
   * run somebody was watching.
   */
  runId: string;
  cause: RunCause;
  /** Wall clock since the run opened. */
  elapsedMs: number;
  /**
   * Lifecycle rows this run has made. Every chunk the planner asked for and
   * the caps let through, so the three counts below partition it.
   */
  planned: number;
  /**
   * Rows that reached the screen. A row completes when the frame after its
   * upload is dispatched, so this is drawn pixels rather than bytes held.
   */
  visible: number;
  /** Rows still going. */
  inFlight: number;
  /** Rows abandoned — the view moved on, or the fetch failed. */
  retired: number;
  /**
   * Rows the caps refused. Named next to the counts they are missing from, so
   * a truncated run does not read as a run that stopped planning.
   */
  unrecorded: number;
  /** The phase bar: where the in-flight rows are sitting, this instant. */
  occupancy: LivePhaseOccupancy[];
  /** In-flight rows that have reached no boundary yet — planned, not admitted. */
  unstamped: number;
  /** The page's own predicate, and why it is not settled. */
  quiescent: boolean;
  quiescenceReason: string;
}

export interface LivePhaseOccupancy {
  phase: Phase;
  rows: number;
}
