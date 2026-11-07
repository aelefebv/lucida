/**
 * Which of the two independent residency populations a resident chunk
 * belongs to (see `CONTEXT.md`). The tiers have separate budgets and
 * separate eviction, so the same chunk key can be resident once under
 * each.
 *
 * This module is the one home for the name. Planning stamps it on every
 * request, the CPU cache stores by it, the worker keys its pools on it,
 * and the trace records it on every row.
 */
export type ResidencyTier = "detail" | "coarse";

/**
 * The tiers in index order. The trace's row table stores a tier as its
 * index into this array and the recorder writes that index directly, so
 * the order must not change.
 */
export const RESIDENCY_TIERS: readonly ResidencyTier[] = ["detail", "coarse"];
