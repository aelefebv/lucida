/**
 * Sustained-condition log helpers.
 *
 * Four upload-phase detectors share the same "log once when this stays
 * true for long enough, rate-limited so we don't spam" shape:
 *
 * - `cold_state.churn` — non-view rebuilds above threshold (timestamp-based)
 * - `upload.resend_storm` — high resend ratio (timestamp-based)
 * - `upload.drain_waste` — high filter ratio (timestamp-based)
 * - `upload.budget_exhausted_sustained` — N consecutive ticks (counter-based)
 *
 * Both shapes live here so the call sites collapse from ~30 LOC of
 * bookkeeping to a single `detector.tick(...)`. See Seam I of the
 * dechaos boundary scan and Item 12 of the composability scan.
 */

/**
 * Fires a log when a condition stays true for at least `sustainMs`,
 * rate-limited to at most one log per `rateLimitMs`. Resets the sustain
 * window when the condition becomes false.
 *
 * Used by `upload.resend_storm`, `upload.drain_waste`, and
 * `cold_state.churn`.
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
   * Advance the detector by one tick. If `condition` is false the
   * sustain window resets; if true and sustained beyond `sustainMs`
   * (and the last log is older than `rateLimitMs`) the configured
   * `log` callback fires with `payloadFor(sustainedMs)` evaluated
   * lazily. `sustainedMs` is the elapsed time since the condition
   * first became true.
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

/**
 * Variant where the condition is counter-based (consecutive ticks above
 * threshold) rather than time-based. Used by
 * `upload.budget_exhausted_sustained`, which arms once the budget has
 * been exhausted for N consecutive `deliverToWorker` ticks.
 */
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

  /**
   * Advance the detector by one tick. If `condition` is true the
   * consecutive counter is bumped; once it reaches `threshold` (and
   * the last log is older than `rateLimitMs`) the configured `log`
   * callback fires with `payloadFor()`. A false tick resets the
   * counter (but not the last-log timestamp).
   */
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

  /** Test-only accessor for the in-flight consecutive count. @internal */
  getConsecutiveCount(): number {
    return this.consecutiveCount;
  }
}
