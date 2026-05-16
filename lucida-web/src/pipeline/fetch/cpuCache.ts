/**
 * CPU Cache — holds decompressed data between network and GPU.
 *
 * Owns detail/overview caches with three-tier adaptive eviction,
 * a priority-ordered fetch scheduler, and the submit/drain/snapshot/telemetry API.
 *
 * See docs/cpu-cache-spec.md for the full specification.
 */

import type {
  ContentSource,
  FetchResult,
  FetchProxyResult,
} from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type {
  RequestPlan,
  ChunkRequest,
  CacheStateSnapshot,
  ProxyRequest,
} from "../planning/index.ts";
import type { SceneEpochs } from "../epochs.ts";
import { InteractionModeDetector } from "./interactionMode.ts";
import { BurstLogger, TelemetryCounters } from "./telemetry.ts";
import {
  LRUPolicy,
  TieredPolicy,
  getTierOrder,
} from "./eviction.ts";
import { ChunkStore } from "./chunkStore.ts";
import {
  ProxyStore,
  proxyInnerKey,
  type ProxyCacheEntry,
  type ProxyEvictable,
} from "./proxyStore.ts";
import { Scheduler } from "./scheduler.ts";
import {
  classifyFetchError,
  NeverRetry,
  OnceTransientRetry,
  type RetryPolicy,
} from "./retry.ts";
import { RejectionTracker } from "./rejection.ts";
import { debugLog } from "../../debug/logging.ts";
import type {
  CacheEntry,
  CacheTelemetry,
  CpuCacheConfig,
  EvictionTier,
  Lane,
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
} from "./types.ts";

// Re-export the public-surface types so callers that imported them via
// `./cpuCache.ts` keep working unchanged. The barrel (`./index.ts`)
// pulls types from `./types.ts` directly.
export type {
  CacheEntry,
  CacheTelemetry,
  CpuCacheConfig,
  EvictionTier,
  Lane,
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
  TierCounters,
  TierResidencyEntry,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAIN_BUDGET = 512 * 1024 * 1024;
export const DEFAULT_OVERVIEW_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_PROXY_BUDGET = 256 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
export const FETCH_CONCURRENCY_MULTIPLIER = 3;
export const TRANSIENT_RETRY_DELAY_MS = 500;
export const MAX_TRANSIENT_RETRIES = 1;
export const INTERACTION_MODE_WINDOW = 10;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FailedEntry {
  failedUntilContentEpoch: number;
  isPermanent: boolean;
}

// ---------------------------------------------------------------------------
// CpuCache
// ---------------------------------------------------------------------------

export class CpuCache {
  private source: ContentSource;
  private decode: DecodePool;
  private config: CpuCacheConfig;

  /**
   * Detail (main) chunk store. Tiered LRU eviction with the
   * active-detail tiebreaker. See `chunkStore.ts` for the public
   * surface; the cache wires its policy + telemetry sink at
   * construction.
   */
  private chunkStore!: ChunkStore;

  /**
   * Overview chunk store. Pure LRU eviction; serves both lane="overview"
   * and lane="minimap" entries (see ADR 0023). Same {@link ChunkStore}
   * class as the main store, parameterized by a different policy +
   * eviction-tier label.
   */
  private overviewStore!: ChunkStore;

  /**
   * Proxy store: two-level Map<datasetId, Map<innerKey, ProxyCacheEntry>>.
   * Eviction tier order is detail > proxy > overview, so under memory
   * pressure proxies stick around longer than overview chunks but are
   * dropped before in-use detail chunks.
   */
  private proxyStore!: ProxyStore;

  /**
   * Chunk fetch scheduler. Owns the pending queue + in-flight Map +
   * bytes accounting + per-key enqueue timestamps + the rate-limited
   * `cache.backpressure` log channel. Wired in the constructor with
   * a `startFn` that runs {@link fetchAndDecode} for the dequeued
   * request. The dedup ladder (rejected / cached / in-flight /
   * failed) STAYS on cpu cache — the scheduler accepts a pre-deduped
   * list via {@link Scheduler.enqueue}.
   */
  private chunkScheduler!: Scheduler<ChunkRequest>;

  /**
   * Proxy fetch scheduler. Mirrors {@link chunkScheduler} but with
   * (a) a different key function (datasetId|innerKey) and
   * (b) a `siblingInFlight` hook that lets the proxy scheduler share
   * the chunk caps — see the original `startProxyFetches` ("share
   * the chunk concurrency caps for now; proxies are a small minority").
   */
  private proxyScheduler!: Scheduler<ProxyRequest>;

  // Ready deliveries (not yet drained)
  private ready: ReadyDelivery[] = [];

  // Active set tracking
  private activeEntityIds = new Set<string>();

  // Epoch velocity tracking → derives the active interaction mode for
  // eviction-order selection.
  private interactionDetector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

  // Failure tracking
  private failures = new Map<string, FailedEntry>(); // inFlightKey → failure

  // Monotonic counter for LRU ordering, tied to insertion order so the
  // eviction policies can sort entries oldest-first.
  private lruCounter = 0;

  // Telemetry counters and rate-limited debug loggers. Counter
  // mutations go through verb calls (`recordHit`, `recordEviction`,
  // …); the cache composes the public `CacheTelemetry` from
  // `counters.snapshot(now)` plus the per-call store walk in
  // `telemetry()`.
  //
  // The `cache.backpressure` channel now lives on the chunk
  // scheduler's `BurstLogger` (passed through its config) so the
  // log fires from `Scheduler.drain` without the cache having to
  // mediate. The proxy scheduler intentionally does NOT get a
  // backpressure logger — pre-Slice-7 behavior never logged
  // backpressure for the proxy path.
  private counters = new TelemetryCounters();
  private burstFailures = new BurstLogger("cache", "cache.failure_burst");

  /**
   * Retry rule for the chunk fetch path. `OnceTransientRetry` mirrors
   * the pre-Slice-8 behaviour: one retry on transient errors, none on
   * permanent (404 / malformed / setup bugs like "no wire format
   * registered"). Wired at construction so tests + future variants can
   * swap policies without touching `fetchAndDecode`.
   */
  private chunkRetryPolicy: RetryPolicy = new OnceTransientRetry(TRANSIENT_RETRY_DELAY_MS);

  /**
   * Retry rule for the proxy fetch path. `NeverRetry` mirrors the
   * pre-Slice-8 behaviour: no in-fetch retries — the orchestrator
   * resubmits on the next plan tick if the proxy is still wanted.
   */
  private proxyRetryPolicy: RetryPolicy = new NeverRetry();

  /**
   * Bumped at the start of every `submit()`. Stamped onto cached
   * entries when their request appears in the new plan. Eviction reads
   * this to identify "not currently wanted" chunks (oldest tick =
   * least recently planned).
   */
  private submitTick = 0;

  /**
   * Chunks the GPU worker reported as `skipped` (atlas full, incoming
   * farther than farthest existing slot). The orchestrator calls
   * {@link markRejected} on each one and {@link clearRejected} on every
   * cold-state rebuild, so the tracker reflects "wanted but not
   * deliverable under the current camera". `submit()` skips enqueuing
   * rejected chunks for fetch — and crucially, does NOT refresh
   * `lastSeenTick` on cached-but-rejected entries, so the
   * active-detail eviction sweeps them out before useful chunks.
   */
  private rejectionTracker = new RejectionTracker();

  // Listeners notified when new chunks become ready
  private listeners: (() => void)[] = [];

  // Current epochs (for failure clearing)
  private currentEpochs: SceneEpochs = {
    content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0,
  };

  constructor(source: ContentSource, decode: DecodePool, config?: Partial<CpuCacheConfig>) {
    this.source = source;
    this.decode = decode;
    this.config = {
      mainBudgetBytes: config?.mainBudgetBytes ?? DEFAULT_MAIN_BUDGET,
      overviewBudgetBytes: config?.overviewBudgetBytes ?? DEFAULT_OVERVIEW_BUDGET,
      proxyBudgetBytes: config?.proxyBudgetBytes ?? DEFAULT_PROXY_BUDGET,
      maxConcurrentFetches: config?.maxConcurrentFetches ?? (decode.size * FETCH_CONCURRENCY_MULTIPLIER),
      maxBytesInFlight: config?.maxBytesInFlight ?? DEFAULT_MAX_BYTES_IN_FLIGHT,
    };

    // Wire the three stores. Eviction policies and telemetry sinks
    // flow in via store-options; insert + eviction collapse into one
    // call on the store side (see Slice 6 / chunkStore.ts).
    //
    // Eviction-burst log is main-cache only (matches pre-Slice-6
    // behavior) — only the main store gets `onEvictionBurst`.
    const mainPolicy = new TieredPolicy(() => this.interactionDetector.current());
    this.chunkStore = new ChunkStore({
      policy: mainPolicy,
      budgetBytes: this.config.mainBudgetBytes,
      // For main-cache evictions the entry's tier is the truth: an
      // active-detail eviction counts under activeDetail even though
      // the cache type is "main".
      evictionTier: (entry) => entry.tier,
      recordEviction: (tier) => this.counters.recordEviction(tier),
      onEvictionBurst: ({ removed, bytesFreed, bytesNeeded }) => {
        debugLog("cache", "cache.eviction_burst", {
          cache: "main",
          removed,
          bytesFreed,
          bytesNeeded,
          mode: this.interactionDetector.current(),
        });
      },
    });
    this.overviewStore = new ChunkStore({
      policy: new LRUPolicy<CacheEntry>(),
      budgetBytes: this.config.overviewBudgetBytes,
      // Overview cache entries all carry tier "prefetch" cosmetically
      // (see `laneToTier`); evictions count under the "overview"
      // aggregate, not the tier-specific buckets.
      evictionTier: () => "overview",
      recordEviction: (tier) => this.counters.recordEviction(tier),
    });
    this.proxyStore = new ProxyStore({
      policy: new LRUPolicy<ProxyEvictable>(),
      budgetBytes: this.config.proxyBudgetBytes,
      recordEviction: () => this.counters.recordEviction("proxy"),
    });

    // Wire the two schedulers. Both share the same concurrency +
    // bytes caps; the proxy scheduler additionally consults the
    // chunk scheduler's totals via `siblingInFlight` so the combined
    // load can't exceed the cap (proxies are a small minority — see
    // the original `startProxyFetches` comment).
    //
    // The chunk scheduler owns the rate-limited `cache.backpressure`
    // log; the proxy scheduler intentionally does not (matches the
    // pre-Slice-7 behavior — only the chunk path logged backpressure).
    //
    // The `startFn` callback decouples the scheduler from
    // decode/proxy mechanics: the scheduler tracks the slot, the
    // callback runs the actual work and is responsible for calling
    // back into the scheduler (`correctInFlightBytes`,
    // `markInFlightDone`) at the right transition points.
    const burstBackpressure = new BurstLogger("cache", "cache.backpressure");
    this.chunkScheduler = new Scheduler<ChunkRequest>(
      {
        maxConcurrentFetches: this.config.maxConcurrentFetches,
        maxBytesInFlight: this.config.maxBytesInFlight,
        burstLogger: burstBackpressure,
      },
      (req) => this.inFlightKey(req),
      (req, controller, _estimate, key) => {
        this.fetchAndDecode(req, controller, key).catch(() => {
          // Errors handled inside fetchAndDecode.
        });
      },
    );
    this.proxyScheduler = new Scheduler<ProxyRequest>(
      {
        maxConcurrentFetches: this.config.maxConcurrentFetches,
        maxBytesInFlight: this.config.maxBytesInFlight,
        // Proxy slots count against the same caps as chunk slots.
        siblingInFlight: () => ({
          count: this.chunkScheduler.inFlightSize,
          bytes: this.chunkScheduler.inFlightBytes,
        }),
      },
      (req) => this.inFlightProxyKey(req),
      (req, controller, _estimate, key) => {
        this.fetchProxy(req, controller, key).catch(() => {
          // Errors handled inside fetchProxy.
        });
      },
    );
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Add new requests to the fetch queue. Purely additive — does NOT cancel
   * in-flight fetches that aren't in the new plan. Use cancelDataset() for
   * explicit removal.
   *
   * Plan churn from view/layout/selection changes is handled cheaply: the
   * dedup pass skips anything already in-flight, cached, or failed, so
   * re-submitting an unchanged plan is a no-op for the fetch queue.
   *
   * Active-set diffing still happens here — entities removed from the
   * active set have their detail entries demoted from active-detail to
   * demoted-detail tier (eviction priority signal).
   */
  submit(plan: RequestPlan): void {
    this.currentEpochs = plan.epochs;
    this.submitTick++;

    // Track epoch velocity
    this.interactionDetector.push(plan.epochs);

    // Update active set → demotion. Only the main store carries tiered
    // entries; the overview store is LRU-only and demotion would be
    // meaningless there.
    const newActiveIds = new Set(plan.activeSet.map(e => e.entityId));
    for (const entityId of this.activeEntityIds) {
      if (!newActiveIds.has(entityId)) {
        this.chunkStore.demoteEntity(entityId);
      }
    }
    this.activeEntityIds = newActiveIds;

    // Build new pending list: skip in-flight and failed; refresh cached.
    // The scheduler accepts the pre-deduped list; it handles the
    // pending-queue + enqueue-timestamp bookkeeping internally
    // (preserving original timestamps across re-submits).
    const pendingChunks: ChunkRequest[] = [];
    const enqueueNow = performance.now();
    for (const req of plan.requests) {
      const key = this.inFlightKey(req);

      this.counters.recordRequest();

      // Worker has rejected this chunk under the current camera (atlas
      // full + too far). Skip without refreshing `lastSeenTick` so the
      // active-detail eviction can sweep the cached copy out — keeping
      // it would burn budget on residency that won't reach the GPU.
      // Cleared on the next cold-state rebuild via `clearRejected()`.
      if (this.rejectionTracker.has(req.entityId, req.chunkKey)) {
        continue;
      }

      // Already cached? Refresh priority + lastSeenTick on the entry so
      // eviction can see the chunk is still wanted and at what urgency.
      // Planning emits cached chunks (it no longer filters them) so the
      // refresh signal reaches every still-wanted entry.
      const cachedEntry = this.lookupCachedEntry(req);
      if (cachedEntry) {
        this.counters.recordHit();
        cachedEntry.priority = req.priority;
        cachedEntry.lastSeenTick = this.submitTick;
        continue;
      }

      // Already in-flight?
      if (this.chunkScheduler.hasInFlight(key)) continue;

      // Failed and not cleared?
      const failure = this.failures.get(key);
      if (failure && this.currentEpochs.content < failure.failedUntilContentEpoch) continue;

      pendingChunks.push(req);
    }
    this.chunkScheduler.enqueue(pendingChunks, enqueueNow);

    // Route proxy requests to fetchProxy. Mirrors the chunk path:
    // dedup against the proxy cache + in-flight map, then enqueue.
    const proxyRequests = plan.proxyRequests ?? [];
    const pendingProxies: ProxyRequest[] = [];
    for (const req of proxyRequests) {
      const key = this.inFlightProxyKey(req);

      // Already cached? Skip silently — mirrors the chunk path. The
      // orchestrator tracks delivered proxies separately and re-sends
      // via `getCachedProxy` when the worker reports an eviction.
      if (this.isProxyCached(req)) continue;

      // Already in-flight?
      if (this.proxyScheduler.hasInFlight(key)) continue;

      pendingProxies.push(req);
    }
    this.proxyScheduler.enqueue(pendingProxies, enqueueNow);

    // Start new fetches
    this.chunkScheduler.drain(() => this.counters.averageDecodedBytes());
    this.proxyScheduler.drain(() => this.counters.averageDecodedBytes());
  }

  /**
   * Drop all state belonging to a removed dataset.
   *
   * Aborts in-flight chunk fetches whose entityId is in entityIds, in-flight
   * proxy fetches under datasetId, queued entries, cached entries (detail +
   * overview chunks for entityIds, proxies under datasetId), ready
   * deliveries, failure-map entries for entityIds, and activeEntityIds
   * entries.
   *
   * The orchestrator owns the dataset → entityIds mapping; this method
   * does not maintain its own. Pass the full set of entity ids that
   * belonged to the removed dataset.
   *
   * Called by RenderLoop.removeDataset. Not called for view/layout/
   * selection epoch bumps — those are pure plan churn and must not
   * abort fetches.
   */
  cancelDataset(datasetId: string, entityIds: string[]): void {
    const entityIdSet = new Set(entityIds);

    // 1. Chunk scheduler: aborts in-flight + drops pending entries
    //    whose entityId is in the set. The scheduler shares one
    //    predicate across both halves so the contract is uniform.
    this.chunkScheduler.cancelDataset(
      (entry) => entityIdSet.has(entry.request.entityId),
    );

    // 2. Proxy scheduler: same shape, filtering on datasetId.
    this.proxyScheduler.cancelDataset(
      (entry) => entry.request.datasetId === datasetId,
    );

    // 3. Cached chunks (detail + overview) — fan out to the stores.
    this.chunkStore.cancelDataset(entityIds);
    this.overviewStore.cancelDataset(entityIds);

    // 4. Cached proxies under this dataset.
    this.proxyStore.cancelDataset(datasetId);

    // 5. Ready deliveries.
    this.ready = this.ready.filter(d => {
      if (d.kind === "proxy") return d.datasetId !== datasetId;
      return !entityIdSet.has(d.entityId);
    });

    // 6. Failure map + activeEntityIds. Failure keys are
    // `${entityId}/${chunkKey}`; entityIds may contain slashes
    // (plate naming, e.g. "plateId:A/1/0"), so prefix-match on
    // `entityId + "/"` rather than splitting.
    for (const entityId of entityIds) {
      const prefix = `${entityId}/`;
      for (const key of this.failures.keys()) {
        if (key.startsWith(prefix)) this.failures.delete(key);
      }
      this.activeEntityIds.delete(entityId);
    }
  }

  /**
   * Mark a chunk as rejected by the GPU worker (atlas full + too far).
   * Subsequent `submit()` calls skip it: no fetch enqueue, no
   * `lastSeenTick` refresh on a cached copy. Cancels an in-flight fetch
   * for the same key if one is still running — its bytes are already
   * spoken for and no consumer will use the result.
   *
   * The orchestrator owns the rejection lifecycle and clears the set
   * via {@link clearRejected} on every cold-state rebuild.
   */
  markRejected(entityId: string, chunkKey: string): void {
    const wasNew = this.rejectionTracker.mark(entityId, chunkKey);
    if (!wasNew) return;

    // First-time rejection: abort the in-flight fetch (if any) so the
    // bytes are released and no consumer waits on a result that won't
    // be used. Repeated `markRejected` calls for the same key are
    // no-ops — the first one already cancelled, and any later refetch
    // would have been blocked by `submit()`'s rejection-ladder check.
    this.chunkScheduler.cancelOne(this.inFlightKey({ entityId, chunkKey } as ChunkRequest));
  }

  /**
   * Clear all worker-rejection markings. Called by the orchestrator on
   * every cold-state rebuild (any of content/layout/view/selection/asset
   * epoch changed) — the camera or active set may have shifted enough
   * that previously-too-far chunks now fit.
   */
  clearRejected(): void {
    this.rejectionTracker.clear();
  }

  /** Pull decoded buffers up to budget. Returns new deliveries only. */
  drain(budgetBytes: number): ReadyDelivery[] {
    if (this.ready.length === 0) return [];

    const result: ReadyDelivery[] = [];
    let remaining = budgetBytes;
    const kept: ReadyDelivery[] = [];

    for (const delivery of this.ready) {
      if (remaining > 0) {
        result.push(delivery);
        remaining -= delivery.data.byteLength;
      } else {
        kept.push(delivery);
      }
    }

    this.ready = kept;
    return result;
  }

  /**
   * Immutable snapshot of cached + in-flight keys. Used by the
   * orchestrator and DebugOverlays for telemetry — Planning no longer
   * consumes this (it emits all visible chunks; the cache dedups in
   * `submit()`).
   */
  snapshot(): CacheStateSnapshot {
    const cached = new Map<string, Set<string>>();
    for (const [entityId, chunkKeys] of this.chunkStore.entityChunkKeys()) {
      cached.set(entityId, new Set(chunkKeys));
    }
    for (const [entityId, chunkKeys] of this.overviewStore.entityChunkKeys()) {
      const existing = cached.get(entityId) ?? new Set();
      for (const key of chunkKeys) existing.add(key);
      cached.set(entityId, existing);
    }

    const inFlight = new Map<string, Set<string>>();
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      const entityId = entry.request.entityId;
      const set = inFlight.get(entityId) ?? new Set();
      set.add(entry.request.chunkKey);
      inFlight.set(entityId, set);
    }

    return { cached, inFlight };
  }

  /** Current stats for debug panel. */
  telemetry(): CacheTelemetry {
    const now = performance.now();
    const counters = this.counters.snapshot(now);
    const mode = this.interactionDetector.current();

    // Per-tier residency is composed from each store's own walk: the
    // main store bins by `entry.tier` (active/demoted/prefetch); the
    // overview + proxy stores total their entries into a single bucket.
    const mainTiers = this.chunkStore.tierResidency();
    const overviewTotals = this.overviewStore.totalResidency();
    const proxyTotals = this.proxyStore.totalResidency();
    const tierResidency = {
      activeDetail: mainTiers.activeDetail,
      demotedDetail: mainTiers.demotedDetail,
      prefetch: mainTiers.prefetch,
      overview: overviewTotals,
      proxy: proxyTotals,
    };

    // Pending-queue starvation signal: oldest enqueue timestamp wins.
    // Lives on the chunk scheduler (Slice 7); the proxy scheduler
    // doesn't surface a separate age — proxies are best-effort and
    // the orchestrator resubmits if they're missing.
    const pendingOldestAgeMs = this.chunkScheduler.oldestPendingAgeMs(now);

    return {
      mainBytes: this.chunkStore.bytes,
      mainBudget: this.config.mainBudgetBytes,
      overviewBytes: this.overviewStore.bytes,
      overviewBudget: this.config.overviewBudgetBytes,
      proxyBytes: this.proxyStore.bytes,
      proxyBudget: this.config.proxyBudgetBytes,
      maxConcurrentFetches: this.config.maxConcurrentFetches,
      maxBytesInFlight: this.config.maxBytesInFlight,
      inFlightCount: this.chunkScheduler.inFlightSize,
      inFlightBytes: this.chunkScheduler.inFlightBytes,
      inFlightProxyCount: this.proxyScheduler.inFlightSize,
      inFlightProxyBytes: this.proxyScheduler.inFlightBytes,
      pendingCount: this.chunkScheduler.pendingSize,
      pendingProxyCount: this.proxyScheduler.pendingSize,
      pendingOldestAgeMs,
      readyCount: this.ready.length,
      hitRate: counters.hitRate,
      evictionsPerSec: counters.evictionsPerSec,
      evictionsByTier: counters.evictionsByTier,
      interactionMode: mode,
      evictionTierOrder: getTierOrder(mode),
      failedChunks: {
        transient: counters.transientFailures,
        permanent: counters.permanentFailures,
      },
      lastError: counters.lastError,
      decodesPerSec: counters.decodesPerSec,
      decodeWorkersTotal: this.decode.size,
      avgDecodeMs: counters.avgDecodeMs,
      decodeP50Ms: counters.decodeP50Ms,
      decodeP95Ms: counters.decodeP95Ms,
      tierResidency,
    };
  }

  /** Update configuration at runtime (e.g. from debug panel). */
  updateConfig(partial: Partial<CpuCacheConfig>): void {
    Object.assign(this.config, partial);
  }

  /**
   * Look up a cached chunk by entity and chunk key.
   * Returns a ReadyChunkDelivery if the chunk is in the detail or
   * overview cache, null otherwise. Used by the Orchestrator for
   * re-sending chunks evicted from the worker. Proxies are not
   * re-sendable through this path — see [`getCachedProxy`].
   */
  getCachedChunk(entityId: string, chunkKey: string): ReadyChunkDelivery | null {
    const entry =
      this.chunkStore.get(entityId, chunkKey) ??
      this.overviewStore.get(entityId, chunkKey);
    return entry ? this.chunkEntryToDelivery(entry) : null;
  }

  /**
   * Look up a cached proxy. Returns a ReadyProxyDelivery if the proxy
   * is in the proxy cache, null otherwise.
   */
  getCachedProxy(
    datasetId: string,
    entityId: string,
    kind: "WellProxy3D" | "FieldProxy3D",
    t: number,
    c: number,
  ): ReadyProxyDelivery | null {
    const entry = this.proxyStore.get(datasetId, proxyInnerKey({ entityId, kind, t, c }));
    if (!entry) return null;
    return this.proxyEntryToDelivery(entry);
  }

  /**
   * Whether a proxy fetch is currently in-flight. Used by debug overlays
   * to render an "in-flight" status without exposing the internal
   * inFlightProxy map.
   */
  isProxyInFlight(
    datasetId: string,
    entityId: string,
    kind: "WellProxy3D" | "FieldProxy3D",
    t: number,
    c: number,
  ): boolean {
    return this.proxyScheduler.hasInFlight(
      `${datasetId}|${proxyInnerKey({ entityId, kind, t, c })}`,
    );
  }

  /**
   * Eviction tier of a cached chunk, or null if it's not cached. Used
   * by the chunk-grid overlay to color cached cells by their eviction
   * tier so churn ("active fades to demoted to prefetch then evicts")
   * is visible. Lookup hits both main + overview caches so overview
   * chunks (which carry tier `prefetch` cosmetically — they're LRU-
   * managed, not tiered) still resolve.
   */
  getCachedChunkTier(entityId: string, chunkKey: string): EvictionTier | null {
    const entry =
      this.chunkStore.get(entityId, chunkKey) ??
      this.overviewStore.get(entityId, chunkKey);
    return entry?.tier ?? null;
  }

  /**
   * Snapshot of the current `pendingRequests` (sorted by priority — the
   * order they will be dequeued). Used by the chunk-grid overlay to
   * color planned chunks by their queue rank, so "expected fetch order"
   * is visible alongside "actual cached state."
   */
  getPendingSnapshot(): readonly ChunkRequest[] {
    return this.chunkScheduler.pendingSnapshot();
  }

  /** Snapshot of pending proxy requests, sorted by priority. */
  getPendingProxySnapshot(): readonly ProxyRequest[] {
    return this.proxyScheduler.pendingSnapshot();
  }

  /**
   * Per-entity dump of cached chunks, grouped by LOD and tier. Used by
   * the DebugPanel "Dump cache contents" button. Pure read; no mutation.
   */
  getCacheDump(): Array<{
    entityId: string;
    cache: "main" | "overview";
    level: number;
    tier: EvictionTier;
    bytes: number;
    chunkKey: string;
    insertedAt: number;
  }> {
    return [
      ...this.chunkStore.dump().map(e => ({ ...e, cache: "main" as const })),
      ...this.overviewStore.dump().map(e => ({ ...e, cache: "overview" as const })),
    ];
  }

  /**
   * Per-dataset dump of cached proxies. Mirrors `getCacheDump` for the
   * proxy tier; separate because proxies live in their own typed map.
   */
  getProxyCacheDump(): Array<{
    datasetId: string;
    entityId: string;
    proxyKind: "WellProxy3D" | "FieldProxy3D";
    t: number;
    c: number;
    bytes: number;
    insertedAt: number;
  }> {
    return this.proxyStore.dump();
  }

  /**
   * Pending-queue dump with per-entry age (ms since enqueue). The
   * panel "Dump pending queue" button uses this to surface starvation.
   */
  getPendingDump(): Array<{
    chunkKey: string;
    entityId: string;
    lane: Lane;
    priority: number;
    ageMs: number;
  }> {
    const now = performance.now();
    return this.chunkScheduler.pendingSnapshot().map(r => {
      const enq = this.chunkScheduler.enqueueTimeFor(this.inFlightKey(r));
      return {
        chunkKey: r.chunkKey,
        entityId: r.entityId,
        lane: r.lane,
        priority: r.priority,
        ageMs: enq !== undefined ? now - enq : 0,
      };
    });
  }

  /** Register a listener called when new chunks become ready. Returns unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    for (const l of this.listeners) l();
  }

  /** Clear all caches, cancel all fetches. */
  reset(): void {
    // Cancel all in-flight + drop pending — fan out to each scheduler.
    this.chunkScheduler.reset();
    this.proxyScheduler.reset();

    // Clear caches — fan out to each store.
    this.chunkStore.reset();
    this.overviewStore.reset();
    this.proxyStore.reset();

    // Clear state
    this.ready = [];
    this.activeEntityIds.clear();
    this.interactionDetector.reset();
    this.failures.clear();
    this.rejectionTracker.clear();
    this.lruCounter = 0;
    this.submitTick = 0;

    // Clear listeners
    this.listeners = [];

    // Reset telemetry counters; the rate-limited burst loggers are
    // stateless wrt boot timing (their windows are clock-relative)
    // so they don't need an explicit reset.
    this.counters.reset();
  }

  // =========================================================================
  // Fetch + Decode
  // =========================================================================

  private async fetchAndDecode(
    req: ChunkRequest,
    controller: AbortController,
    key: string,
    retryCount = 0,
  ): Promise<void> {
    let result: FetchResult;
    try {
      result = await this.source.fetch(
        { datasetId: req.datasetId, imageId: req.imageId, chunkKey: req.chunkKey },
        controller.signal,
      );
    } catch (err: unknown) {
      const fe = classifyFetchError(err);

      // Aborted — clean and silent. Covers both signal aborts
      // (`DOMException` promoted by `classifyFetchError`) and explicit
      // caller cancellations (`Dataset removed`).
      if (fe.kind === "abort") {
        this.chunkScheduler.markInFlightDone(key);
        return;
      }

      // Retry if the policy allows. Pre-Slice-8 this was a manual
      // `!isPermanent && retryCount < MAX_TRANSIENT_RETRIES` check
      // with string-substring classification; now the source's typed
      // `FetchError.kind` owns the decision and the policy is
      // injectable.
      if (this.chunkRetryPolicy.shouldRetry(fe, retryCount)) {
        await new Promise(r => setTimeout(r, this.chunkRetryPolicy.delayMs(retryCount)));
        if (!this.chunkScheduler.hasInFlight(key)) return; // cancelled during wait
        return this.fetchAndDecode(req, controller, key, retryCount + 1);
      }

      // Final failure: mark in failures map + record telemetry. The
      // "no wire format registered" path now lands here with
      // `kind: "permanent"` (Slice 8 bug fix; was misclassified
      // transient pre-refactor).
      const isPermanent = fe.kind === "permanent";
      this.failures.set(key, {
        failedUntilContentEpoch: this.currentEpochs.content + 1,
        isPermanent,
      });
      this.counters.recordFetchFailure(isPermanent, fe.message);
      this.recordFailureForBurstDetection(isPermanent, fe.message);
      this.chunkScheduler.markInFlightDone(key);
      return;
    }

    // Correct in-flight bytes from estimate to actual
    const responseBytes = result.bytes.byteLength;
    this.chunkScheduler.correctInFlightBytes(key, responseBytes);

    // Update running average for future estimates
    this.counters.recordCompletedFetch(responseBytes);

    // Decode
    let decoded: ArrayBuffer;
    try {
      const t0 = performance.now();
      decoded = await this.decode.decode(result.bytes, result.wireFormat);
      this.counters.recordDecode(performance.now() - t0);
    } catch (err: unknown) {
      this.counters.recordError(err instanceof Error ? err.message : String(err));
      // Guard: submit() may have already cancelled this entry during decode
      this.chunkScheduler.markInFlightDone(key);
      return;
    }

    // Remove from in-flight (guard: submit() may have cancelled during decode)
    this.chunkScheduler.markInFlightDone(key);

    // Check if still wanted (might have been cancelled during decode)
    // We still cache it since the work is done

    // Insert into cache
    const lane = req.lane;
    const tier = this.laneToTier(lane);
    const cacheEntry: CacheEntry = {
      data: decoded,
      sizeBytes: decoded.byteLength,
      lane,
      tier,
      entityId: req.entityId,
      imageId: req.imageId,
      level: req.level,
      t: req.t,
      c: req.c,
      z: req.z,
      y: req.y,
      x: req.x,
      chunkKey: req.chunkKey,
      insertedAt: this.lruCounter++,
      epochs: { ...this.currentEpochs },
      dataType: result.dataType,
      priority: req.priority,
      lastSeenTick: this.submitTick,
    };

    // `lane: "minimap"` shares the overview cache (see ADR 0023) so
    // minimap chunks land in the most-protected eviction tier.
    // Combined with the planner emitting minimap at priority 0, the
    // effect is "fetched first, evicted last" — minimap survives
    // memory pressure that clears detail chunks.
    if (lane === "overview" || lane === "minimap") {
      this.overviewStore.insert(cacheEntry);
    } else {
      this.chunkStore.insert(cacheEntry);
    }

    // Mark as ready for drain
    this.ready.push(this.chunkEntryToDelivery(cacheEntry));

    // Notify listeners that a new chunk is ready
    this.notifyListeners();

    // Start next pending fetch
    this.chunkScheduler.drain(() => this.counters.averageDecodedBytes());
  }

  // =========================================================================
  // Proxy Fetch
  // =========================================================================

  private async fetchProxy(
    req: ProxyRequest,
    controller: AbortController,
    key: string,
  ): Promise<void> {
    let result: FetchProxyResult;
    try {
      result = await this.source.fetchProxy(
        {
          datasetId: req.datasetId,
          entityId: req.entityId,
          kind: req.kind,
          t: req.t,
          c: req.c,
        },
        controller.signal,
      );
    } catch (err: unknown) {
      const fe = classifyFetchError(err);
      if (fe.kind === "abort") {
        this.proxyScheduler.markInFlightDone(key);
        return;
      }
      // Proxy retry policy is `NeverRetry` — consult it for symmetry
      // with the chunk path; today it always returns false. No
      // failures-map entry: the orchestrator resubmits on the next
      // plan tick if the proxy is still wanted (pre-Slice-8 behaviour
      // preserved).
      if (this.proxyRetryPolicy.shouldRetry(fe, 0)) {
        await new Promise(r => setTimeout(r, this.proxyRetryPolicy.delayMs(0)));
        if (!this.proxyScheduler.hasInFlight(key)) return;
        return this.fetchProxy(req, controller, key);
      }
      this.counters.recordError(fe.message);
      this.proxyScheduler.markInFlightDone(key);
      return;
    }

    // Correct in-flight bytes accounting
    const responseBytes = result.data.byteLength;
    this.proxyScheduler.correctInFlightBytes(key, responseBytes);

    // Insert into proxy cache (store handles eviction internally).
    const cacheEntry: ProxyCacheEntry = {
      header: result.header,
      data: result.data,
      bytes: responseBytes,
      datasetId: req.datasetId,
      entityId: req.entityId,
      imageId: req.imageId,
      proxyKind: req.kind,
      t: req.t,
      c: req.c,
      insertedAt: this.lruCounter++,
      epochs: { ...this.currentEpochs },
    };

    this.proxyStore.insert(req.datasetId, proxyInnerKey(req), cacheEntry);

    this.proxyScheduler.markInFlightDone(key);

    // Mark as ready for drain
    this.ready.push(this.proxyEntryToDelivery(cacheEntry));
    this.notifyListeners();

    // Drain queue
    this.proxyScheduler.drain(() => this.counters.averageDecodedBytes());
  }

  private isProxyCached(req: ProxyRequest): boolean {
    return this.proxyStore.has(req.datasetId, proxyInnerKey(req));
  }

  private inFlightProxyKey(req: ProxyRequest): string {
    return `${req.datasetId}|${proxyInnerKey(req)}`;
  }

  /**
   * Failure-burst detector. Aggregates failures within a 1-second
   * window; emits a single log entry per window if the burst exceeds
   * the threshold. Avoids one-line-per-failure spam while still
   * surfacing real outages (e.g., the WS bridge dropping mid-fetch).
   */
  private recordFailureForBurstDetection(isPermanent: boolean, message: string): void {
    this.burstFailures.recordBurst(4, (count) => ({
      failuresInLastSec: count,
      lastFailurePermanent: isPermanent,
      lastError: message,
    }));
  }

  private proxyEntryToDelivery(entry: ProxyCacheEntry): ReadyProxyDelivery {
    return {
      kind: "proxy",
      datasetId: entry.datasetId,
      entityId: entry.entityId,
      imageId: entry.imageId,
      proxyKind: entry.proxyKind,
      t: entry.t,
      c: entry.c,
      header: entry.header,
      data: entry.data,
      epochs: entry.epochs,
    };
  }

  private chunkEntryToDelivery(entry: CacheEntry): ReadyChunkDelivery {
    return {
      kind: "chunk",
      entityId: entry.entityId,
      imageId: entry.imageId,
      level: entry.level,
      t: entry.t,
      c: entry.c,
      z: entry.z,
      y: entry.y,
      x: entry.x,
      chunkKey: entry.chunkKey,
      data: entry.data,
      dataType: entry.dataType,
      epochs: entry.epochs,
      lane: entry.lane,
    };
  }

  // =========================================================================
  // Cache Management
  // =========================================================================

  private lookupCachedEntry(req: ChunkRequest): CacheEntry | undefined {
    // `minimap` shares the overview cache (see ADR 0023) so we look
    // in the same store. Other lanes (detail / prefetch) live in the
    // main chunk store.
    const usesOverviewCache = req.lane === "overview" || req.lane === "minimap";
    const store = usesOverviewCache ? this.overviewStore : this.chunkStore;
    return store.get(req.entityId, req.chunkKey);
  }

  private laneToTier(lane: Lane): EvictionTier {
    if (lane === "prefetch") return "prefetch";
    // overview + minimap share the overview store (simple LRU, tier
    // doesn't matter — see ADR 0023). The "prefetch" tier value here
    // is purely a no-op label for entries that live in the overview
    // store; the active-detail / demoted-detail / prefetch
    // distinctions only matter for entries in the main chunk store.
    if (lane === "overview" || lane === "minimap") return "prefetch";
    // Only "detail" remains.
    return "active-detail";
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private inFlightKey(req: ChunkRequest): string {
    return `${req.entityId}/${req.chunkKey}`;
  }
}
