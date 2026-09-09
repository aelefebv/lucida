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

import type { EndReason, Phase, RunCause, TraceReading, TraceTick } from "./types.ts";

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

/**
 * Where a reader of the steady-state tiers left off (#1068).
 *
 * An interval's clock starts at zero, so an offset alone is ambiguous the
 * moment one interval hands over to the next. Carrying the interval the
 * offset belongs to makes the handover visible: a sample taken against a
 * cursor from a previous interval reads that interval from its start rather
 * than from an offset that means nothing in it.
 */
export interface WatchCursor {
  intervalId: string;
  /** Microseconds from that interval's start. */
  atUs: number;
}

/**
 * One sample of the steady-state tiers, taken without closing the interval
 * and without walking a row: the newest reading and the planning samples
 * since the cursor.
 *
 * The third read that does not conclude the interval it describes, beside
 * {@link LiveProgress} and the provisional reading. It exists because the
 * watch stream publishes what happened since its last aggregate a few times
 * a second, and every other way to those tiers serialises the whole ring.
 */
export interface WatchSample {
  /** The interval sampled, labelled or not, and the cursor's other half. */
  intervalId: string;
  /** The labelled run open at the sample, or null in the steady state. */
  runId: string | null;
  /** Microseconds from the interval's start at the sample. */
  atUs: number;
  /** The newest reading taken since the cursor, or null when none was. */
  reading: TraceReading | null;
  /** The planning samples taken since the cursor, oldest first. */
  ticks: TraceTick[];
}

/** An edge of a labelled run: the moment it opened, or the moment it ended. */
export interface RunBoundary {
  runId: string;
  cause: RunCause;
  /** Null on the opening edge. */
  endReason: EndReason | null;
  /** How long the run lasted, on the closing edge; null on the opening one. */
  durationUs: number | null;
}
