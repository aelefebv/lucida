/**
 * Upload-phase telemetry. Owns rolling 1s ring buffers (events +
 * per-tick aggregates), a bounded size sketch, cumulative counters, and
 * two sustained-anomaly detectors. `publish` aggregates, derives
 * `UploadRollingStats` and fires anomaly logs to the `orch` log category.
 */

import { debugLog } from "../../../debug/logging.ts";
import {
  UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
  UPLOAD_FILTER_RATIO_THRESHOLD,
  UPLOAD_LOG_RATE_LIMIT_MS,
  UPLOAD_LOG_SUSTAIN_MS,
  UPLOAD_SIZE_SAMPLES,
  UPLOAD_WINDOW_MS,
} from "../constants.ts";
import {
  ConsecutiveTickDetector,
  SustainedCondition,
} from "./sustained.ts";
import { TimeWindow } from "./timeWindow.ts";

/**
 * Per-tick `deliverToWorker` snapshot. Resets at the start of each
 * call; published at the end.
 */
export interface UploadTickStats {
  /** Deliverable chunks considered from `cpuCache.getDeliverable()` this tick. */
  drainedChunks: number;
  /** Chunks actually posted to the worker this tick. */
  uploadedChunks: number;
  /** Bytes actually posted (from delivery `data.byteLength`). */
  bytesUploaded: number;
  bytesBudget: number;
  /**
   * Upload stopped early because remaining budget hit zero. Not a
   * function of bytesUploaded reaching bytesBudget: a single chunk
   * larger than remaining will still be uploaded and trigger this.
   */
  budgetExhausted: boolean;
  // Skip reasons during the delivery pass (one entry per considered item):
  /** Lane was `prefetch` — pre-cached for future timepoint. */
  skippedPrefetch: number;
  /** Lane was `overview` — minimap path owns these. */
  skippedOverview: number;
  /** Chunk level didn't match `targetLevelByImage[imageId]`. Stale plan. */
  skippedWrongLod: number;
  /** Chunk already in CpuCache delivery sent state for the worker memberId. */
  skippedAlreadySent: number;
  /** The slice view's plane is in another chunk along Z. Stale plan, as a wrong level is. */
  skippedOtherPlane: number;
  /** Couldn't resolve dataset/imageSpec/level meta — should be ~0; bug indicator. */
  skippedNoMeta: number;
}

/**
 * 1s rolling upload stats. Computed by pruning a per-event log to a
 * 1s window. NaN ratios mean "no events in window".
 */
export interface UploadRollingStats {
  /** Bytes/sec across all uploads in the last 1s. */
  bytesPerSec: number;
  /** Chunk uploads/sec in the last 1s. */
  uploadsPerSec: number;
  /**
   * Ratio of *upload-bound* considered chunks that were filtered out:
   * `(skippedWrongLod + skippedAlreadySent + skippedOtherPlane + skippedNoMeta) /
   *  (drainedChunks − skippedPrefetch − skippedOverview)`.
   *
   * Excludes prefetch (cache-only by design) and overview (minimap path).
   * High = real planning / wanted-set sync issue — chunks the orch *meant*
   * to upload to the main GPU atlas got filtered.
   */
  filterRatio: number;
  /** p50 / p95 of upload byte sizes over the last N samples. */
  uploadSizeP50: number | null;
  uploadSizeP95: number | null;
  // Cumulative since session start
  totalBytes: number;
  totalUploads: number;
  /** Number of `deliverToWorker` calls in window where budgetExhausted=true. */
  budgetExhaustedTicksLastSecond: number;
}

export function emptyUploadTickStats(): UploadTickStats {
  return {
    drainedChunks: 0,
    uploadedChunks: 0,
    bytesUploaded: 0, bytesBudget: 0,
    budgetExhausted: false,
    skippedPrefetch: 0, skippedOverview: 0, skippedWrongLod: 0,
    skippedAlreadySent: 0, skippedOtherPlane: 0, skippedNoMeta: 0,
  };
}

/** Per-tick aggregate stored in the rolling window. */
interface TickWindowEntry {
  at: number;
  drained: number;
  uploaded: number;
  skipped: number;
  skippedPrefetch: number;
  skippedOverview: number;
  skippedWrongLod: number;
  skippedAlreadySent: number;
  skippedOtherPlane: number;
  skippedNoMeta: number;
  budgetExhausted: boolean;
}

interface EventEntry {
  at: number;
  bytes: number;
}

export class UploadTelemetry {
  private readonly uploadEvents = new TimeWindow<EventEntry>();
  private readonly uploadTickWindow = new TimeWindow<TickWindowEntry>();
  /**
   * Circular sample buffer for p50/p95 upload size: the most recent
   * `UPLOAD_SIZE_SAMPLES` byte counts, in arbitrary order (they get sorted
   * before use, so the write position carries no meaning).
   */
  private readonly uploadSizeSamples = new Array<number>(UPLOAD_SIZE_SAMPLES);
  private uploadSizeCursor = 0;
  private uploadSizeCount = 0;
  private uploadTotalBytes = 0;
  private uploadTotalUploads = 0;

  private readonly budgetExhaustedDetector = new ConsecutiveTickDetector({
    threshold: UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
    rateLimitMs: UPLOAD_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "upload.budget_exhausted_sustained", payload as Record<string, unknown>),
  });
  private readonly drainWasteDetector = new SustainedCondition({
    sustainMs: UPLOAD_LOG_SUSTAIN_MS,
    rateLimitMs: UPLOAD_LOG_RATE_LIMIT_MS,
    log: (payload) =>
      debugLog("orch", "upload.drain_waste", payload as Record<string, unknown>),
  });

  recordEvent(now: number, bytes: number): void {
    this.uploadEvents.push({ at: now, bytes });
    this.uploadSizeSamples[this.uploadSizeCursor] = bytes;
    this.uploadSizeCursor = (this.uploadSizeCursor + 1) % UPLOAD_SIZE_SAMPLES;
    if (this.uploadSizeCount < UPLOAD_SIZE_SAMPLES) this.uploadSizeCount += 1;
    this.uploadTotalBytes += bytes;
    this.uploadTotalUploads += 1;
  }

  /** Called once at the end of each `deliverToWorker` invocation. */
  publish(now: number, stats: UploadTickStats): UploadRollingStats {
    const skipped =
      stats.skippedPrefetch +
      stats.skippedOverview +
      stats.skippedWrongLod +
      stats.skippedAlreadySent +
      stats.skippedOtherPlane +
      stats.skippedNoMeta;
    this.uploadTickWindow.push({
      at: now,
      drained: stats.drainedChunks,
      uploaded: stats.uploadedChunks,
      skipped,
      skippedPrefetch: stats.skippedPrefetch,
      skippedOverview: stats.skippedOverview,
      skippedWrongLod: stats.skippedWrongLod,
      skippedAlreadySent: stats.skippedAlreadySent,
      skippedOtherPlane: stats.skippedOtherPlane,
      skippedNoMeta: stats.skippedNoMeta,
      budgetExhausted: stats.budgetExhausted,
    });

    // Prune both ring buffers to the 1s window. O(dropped), not O(dropped·n).
    const cutoff = now - UPLOAD_WINDOW_MS;
    this.uploadEvents.pruneBefore(cutoff);
    this.uploadTickWindow.pruneBefore(cutoff);

    let bytesInWindow = 0;
    let uploadsInWindow = 0;
    this.uploadEvents.forEach((e) => {
      bytesInWindow += e.bytes;
      uploadsInWindow += 1;
    });

    let drainedInWindow = 0;
    let skippedInWindow = 0;
    let exhaustedTicks = 0;
    let winSkippedPrefetch = 0;
    let winSkippedOverview = 0;
    let winSkippedWrongLod = 0;
    let winSkippedAlreadySent = 0;
    let winSkippedOtherPlane = 0;
    let winSkippedNoMeta = 0;
    this.uploadTickWindow.forEach((t) => {
      drainedInWindow += t.drained;
      skippedInWindow += t.skipped;
      winSkippedPrefetch += t.skippedPrefetch;
      winSkippedOverview += t.skippedOverview;
      winSkippedWrongLod += t.skippedWrongLod;
      winSkippedAlreadySent += t.skippedAlreadySent;
      winSkippedOtherPlane += t.skippedOtherPlane;
      winSkippedNoMeta += t.skippedNoMeta;
      if (t.budgetExhausted) exhaustedTicks += 1;
    });
    const skippedInWindowByCause = {
      skippedPrefetch: winSkippedPrefetch,
      skippedOverview: winSkippedOverview,
      skippedWrongLod: winSkippedWrongLod,
      skippedAlreadySent: winSkippedAlreadySent,
      skippedOtherPlane: winSkippedOtherPlane,
      skippedNoMeta: winSkippedNoMeta,
    };
    // Upload-bound = chunks meant for the main GPU atlas. Excludes
    // prefetch (cache-only) and overview (minimap).
    const drainedUploadBoundInWindow =
      drainedInWindow - winSkippedPrefetch - winSkippedOverview;
    const skippedUploadBoundInWindow =
      winSkippedWrongLod + winSkippedAlreadySent + winSkippedOtherPlane + winSkippedNoMeta;

    let p50: number | null = null;
    let p95: number | null = null;
    if (this.uploadSizeCount > 0) {
      const sorted = this.uploadSizeSamples
        .slice(0, this.uploadSizeCount)
        .sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    const rolling: UploadRollingStats = {
      // UPLOAD_WINDOW_MS = 1000ms, so bytes-in-window = bytes-per-sec.
      bytesPerSec: bytesInWindow,
      uploadsPerSec: uploadsInWindow,
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

    return rolling;
  }

  /**
   * Detectors:
   * 1. `upload.budget_exhausted_sustained` — CPU→GPU pipe saturated.
   * 2. `upload.drain_waste` — decoded chunks unwanted by GPU
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
        skippedOverview: number;
        skippedWrongLod: number;
        skippedAlreadySent: number;
        skippedOtherPlane: number;
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

    const drainCondition =
      !Number.isNaN(rolling.filterRatio) &&
      rolling.filterRatio > UPLOAD_FILTER_RATIO_THRESHOLD;
    this.drainWasteDetector.tick(now, drainCondition, (sustainedMs) => ({
      filterRatio: rolling.filterRatio,
      drainedUploadBoundInWindow: window.drainedUploadBoundInWindow,
      skippedUploadBoundInWindow: window.skippedUploadBoundInWindow,
      skippedWrongLod: window.byCause.skippedWrongLod,
      skippedAlreadySent: window.byCause.skippedAlreadySent,
      skippedOtherPlane: window.byCause.skippedOtherPlane,
      skippedNoMeta: window.byCause.skippedNoMeta,
      // Informational — prefetch/overview don't count toward the ratio
      // but are useful "was the decode pool busy?" context.
      skippedPrefetch: window.byCause.skippedPrefetch,
      skippedOverview: window.byCause.skippedOverview,
      sustainedMs: Math.round(sustainedMs),
    }));
  }
}
