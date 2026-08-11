/**
 * Shapes for the orchestration telemetry aggregators.
 *
 * This file used to hold a global sink the pipeline wrote gauges into while
 * `enabled` was true — flipped by the debug panel opening. That gate is gone
 * (ADR 0049: recording is unconditional), and the gauges went with it rather
 * than becoming unconditional work, because the trace already carries the same
 * per-tick aggregates on a path that allocates nothing. What is left are the
 * types the upload window is expressed in, which the `orch` log category still
 * emits.
 */





/**
 * Per-tick `deliverToWorker` snapshot. Resets at the start of each
 * call; published at the end. Drives the Orch tab's per-tick pane.
 */
export interface UploadTickStats {
  /** Deliverable items considered from `cpuCache.getDeliverable()` this tick. */
  drainedChunks: number;
  drainedProxies: number;
  /** Items actually posted to the worker this tick. */
  uploadedChunks: number;
  uploadedProxies: number;
  /** Bytes actually posted (from delivery `data.byteLength`). */
  bytesUploaded: number;
  /** Upload byte budget passed in by the caller. */
  bytesBudget: number;
  /**
   * Upload stopped early because remaining budget hit zero. NOT a
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
  /** Couldn't resolve dataset/imageSpec/level meta — should be ~0; bug indicator. */
  skippedNoMeta: number;
}

/**
 * 1s rolling upload stats. Computed by pruning a per-event log to a
 * 1s window. NaN ratios mean "no events in window" — render as `—`.
 */
export interface UploadRollingStats {
  /** Bytes/sec across all uploads in the last 1s. */
  bytesPerSec: number;
  /** Uploads/sec (chunks + proxies). */
  uploadsPerSec: number;
  /** Chunk uploads/sec in the last 1s. */
  chunkUploadsPerSec: number;
  /** Proxy uploads/sec in the last 1s. */
  proxyUploadsPerSec: number;
  /**
   * Ratio of *upload-bound* considered chunks that were filtered out:
   * `(skippedWrongLod + skippedAlreadySent + skippedNoMeta) /
   *  (drainedChunks − skippedPrefetch − skippedOverview)`.
   *
   * Excludes prefetch (cache-only by design), overview (minimap path),
   * and proxies (separate atlas, never skipped). High = real
   * planning / wanted-set sync issue — chunks the orch *meant* to
   * upload to the main GPU atlas got filtered.
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
    drainedChunks: 0, drainedProxies: 0,
    uploadedChunks: 0, uploadedProxies: 0,
    bytesUploaded: 0, bytesBudget: 0,
    budgetExhausted: false,
    skippedPrefetch: 0, skippedOverview: 0, skippedWrongLod: 0,
    skippedAlreadySent: 0, skippedNoMeta: 0,
  };
}


