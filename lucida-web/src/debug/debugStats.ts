/**
 * Shapes for the orchestration telemetry aggregators.
 *
 * This file used to hold a global sink the pipeline wrote gauges into while
 * `enabled` was true — flipped by the debug panel opening. That gate is gone
 * (ADR 0049: recording is unconditional), and the gauges went with it rather
 * than becoming unconditional work, because the trace already carries the same
 * per-tick aggregates on a path that allocates nothing. What is left are the
 * types the upload and cold-state windows are expressed in, which the `orch`
 * log category still emits.
 */


/**
 * Upper bound on rows in any per-member debug ARRAY (`memberStats`,
 * `orch.activeSet`). A wide collection has tens of
 * thousands of members; building (and letting the panel copy/render)
 * unbounded per-member rows freezes the page for seconds. Scalar totals
 * next to each array keep reporting the full population.
 */
/**
 * Per-dataset planning snapshot. Populated by the orchestrator after each
 * full plan() run; replayed onto cache-hit ticks so the panel doesn't
 * blink to zero between non-planning frames.
 *
 * Single datasets and collections use the same shape. For single, `groupsByMode`
 * collapses to a single "tiles-with-detail" count; the per-LOD breakdown
 * carries the heavy lifting (it's the dominant signal for "is my LOD
 * selection sane").
 */



/** Per-epoch cause attribution counters. */
export interface ColdStateCauseCounts {
  content: number;
  layout: number;
  view: number;
  selection: number;
  asset: number;
}

export interface ColdStateDebug {
  /** Cumulative rebuilds since session start. */
  rebuilds: number;
  /** Cumulative cache hits since session start. */
  cacheHits: number;
  /** Hit rate over the last 1s window (0..1). NaN if no events yet. */
  hitRate: number;
  /** Rebuilds in the last 1s rolling window. */
  rebuildsLastSecond: number;
  /** Cache hits in the last 1s rolling window. */
  hitsLastSecond: number;
  /**
   * Per-epoch invalidation counts in the last 1s window. A single
   * rebuild can bump multiple epochs (e.g. view + selection during a
   * t-scrub with camera motion), so the sum may exceed `rebuildsLastSecond`.
   */
  causeLastSecond: ColdStateCauseCounts;
  /** Wall-clock ms for the most recent rebuild (planAndFetch non-fast-path). */
  lastRebuildMs: number | null;
  /** p50 of last-N rebuild durations (60-sample window). */
  rebuildP50Ms: number | null;
  /** p95 of last-N rebuild durations. */
  rebuildP95Ms: number | null;
  /**
   * `performance.now()` timestamp of the last rebuild. The DebugPanel
   * polls every ~200ms and computes `now - lastRebuildAt` to drive the
   * header pulse afterglow.
   */
  lastRebuildAt: number;
}

export function emptyColdStateDebug(): ColdStateDebug {
  return {
    rebuilds: 0,
    cacheHits: 0,
    hitRate: NaN,
    rebuildsLastSecond: 0,
    hitsLastSecond: 0,
    causeLastSecond: { content: 0, layout: 0, view: 0, selection: 0, asset: 0 },
    lastRebuildMs: null,
    rebuildP50Ms: null,
    rebuildP95Ms: null,
    lastRebuildAt: 0,
  };
}


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


