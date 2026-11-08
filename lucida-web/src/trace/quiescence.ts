/**
 * The published quiescence predicate.
 *
 * Quiescence is a boolean the page publishes, never something inferred from
 * outside. A driver can only watch the frame counter stop, and that is wrong
 * in the one case that matters: a stalled pipeline and a finished one both
 * stop drawing.
 */

import type { Outstanding } from "./types.ts";

/**
 * What the page measures. The render loop supplies the three flags; the CPU
 * cache supplies the {@link Outstanding} half through `quiescenceInputs()`.
 */
export interface CacheQuiescenceInputs extends Outstanding {
  /**
   * True when the pending queue was too deep to classify by lane. The scan
   * is bounded so the predicate cannot cost more than the tick it runs in;
   * an unclassified queue reads as "not quiescent", which keeps a run open
   * rather than closing one early on a guess.
   */
  pendingUnclassified: boolean;
  /**
   * Wanted chunks of each tier that the source failed for good. Nothing asks
   * for them again until the dataset is reopened, so waiting on them would
   * never end: the view settles without them, and the failure says why.
   */
  failedDetailChunks: number;
  failedCoarseChunks: number;
}

/** The cache's half plus the render loop's own three flags. */
export interface QuiescenceInputs extends CacheQuiescenceInputs {
  interactiveDirty: boolean;
  residencyDirty: boolean;
  frameInFlight: boolean;
}

export interface QuiescenceState extends QuiescenceInputs {
  quiescent: boolean;
  /** Why not — or `"quiescent"`. Names the first unmet clause. */
  reason: string;
  /** `performance.now()` at publication. */
  at: number;
}

/**
 * A zeroed state, for a caller that will reuse one instance across ticks.
 * The publish path runs every tick, and the monitor must not allocate in
 * steady state: its own GC pauses would appear as stalls in its own trace.
 */
export function createQuiescenceState(): QuiescenceState {
  return {
    interactiveDirty: false,
    residencyDirty: false,
    frameInFlight: false,
    desiredDetailChunks: 0,
    residentDetailChunks: 0,
    desiredCoarseChunks: 0,
    residentCoarseChunks: 0,
    detailBytes: 0,
    detailBudgetBytes: 0,
    coarseBytes: 0,
    coarseBudgetBytes: 0,
    pending: 0,
    inFlight: 0,
    speculativePending: 0,
    speculativeInFlight: 0,
    pendingUnclassified: false,
    failedDetailChunks: 0,
    failedCoarseChunks: 0,
    quiescent: false,
    reason: "unpublished",
    at: 0,
  };
}

/**
 * Decide the predicate over `state`'s already-filled inputs, in place. The
 * caller fills the input fields, this fills `reason`, `quiescent` and `at`.
 */
export function evaluateQuiescence(state: QuiescenceState, at: number): QuiescenceState {
  const reason = quiescenceReason(state);
  state.at = at;
  state.reason = reason;
  state.quiescent = reason === "quiescent";
  return state;
}

function quiescenceReason(i: QuiescenceInputs): string {
  if (i.interactiveDirty) return "interactive_dirty";
  if (i.residencyDirty) return "residency_dirty";
  if (i.frameInFlight) return "frame_in_flight";
  if (i.pendingUnclassified) return "pending_unclassified";
  if (i.inFlight > 0) return "chunks_in_flight";
  if (i.pending > 0) return "chunks_pending";
  if (i.residentDetailChunks + i.failedDetailChunks < i.desiredDetailChunks) {
    return "detail_not_resident";
  }
  if (i.residentCoarseChunks + i.failedCoarseChunks < i.desiredCoarseChunks) {
    return "coarse_not_resident";
  }
  return "quiescent";
}
