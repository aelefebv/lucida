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

/**
 * Frames a view change may have on the GPU at once. One drawing and one
 * queued keeps a GPU that needs about a frame interval per frame busy, where
 * one at a time would leave it idle until the next callback.
 */
export const MAX_INTERACTIVE_FRAMES_IN_FLIGHT = 2;

export class FramePacer {
  /** When the newest finished frame was heard of, and how long it took. */
  private lastDoneAt = Number.NEGATIVE_INFINITY;
  private lastFrameMs = 0;

  /** A frame finished `frameMs` after it was dispatched; the loop heard at `at`. */
  noteFrameDone(frameMs: number, at: number): void {
    this.lastDoneAt = at;
    this.lastFrameMs = frameMs;
  }

  /** Whether a frame for a view change may go now. */
  mayDrawInteractive(framesInFlight: number): boolean {
    return framesInFlight < MAX_INTERACTIVE_FRAMES_IN_FLIGHT;
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
