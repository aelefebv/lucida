/**
 * Event-driven watchdog for main-view frames submitted to the GPU worker.
 *
 * Dirty render work creates an obligation before the browser schedules its
 * RAF. The eventual submission adopts that same obligation, and only a
 * worker-confirmed `framePresented` can retire it. This covers both halves of
 * frame starvation: a render loop that never submits and GPU work that never
 * completes. The oldest outstanding obligation owns the deadline, so a stream
 * of newer renders cannot postpone detection forever. Confirmed ordered
 * presentation is progress and gives the still-pending queue a fresh budget.
 * Background tabs pause the deadline and receive a fresh budget on return;
 * browsers routinely suspend WebGPU work while hidden, which is not failure.
 */

export const FRAME_STARVATION_TIMEOUT_MS = 10_000;

export interface FrameStarvation {
  oldestFrameId: number;
  pendingFrameCount: number;
  ageMs: number;
}

interface Options {
  onStarved: (starvation: FrameStarvation) => void;
  timeoutMs?: number;
  now?: () => number;
  isVisible?: () => boolean;
}

export class FrameStarvationWatchdog {
  private readonly onStarved: (starvation: FrameStarvation) => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly isVisible: () => boolean;
  private readonly obligations = new Map<number, {
    waitingSince: number;
    submitted: boolean;
  }>();
  private lastPresentedFrameId: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: Options) {
    this.onStarved = options.onStarved;
    this.timeoutMs = options.timeoutMs ?? FRAME_STARVATION_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
    this.isVisible = options.isVisible ?? (() =>
      typeof document === "undefined" || document.visibilityState === "visible");
  }

  /** Create a deadline for the next frame before RAF/render submission. */
  expected(frameId: number): void {
    if (this.stopped || this.obligations.has(frameId)) return;
    this.obligations.set(frameId, { waitingSince: this.now(), submitted: false });
    this.schedule();
  }

  submitted(frameId: number): void {
    if (this.stopped) return;
    const obligation = this.obligations.get(frameId);
    if (obligation) {
      // Preserve the pre-RAF timestamp: reaching postMessage is progress, but
      // it must not reset the user's end-to-end wait budget.
      obligation.submitted = true;
    } else {
      this.obligations.set(frameId, { waitingSince: this.now(), submitted: true });
    }
    this.schedule();
  }

  presented(frameId: number): void {
    if (this.stopped) return;
    // Frame ids are monotonic and the worker queue is ordered. Acknowledging N
    // proves every earlier main-view submission has also completed.
    const madeProgress = this.lastPresentedFrameId === null
      || frameId > this.lastPresentedFrameId;
    if (madeProgress) this.lastPresentedFrameId = frameId;
    for (const pendingId of this.obligations.keys()) {
      if (pendingId <= frameId) {
        this.obligations.delete(pendingId);
      }
    }
    if (madeProgress) {
      const progressedAt = this.now();
      for (const obligation of this.obligations.values()) {
        obligation.waitingSince = progressedAt;
      }
    }
    this.schedule();
  }

  /** Forget only work that never reached the worker. Used when a render loop
   *  is intentionally stopped or its canvas becomes unavailable. Submitted
   *  GPU work remains protected until its acknowledgement arrives. */
  cancelUnsubmitted(): void {
    if (this.stopped) return;
    for (const [frameId, obligation] of this.obligations) {
      if (!obligation.submitted) this.obligations.delete(frameId);
    }
    this.schedule();
  }

  /** Reconcile browser visibility without polling. Hidden time is excluded
   *  from the failure budget; a visible return rebases pending obligations. */
  visibilityChanged(): void {
    if (this.stopped) return;
    this.cancelTimer();
    if (!this.isVisible()) return;
    const resumedAt = this.now();
    for (const obligation of this.obligations.values()) {
      obligation.waitingSince = resumedAt;
    }
    this.schedule();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelTimer();
    this.obligations.clear();
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.stopped || this.obligations.size === 0 || !this.isVisible()) return;

    const oldest = this.oldest();
    if (!oldest) return;
    const remainingMs = Math.max(0, this.timeoutMs - (this.now() - oldest.waitingSince));
    this.timer = setTimeout(() => this.check(), remainingMs);
  }

  private check(): void {
    this.timer = null;
    if (this.stopped || !this.isVisible()) return;
    const oldest = this.oldest();
    if (!oldest) return;

    const ageMs = this.now() - oldest.waitingSince;
    if (ageMs < this.timeoutMs) {
      this.schedule();
      return;
    }

    // Exactly once. The owner transitions its renderer to a terminal recovery
    // state, but stopping here also makes the class safe in isolation.
    this.stopped = true;
    this.obligations.clear();
    this.onStarved({
      oldestFrameId: oldest.frameId,
      pendingFrameCount: oldest.pendingCount,
      ageMs,
    });
  }

  private oldest(): { frameId: number; waitingSince: number; pendingCount: number } | null {
    let frameId: number | null = null;
    let waitingSince = Number.POSITIVE_INFINITY;
    for (const [candidateId, obligation] of this.obligations) {
      if (obligation.waitingSince < waitingSince) {
        frameId = candidateId;
        waitingSince = obligation.waitingSince;
      }
    }
    return frameId === null
      ? null
      : { frameId, waitingSince, pendingCount: this.obligations.size };
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
