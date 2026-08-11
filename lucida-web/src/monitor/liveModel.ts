/**
 * The run in progress, as a surface renders it (#937).
 *
 * Counters and a phase bar, and deliberately nothing that reads as a verdict.
 * The prototype's auto-following window was nearly useless — by the time you
 * look, the interesting part of an open has scrolled out of the window — so
 * there is no window here at all: every number is cumulative over the whole
 * run, and the bar is the rows in flight this instant. Nothing on this view
 * moves out of reach while you read it.
 *
 * A verdict is withheld until the run closes because closing the interval is
 * what makes it analysable: the attribution back-walk needs an end to walk
 * back from, and a headline that changes as you read it is not one.
 */

import type { LiveProgress } from "../trace/liveProgress.ts";
import { formatCause, formatMs } from "./monitorModel.ts";

export interface LiveCounter {
  label: string;
  value: string;
  /**
   * What the number counts, so it is never read as a rate or a verdict. Not
   * `note` — that word belongs to a finding that is not a stall, and the two
   * would sit on the same surface.
   */
  meaning: string;
}

export interface LiveBarSegment {
  /** A phase id, or `planned` for rows that have reached no boundary yet. */
  id: string;
  rows: number;
  /** Share of the rows in flight, as a percentage. */
  pct: number;
}

export interface LiveView {
  runId: string;
  cause: string;
  elapsed: string;
  /** The page's own quiescence predicate, in its own words. */
  quiescence: string;
  counters: LiveCounter[];
  /** Empty when nothing is in flight — a bar of zeroes is not a shape. */
  bar: LiveBarSegment[];
  /** Truncation, said next to the counts it is missing from, or null. */
  unrecorded: string | null;
}

/** Rows that exist but have stamped no boundary — planned, not yet admitted. */
const PLANNED_SEGMENT = "planned";

export function buildLiveView(progress: LiveProgress): LiveView {
  const inFlight = progress.inFlight;
  const segments: LiveBarSegment[] = [];
  if (progress.unstamped > 0) {
    segments.push(segment(PLANNED_SEGMENT, progress.unstamped, inFlight));
  }
  for (const slot of progress.occupancy) {
    if (slot.rows > 0) segments.push(segment(slot.phase, slot.rows, inFlight));
  }

  return {
    runId: progress.runId,
    cause: formatCause(progress.cause),
    elapsed: formatMs(progress.elapsedMs),
    quiescence: progress.quiescent
      ? "quiescent — the run closes once that holds"
      : progress.quiescenceReason,
    counters: [
      {
        label: "planned",
        value: count(progress.planned),
        meaning: "chunks this run has asked for",
      },
      {
        label: "visible",
        value: count(progress.visible),
        meaning: "drawn in a frame",
      },
      {
        label: "in flight",
        value: count(progress.inFlight),
        meaning: "still going",
      },
      {
        label: "retired",
        value: count(progress.retired),
        meaning: "abandoned — the view moved on, or the fetch failed",
      },
    ],
    bar: segments,
    unrecorded:
      progress.unrecorded > 0
        ? `${count(progress.unrecorded)} rows past the per-run cap are not in these counts`
        : null,
  };
}

function segment(id: string, rows: number, inFlight: number): LiveBarSegment {
  return { id, rows, pct: inFlight > 0 ? (rows / inFlight) * 100 : 0 };
}

function count(value: number): string {
  return value.toLocaleString();
}
