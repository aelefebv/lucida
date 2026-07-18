/**
 * A requestAnimationFrame owner that is quiescent by default.
 *
 * `wake()` coalesces any number of events onto one callback. The callback
 * explicitly returns whether it still has continuous work; returning false
 * leaves no browser callback pending until the next event wakes it. Keeping
 * this policy in one small owner makes idle-frame budgets deterministic and
 * prevents input code from growing bespoke self-rescheduling RAF loops.
 */
export interface AnimationFrameDriver {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

const browserAnimationFrames: AnimationFrameDriver = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

export class DemandDrivenAnimationFrame {
  private frameId: number | null = null;
  private disposed = false;
  private readonly step: (timestamp: number) => boolean;
  private readonly driver: AnimationFrameDriver;

  constructor(
    step: (timestamp: number) => boolean,
    driver: AnimationFrameDriver = browserAnimationFrames,
  ) {
    this.step = step;
    this.driver = driver;
  }

  get pending(): boolean {
    return this.frameId !== null;
  }

  /** Schedule at most one callback. Returns true only when newly scheduled. */
  wake(): boolean {
    if (this.disposed || this.frameId !== null) return false;
    this.frameId = this.driver.request(this.run);
    return true;
  }

  /** Cancel pending work and permanently disable this owner. */
  dispose(): void {
    this.disposed = true;
    if (this.frameId !== null) {
      this.driver.cancel(this.frameId);
      this.frameId = null;
    }
  }

  private readonly run = (timestamp: number): void => {
    this.frameId = null;
    if (this.disposed) return;
    if (this.step(timestamp)) this.wake();
  };
}
