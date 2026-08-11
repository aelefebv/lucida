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

/**
 * What the page measures. The render loop supplies the first three; the CPU
 * cache supplies the rest through `quiescenceInputs()`.
 *
 * Speculative (prefetch-lane) work is reported separately and never counted
 * against the predicate: the prefetch lane keeps requesting future
 * timepoints, so on a timeseries a naive "queues empty" test may never go
 * true. What is still outstanding at settle is reported, not hidden.
 */
export interface CacheQuiescenceInputs {
  desiredDetailChunks: number;
  residentDetailChunks: number;
  desiredCoarseChunks: number;
  residentCoarseChunks: number;
  pending: number;
  inFlight: number;
  speculativePending: number;
  speculativeInFlight: number;
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

export function evaluateQuiescence(inputs: QuiescenceInputs, at: number): QuiescenceState {
  const reason = quiescenceReason(inputs);
  return { ...inputs, at, reason, quiescent: reason === "quiescent" };
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
