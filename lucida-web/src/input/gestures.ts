/**
 * Turns touch pointers into the canvas's gestures: one-finger drag, pinch
 * and two-finger drag, tap, double tap, two-finger tap, and long press.
 *
 * Pure: the caller feeds pointer samples stamped with a time, and asks for the
 * one timed gesture, the long press, through `tick` once `nextDeadline` passes.
 * Positions are in whatever space the samples use; the viewers pass client CSS
 * pixels.
 */

/** How far (CSS px) a finger may travel and still be holding still or tapping.
 * Wider than the mouse's click slop, since a fingertip wobbles. */
export const TOUCH_SLOP = 10;
/** A finger held still this long (ms) is a long press. */
export const LONG_PRESS_MS = 500;
/** The longest wait (ms) from one tap's release to the next tap's press for the
 * two to make a double tap. */
export const DOUBLE_TAP_MS = 300;
/** How far apart (CSS px) the two taps of a double tap may land. */
export const DOUBLE_TAP_SLOP = 40;
/** A two-finger tap lifts its last finger within this long (ms) of the first
 * landing. */
export const TWO_FINGER_TAP_MS = 400;

export interface PointerSample {
  id: number;
  x: number;
  y: number;
  /** Milliseconds on any monotonic clock, the same one `tick` is given. */
  time: number;
}

export type Gesture =
  /** The first finger of a gesture the caller claimed at `down` (to draw with).
   * Raw positions, with no slop applied. */
  | { type: "pressStart"; x: number; y: number }
  | { type: "pressMove"; x: number; y: number }
  | { type: "pressEnd"; x: number; y: number }
  /** A claimed press is abandoned: a second finger landed, or the browser
   * cancelled the pointer. */
  | { type: "pressCancel" }
  /** One finger moving past the slop. `dx`/`dy` is the travel since the last
   * drag; the first one covers the whole way from the press, so whatever the
   * finger landed on stays under it. */
  | { type: "drag"; x: number; y: number; dx: number; dy: number }
  /** Two or more fingers moving: `x`/`y` is their centroid, `dx`/`dy` its travel
   * since the last pinch, and `scale` the change in their spread (above 1 when
   * they move apart). A two-finger drag is a pinch with a scale near 1. */
  | { type: "pinch"; x: number; y: number; dx: number; dy: number; scale: number }
  | { type: "tap"; x: number; y: number }
  /** The second tap of a double tap, in place of its `tap`. */
  | { type: "doubleTap"; x: number; y: number }
  | { type: "twoFingerTap"; x: number; y: number }
  | { type: "longPress"; x: number; y: number };

type Phase =
  | "idle"
  /** One finger within the slop: still a tap, a long press, or a drag. */
  | "pending"
  /** One finger the caller claimed. */
  | "pressing"
  | "dragging"
  /** Two or more fingers, or the one left while a two-finger tap is still
   * possible. */
  | "multi"
  /** Fired or cancelled: nothing more until every finger lifts. */
  | "spent";

interface Finger {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

interface Point {
  x: number;
  y: number;
}

/** Below this spread (CSS px) the fingers are too close for a stable ratio. */
const MIN_SPREAD = 1;

export class GestureRecognizer {
  private readonly fingers = new Map<number, Finger>();
  private phase: Phase = "idle";
  private gestureStart = 0;
  private longPressAt: number | null = null;
  private lastTap: (Point & { time: number }) | null = null;
  private doubleTapArmed = false;
  private pressTravelled = false;
  /** The last position a drag reported. */
  private last: Point = { x: 0, y: 0 };
  /** Whether the fingers of a multi-finger gesture have left the slop. */
  private transforming = false;
  /** Where a two-finger tap would land, while one is still possible. */
  private twoFingerTapAt: Point | null = null;
  private centroid: Point = { x: 0, y: 0 };
  private spread = 0;

  /** A finger lands. `press` claims a fresh gesture's first finger for the
   * caller, which then gets press events instead of navigation; later
   * fingers ignore it. */
  down(p: PointerSample, options: { press?: boolean } = {}): Gesture[] {
    if (this.fingers.has(p.id)) return this.move(p);
    this.fingers.set(p.id, { x: p.x, y: p.y, startX: p.x, startY: p.y });

    if (this.fingers.size === 1) {
      this.gestureStart = p.time;
      this.last = { x: p.x, y: p.y };
      if (options.press) {
        this.phase = "pressing";
        this.pressTravelled = false;
        this.lastTap = null;
        return [{ type: "pressStart", x: p.x, y: p.y }];
      }
      this.phase = "pending";
      this.longPressAt = p.time + LONG_PRESS_MS;
      const tap = this.lastTap;
      this.doubleTapArmed =
        tap !== null && p.time - tap.time <= DOUBLE_TAP_MS && Math.hypot(p.x - tap.x, p.y - tap.y) <= DOUBLE_TAP_SLOP;
      return [];
    }

    if (this.phase === "spent") return [];
    const out: Gesture[] = [];
    if (this.phase === "pressing") out.push({ type: "pressCancel" });
    if (this.phase === "multi") {
      // A third finger, or one coming back: no longer a two-finger tap.
      this.twoFingerTapAt = null;
      this.rebaseline();
    } else {
      const stillTap = this.phase === "pending" || (this.phase === "pressing" && !this.pressTravelled);
      // A drag that gains a finger is already moving, so it transforms at once.
      this.transforming = this.phase === "dragging";
      this.phase = "multi";
      this.rebaseline();
      this.twoFingerTapAt = stillTap ? { ...this.centroid } : null;
    }
    this.longPressAt = null;
    this.lastTap = null;
    return out;
  }

  move(p: PointerSample): Gesture[] {
    const finger = this.fingers.get(p.id);
    if (!finger) return [];
    finger.x = p.x;
    finger.y = p.y;
    switch (this.phase) {
      case "pending":
        if (!beyondSlop(finger)) return [];
        this.phase = "dragging";
        this.longPressAt = null;
        this.lastTap = null;
        return [this.dragTo(finger)];
      case "dragging":
        return [this.dragTo(finger)];
      case "pressing":
        if (beyondSlop(finger)) this.pressTravelled = true;
        return [{ type: "pressMove", x: p.x, y: p.y }];
      case "multi":
        if (!this.transforming) {
          if (![...this.fingers.values()].some(beyondSlop)) return [];
          this.transforming = true;
          this.twoFingerTapAt = null;
        }
        if (this.fingers.size === 1) {
          // The finger left over from a two-finger tap that never happened.
          this.phase = "dragging";
          return [this.dragTo(finger)];
        }
        return [this.transform()];
      default:
        return [];
    }
  }

  up(p: PointerSample): Gesture[] {
    const finger = this.fingers.get(p.id);
    if (!finger) return [];
    finger.x = p.x;
    finger.y = p.y;
    // A long press whose deadline passed wins over a tap, even when the
    // caller's timer hasn't run yet.
    const out = this.tick(p.time);
    this.fingers.delete(p.id);
    const remaining = this.fingers.size;

    switch (this.phase) {
      case "pending":
        this.phase = "idle";
        this.longPressAt = null;
        if (this.doubleTapArmed) {
          this.lastTap = null;
          out.push({ type: "doubleTap", x: finger.startX, y: finger.startY });
        } else {
          this.lastTap = { x: finger.startX, y: finger.startY, time: p.time };
          out.push({ type: "tap", x: finger.startX, y: finger.startY });
        }
        break;
      case "pressing":
        this.phase = "idle";
        out.push({ type: "pressEnd", x: p.x, y: p.y });
        break;
      case "multi":
        if (remaining === 0) {
          if (this.twoFingerTapAt && p.time - this.gestureStart <= TWO_FINGER_TAP_MS) {
            out.push({ type: "twoFingerTap", ...this.twoFingerTapAt });
          }
          this.phase = "idle";
        } else if (remaining === 1) {
          const [rest] = this.fingers.values();
          this.last = { x: rest.x, y: rest.y };
          // Moving fingers keep moving with the one left; still ones may yet
          // lift together as a tap.
          if (this.transforming) this.phase = "dragging";
        } else {
          this.rebaseline();
        }
        break;
      default:
        if (remaining === 0) this.phase = "idle";
    }
    return out;
  }

  /** The browser took the pointer back. The gesture ends without firing. */
  cancel(p: PointerSample): Gesture[] {
    if (!this.fingers.delete(p.id)) return [];
    const out: Gesture[] = this.phase === "pressing" ? [{ type: "pressCancel" }] : [];
    this.longPressAt = null;
    this.lastTap = null;
    this.twoFingerTapAt = null;
    this.phase = this.fingers.size === 0 ? "idle" : "spent";
    return out;
  }

  /** Fires a long press once its deadline passes. */
  tick(now: number): Gesture[] {
    if (this.phase !== "pending" || this.longPressAt === null || now < this.longPressAt) return [];
    const [finger] = this.fingers.values();
    this.phase = "spent";
    this.longPressAt = null;
    this.lastTap = null;
    return [{ type: "longPress", x: finger.startX, y: finger.startY }];
  }

  /** When `tick` may next fire something, or null when nothing is timed. */
  nextDeadline(): number | null {
    return this.phase === "pending" ? this.longPressAt : null;
  }

  /** Whether any finger is down. */
  get active(): boolean {
    return this.fingers.size > 0;
  }

  private dragTo(finger: Finger): Gesture {
    const dx = finger.x - this.last.x;
    const dy = finger.y - this.last.y;
    this.last = { x: finger.x, y: finger.y };
    return { type: "drag", x: finger.x, y: finger.y, dx, dy };
  }

  private transform(): Gesture {
    const before = this.centroid;
    const spreadBefore = this.spread;
    this.rebaseline();
    const scale = spreadBefore >= MIN_SPREAD && this.spread >= MIN_SPREAD ? this.spread / spreadBefore : 1;
    return {
      type: "pinch",
      x: this.centroid.x,
      y: this.centroid.y,
      dx: this.centroid.x - before.x,
      dy: this.centroid.y - before.y,
      scale,
    };
  }

  /** Re-measure the centroid and spread from the fingers down now, so a finger
   * landing or lifting doesn't read as a jump. */
  private rebaseline(): void {
    let x = 0;
    let y = 0;
    for (const f of this.fingers.values()) {
      x += f.x;
      y += f.y;
    }
    const n = this.fingers.size;
    this.centroid = { x: x / n, y: y / n };
    let spread = 0;
    for (const f of this.fingers.values()) spread += Math.hypot(f.x - this.centroid.x, f.y - this.centroid.y);
    this.spread = spread / n;
  }
}

function beyondSlop(f: Finger): boolean {
  return Math.hypot(f.x - f.startX, f.y - f.startY) > TOUCH_SLOP;
}
