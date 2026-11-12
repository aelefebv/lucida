/**
 * One animation-frame loop for the layers that follow the camera between
 * React renders: annotation overlays, peer cursors, the collection
 * navigator, held camera keys. It runs only while something changes and
 * stops once the page has been still for {@link IDLE_AFTER_MS} or is hidden,
 * so an idle viewer requests no frames.
 *
 * Whatever can move what these layers show wakes it: input anywhere on the
 * page, every render-loop dirty (data, camera, peers, playback, resize), and
 * a subscriber's own React render.
 */

import { useEffect } from "react";

/** Draws one frame. Returning true keeps the clock running, as a held key does. */
export type FrameCallback = (time: number) => boolean | void;

/**
 * When in a frame a callback draws. A `follow` callback places its element
 * by where another layer's callback put one, so it draws after every `move`
 * callback of the frame, whichever subscribed first.
 */
export type FramePhase = "move" | "follow";

/** Stillness after the last wake before the clock stops. */
export const IDLE_AFTER_MS = 500;

const WAKE_EVENTS = ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "keyup", "touchstart", "touchmove"] as const;

export class FrameClock {
  private readonly phases: Record<FramePhase, Set<FrameCallback>> = { move: new Set(), follow: new Set() };
  private rafId: number | null = null;
  private awakeUntil = 0;
  private listening = false;

  /** Draw `callback` on every frame the clock runs, starting now. Returns the unsubscribe. */
  subscribe(callback: FrameCallback, phase: FramePhase = "move"): () => void {
    const callbacks = this.phases[phase];
    callbacks.add(callback);
    this.listen();
    this.wake();
    return () => {
      callbacks.delete(callback);
      if (this.subscribers === 0) this.stop();
    };
  }

  /** Run for at least {@link IDLE_AFTER_MS} more. Cheap enough to call on every change. */
  wake = (): void => {
    if (this.subscribers === 0 || isHidden()) return;
    this.awakeUntil = performance.now() + IDLE_AFTER_MS;
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  };

  /** Whether a frame is requested: false once the page is idle. */
  get running(): boolean {
    return this.rafId !== null;
  }

  private get subscribers(): number {
    return this.phases.move.size + this.phases.follow.size;
  }

  private tick = (time: number): void => {
    this.rafId = null;
    let keepAwake = false;
    for (const callback of [...this.phases.move, ...this.phases.follow]) {
      if (callback(time) === true) keepAwake = true;
    }
    if (this.subscribers === 0 || isHidden()) return;
    if (keepAwake || performance.now() < this.awakeUntil) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private onVisibilityChange = (): void => {
    if (!isHidden()) {
      this.wake();
    } else if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  };

  private listen(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    const options = { capture: true, passive: true };
    for (const type of WAKE_EVENTS) window.addEventListener(type, this.wake, options);
    window.addEventListener("resize", this.wake, options);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (!this.listening) return;
    this.listening = false;
    const options = { capture: true };
    for (const type of WAKE_EVENTS) window.removeEventListener(type, this.wake, options);
    window.removeEventListener("resize", this.wake, options);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** The page's one clock. */
export const frameClock = new FrameClock();

/** Wake the page's clock: something a camera-following layer shows may have changed. */
export function wakeFrames(): void {
  frameClock.wake();
}

/**
 * Wake the clock after every render of the calling component, so a layer
 * that re-rendered with new content gets a frame to place it.
 */
export function useWakeFramesOnRender(): void {
  useEffect(() => {
    frameClock.wake();
  });
}
