import { GpuLoad } from "./gpuLoad.ts";

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

/** The lowest share of the capped resolution a long frame steps a gesture down to. */
export const MIN_ADAPTIVE_SCALE = 0.5;

/** The most a gesture's ray march coarsens past its usual step once the resolution is at its floor. */
export const MAX_MARCH_COARSENING = 2;

/** Quiet after the last input before the full resolution comes back. */
export const RESTORE_AFTER_MS = 250;

/**
 * GPU idle past which a gesture starts at its cheapest settings on a device
 * that cannot time its passes. A desktop GPU drops its clocks once it has sat
 * idle about this long, and on its lowest ones a frame at the resolution floor
 * still takes 30 ms or more until they come back a few hundred milliseconds
 * into the gesture.
 */
export const GPU_IDLE_MS = 1000;

/**
 * The {@link GpuLoad} share at or above which a gesture starts as a warm GPU
 * would. A GPU kept a third busy steps down within about a second, so only a
 * GPU kept busier than that lately is surely still on its top clocks. Below
 * it the start is cheap, which costs a frame or two of resolution where the
 * clocks turn out to be up, against several long frames where they are down.
 */
export const WARM_GPU_LOAD = 0.5;

/**
 * The share of the capped resolution a gesture that starts on lowered clocks
 * draws at, below the floor a long frame steps to, until its clocks are back.
 */
export const IDLE_START_SCALE = 0.25;

/**
 * A frame of a gesture's idle start whose passes took at most this on the
 * GPU leaves room to climb back toward the warm settings. Half the target,
 * so a climb lands well inside it, and a frame on clocks still idle, which
 * takes about the target even at the cheapest settings, does not climb.
 */
export const IDLE_CLIMB_PASS_MS = TARGET_FRAME_MS / 2;

/** The share of device pixels the cap leaves: `1` up to a ratio of 2. */
export function cappedPixelRatioScale(devicePixelRatio: number): number {
  return devicePixelRatio > MAX_RENDER_PIXEL_RATIO ? MAX_RENDER_PIXEL_RATIO / devicePixelRatio : 1;
}

/**
 * Lowers the resolution while a gesture's frames run long and restores it
 * once input stops. A capable machine never sees a long frame, so it leaves
 * full resolution only while a gesture's GPU comes back from idle clocks.
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
  /** The gesture under way started on clocks a light load had likely lowered. */
  private startedOnLowClocks = false;
  /**
   * The scale and march the gesture under way would have started at on a
   * GPU on its top clocks, while it draws at its cheapest settings instead.
   * Null once a frame has kept up, or when the gesture started warm.
   */
  private warmStart: { factor: number; coarsening: number } | null = null;
  /** The idle start under way has raised its settings at least once. */
  private climbed = false;
  /**
   * What the newest frame's passes took on the GPU's own clock, since the
   * idle start last changed its settings. Null before one arrived, and on a
   * device that cannot time them.
   */
  private gpuPassMs: number | null = null;
  private readonly gpuLoad = new GpuLoad();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** The share of the capped resolution to draw at, in `[IDLE_START_SCALE, 1]`. */
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
   * An input landed; `lastDispatchedSeq` is the newest frame already sent,
   * and the GPU had sat idle `gpuIdleMs` since it finished its last frame.
   * A gesture's first input leaves the frames before it out: a frame's
   * latency is read at the tick after it finishes, which is often the
   * gesture's first, and a frame a load drew says nothing about the gesture.
   */
  noteInput(lastDispatchedSeq: number, gpuIdleMs = 0): void {
    const now = this.now();
    if (now - this.lastInputAt >= RESTORE_AFTER_MS) {
      this.settledAfterSeq = Math.max(this.settledAfterSeq, lastDispatchedSeq);
      this.factor = Math.min(this.factor, this.gestureStart);
      this.gestureUnfitted = true;
      this.startedOnLowClocks = this.gpuLoad.timed
        ? this.gpuLoad.share(now) < WARM_GPU_LOAD
        : gpuIdleMs >= GPU_IDLE_MS;
    }
    this.lastInputAt = now;
  }

  /** Whether input is under way, or quiet for less than {@link RESTORE_AFTER_MS}. */
  get inGesture(): boolean {
    return this.now() - this.lastInputAt < RESTORE_AFTER_MS;
  }

  /**
   * A viewport frame's passes took `ms` on the GPU's own clock. Unlike its
   * latency, this leaves out the trip to the worker and back, which a frame
   * as cheap as an idle start's is mostly made of.
   */
  noteGpuPass(ms: number): void {
    this.gpuPassMs = ms;
    this.gpuLoad.notePass(ms, this.now());
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
    const predictedMs = (this.fullQualityFrameMs * share * this.factor * this.factor) / this.coarsening;
    if (predictedMs > LONG_FRAME_MS) this.stepDown(predictedMs);
    // The full-quality frame was timed on clocks a lightly loaded GPU has
    // likely dropped since, so it predicts the first frames many times too
    // cheap. Start at the cheapest settings, and climb back to the fitted
    // ones as frames show the clocks returning.
    if (this.startedOnLowClocks && (this.factor > IDLE_START_SCALE || this.coarsening < MAX_MARCH_COARSENING)) {
      this.warmStart = { factor: this.factor, coarsening: this.coarsening };
      this.climbed = false;
      this.factor = IDLE_START_SCALE;
      this.coarsening = MAX_MARCH_COARSENING;
      this.gpuPassMs = null;
    }
  }

  /**
   * A frame finished. During a gesture a long one steps the frame's cost
   * down, by as much as brings a frame like it to {@link TARGET_FRAME_MS};
   * `lastDispatchedSeq` is the newest frame already sent, which the step
   * cannot affect. True when the scale or the march changed.
   *
   * A gesture that starts after a light load can meet the GPU on lowered
   * clocks, where a frame can take ten times what the last full-quality frame
   * predicts, until the clocks come back a few hundred milliseconds in. A
   * frame still long at the resolution's floor then coarsens the march, as a
   * predicted one does, or every frame until then holds the GPU that long.
   *
   * During an idle start a frame climbs toward the warm settings as far as
   * its pass leaves room, and a long one steps down no lower than where the
   * idle start began: a view that grows heavier as it moves, such as one
   * zooming in, outgrows what an earlier frame's pass left room for.
   */
  noteFrame(frameSeq: number, latencyMs: number, lastDispatchedSeq: number): boolean {
    if (this.now() - this.lastInputAt >= RESTORE_AFTER_MS) return false;
    if (frameSeq <= this.settledAfterSeq) return false;
    if (this.warmStart !== null && this.climb(latencyMs)) {
      this.settledAfterSeq = lastDispatchedSeq;
      return true;
    }
    if (latencyMs <= LONG_FRAME_MS) return false;
    const minFactor = this.warmStart !== null ? IDLE_START_SCALE : MIN_ADAPTIVE_SCALE;
    if (this.factor <= minFactor && this.coarsening >= MAX_MARCH_COARSENING) return false;
    this.stepDown(latencyMs, minFactor);
    this.settledAfterSeq = lastDispatchedSeq;
    return true;
  }

  /**
   * During an idle start, raise the frame's cost toward the warm settings by
   * as much as the newest frame's GPU pass leaves room for. Once there, the
   * idle start is over and a long frame steps down as ever. A device that
   * cannot time its passes takes the warm settings back on the first frame
   * whose latency is within the target. True when the settings changed.
   */
  private climb(latencyMs: number): boolean {
    const warm = this.warmStart!;
    const warmCost = (warm.factor * warm.factor) / warm.coarsening;
    let cost: number;
    if (this.gpuPassMs === null) {
      if (latencyMs > TARGET_FRAME_MS) return false;
      cost = warmCost;
    } else {
      if (this.gpuPassMs > IDLE_CLIMB_PASS_MS) return false;
      cost = Math.min(warmCost, ((this.factor * this.factor) / this.coarsening) * (IDLE_CLIMB_PASS_MS / this.gpuPassMs));
    }
    this.gpuPassMs = null;
    this.climbed = true;
    if (cost >= warmCost) {
      this.factor = warm.factor;
      this.coarsening = warm.coarsening;
      this.warmStart = null;
      return true;
    }
    // The march's coarsening goes first: it blurs along each ray, where a
    // lower scale blurs across the whole frame.
    this.coarsening = Math.max(warm.coarsening, (this.factor * this.factor) / cost);
    this.factor = Math.sqrt(cost * this.coarsening);
    return true;
  }

  /**
   * Lower the cost of a frame that takes `ms` at the current scale and march
   * to {@link TARGET_FRAME_MS}: the resolution first, then, past its floor
   * `minFactor`, the march, each no lower than its own floor. A scale already
   * below the floor stays where it is.
   */
  private stepDown(ms: number, minFactor = MIN_ADAPTIVE_SCALE): void {
    // A frame's cost goes with its pixels, the square of the scale, so one
    // step reaches the target instead of creeping down a fixed share a step
    // while every frame on the way holds the GPU for too long.
    const floor = Math.min(minFactor, this.factor);
    const factor = Math.max(floor, this.factor * Math.sqrt(TARGET_FRAME_MS / ms));
    // It goes with the samples along each ray too, so past the resolution's
    // floor the march takes what is left.
    const atFloorMs = (ms * factor * factor) / (this.factor * this.factor);
    if (atFloorMs > LONG_FRAME_MS) {
      this.coarsening = Math.min(MAX_MARCH_COARSENING, (this.coarsening * atFloorMs) / TARGET_FRAME_MS);
    }
    this.factor = factor;
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
    // A gesture that never climbed from its idle start says nothing about
    // what a warm GPU keeps up with, so the next starts from where this one
    // would have. One that climbed ended on clocks that kept up with where it
    // got to, as a warm gesture does.
    const ended = this.warmStart !== null && !this.climbed
      ? this.warmStart.factor
      : Math.max(MIN_ADAPTIVE_SCALE, this.factor);
    this.warmStart = null;
    this.gestureStart = Math.min(1, ended * GESTURE_START_STEP_UP);
    this.factor = 1;
    this.coarsening = 1;
    return true;
  }
}
