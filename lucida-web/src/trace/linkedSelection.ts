/**
 * The linked selection: the chunk set a brushed window in the dock
 * publishes, and the one place the overlay reads it from.
 *
 * The dock is the temporal surface and the overlay the spatial one. They
 * link through a selection and do not merge (ADR 0052 as amended), and this
 * module is the link: one slot holding the current set, a publish, and a
 * listener. The dock never reaches into the overlay and the overlay never
 * reaches into the dock; each imports this file and nothing of the other.
 *
 * Kept beside the trace rather than under either surface for that reason.
 * The set itself is derived by `diagnose/chunkSelection.ts`, from the same
 * rows the phase table reads over the same window.
 */

import type { ChunkSelection } from "./diagnose/chunkSelection.ts";

let current: ChunkSelection | null = null;
const listeners = new Set<() => void>();

/** The set on screen, or null when no window is brushed. */
export function currentChunkSelection(): ChunkSelection | null {
  return current;
}

/**
 * Replace the published set. Null clears it, which is what clearing the
 * brush does. Publishing the set already held says nothing to anyone.
 */
export function publishChunkSelection(selection: ChunkSelection | null): void {
  if (selection === current) return;
  current = selection;
  for (const listener of listeners) listener();
}

/** Hear every change. Returns the unsubscribe. */
export function onChunkSelectionChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
