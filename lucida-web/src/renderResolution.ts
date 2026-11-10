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

/**
 * A gesture's frame slower than this, dispatch to done, lowers the
 * resolution: a display frame and the trip to the render worker and back.
 */
export const LONG_FRAME_MS = 20;

/** What a long frame's step down aims its frames at, within a display frame. */
export const TARGET_FRAME_MS = 12;

/** Each gesture starts this much above the scale the gesture before it ended at. */
export const GESTURE_START_STEP_UP = 1.25;

/** The lowest share of the capped resolution a gesture is drawn at. */
export const MIN_ADAPTIVE_SCALE = 0.5;

/** The most a gesture's ray march coarsens past its usual step once the resolution is at its floor. */
export const MAX_MARCH_COARSENING = 2;

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
  /**
   * The scale a gesture starts at: a step above where the gesture before it
   * ended. A GPU left idle drops its clocks, so a gesture's first frames
   * are its slowest, and starting a heavy view at full resolution makes them
   * slower still. A view that turns cheap works back to full a gesture at a
   * time.
   */
  private gestureStart = 1;
  /** What the last frame drawn at full quality took, dispatch to done. */
  private fullQualityFrameMs: number | null = null;
  /** The gesture under way has not drawn its first frame. */
  private gestureUnfitted = false;
  private coarsening = 1;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  /**
   * The last frame dispatched before the latest step down or before the
   * gesture's first input, whichever is later. Frames up to it were drawn at
   * the old resolution, or for no gesture, so their latency says nothing
   * about the gesture's resolution and must not step it down.
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

  /**
   * How many times its usual step a gesture's ray march takes, in
   * `[1, MAX_MARCH_COARSENING]`: above 1 only where the resolution's floor
   * leaves a gesture's frame long.
   */
  get marchCoarsening(): number {
    return this.coarsening;
  }

  /**
   * An input landed; `lastDispatchedSeq` is the newest frame already sent.
   * A gesture's first input leaves the frames before it out: a frame's
   * latency is read at the tick after it finishes, which is often the
   * gesture's first, and a frame a load drew says nothing about the gesture.
   */
  noteInput(lastDispatchedSeq: number): void {
    const now = this.now();
    if (now - this.lastInputAt >= RESTORE_AFTER_MS) {
      this.settledAfterSeq = Math.max(this.settledAfterSeq, lastDispatchedSeq);
      this.factor = Math.min(this.factor, this.gestureStart);
      this.gestureUnfitted = true;
    }
    this.lastInputAt = now;
  }

  /** A frame drawn at full quality took `ms`, dispatch to done. */
  noteFullQualityFrame(ms: number): void {
    this.fullQualityFrameMs = ms;
  }

  /** What the last frame drawn at full quality took, or null before one finished. */
  get fullQualityMs(): number | null {
    return this.fullQualityFrameMs;
  }

  /**
   * Before a gesture's first frame, which costs `share` of a full-quality
   * frame at full scale: if the last full-quality frame says that frame
   * would be long, step down now, as a long frame would. Waiting to measure
   * one costs a whole long frame, and on a GPU slow enough the gesture's
   * frames outlast its input, so none is ever measured within it.
   */
  fitGestureStart(share: number): void {
    if (!this.gestureUnfitted) return;
    this.gestureUnfitted = false;
    if (this.fullQualityFrameMs === null) return;
    const predictedMs = this.fullQualityFrameMs * share * this.factor * this.factor;
    if (predictedMs <= LONG_FRAME_MS) return;
    this.factor = Math.max(MIN_ADAPTIVE_SCALE, this.factor * Math.sqrt(TARGET_FRAME_MS / predictedMs));
    // A frame's cost goes with its samples along each ray too, so past the
    // resolution's floor the march takes what is left, up to its own floor.
    const atFloorMs = this.fullQualityFrameMs * share * this.factor * this.factor;
    if (atFloorMs > LONG_FRAME_MS) this.coarsening = Math.min(MAX_MARCH_COARSENING, atFloorMs / TARGET_FRAME_MS);
  }

  /**
   * A frame finished. During a gesture a long one steps the resolution down,
   * by as much as brings a frame like it to {@link TARGET_FRAME_MS};
   * `lastDispatchedSeq` is the newest frame already sent, which the step
   * cannot affect. True when the scale changed.
   */
  noteFrame(frameSeq: number, latencyMs: number, lastDispatchedSeq: number): boolean {
    if (this.now() - this.lastInputAt >= RESTORE_AFTER_MS) return false;
    if (frameSeq <= this.settledAfterSeq) return false;
    if (latencyMs <= LONG_FRAME_MS || this.factor <= MIN_ADAPTIVE_SCALE) return false;
    // A frame's cost goes with its pixels, the square of the scale, so one
    // step reaches the target instead of creeping down a fixed share a step
    // while every frame on the way holds the GPU for too long.
    this.factor = Math.max(MIN_ADAPTIVE_SCALE, this.factor * Math.sqrt(TARGET_FRAME_MS / latencyMs));
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
    this.gestureStart = Math.min(1, this.factor * GESTURE_START_STEP_UP);
    this.factor = 1;
    this.coarsening = 1;
    return true;
  }
}
