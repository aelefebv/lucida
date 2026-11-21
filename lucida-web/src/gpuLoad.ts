/**
 * How busy the viewport's frames have kept the GPU lately, read from their
 * passes' GPU time.
 *
 * A desktop GPU picks its clocks from its own recent load. Left idle, or kept
 * busy only a third of the time, it steps down from its top clocks within
 * about a second, and on the lower ones a frame takes several times as long.
 * The frames' pass times are the part of that load the page can see.
 */

/**
 * How fast an old pass stops counting. A desktop GPU's clocks follow its load
 * over about a second, so a pass half a second old counts a third as much as
 * one just finished.
 */
export const GPU_LOAD_DECAY_MS = 500;

export class GpuLoad {
  /** The passes' GPU time, each weighted down by its age as of {@link atMs}. */
  private busyMs = 0;
  private atMs = Number.NEGATIVE_INFINITY;
  private measured = false;
  private readonly decayMs: number;

  constructor(decayMs = GPU_LOAD_DECAY_MS) {
    this.decayMs = decayMs;
  }

  /** A frame's passes took `passMs` on the GPU, heard at `atMs`. */
  notePass(passMs: number, atMs: number): void {
    this.busyMs = this.decayedAt(atMs) + passMs;
    this.atMs = atMs;
    this.measured = true;
  }

  /**
   * The share of the recent past the passes took, weighted toward the newest:
   * about 1 for frames back to back, and 0 long after the last one.
   */
  share(atMs: number): number {
    return this.decayedAt(atMs) / this.decayMs;
  }

  /** Whether any pass was heard: a device without timestamp queries never times one. */
  get timed(): boolean {
    return this.measured;
  }

  private decayedAt(atMs: number): number {
    if (this.busyMs === 0) return 0;
    return this.busyMs * Math.exp(-Math.max(0, atMs - this.atMs) / this.decayMs);
  }
}
