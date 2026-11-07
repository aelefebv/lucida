/**
 * How much of the device's pixel density the viewport renders at.
 *
 * Only the render target shrinks. The camera, planning, hit testing, and
 * every overlay keep working in device pixels at the full ratio, and the
 * browser scales the smaller frame up to the canvas, so nothing that maps a
 * pointer to the data needs to know.
 */

/**
 * Past this many device pixels per CSS pixel the extra ones cost memory and
 * fill rate nobody can see at arm's length.
 */
export const MAX_RENDER_PIXEL_RATIO = 2;

/** A gesture's frame slower than this, dispatch to done, lowers the resolution. */
export const LONG_FRAME_MS = 33;

/** Each long frame scales the resolution by this. */
const STEP_DOWN = 0.8;

/** The lowest share of the capped resolution a gesture is drawn at. */
export const MIN_ADAPTIVE_SCALE = 0.5;

/** Quiet after the last input before the full resolution comes back. */
export const RESTORE_AFTER_MS = 250;

/** The share of device pixels the cap leaves: `1` up to a ratio of 2. */
export function cappedPixelRatioScale(devicePixelRatio: number): number {
  return devicePixelRatio > MAX_RENDER_PIXEL_RATIO ? MAX_RENDER_PIXEL_RATIO / devicePixelRatio : 1;
}

/**
 * Lowers the resolution while a gesture's frames run long and restores it
 * once input stops. A capable machine never sees a long frame, so it never
 * leaves full resolution.
 */
export class AdaptiveResolution {
  private factor = 1;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  /**
   * The last frame dispatched before the latest step down. Frames up to it
   * were drawn at the old resolution, so their latency says nothing about
   * the new one and must not step it down again.
   */
  private settledAfterSeq = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** The share of the capped resolution to draw at, in `[MIN_ADAPTIVE_SCALE, 1]`. */
  get scale(): number {
    return this.factor;
  }

  noteInput(): void {
    this.lastInputAt = this.now();
  }

  /**
   * A frame finished. During a gesture a long one steps the resolution down;
   * `lastDispatchedSeq` is the newest frame already sent, which the step
   * cannot affect. True when the scale changed.
   */
  noteFrame(frameSeq: number, latencyMs: number, lastDispatchedSeq: number): boolean {
    if (this.now() - this.lastInputAt >= RESTORE_AFTER_MS) return false;
    if (frameSeq <= this.settledAfterSeq) return false;
    if (latencyMs <= LONG_FRAME_MS || this.factor <= MIN_ADAPTIVE_SCALE) return false;
    this.factor = Math.max(MIN_ADAPTIVE_SCALE, this.factor * STEP_DOWN);
    this.settledAfterSeq = lastDispatchedSeq;
    return true;
  }

  /** Milliseconds until a lowered resolution may come back, or null when it is full. */
  msUntilRestore(): number | null {
    if (this.factor >= 1) return null;
    return Math.max(0, this.lastInputAt + RESTORE_AFTER_MS - this.now());
  }

  /** Restore full resolution once input has stopped. True when it changed. */
  restoreIfIdle(): boolean {
    const wait = this.msUntilRestore();
    if (wait === null || wait > 0) return false;
    this.factor = 1;
    return true;
  }
}
