/**
 * Sustained-condition log helpers. Two shapes:
 * `SustainedCondition` (timestamp-based) and `ConsecutiveTickDetector`
 * (counter-based). Both collapse detector call sites to a single
 * `detector.tick(...)`.
 */

/**
 * Fires a log when a condition stays true for at least `sustainMs`,
 * rate-limited to one log per `rateLimitMs`. Resets the sustain window
 * when the condition becomes false.
 */
export class SustainedCondition {
  private aboveThresholdSince: number | null = null;
  private lastLogAt: number = 0;
  private readonly args: {
    sustainMs: number;
    rateLimitMs: number;
    log: (payload: object) => void;
  };

  constructor(args: {
    sustainMs: number;
    rateLimitMs: number;
    log: (payload: object) => void;
  }) {
    this.args = args;
  }

  /**
   * `payloadFor` is evaluated lazily and only when a log fires.
   * `sustainedMs` is elapsed time since the condition first became true.
   */
  tick(now: number, condition: boolean, payloadFor: (sustainedMs: number) => object): void {
    if (!condition) {
      this.aboveThresholdSince = null;
      return;
    }
    if (this.aboveThresholdSince === null) {
      this.aboveThresholdSince = now;
      return;
    }
    const sustained = now - this.aboveThresholdSince;
    const sinceLastLog = now - this.lastLogAt;
    if (sustained < this.args.sustainMs) return;
    if (sinceLastLog < this.args.rateLimitMs) return;
    this.args.log(payloadFor(sustained));
    this.lastLogAt = now;
  }
}

/** Counter-based variant: arms after N consecutive true ticks. */
export class ConsecutiveTickDetector {
  private consecutiveCount: number = 0;
  private lastLogAt: number = 0;
  private readonly args: {
    threshold: number;
    rateLimitMs: number;
    log: (payload: object) => void;
  };

  constructor(args: {
    threshold: number;
    rateLimitMs: number;
    log: (payload: object) => void;
  }) {
    this.args = args;
  }

  /** A false tick resets the counter but NOT the last-log timestamp. */
  tick(now: number, condition: boolean, payloadFor: () => object): void {
    if (condition) {
      this.consecutiveCount++;
      if (
        this.consecutiveCount >= this.args.threshold &&
        now - this.lastLogAt >= this.args.rateLimitMs
      ) {
        this.args.log(payloadFor());
        this.lastLogAt = now;
      }
    } else {
      this.consecutiveCount = 0;
    }
  }

  /** @internal Test-only accessor. */
  getConsecutiveCount(): number {
    return this.consecutiveCount;
  }
}
