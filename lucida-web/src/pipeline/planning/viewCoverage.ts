/**
 * How much of what each view asks for admission lets through, when several
 * views share the page's memory. Under pressure a view covers less, and says
 * so; the page's own settle already waits for every view's chunks, since the
 * cache drives toward the union of their plans.
 */
import { requestIdentity } from "./plan.ts";
import type { ChunkRequest } from "./types.ts";

export interface ViewCoverage {
  /** Its own detail and coarse requests, across every dataset it draws. */
  wanted: number;
  /** Those admission left out for want of room. */
  short: number;
  /** Those admission let through, which the view settles on once each is held and on the GPU. */
  admitted: ChunkRequest[];
}

/** Count one dataset's plan into each view's coverage. */
export function tallyViewCoverage(
  coverage: Map<number, ViewCoverage>,
  byView: ReadonlyMap<number, readonly ChunkRequest[]>,
  admitted: readonly ChunkRequest[],
): void {
  const admittedIds = new Set(admitted.map(requestIdentity));
  for (const [view, own] of byView) {
    let entry = coverage.get(view);
    if (!entry) {
      entry = { wanted: 0, short: 0, admitted: [] };
      coverage.set(view, entry);
    }
    for (const req of own) {
      entry.wanted++;
      if (admittedIds.has(requestIdentity(req))) entry.admitted.push(req);
      else entry.short++;
    }
  }
}
