import { useSyncExternalStore } from "react";
import { settleSignal } from "../pipeline/settle.ts";

/**
 * The share of its wanted set the view settled covering, when the memory
 * budgets held less than it wanted; null while it covers everything or has
 * not settled.
 */
export function useCoverageLoss(): number | null {
  return useSyncExternalStore(subscribe, coverageLoss);
}

function subscribe(onChange: () => void): () => void {
  return settleSignal.subscribe(onChange);
}

function coverageLoss(): number | null {
  const state = settleSignal.state;
  if (settleSignal.outcome !== "settled" || state?.reason !== "coverage_limited") return null;
  return state.coverage;
}

/** What the viewer says about a view that settled covering less, in one quiet line. */
export function coverageNotice(coverage: number): string {
  // Floored, so a view one chunk short never reads as 100%.
  const pct = Math.floor(coverage * 100);
  return `Memory is full: this view holds ${pct}% of the data it asks for.`;
}
