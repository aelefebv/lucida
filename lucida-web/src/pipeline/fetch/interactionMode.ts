/**
 * Interaction-mode detector.
 *
 * Buffers a sliding window of `SceneEpochs` snapshots and derives the
 * current interaction mode from the deltas. The CPU cache reads the
 * mode to bias eviction tier order — panning protects active-detail,
 * scrubbing protects prefetch (the next-time-step chunks the user is
 * actively skimming through), idle uses the panning order as a default.
 *
 * Pure: no clock, no I/O. Push fresh epochs each `submit()` tick;
 * the mode is recomputed on each `current()` call from the buffered
 * history.
 */
import type { SceneEpochs } from "../epochs.ts";

export type InteractionMode = "panning" | "scrubbing" | "idle";

export class InteractionModeDetector {
  private readonly windowSize: number;
  private epochHistory: SceneEpochs[] = [];

  constructor(windowSize: number) {
    this.windowSize = windowSize;
  }

  /** Append a fresh epochs snapshot; drop the oldest when over windowSize. */
  push(epochs: SceneEpochs): void {
    this.epochHistory.push({ ...epochs });
    if (this.epochHistory.length > this.windowSize) {
      this.epochHistory.shift();
    }
  }

  /** Derive the current interaction mode from the buffered history. */
  current(): InteractionMode {
    if (this.epochHistory.length < 2) return "idle";

    let viewBumps = 0;
    let selectionBumps = 0;
    for (let i = 1; i < this.epochHistory.length; i++) {
      if (this.epochHistory[i].view !== this.epochHistory[i - 1].view) viewBumps++;
      if (this.epochHistory[i].selection !== this.epochHistory[i - 1].selection) selectionBumps++;
    }

    if (selectionBumps > viewBumps && selectionBumps >= 2) return "scrubbing";
    if (viewBumps >= 2) return "panning";
    return "idle";
  }

  /** Drop the buffered history. Used by `CpuCache.reset()`. */
  reset(): void {
    this.epochHistory = [];
  }
}
