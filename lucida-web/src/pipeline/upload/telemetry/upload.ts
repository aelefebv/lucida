/**
 * Upload-phase telemetry. Owns rolling 1s ring buffers (events +
 * per-tick aggregates), a bounded size sketch, cumulative counters, and
 * three sustained-anomaly detectors. `publish` aggregates, derives
 * `UploadRollingStats`, fires anomaly logs, and writes to `debugStats.upload`.
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
  private uploadEvents: EventEntry[] = [];
  private uploadTickWindow: TickWindowEntry[] = [];
  /** FIFO sample buffer for p50/p95 upload size. */
  private uploadSizeSamples: number[] = [];
  private uploadTotalBytes = 0;
  private uploadTotalUploads = 0;

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

  recordEvent(
    now: number,
    bytes: number,
    isResend: boolean,
  ): void {
    this.uploadEvents.push({ at: now, bytes, isResend });
    this.uploadSizeSamples.push(bytes);
    if (this.uploadSizeSamples.length > UPLOAD_SIZE_SAMPLES) {
      this.uploadSizeSamples.shift();
    }
    this.uploadTotalBytes += bytes;
    this.uploadTotalUploads += 1;
  }

  /** Called once at the end of each `deliverToWorker` invocation. */
  publish(now: number, stats: UploadTickStats): void {
    const skipped =
      stats.skippedPrefetch +
      stats.skippedWrongLod +
      stats.skippedAlreadySent +
      stats.skippedNoMeta;
    const drained = stats.drainedChunks;
    const uploaded = stats.uploadedChunks;
    this.uploadTickWindow.push({
      at: now,
      drained,
      drainedChunks: stats.drainedChunks,
      uploaded,
      skipped,
      skippedPrefetch: stats.skippedPrefetch,
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

    let bytesInWindow = 0;
    let uploadsInWindow = 0;
    let chunkUploadsInWindow = 0;
    let resendUploads = 0;
    for (const e of this.uploadEvents) {
      bytesInWindow += e.bytes;
      uploadsInWindow += 1;
      chunkUploadsInWindow += 1;
      if (e.isResend) resendUploads += 1;
    }

    let drainedInWindow = 0;
    let drainedChunksInWindow = 0;
    let skippedInWindow = 0;
    let exhaustedTicks = 0;
    let winSkippedPrefetch = 0;
    let winSkippedWrongLod = 0;
    let winSkippedAlreadySent = 0;
    let winSkippedNoMeta = 0;
    for (const t of this.uploadTickWindow) {
      drainedInWindow += t.drained;
      drainedChunksInWindow += t.drainedChunks;
      skippedInWindow += t.skipped;
      winSkippedPrefetch += t.skippedPrefetch;
      winSkippedWrongLod += t.skippedWrongLod;
      winSkippedAlreadySent += t.skippedAlreadySent;
      winSkippedNoMeta += t.skippedNoMeta;
      if (t.budgetExhausted) exhaustedTicks += 1;
    }
    const skippedInWindowByCause = {
      skippedPrefetch: winSkippedPrefetch,
      skippedWrongLod: winSkippedWrongLod,
      skippedAlreadySent: winSkippedAlreadySent,
      skippedNoMeta: winSkippedNoMeta,
    };
    // Upload-bound = chunks meant for the main GPU atlas. Excludes
    // prefetch traffic (cache-only).
    const drainedUploadBoundInWindow =
      drainedChunksInWindow - winSkippedPrefetch;
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
      // UPLOAD_WINDOW_MS = 1000ms, so bytes-in-window = bytes-per-sec.
      bytesPerSec: bytesInWindow,
      uploadsPerSec: uploadsInWindow,
      chunkUploadsPerSec: chunkUploadsInWindow,
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
   * Detectors:
   * 1. `upload.budget_exhausted_sustained` — CPU→GPU pipe saturated.
   * 2. `upload.resend_storm` — worker evicting faster than decodes fill
   *    (pool capacity vs working set mismatch).
   * 3. `upload.drain_waste` — decoded chunks unwanted by GPU
   *    (planning / wanted-set sync issue).
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
        skippedWrongLod: number;
        skippedAlreadySent: number;
        skippedNoMeta: number;
      };
    },
  ): void {
    this.budgetExhaustedDetector.tick(
      now,
      stats.budgetExhausted,
      () => ({
        consecutiveTicks: this.budgetExhaustedDetector.getConsecutiveCount(),
        bytesUploadedThisTick: stats.bytesUploaded,
        bytesBudget: stats.bytesBudget,
      }),
    );

    const resendCondition =
      !Number.isNaN(rolling.resendRatio) &&
      rolling.resendRatio > UPLOAD_RESEND_RATIO_THRESHOLD;
    this.resendStormDetector.tick(now, resendCondition, (sustainedMs) => ({
      resendRatio: rolling.resendRatio,
      uploadsPerSec: rolling.uploadsPerSec,
      sustainedMs: Math.round(sustainedMs),
    }));

    const drainCondition =
      !Number.isNaN(rolling.filterRatio) &&
      rolling.filterRatio > UPLOAD_FILTER_RATIO_THRESHOLD;
    this.drainWasteDetector.tick(now, drainCondition, (sustainedMs) => ({
      filterRatio: rolling.filterRatio,
      drainedUploadBoundInWindow: window.drainedUploadBoundInWindow,
      skippedUploadBoundInWindow: window.skippedUploadBoundInWindow,
      skippedWrongLod: window.byCause.skippedWrongLod,
      skippedAlreadySent: window.byCause.skippedAlreadySent,
      skippedNoMeta: window.byCause.skippedNoMeta,
      // Informational — prefetch doesn't count toward the ratio
      // but are useful "was the decode pool busy?" context.
      skippedPrefetch: window.byCause.skippedPrefetch,
      sustainedMs: Math.round(sustainedMs),
    }));
  }
}
