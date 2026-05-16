/**
 * Global debug stats sink.
 *
 * The render loop writes stats here during each tick. The DebugPanel
 * component polls them on a timer. This keeps instrumentation decoupled
 * from rendering — the only coupling is this flat, write-anywhere object.
 */

export interface MemberStat {
  id: string;
  level: number;
  numLevels: number;
  chunksNeeded: number;
  chunksSent: number;
}

/** Per-member debug data from the Orchestrator's adapter translation. */
export interface OrchMemberDebug {
  imageId: string;
  position: [number, number];
  neededCount: number;
  prefetchCount: number;
  /** Level selected by upload path: needed[0]?.level */
  uploadLevel: number | undefined;
  /** Breakdown: how many needed chunks at each level */
  chunksByLevel: Record<number, number>;
  /** True if needed[] contains chunks at more than one level */
  mixedLevels: boolean;
}

/**
 * Per-dataset planning snapshot. Populated by the orchestrator after each
 * full plan() run; replayed onto cache-hit ticks so the panel doesn't
 * blink to zero between non-planning frames.
 *
 * Single datasets and plates use the same shape. For single, `wellsByMode`
 * collapses to a single "fields-with-detail" count; the per-LOD breakdown
 * carries the heavy lifting (it's the dominant signal for "is my LOD
 * selection sane").
 */
export interface PlanningDatasetDebug {
  datasetId: string;
  /**
   * Total chunk requests in the plan, broken down by lane. The
   * `minimap` lane is highest priority (see
   * [[decisions/0023-minimap-lane-with-highest-priority]]); `proxy`
   * is a chunk-lane reservation used by the type-system extension
   * (proxy *requests* are still tracked separately in {@link proxyCount}).
   */
  lanes: {
    minimap: number;
    detail: number;
    proxy: number;
    prefetch: number;
    overview: number;
  };
  /** Proxy requests in the plan (separate from chunk lanes). */
  proxyCount: number;
  /** Total chunk requests in the plan (sum of `lanes`). */
  totalChunks: number;
  /** Chunk requests grouped by LOD level — independent of lane. */
  chunksByLevel: Record<number, number>;
  /**
   * Per-LOD breakdown for the focused dataset. One entry per LOD that
   * appears in the plan, with cross-references against the CPU cache.
   */
  lodBreakdown: Array<{
    level: number;
    planned: number;
    cached: number;
    inFlight: number;
  }>;
  /** Frustum / xy / z culling stages, summed across all entities. */
  culling: {
    considered: number;
    afterXyBounds: number;
    afterZRange: number;
    afterFrustum: number;
  };
  /** Number of times catalog-aware mode assignment downgraded a well's mode. */
  catalogDegradations: number;
  /** Active-set entries grouped by tier mode. */
  wellsByMode: {
    wellAsProxy: number;
    fieldsWithProxyFallback: number;
    fieldsWithDetail: number;
  };
  /**
   * Entity nearest the viewport center (or null if no visible entities).
   * Drives the focal-entity inspector in the Planning tab.
   */
  focalEntity: {
    entityId: string;
    parentWellId: string | null;
    kind: string;
    projectedDiagonalPx: number;
    projectedAreaPx2: number;
    importance: number;
    idealTargetLod: number;
    detailOwnedRange: [number, number];
    mode: string;
    /** Human-readable reason for the chosen mode (threshold band). */
    modeReason: string;
    /** Lowest priority value across this entity's chunk requests, or null. */
    topPriority: number | null;
    /** How many chunk requests this entity contributed to the plan. */
    chunkCount: number;
  } | null;
}

/** Orchestrator debug snapshot, populated per planning cycle. */
export interface OrchDebug {
  /** Active set entries from plan() */
  activeSet: Array<{
    entityId: string;
    /** Tier mode — see {@link import("../pipeline/planning/index.ts").EntityMode}. */
    mode: string;
    targetLod: number;
    coarsestDetailLod: number;
    detailOwnedLodRange: [number, number];
  }>;
  /** Request counts by lane */
  laneCount: { detail: number; prefetch: number; overview: number };
  /** Request counts by level */
  chunksByLevel: Record<number, number>;
  /** First N requests for inspection */
  topRequests: Array<{
    entityId: string;
    level: number;
    t: number; c: number; z: number; y: number; x: number;
    lane: string;
    priority: number;
    chunkKey: string;
  }>;
  /** Per-member roster entry (for debug display) */
  members: OrchMemberDebug[];
  /** True if any member has mixed levels in needed[] */
  hasMixedLevels: boolean;
  /** Whether this was an epoch cache hit (plan() skipped) */
  epochCacheHit: boolean;
  /**
   * Cold-state rebuild telemetry. Counts and rates for `planAndFetch`
   * fast-path hits vs full rebuilds, with per-epoch cause attribution
   * and timing. Surfaced in DebugPanel "Render" tab + a header pulse.
   *
   * Populated on every tick of `planAndFetch` (both hit and rebuild
   * paths). The cumulative counters (`rebuilds`/`cacheHits`/`causeTotal`)
   * grow monotonically; the windowed counters are pruned to the last
   * second of activity.
   */
  coldState: ColdStateDebug;
  /** VisibleRegion from WASM (for coordinate debugging) */
  visibleRegion: { xyBounds: [number, number, number, number]; zRange: [number, number]; effectiveZoom: number } | null;
  /** First few entity positions + level0 shape (for overlap debugging) */
  entityDiag: Array<{
    entityId: string;
    position: [number, number];
    fullShape: [number, number] | null; // [fullX, fullY] from level 0
    cachedKeys: number; // how many keys getCachedKeys returned
  }>;
}

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
  /** Cumulative per-epoch invalidation counts since session start. */
  causeTotal: ColdStateCauseCounts;
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

/** Initialize a zeroed ColdStateDebug snapshot. */
export function emptyColdStateDebug(): ColdStateDebug {
  return {
    rebuilds: 0,
    cacheHits: 0,
    hitRate: NaN,
    rebuildsLastSecond: 0,
    hitsLastSecond: 0,
    causeLastSecond: { content: 0, layout: 0, view: 0, selection: 0, asset: 0 },
    causeTotal: { content: 0, layout: 0, view: 0, selection: 0, asset: 0 },
    lastRebuildMs: null,
    rebuildP50Ms: null,
    rebuildP95Ms: null,
    lastRebuildAt: 0,
  };
}

export interface DebugStats {
  enabled: boolean;

  // Frame timing
  frameTimeMs: number;
  planTimeMs: number;
  uploadTimeMs: number;

  // LOD
  effectiveZoom: number;
  zoomPerVoxel: number;
  selectedLevel: number;
  numLevels: number;

  // Upload budget
  uploadBytesUsed: number;
  uploadBudgetTotal: number;
  budgetExhausted: boolean;

  // Render passes
  renderPasses: {
    total: number;
    /**
     * Per-dataset breakdown using the original `dsId` from the layer-build
     * loop, not the layer's `datasetId` (which may be a composite key
     * `imageId:chN` in multi-channel mode).
     */
    byDataset: Record<string, number>;
  };
  visibleMembers: number;
  totalMembers: number;

  // Multi-channel
  activeChannels: number;

  // Plan cache
  planCacheHits: number;
  planCacheMisses: number;

  // Per-member breakdown
  memberStats: MemberStat[];

  // Mode
  mode: "slice" | "volume" | "";

  // Orchestrator debug
  orch: OrchDebug | null;

  /**
   * Planning section. Per-dataset because both the lane counts and the
   * LOD breakdown vary per dataset; a single key gives us a panel that
   * groups naturally and avoids the "last dataset wins" aliasing in
   * `orch`. Empty object until the first plan() runs.
   */
  planning: {
    byDataset: Record<string, PlanningDatasetDebug>;
  };

  /**
   * CPU → GPU upload telemetry. Populated by `deliverToWorker` each
   * tick. Two views:
   *
   * - `tick`: snapshot of the most recent `deliverToWorker` call —
   *   what got drained, what got uploaded vs filtered, bytes against
   *   budget, resend pass results.
   * - `rolling`: 1s-windowed rates and ratios for "is the upload path
   *   keeping up?" plus cumulative totals and an upload-size sketch.
   *
   * Both are `null` until the first `deliverToWorker` call lands.
   */
  upload: {
    tick: UploadTickStats | null;
    rolling: UploadRollingStats | null;
  };
}

/**
 * Per-tick `deliverToWorker` snapshot. Resets at the start of each
 * call; published at the end. Drives the Orch tab's per-tick pane.
 */
export interface UploadTickStats {
  /** Items returned by `cpuCache.drain(budget)` this tick. */
  drainedChunks: number;
  drainedProxies: number;
  /** Items actually posted to the worker this tick. */
  uploadedChunks: number;
  uploadedProxies: number;
  /** Bytes actually posted (from delivery `data.byteLength`). */
  bytesUploaded: number;
  /** Drain byte budget passed in by the caller. */
  bytesBudget: number;
  /**
   * Drain stopped early because remaining budget hit zero. NOT a
   * function of bytesUploaded reaching bytesBudget: a single chunk
   * larger than remaining will still be uploaded and trigger this.
   */
  budgetExhausted: boolean;
  // Skip reasons during the drain pass (one entry per drained item):
  /** Lane was `prefetch` — pre-cached for future timepoint. */
  skippedPrefetch: number;
  /** Lane was `overview` — minimap path owns these. */
  skippedOverview: number;
  /** Chunk level didn't match `targetLevelByImage[imageId]`. Stale plan. */
  skippedWrongLod: number;
  /** Chunk already in the orchestrator's `DeliveryTracker` sent set for the worker memberId. */
  skippedAlreadySent: number;
  /** Couldn't resolve dataset/imageSpec/level meta — should be ~0; bug indicator. */
  skippedNoMeta: number;
  // Resend pass — separate from drain because it indicates worker
  // eviction churn rather than fresh decode work.
  resendChunkUploads: number;
  resendProxyUploads: number;
  resendChunksConsidered: number;
  resendChunksAlreadySent: number;
  resendChunksNotCached: number;
  /**
   * Chunks the worker has reported as `skipped` (atlas full + farther
   * than the farthest existing slot). Tracked in the orchestrator's
   * `DeliveryTracker` rejected set and skipped by the resend pass until
   * the next plan rebuild clears the rejection state.
   */
  resendChunksRejected: number;
  resendProxiesConsidered: number;
  resendProxiesAlreadyDelivered: number;
  resendProxiesNotCached: number;
}

/**
 * 1s rolling upload stats. Computed by pruning a per-event log to a
 * 1s window. NaN ratios mean "no events in window" — render as `—`.
 */
export interface UploadRollingStats {
  /** Bytes/sec across all uploads (drain + resend) in the last 1s. */
  bytesPerSec: number;
  /** Uploads/sec (chunks + proxies). */
  uploadsPerSec: number;
  /**
   * Ratio of uploads sourced from the resend pass. High = atlas
   * thrashing (worker is evicting faster than fresh decodes can fill).
   */
  resendRatio: number;
  /**
   * Ratio of *upload-bound* drained chunks that were filtered out:
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

/** Initialize a zeroed UploadTickStats. */
export function emptyUploadTickStats(): UploadTickStats {
  return {
    drainedChunks: 0, drainedProxies: 0,
    uploadedChunks: 0, uploadedProxies: 0,
    bytesUploaded: 0, bytesBudget: 0,
    budgetExhausted: false,
    skippedPrefetch: 0, skippedOverview: 0, skippedWrongLod: 0,
    skippedAlreadySent: 0, skippedNoMeta: 0,
    resendChunkUploads: 0, resendProxyUploads: 0,
    resendChunksConsidered: 0, resendChunksAlreadySent: 0, resendChunksNotCached: 0,
    resendChunksRejected: 0,
    resendProxiesConsidered: 0, resendProxiesAlreadyDelivered: 0, resendProxiesNotCached: 0,
  };
}

export const debugStats: DebugStats = {
  enabled: false,
  frameTimeMs: 0,
  planTimeMs: 0,
  uploadTimeMs: 0,
  effectiveZoom: 0,
  zoomPerVoxel: 0,
  selectedLevel: 0,
  numLevels: 0,
  uploadBytesUsed: 0,
  uploadBudgetTotal: 8 * 1024 * 1024,
  budgetExhausted: false,
  renderPasses: { total: 0, byDataset: {} },
  visibleMembers: 0,
  totalMembers: 0,
  activeChannels: 1,
  planCacheHits: 0,
  planCacheMisses: 0,
  memberStats: [],
  mode: "",
  orch: null,
  planning: { byDataset: {} },
  upload: { tick: null, rolling: null },
};

/** Reset per-frame counters. Call at the start of each tick. */
export function resetFrameStats(): void {
  debugStats.planCacheHits = 0;
  debugStats.planCacheMisses = 0;
  debugStats.memberStats = [];
  debugStats.visibleMembers = 0;
  debugStats.totalMembers = 0;
  debugStats.renderPasses = { total: 0, byDataset: {} };
  debugStats.uploadBytesUsed = 0;
  debugStats.budgetExhausted = false;
}
