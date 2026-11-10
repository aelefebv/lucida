/**
 * When the render loop may hand the GPU another viewport frame.
 *
 * A frame dispatched while earlier ones are still drawing queues behind them.
 * On a GPU slower than the frame clock the queue only grows: each frame in it
 * is drawn in full though the next replaces it, and while the GPU works
 * through them the page's frame callbacks, which deliver arriving chunks to
 * the GPU, wait as well. A view that is loading then spends its time drawing
 * frames nobody sees, one per handful of chunks, instead of loading.
 *
 * A GPU that finishes each frame within one frame callback is never held
 * here.
 */

import { LONG_FRAME_MS } from "./renderResolution.ts";

/**
 * Frames a view change may have on the GPU at once. One drawing and one
 * queued keeps a GPU that needs about a frame interval per frame busy, where
 * one at a time would leave it idle until the next callback.
 */
export const MAX_INTERACTIVE_FRAMES_IN_FLIGHT = 2;

/**
 * A full-quality volume frame is drawn in bands once the last one took
 * longer than this, dispatch to done. A frame on the GPU cannot be taken
 * back, so input that arrives while one draws waits for all of it, and on
 * a slow enough GPU the browser stops delivering input until it lands.
 */
export const BANDED_FRAME_MS = 150;

/** What each band of a banded frame aims to take. */
export const BAND_TARGET_MS = 50;

/** The most bands a frame is drawn in: each costs a submission and a trip back from the GPU. */
export const MAX_BANDS = 32;

/** Bands for a full-quality volume frame, from what the last one took; 1 draws it whole. */
export function bandsFor(fullQualityMs: number | null): number {
  if (fullQualityMs === null || fullQualityMs <= BANDED_FRAME_MS) return 1;
  return Math.min(MAX_BANDS, Math.ceil(fullQualityMs / BAND_TARGET_MS));
}

export class FramePacer {
  /** When the newest finished frame was heard of, and how long it took. */
  private lastDoneAt = Number.NEGATIVE_INFINITY;
  private lastFrameMs = 0;

  /** A frame finished `frameMs` after it was dispatched; the loop heard at `at`. */
  noteFrameDone(frameMs: number, at: number): void {
    this.lastDoneAt = at;
    this.lastFrameMs = frameMs;
  }

  /**
   * Whether a frame for a view change may go now. A second frame queues
   * only behind one that keeps up: queued behind a long frame, it would hold
   * the GPU, which the browser and the rest of the desktop draw with too,
   * busy back to back.
   */
  mayDrawInteractive(framesInFlight: number): boolean {
    const limit = this.lastFrameMs > LONG_FRAME_MS ? 1 : MAX_INTERACTIVE_FRAMES_IN_FLIGHT;
    return framesInFlight < limit;
  }

  /**
   * Whether a frame for newly resident chunks may go now. Nobody is waiting
   * on one, so it waits for the frame before it to finish. If chunks are
   * still waiting to be delivered it then waits as long again as that frame
   * took, so the ticks in between deliver them and one frame draws them all:
   * while a view loads, the GPU spends at most half its time drawing it.
   */
  mayDrawResidency(now: number, framesInFlight: number, deliveryBacklogged: boolean): boolean {
    if (framesInFlight > 0) return false;
    return !deliveryBacklogged || now - this.lastDoneAt >= this.lastFrameMs;
  }
}
