/**
 * The published quiescence predicate (ADR 0051).
 *
 * Quiescence is a boolean the page publishes, never something inferred from
 * outside. Watching the frame counter stop is the only thing possible from a
 * driver, and it is wrong in the one case that matters: a stalled pipeline
 * and a finished one both stop drawing.
 *
 * Both halves of the predicate already existed unpublished — the render loop
 * knows when no dirty flag is set and no frame is in flight, and the CPU
 * cache already computes resident detail against desired detail next to its
 * pending and in-flight counts. This module is where they meet.
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
 * The publish path runs every tick, and ADR 0049 asks the monitor not to
 * allocate in steady state: its own GC pauses would appear as stalls in its
 * own trace.
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
    pending: 0,
    inFlight: 0,
    speculativePending: 0,
    speculativeInFlight: 0,
    pendingUnclassified: false,
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
  if (i.residentDetailChunks < i.desiredDetailChunks) return "detail_not_resident";
  if (i.residentCoarseChunks < i.desiredCoarseChunks) return "coarse_not_resident";
  return "quiescent";
}
