/**
 * Upload-phase telemetry collaborator.
 *
 * Replaces the cluster of ~9 upload-telemetry fields and the three
 * private helpers (`recordUploadEvent`, `publishUploadStats`,
 * `maybeLogUploadAnomalies`) that previously lived directly on
 * `Orchestrator`. See Seam H of the dechaos boundary scan and Item 11
 * of the composability scan.
 *
 * The class owns:
 *   - A rolling 1s ring buffer of upload events (drain + resend).
 *   - A rolling 1s ring buffer of per-tick aggregates.
 *   - A bounded p50/p95 size sample buffer.
 *   - Cumulative byte / upload counters.
 *   - Three sustained-anomaly detectors driven by the shared helpers
 *     in `sustained.ts`.
 *
 * The `Orchestrator` calls `recordEvent(now, bytes, isResend)` per
 * upload and `publish(now, tickStats)` at the end of each
 * `deliverToWorker` invocation. The publish call aggregates, derives
 * `UploadRollingStats`, fires any sustained-anomaly logs, and writes
 * to `debugStats.upload`.
 */

import {
  debugStats,
  type UploadTickStats,
  type UploadRollingStats,
} from "../../../debug/debugStats.ts";
import { debugLog } from "../../../debug/logging.ts";
import {
  UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
  UPLOAD_FILTER_RATIO_THRESHOLD,
  UPLOAD_LOG_RATE_LIMIT_MS,
  UPLOAD_LOG_SUSTAIN_MS,
  UPLOAD_RESEND_RATIO_THRESHOLD,
  UPLOAD_SIZE_SAMPLES,
  UPLOAD_WINDOW_MS,
} from "../constants.ts";
import {
  ConsecutiveTickDetector,
  SustainedCondition,
} from "./sustained.ts";

/** Per-tick aggregate stored in the rolling window. */
interface TickWindowEntry {
  at: number;
  drained: number;
  drainedChunks: number;
  uploaded: number;
  skipped: number;
  skippedPrefetch: number;
  skippedOverview: number;
  skippedWrongLod: number;
  skippedAlreadySent: number;
  skippedNoMeta: number;
  budgetExhausted: boolean;
}

interface EventEntry {
  at: number;
  bytes: number;
  isResend: boolean;
}

export class UploadTelemetry {
  /** Rolling 1s window of per-upload events. */
  private uploadEvents: EventEntry[] = [];
  /** Rolling 1s window of per-tick aggregates. */
  private uploadTickWindow: TickWindowEntry[] = [];
  /** Bounded sample buffer for p50/p95 upload size. FIFO. */
  private uploadSizeSamples: number[] = [];
  private uploadTotalBytes = 0;
  private uploadTotalUploads = 0;

  // Three sustained-anomaly detectors.
  private readonly budgetExhaustedDetector = new ConsecutiveTickDetector({
    threshold: UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
    rateLimitMs: UPLOAD_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "upload.budget_exhausted_sustained", payload as Record<string, unknown>),
  });
  private readonly resendStormDetector = new SustainedCondition({
    sustainMs: UPLOAD_LOG_SUSTAIN_MS,
    rateLimitMs: UPLOAD_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "upload.resend_storm", payload as Record<string, unknown>),
  });
  private readonly drainWasteDetector = new SustainedCondition({
    sustainMs: UPLOAD_LOG_SUSTAIN_MS,
    rateLimitMs: UPLOAD_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "upload.drain_waste", payload as Record<string, unknown>),
  });

  /**
   * Record one upload (drain-path or resend-path) into the event ring
   * buffer + size sample buffer + cumulative totals.
   */
  recordEvent(now: number, bytes: number, isResend: boolean): void {
    this.uploadEvents.push({ at: now, bytes, isResend });
    this.uploadSizeSamples.push(bytes);
    if (this.uploadSizeSamples.length > UPLOAD_SIZE_SAMPLES) {
      this.uploadSizeSamples.shift();
    }
    this.uploadTotalBytes += bytes;
    this.uploadTotalUploads += 1;
  }

  /**
   * Aggregate the current tick's stats into the rolling window, derive
   * rolling stats, fire any sustained-anomaly logs, and publish to
   * `debugStats.upload`. Replaces `Orchestrator.publishUploadStats` +
   * `Orchestrator.maybeLogUploadAnomalies`.
   *
   * Called once at the end of each `deliverToWorker` invocation.
   */
  publish(now: number, stats: UploadTickStats): void {
    const skipped =
      stats.skippedPrefetch +
      stats.skippedOverview +
      stats.skippedWrongLod +
      stats.skippedAlreadySent +
      stats.skippedNoMeta;
    const drained = stats.drainedChunks + stats.drainedProxies;
    const uploaded = stats.uploadedChunks + stats.uploadedProxies;
    this.uploadTickWindow.push({
      at: now,
      drained,
      drainedChunks: stats.drainedChunks,
      uploaded,
      skipped,
      skippedPrefetch: stats.skippedPrefetch,
      skippedOverview: stats.skippedOverview,
      skippedWrongLod: stats.skippedWrongLod,
      skippedAlreadySent: stats.skippedAlreadySent,
      skippedNoMeta: stats.skippedNoMeta,
      budgetExhausted: stats.budgetExhausted,
    });

    // Prune both ring buffers to the 1s window.
    const cutoff = now - UPLOAD_WINDOW_MS;
    while (this.uploadEvents.length > 0 && this.uploadEvents[0].at < cutoff) {
      this.uploadEvents.shift();
    }
    while (
      this.uploadTickWindow.length > 0 &&
      this.uploadTickWindow[0].at < cutoff
    ) {
      this.uploadTickWindow.shift();
    }

    // Single-pass aggregate over event ring.
    let bytesInWindow = 0;
    let uploadsInWindow = 0;
    let resendUploads = 0;
    for (const e of this.uploadEvents) {
      bytesInWindow += e.bytes;
      uploadsInWindow += 1;
      if (e.isResend) resendUploads += 1;
    }

    // Single-pass aggregate over tick ring.
    let drainedInWindow = 0;
    let drainedChunksInWindow = 0;
    let skippedInWindow = 0;
    let exhaustedTicks = 0;
    let winSkippedPrefetch = 0;
    let winSkippedOverview = 0;
    let winSkippedWrongLod = 0;
    let winSkippedAlreadySent = 0;
    let winSkippedNoMeta = 0;
    for (const t of this.uploadTickWindow) {
      drainedInWindow += t.drained;
      drainedChunksInWindow += t.drainedChunks;
      skippedInWindow += t.skipped;
      winSkippedPrefetch += t.skippedPrefetch;
      winSkippedOverview += t.skippedOverview;
      winSkippedWrongLod += t.skippedWrongLod;
      winSkippedAlreadySent += t.skippedAlreadySent;
      winSkippedNoMeta += t.skippedNoMeta;
      if (t.budgetExhausted) exhaustedTicks += 1;
    }
    const skippedInWindowByCause = {
      skippedPrefetch: winSkippedPrefetch,
      skippedOverview: winSkippedOverview,
      skippedWrongLod: winSkippedWrongLod,
      skippedAlreadySent: winSkippedAlreadySent,
      skippedNoMeta: winSkippedNoMeta,
    };
    // Upload-bound counts: chunks that were *meant* to upload to the
    // main GPU atlas. Excludes prefetch (cache-only), overview (minimap
    // path), and proxies (separate atlas + always-uploads).
    const drainedUploadBoundInWindow =
      drainedChunksInWindow - winSkippedPrefetch - winSkippedOverview;
    const skippedUploadBoundInWindow =
      winSkippedWrongLod + winSkippedAlreadySent + winSkippedNoMeta;

    let p50: number | null = null;
    let p95: number | null = null;
    if (this.uploadSizeSamples.length > 0) {
      const sorted = [...this.uploadSizeSamples].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    const rolling: UploadRollingStats = {
      // Window is exactly UPLOAD_WINDOW_MS = 1000 ms, so bytes-in-window
      // equals bytes-per-sec by construction.
      bytesPerSec: bytesInWindow,
      uploadsPerSec: uploadsInWindow,
      resendRatio: uploadsInWindow > 0 ? resendUploads / uploadsInWindow : NaN,
      filterRatio:
        drainedUploadBoundInWindow > 0
          ? skippedUploadBoundInWindow / drainedUploadBoundInWindow
          : NaN,
      uploadSizeP50: p50,
      uploadSizeP95: p95,
      totalBytes: this.uploadTotalBytes,
      totalUploads: this.uploadTotalUploads,
      budgetExhaustedTicksLastSecond: exhaustedTicks,
    };

    this.runAnomalyDetectors(now, stats, rolling, {
      drainedInWindow,
      skippedInWindow,
      drainedUploadBoundInWindow,
      skippedUploadBoundInWindow,
      byCause: skippedInWindowByCause,
    });

    if (debugStats.enabled) {
      debugStats.upload = {
        tick: { ...stats },
        rolling,
      };
    }
  }

  /**
   * Three sustained-anomaly detectors:
   *
   * 1. `upload.budget_exhausted_sustained` — N consecutive ticks where
   *    `budgetExhausted=true`. Indicates the CPU→GPU pipe is saturated;
   *    upload work is being deferred to subsequent ticks.
   * 2. `upload.resend_storm` — most uploads come from the resend pass,
   *    sustained > 2s. Worker is evicting faster than fresh decodes
   *    can fill; usually pool capacity vs working set mismatch.
   * 3. `upload.drain_waste` — most drained chunks are filtered out,
   *    sustained > 2s. Decode pool is burning cycles on chunks the GPU
   *    no longer wants — often a planning/wanted-set sync issue.
   *
   * Each detector collapses to a single `detector.tick(...)` call via
   * the shared helpers in `sustained.ts`.
   */
  private runAnomalyDetectors(
    now: number,
    stats: UploadTickStats,
    rolling: UploadRollingStats,
    window: {
      drainedInWindow: number;
      skippedInWindow: number;
      drainedUploadBoundInWindow: number;
      skippedUploadBoundInWindow: number;
      byCause: {
        skippedPrefetch: number;
        skippedOverview: number;
        skippedWrongLod: number;
        skippedAlreadySent: number;
        skippedNoMeta: number;
      };
    },
  ): void {
    // 1. Sustained budget exhaustion — counter-based detector.
    this.budgetExhaustedDetector.tick(
      now,
      stats.budgetExhausted,
      () => ({
        consecutiveTicks: this.budgetExhaustedDetector.getConsecutiveCount(),
        bytesUploadedThisTick: stats.bytesUploaded,
        bytesBudget: stats.bytesBudget,
      }),
    );

    // 2. Resend storm — timestamp-based detector.
    const resendCondition =
      !Number.isNaN(rolling.resendRatio) &&
      rolling.resendRatio > UPLOAD_RESEND_RATIO_THRESHOLD;
    this.resendStormDetector.tick(now, resendCondition, (sustainedMs) => ({
      resendRatio: rolling.resendRatio,
      uploadsPerSec: rolling.uploadsPerSec,
      sustainedMs: Math.round(sustainedMs),
    }));

    // 3. Drain waste — timestamp-based detector.
    const drainCondition =
      !Number.isNaN(rolling.filterRatio) &&
      rolling.filterRatio > UPLOAD_FILTER_RATIO_THRESHOLD;
    this.drainWasteDetector.tick(now, drainCondition, (sustainedMs) => ({
      // filterRatio is upload-bound: skipped non-prefetch /
      // (drained chunks − prefetch − overview). High = real
      // planning / wanted-set sync issue.
      filterRatio: rolling.filterRatio,
      drainedUploadBoundInWindow: window.drainedUploadBoundInWindow,
      skippedUploadBoundInWindow: window.skippedUploadBoundInWindow,
      skippedWrongLod: window.byCause.skippedWrongLod,
      skippedAlreadySent: window.byCause.skippedAlreadySent,
      skippedNoMeta: window.byCause.skippedNoMeta,
      // Informational — prefetch/overview decode load doesn't count
      // toward the ratio, but it's useful context for "was the decode
      // pool busy this window?".
      skippedPrefetch: window.byCause.skippedPrefetch,
      skippedOverview: window.byCause.skippedOverview,
      sustainedMs: Math.round(sustainedMs),
    }));
  }
}
