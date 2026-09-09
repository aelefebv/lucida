/**
 * The window: which stretch of the run's clock a derivation reads.
 *
 * One resolver and one clip, shared by the rollup, the critical path, the
 * limiters and the coverage block, so that "inside the window" means the same
 * thing to all of them. A row that crosses an edge counts for the part inside,
 * on every table. A rollup that clipped and a chain that did not would
 * disagree about the same row.
 *
 * No window is the whole run, and the whole run is a window like any other:
 * the tables clip to `[0, wall]` either way, which is what lets a full-window
 * reading equal an unwindowed one by construction rather than by test.
 */

import type { TraceRun } from "../types.ts";
import type { DiagnosticWindow, WindowRequest } from "./types.ts";

/** A window in the trace's own units, resolved against one run. */
export interface RunWindow {
  startUs: number;
  endUs: number;
  /** True when the window is the whole run, so nothing is left out for want of a position. */
  whole: boolean;
  /**
   * True when a caller asked for a window, even the whole run. Decides whether
   * the document states one: a reading nobody scoped carries no window, and a
   * reading someone scoped to the whole run says so.
   */
  requested: boolean;
}

/**
 * Resolve a request against the run: clamp it to `[0, wall]` and refuse an
 * interval that is empty once clamped. A window past the end is clamped rather
 * than refused, because "to the end" is what a hand-typed `..99999` means, and
 * the document states what was actually read.
 */
export function resolveWindow(run: TraceRun, request?: WindowRequest): RunWindow {
  const wallUs = Math.max(0, run.header.durationUs);
  if (!request) return { startUs: 0, endUs: wallUs, whole: true, requested: false };
  if (!Number.isFinite(request.startMs) || !Number.isFinite(request.endMs)) {
    throw new Error(`a window needs two finite millisecond offsets, not ${request.startMs}..${request.endMs}`);
  }
  // The document prints the wall to a tenth of a millisecond, so an end typed
  // back from it can miss the wall by up to half of that. That is the whole
  // run, not a window 50 µs short of it that would leave unplaced rows out.
  const startUs = snap(clamp(Math.round(request.startMs * 1_000), 0, wallUs), 0);
  const endUs = snap(clamp(Math.round(request.endMs * 1_000), 0, wallUs), wallUs);
  if (endUs <= startUs) {
    throw new Error(
      `window ${request.startMs}..${request.endMs} ms is empty on a run of ${usToMsExact(wallUs)} ms`,
    );
  }
  return { startUs, endUs, whole: startUs === 0 && endUs === wallUs, requested: true };
}

/** The document's statement of the window, in the diagnostic's units. */
export function describeWindow(run: TraceRun, window: RunWindow): DiagnosticWindow {
  return {
    startMs: usToMsExact(window.startUs),
    endMs: usToMsExact(window.endUs),
    spanMs: usToMsExact(window.endUs - window.startUs),
    ofWallMs: usToMsExact(Math.max(0, run.header.durationUs)),
    whole: window.whole,
  };
}

/** A positioned span clipped to the window, or null when none of it is inside. */
export interface ClippedSpan {
  startUs: number;
  endUs: number;
  us: number;
  /** True when an edge cut the span, so the part inside is less than the whole. */
  clipped: boolean;
}

export function clipSpan(startUs: number, endUs: number, window: RunWindow): ClippedSpan | null {
  const clippedStartUs = Math.max(startUs, window.startUs);
  const clippedEndUs = Math.min(endUs, window.endUs);
  if (clippedEndUs <= clippedStartUs) return null;
  return {
    startUs: clippedStartUs,
    endUs: clippedEndUs,
    us: clippedEndUs - clippedStartUs,
    clipped: clippedStartUs !== startUs || clippedEndUs !== endUs,
  };
}

/** Whether an instant falls inside the window. Start inclusive, end inclusive: a reading at the edge belongs. */
export function inWindow(atUs: number, window: RunWindow): boolean {
  return atUs >= window.startUs && atUs <= window.endUs;
}

/**
 * The window as a command line spells it: `START..END` in milliseconds from
 * run start. One spelling, shared by the follow-up commands the text prints
 * and the reason a windowed chain gives for being undefined, so the flag a
 * reader types is the one the document showed them.
 */
export function windowLabel(window: RunWindow): string {
  return labelMs(usToMsExact(window.startUs), usToMsExact(window.endUs));
}

/** The same spelling for an interval already in milliseconds. */
export function labelMs(startMs: number, endMs: number): string {
  return `${startMs}..${endMs}`;
}

/** The span in whole and fractional milliseconds, without the rollup's tenth-of-a-millisecond rounding: an edge is where the caller put it. */
function usToMsExact(us: number): number {
  return us / 1_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Half of the tenth of a millisecond the document rounds to. */
const EDGE_TOLERANCE_US = 50;

function snap(us: number, edgeUs: number): number {
  return Math.abs(us - edgeUs) <= EDGE_TOLERANCE_US ? edgeUs : us;
}
