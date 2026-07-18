/**
 * Telemetry counters and burst-rate-limited debug loggers for CpuCache.
 *
 * `TelemetryCounters` owns the scattered counter tiles the cache used
 * to mutate inline (totalRequests, totalHits, decode latency window,
 * eviction counts per tier, failure counts, average decoded bytes,
 * etc.). Mutation sites in CpuCache become verb calls; the read path
 * is a single `snapshot(now)` that also rolls the per-window counters.
 *
 * `BurstLogger` encapsulates the two rate-limited debug log paths:
 *  - `cache.backpressure` — emit a summary at most once per window
 *    while pressure persists (recordSkipped).
 *  - `cache.failure_burst` — emit one log per window when a failure
 *    count crosses a threshold (recordBurst).
 *
 * Pure: no I/O beyond the BurstLogger calls into `debugLog`. Snapshots
 * read `performance.now()` via the caller-supplied `now` so unit tests
 * remain deterministic without faking the global clock.
 */

import { debugLog, type DebugCategory } from "../../debug/logging.ts";
import type { EvictionTier, TierCounters } from "./types.ts";

/** Fresh per-tier eviction counter. Shared shape with cpuCache exports. */
export function freshTierCounters(): TierCounters {
  return { activeDetail: 0, demotedDetail: 0, prefetch: 0, overview: 0 };
}

/** Tier label used by `recordEviction`. Either an EvictionTier or one of the
 *  cache-side aggregate ("overview") that doesn't map onto the
 *  three-tier detail enum. */
export type EvictionRecordTier = EvictionTier | "overview";

/**
 * Result shape returned by {@link TelemetryCounters.snapshot}. Cpu cache
 * composes the public `CacheTelemetry` from this plus per-call store
 * walks (tier residency, pending oldest age, etc.).
 */
export interface TelemetrySnapshot {
  totalRequests: number;
  totalHits: number;
  hitRate: number;
  /** Evictions in the last window (since the previous `snapshot`). */
  evictionsSinceSnapshot: number;
  /** Decodes in the last window (since the previous `snapshot`). */
  decodesSinceSnapshot: number;
  /** Per-tier eviction counts in the last window. */
  evictionsByTier: TierCounters;
  /** Evictions per second computed against the last `snapshot` time. */
  evictionsPerSec: number;
  /** Decodes per second computed against the last `snapshot` time. */
  decodesPerSec: number;
  /** Mean of the rolling decode-latency window (0 if no samples). */
  avgDecodeMs: number;
  /** Median of the rolling decode-latency window (0 if no samples). */
  decodeP50Ms: number;
  /** 95th-percentile of the rolling decode-latency window (0 if no samples). */
  decodeP95Ms: number;
  /** Permanent fetch failures since boot (or last `reset`). */
  permanentFailures: number;
  /** Transient fetch failures since boot (or last `reset`). */
  transientFailures: number;
  /** Latest fetch error message, or null if none. */
  lastError: string | null;
  /** Running average of source response payload sizes (bytes). */
  avgDecodedBytes: number;
  /** Number of completed fetches feeding `avgDecodedBytes`. */
  completedFetches: number;
}

/**
 * Window size for the rolling decode-latency samples. P50/P95/avg
 * are computed from the last N completed decodes.
 */
const DECODE_LATENCY_WINDOW = 100;

/** Pick a percentile from a sorted numeric array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx];
}

export class TelemetryCounters {
  private totalRequests = 0;
  private totalHits = 0;
  private evictionsSinceSnapshot = 0;
  private decodesSinceSnapshot = 0;
  private evictionsByTierSinceSnapshot: TierCounters = freshTierCounters();
  private decodeTimes: number[] = [];
  private permanentFailures = 0;
  private transientFailures = 0;
  private lastError: string | null = null;
  private avgDecodedBytes = 0;
  private completedFetches = 0;
  private lastSnapshotAt: number;

  constructor(now: number = performance.now()) {
    this.lastSnapshotAt = now;
  }

  recordRequest(): void {
    this.totalRequests++;
  }

  recordHit(): void {
    this.totalHits++;
  }

  recordEviction(tier: EvictionRecordTier): void {
    this.evictionsSinceSnapshot++;
    switch (tier) {
      case "active-detail":
        this.evictionsByTierSinceSnapshot.activeDetail++;
        break;
      case "demoted-detail":
        this.evictionsByTierSinceSnapshot.demotedDetail++;
        break;
      case "prefetch":
        this.evictionsByTierSinceSnapshot.prefetch++;
        break;
      case "overview":
        this.evictionsByTierSinceSnapshot.overview++;
        break;
    }
  }

  recordDecode(ms: number): void {
    this.decodeTimes.push(ms);
    if (this.decodeTimes.length > DECODE_LATENCY_WINDOW) this.decodeTimes.shift();
    this.decodesSinceSnapshot++;
  }

  recordFetchFailure(isPermanent: boolean, message: string): void {
    if (isPermanent) this.permanentFailures++;
    else this.transientFailures++;
    this.lastError = message;
  }

  /** Standalone setter for errors that do not fit the fetch classification. */
  recordError(message: string): void {
    this.lastError = message;
  }

  /**
   * Update the diagnostic running average of source response payload sizes,
   * and bump the count of completed fetches that fed it.
   */
  recordCompletedFetch(responseBytes: number): void {
    this.completedFetches++;
    this.avgDecodedBytes += (responseBytes - this.avgDecodedBytes) / this.completedFetches;
  }

  /** Current diagnostic running average of source response payload sizes. */
  averageDecodedBytes(): number {
    return this.avgDecodedBytes;
  }

  /**
   * Snapshot of the current counters. Side effects:
   *  - resets `evictionsSinceSnapshot`, `decodesSinceSnapshot`, and the
   *    per-tier eviction window to zero
   *  - updates `lastSnapshotAt` so the next `snapshot()` measures the
   *    elapsed window from this call.
   *
   * The hit rate, decodes/sec, and evictions/sec are derived once at
   * snapshot time so the cache doesn't need to repeat the math.
   */
  snapshot(now: number): TelemetrySnapshot {
    const elapsedSec = (now - this.lastSnapshotAt) / 1000 || 1;
    const evictionsPerSec = this.evictionsSinceSnapshot / elapsedSec;
    const decodesPerSec = this.decodesSinceSnapshot / elapsedSec;
    const evictionsByTier = this.evictionsByTierSinceSnapshot;
    const evictionsSinceSnapshot = this.evictionsSinceSnapshot;
    const decodesSinceSnapshot = this.decodesSinceSnapshot;

    let avgDecodeMs = 0;
    let decodeP50Ms = 0;
    let decodeP95Ms = 0;
    if (this.decodeTimes.length > 0) {
      avgDecodeMs = this.decodeTimes.reduce((a, b) => a + b, 0) / this.decodeTimes.length;
      const sorted = [...this.decodeTimes].sort((a, b) => a - b);
      decodeP50Ms = percentile(sorted, 0.5);
      decodeP95Ms = percentile(sorted, 0.95);
    }

    this.evictionsSinceSnapshot = 0;
    this.decodesSinceSnapshot = 0;
    this.evictionsByTierSinceSnapshot = freshTierCounters();
    this.lastSnapshotAt = now;

    return {
      totalRequests: this.totalRequests,
      totalHits: this.totalHits,
      hitRate: this.totalRequests > 0 ? this.totalHits / this.totalRequests : 0,
      evictionsSinceSnapshot,
      decodesSinceSnapshot,
      evictionsByTier,
      evictionsPerSec,
      decodesPerSec,
      avgDecodeMs,
      decodeP50Ms,
      decodeP95Ms,
      permanentFailures: this.permanentFailures,
      transientFailures: this.transientFailures,
      lastError: this.lastError,
      avgDecodedBytes: this.avgDecodedBytes,
      completedFetches: this.completedFetches,
    };
  }

  /** Reset every counter to its boot state. Mirrors `CpuCache.reset()`. */
  reset(now: number = performance.now()): void {
    this.totalRequests = 0;
    this.totalHits = 0;
    this.evictionsSinceSnapshot = 0;
    this.decodesSinceSnapshot = 0;
    this.evictionsByTierSinceSnapshot = freshTierCounters();
    this.decodeTimes = [];
    this.permanentFailures = 0;
    this.transientFailures = 0;
    this.lastError = null;
    this.avgDecodedBytes = 0;
    this.completedFetches = 0;
    this.lastSnapshotAt = now;
  }
}

/**
 * Rate-limited debug logger. Two emission patterns:
 *
 * 1. `recordSkipped(delta, payloadFn)` — accumulate a skipped counter
 *    on every call, emit a summary at most once per `windowMs`. The
 *    payload is built lazily via `payloadFn(skippedSinceLastLog)` only
 *    when an emission is about to fire. Use for "we kept falling
 *    behind, here's the summary"-style logs (cache.backpressure).
 *
 * 2. `recordBurst(threshold, payloadFn)` — count events within a
 *    window, emit ONCE when the count first crosses `threshold` in
 *    that window. Use for "real outage detected, here's a heads-up"
 *    logs (cache.failure_burst).
 *
 * Both share the same window state (`windowStartedAt`, `counter`),
 * so a single `BurstLogger` instance owns one stream of related events.
 */
export class BurstLogger {
  private windowStartedAt = 0;
  private counter = 0;
  private burstThresholdReached = false;
  private readonly category: DebugCategory;
  private readonly eventName: string;
  private readonly windowMs: number;

  constructor(category: DebugCategory, eventName: string, windowMs: number = 1000) {
    this.category = category;
    this.eventName = eventName;
    this.windowMs = windowMs;
  }

  /**
   * Backpressure pattern. Adds `delta` to the skipped-events counter.
   * If at least `windowMs` have elapsed since the last emit (or boot),
   * emit a summary log and reset the counter.
   */
  recordSkipped(delta: number, payloadFn: (skipped: number) => Record<string, unknown>): void {
    this.counter += delta;
    const now = performance.now();
    if (now - this.windowStartedAt >= this.windowMs) {
      debugLog(this.category, this.eventName, payloadFn(this.counter));
      this.windowStartedAt = now;
      this.counter = 0;
    }
  }

  /**
   * Failure-burst pattern. Counts events within a `windowMs` window;
   * emits one log the first time the in-window count reaches
   * `threshold`. The window resets when an event arrives more than
   * `windowMs` after the start of the current window.
   */
  recordBurst(threshold: number, payloadFn: (count: number) => Record<string, unknown>): void {
    const now = performance.now();
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.counter = 1;
      this.burstThresholdReached = false;
      return;
    }
    this.counter++;
    if (!this.burstThresholdReached && this.counter >= threshold) {
      debugLog(this.category, this.eventName, payloadFn(this.counter));
      this.burstThresholdReached = true;
    }
  }
}
