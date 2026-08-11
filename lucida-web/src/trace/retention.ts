/**
 * The retention policy: two caps, two rungs of degradation, and no third.
 *
 * Bytes are the unit because they bound the thing that actually matters under
 * a workload whose rate varies by three orders of magnitude between idle and
 * peak — a sixty-second window is zero bytes at idle and megabytes mid-orbit.
 * Whole intervals are the granularity of discard because a half-evicted run
 * is not a diagnostic artifact (ADR 0049).
 *
 * The reflex policy for a bounded buffer is a drop-oldest ring, and for the
 * per-chunk tier that is the actively wrong choice: the beginning of a run is
 * the diagnostic payload, so discarding it silently yields a trace that looks
 * complete while having deleted the stall being investigated.
 */

/**
 * Everything the recorder holds, across every retained interval and the one in
 * progress. About 1% of what the CPU cache is already configured to hold, and
 * small enough that arguing about the figure costs more than paying it.
 */
export const RESIDENT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * One interval's ceiling, separate from the resident cap on purpose: a runaway
 * run truncates itself instead of first evicting all the history around it.
 *
 * Roughly sixteen times the headroom the expensive measured case needs, so
 * reaching it means something pathological is happening — and a loud
 * truncation is a better diagnostic of pathology than a silently coarsened
 * trace that still looks complete. There is no sampling rung, no
 * granularity-reduction rung and no downsample-to-aggregates rung below this
 * one, by decision rather than by omission.
 */
export const PER_RUN_CAP_BYTES = 2 * 1024 * 1024;

/**
 * The workload the two caps above were derived at, carried in every document.
 * They are derived, not universal: a workload an order of magnitude larger
 * would truncate more often and should have them re-derived rather than be
 * quietly cut against numbers that never fitted it.
 */
export const CAP_DERIVATION = "measured volumes at a 384-member collection";
