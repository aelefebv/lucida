/**
 * Whether the views are moving, read from the scene's view epoch as each tick
 * sees it.
 *
 * A gesture changes the camera on every frame, and a pause of
 * {@link STILL_MS} with no change ends it. The plan after that pause is the
 * one the view settles on, so the pause is short; a long task can hold a
 * tick back a few frames mid-gesture, so it is not shorter.
 *
 * One change on its own, such as a jump to a saved view, is not a move: no
 * change follows it for its plan to fall behind.
 */

/** How long the camera holds still before a move counts as over. */
export const STILL_MS = 100;

export class ViewMotion {
  private epoch: number | null = null;
  /** When a tick last saw the epoch change. */
  private changedAt = Number.NEGATIVE_INFINITY;
  /** When the run of changes that ends at {@link changedAt} began. */
  private startedAt = Number.NEGATIVE_INFINITY;

  /** The view epoch as a tick at `now` reads it. */
  note(epoch: number, now: number): void {
    if (epoch === this.epoch) return;
    const first = this.epoch === null;
    this.epoch = epoch;
    if (first) return;
    if (now - this.changedAt >= STILL_MS) this.startedAt = now;
    this.changedAt = now;
  }

  /** Whether the views are moving at `now`: the camera changed more than once, the last time under {@link STILL_MS} ago. */
  moving(now: number): boolean {
    return this.changedAt > this.startedAt && now - this.changedAt < STILL_MS;
  }

  /** When the views stop moving if nothing moves them again. */
  stopsAt(): number {
    return this.changedAt + STILL_MS;
  }

  /**
   * Whether the camera has held still for {@link STILL_MS} at `now`. A tick
   * that runs after a long task sees the input that came during it as a
   * change, so a held-up frame never reads as a stop.
   */
  stopped(now: number): boolean {
    return now >= this.stopsAt();
  }
}
