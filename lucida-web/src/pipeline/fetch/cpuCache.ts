/**
 * CPU Cache — holds decompressed data between network and GPU.
 *
 * Owns detail/overview caches with three-tier adaptive eviction,
 * a priority-ordered fetch scheduler, and the submit/getDeliverable/snapshot/telemetry API.
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
import { DeliveryState } from "./deliveryState.ts";
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
  ResidencyTier,
} from "./types.ts";

// Re-exported so existing `./cpuCache.ts` imports keep working.
export type {
  CacheEntry,
  CacheTelemetry,
  CpuCacheConfig,
  EvictionTier,
  Lane,
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
  ResidencyTier,
  TierCounters,
  TierResidencyEntry,
} from "./types.ts";

export const DEFAULT_MAIN_BUDGET = 512 * 1024 * 1024;
export const DEFAULT_OVERVIEW_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_PROXY_BUDGET = 256 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
export const FETCH_CONCURRENCY_MULTIPLIER = 3;
export const TRANSIENT_RETRY_DELAY_MS = 500;
export const MAX_TRANSIENT_RETRIES = 1;
/** Consecutive chunk-delivery failures with no delivered chunk in between
 *  before the `onChunkFailureStreak` config callback fires. What counts:
 *  permanent-kind fetch rejections — including the server's per-chunk
 *  `source_chunk_status` reports for store failures (revoked access,
 *  backend faults) — plus decode failures. Transient-kind failures
 *  (timeouts, disconnect rejections) never count. High enough that a few
 *  isolated misses never trip it; a systemically dead source crosses it
 *  within one viewport's requests. */
export const CHUNK_FAILURE_STREAK_THRESHOLD = 10;
/** Minimum spacing between `onChunkFailureStreak` calls while a streak
 *  persists — an aggregate signal, never per-chunk spam. */
export const CHUNK_FAILURE_NOTIFY_INTERVAL_MS = 15_000;
export const INTERACTION_MODE_WINDOW = 10;
const SPARSE_DETAIL_MIN_DESIRED_CHUNKS = 4;
const SPARSE_DETAIL_COVERAGE_RATIO = 0.25;
const SPARSE_DETAIL_STREAK_THRESHOLD = 3;
const SPARSE_DETAIL_LOG_RATE_LIMIT_MS = 5000;

interface FailedEntry {
  failedUntilContentEpoch: number;
  isPermanent: boolean;
}

interface InFlightChunkMeta {
  request: ChunkRequest;
  lastSeenTick: number;
  epochs: SceneEpochs;
}

interface InFlightProxyMeta {
  request: ProxyRequest;
  lastSeenTick: number;
  epochs: SceneEpochs;
}

export class CpuCache {
  private source: ContentSource;
  private decode: DecodePool;
  private config: CpuCacheConfig;

  private chunkStore!: ChunkStore;

  /** Serves both lane="overview" and lane="minimap" (ADR 0023). */
  private overviewStore!: ChunkStore;

  private proxyStore!: ProxyStore;

  private chunkScheduler!: Scheduler<ChunkRequest>;

  /** Shares concurrency / bytes caps with `chunkScheduler` via `siblingInFlight`. */
  private proxyScheduler!: Scheduler<ProxyRequest>;

  readonly deliveryState = new DeliveryState();

  private activeEntityIds = new Set<string>();
  private activeEntityIdsThisRebuild = new Set<string>();

  private interactionDetector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

  private failures = new Map<string, FailedEntry>();

  private lruCounter = 0;

  private counters = new TelemetryCounters();
  private burstFailures = new BurstLogger("cache", "cache.failure_burst");

  /** Consecutive chunk-delivery failures with no delivered (fetched AND
   *  decoded) chunk in between. Feeds `onChunkFailureStreak` (see
   *  `CpuCacheConfig`). */
  private chunkFailureStreak = 0;
  private lastChunkFailureNotifyAt = -Infinity;
  /** True after `onChunkFailureStreak` has fired and no delivery has
   *  recovered since — i.e. the owner may be showing the signal. */
  private chunkFailureSurfaced = false;

  private chunkRetryPolicy: RetryPolicy = new OnceTransientRetry(TRANSIENT_RETRY_DELAY_MS);

  /** Proxies are not retried in-fetch; orchestrator resubmits next tick. */
  private proxyRetryPolicy: RetryPolicy = new NeverRetry();

  /** Plan-rebuild generation stamped onto wanted cache entries. */
  private currentSubmitTick = 0;
  private desiredDetailKeysThisTick = new Set<string>();
  private desiredCoarseKeysThisTick = new Set<string>();
  private sparseDetailStreak = 0;
  private lastSparseDetailLogAt = -Infinity;

  /**
   * Latest wanted metadata for in-flight fetches. The request object
   * passed to `fetchAndDecode` may have been queued under an older
   * camera/LOD plan; these maps let later submits refresh the generation
   * and lane while the bytes are still in flight.
   */
  private inFlightChunkMeta = new Map<string, InFlightChunkMeta>();
  private inFlightProxyMeta = new Map<string, InFlightProxyMeta>();

  /**
   * Worker-rejected (atlas full + too far) chunks. `submit()` skips
   * enqueuing and does NOT refresh `lastSeenTick`, so the active-detail
   * eviction can sweep cached-but-rejected copies before useful ones.
   */
  private rejectionTracker = new RejectionTracker();

  private listeners: (() => void)[] = [];

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
      onChunkFailureStreak: config?.onChunkFailureStreak,
      onChunkFailureRecovered: config?.onChunkFailureRecovered,
    };

    const mainPolicy = new TieredPolicy(() => this.interactionDetector.current());
    this.chunkStore = new ChunkStore({
      policy: mainPolicy,
      budgetBytes: this.config.mainBudgetBytes,
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
      evictionTier: () => "overview",
      recordEviction: (tier) => this.counters.recordEviction(tier),
    });
    this.proxyStore = new ProxyStore({
      policy: new LRUPolicy<ProxyEvictable>(),
      budgetBytes: this.config.proxyBudgetBytes,
      recordEviction: () => this.counters.recordEviction("proxy"),
    });

    // Backpressure log is chunk-path only; proxy scheduler omits it.
    const burstBackpressure = new BurstLogger("cache", "cache.backpressure");
    this.chunkScheduler = new Scheduler<ChunkRequest>(
      {
        maxConcurrentFetches: this.config.maxConcurrentFetches,
        maxBytesInFlight: this.config.maxBytesInFlight,
        burstLogger: burstBackpressure,
        siblingInFlight: () => {
          const proxyScheduler = this.proxyScheduler as Scheduler<ProxyRequest> | undefined;
          return {
            count: proxyScheduler?.inFlightSize ?? 0,
            bytes: proxyScheduler?.inFlightBytes ?? 0,
          };
        },
      },
      (req) => this.inFlightKey(req),
      (req, controller, _estimate, key) => {
        const startedEpochs = { ...this.currentEpochs };
        this.rememberInFlightChunk(key, req, startedEpochs);
        // `fetchAndDecode` handles fetch/decode failures internally (retry,
        // failure map, streak surfacing); anything escaping here is an
        // unexpected pipeline error — keep it out of the void.
        this.fetchAndDecode(req, controller, key, 0, startedEpochs).catch((err: unknown) => {
          console.warn("[CpuCache] unexpected chunk pipeline error:", err);
        });
      },
    );
    this.proxyScheduler = new Scheduler<ProxyRequest>(
      {
        maxConcurrentFetches: this.config.maxConcurrentFetches,
        maxBytesInFlight: this.config.maxBytesInFlight,
        siblingInFlight: () => ({
          count: this.chunkScheduler.inFlightSize,
          bytes: this.chunkScheduler.inFlightBytes,
        }),
      },
      (req) => this.inFlightProxyKey(req),
      (req, controller, _estimate, key) => {
        this.rememberInFlightProxy(key, req, { ...this.currentEpochs });
        // Same boundary as the chunk arm: `fetchProxy` handles fetch
        // failures internally; only unexpected pipeline errors land here.
        this.fetchProxy(req, controller, key).catch((err: unknown) => {
          console.warn("[CpuCache] unexpected proxy pipeline error:", err);
        });
      },
    );
  }

  // Public API

  /**
   * Submit the current request plan. Re-submitting an unchanged plan is
   * still a no-op, but work for active entities that disappeared from
   * the new plan is preempted so scrubbed-away T/Z/channel work does not
   * block current requests behind the scheduler caps.
   */
  submit(plan: RequestPlan): void {
    this.currentEpochs = plan.epochs;

    this.interactionDetector.push(plan.epochs);

    const newActiveIds = new Set(plan.activeSet.map(e => e.entityId));
    for (const entityId of newActiveIds) this.activeEntityIdsThisRebuild.add(entityId);
    const plannedChunkKeys = new Set(plan.requests.map(req => this.inFlightKey(req)));
    this.recordTierDemand(plan.requests);
    this.applyElasticTierBudgets();
    this.cancelOmittedChunkWork(newActiveIds, plannedChunkKeys);

    const pendingChunks: ChunkRequest[] = [];
    const enqueueNow = performance.now();
    for (const req of plan.requests) {
      const key = this.inFlightKey(req);

      this.counters.recordRequest();

      // Worker-rejected under the current camera. Skip without
      // refreshing `lastSeenTick` so the cached copy can be evicted.
      if (this.rejectionTracker.has(req.entityId, req.chunkKey)) {
        continue;
      }

      // Refresh lane/tier/priority/lastSeenTick on cached entries so
      // deliverability and eviction reflect the current plan.
      const cachedEntry = this.lookupCachedEntry(req);
      if (cachedEntry) {
        this.counters.recordHit();
        cachedEntry.lane = req.lane;
        cachedEntry.residencyTier = this.requestResidencyTier(req);
        cachedEntry.tier = this.laneToTier(req.lane);
        cachedEntry.priority = req.priority;
        cachedEntry.lastSeenTick = this.currentSubmitTick;
        continue;
      }

      if (this.chunkScheduler.hasInFlight(key)) {
        this.rememberInFlightChunk(key, req, { ...this.currentEpochs });
        continue;
      }

      const failure = this.failures.get(key);
      if (failure && this.currentEpochs.content < failure.failedUntilContentEpoch) continue;

      pendingChunks.push(req);
    }
    this.chunkScheduler.enqueue(this.orderChunkRequestsForTierAllocation(pendingChunks), enqueueNow);

    const proxyRequests = plan.proxyRequests ?? [];
    const pendingProxies: ProxyRequest[] = [];
    for (const req of proxyRequests) {
      const key = this.inFlightProxyKey(req);

      const cachedProxy = this.proxyStore.get(req.datasetId, proxyInnerKey(req));
      if (cachedProxy) {
        cachedProxy.priority = req.priority;
        cachedProxy.lastSeenTick = this.currentSubmitTick;
        continue;
      }

      if (this.proxyScheduler.hasInFlight(key)) {
        this.rememberInFlightProxy(key, req, { ...this.currentEpochs });
        continue;
      }

      pendingProxies.push(req);
    }
    this.proxyScheduler.enqueue(pendingProxies, enqueueNow);

    this.drainSchedulers();
  }

  private cancelOmittedChunkWork(
    activeEntityIds: Set<string>,
    plannedChunkKeys: Set<string>,
  ): void {
    if (activeEntityIds.size === 0) return;
    const cancelled = this.chunkScheduler.cancelWhere((entry) => (
      activeEntityIds.has(entry.request.entityId) &&
      !plannedChunkKeys.has(this.inFlightKey(entry.request))
    ));
    for (const key of cancelled) {
      this.inFlightChunkMeta.delete(key);
    }
  }

  /**
   * Drop all state for a removed dataset. The orchestrator owns the
   * dataset → entityIds mapping; pass the full set. Not called for
   * view/layout/selection bumps — those must not abort fetches.
   */
  cancelDataset(datasetId: string, entityIds: string[]): void {
    const entityIdSet = new Set(entityIds);

    this.chunkScheduler.cancelDataset(
      (entry) => entityIdSet.has(entry.request.entityId),
    );

    this.proxyScheduler.cancelDataset(
      (entry) => entry.request.datasetId === datasetId,
    );

    this.chunkStore.cancelDataset(entityIds);
    this.overviewStore.cancelDataset(entityIds);

    this.proxyStore.cancelDataset(datasetId);
    this.deliveryState.clearProxySentForDataset(datasetId);

    // Failure keys are `${entityId}/${chunkKey}`; entityIds may
    // contain slashes (collection naming, e.g. "collectionId:A/1/0"), so
    // prefix-match on `entityId + "/"` rather than splitting.
    for (const entityId of entityIds) {
      const prefix = `${entityId}/`;
      for (const key of this.failures.keys()) {
        if (key.startsWith(prefix)) this.failures.delete(key);
      }
      for (const key of this.inFlightChunkMeta.keys()) {
        if (key.startsWith(prefix)) this.inFlightChunkMeta.delete(key);
      }
      this.activeEntityIds.delete(entityId);
      this.activeEntityIdsThisRebuild.delete(entityId);
      this.deliveryState.clearChunksForImage(entityId);
    }
    const proxyPrefix = `${datasetId}|`;
    for (const key of this.inFlightProxyMeta.keys()) {
      if (key.startsWith(proxyPrefix)) this.inFlightProxyMeta.delete(key);
    }
  }

  /**
   * Worker reports a chunk was skipped (atlas full + too far). Aborts
   * the in-flight fetch if any; subsequent `submit()` calls skip
   * enqueuing and don't refresh `lastSeenTick`. Cleared on every
   * cold-state rebuild via {@link clearRejected}.
   */
  markRejected(entityId: string, chunkKey: string): void {
    const wasNew = this.rejectionTracker.mark(entityId, chunkKey);
    if (!wasNew) return;

    const cancelled = this.chunkScheduler.cancelWhere((entry) => (
      entry.request.entityId === entityId &&
      entry.request.chunkKey === chunkKey
    ));
    for (const key of cancelled) {
      this.inFlightChunkMeta.delete(key);
    }
  }

  clearRejected(): void {
    this.rejectionTracker.clear();
  }

  onPlanRebuildStart(): void {
    for (const entityId of this.activeEntityIds) {
      if (!this.activeEntityIdsThisRebuild.has(entityId)) {
        this.chunkStore.demoteEntity(entityId);
      }
    }
    this.activeEntityIds = this.activeEntityIdsThisRebuild;
    this.activeEntityIdsThisRebuild = new Set();
    this.currentSubmitTick++;
    this.desiredDetailKeysThisTick.clear();
    this.desiredCoarseKeysThisTick.clear();
    this.sparseDetailStreak = 0;
    this.rejectionTracker.clear();
    this.deliveryState.onPlanRebuildStart();
  }

  *getDeliverable(): Iterable<ReadyDelivery> {
    const candidates: ReadyDelivery[] = [];

    for (const entry of this.chunkStore.iterateTier("active-detail")) {
      if (entry.lane !== "detail") continue;
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (this.deliveryState.wasChunkSent(
        entry.imageId,
        entry.c,
        entry.chunkKey,
        entry.residencyTier,
      )) {
        continue;
      }
      if (this.rejectionTracker.has(entry.entityId, entry.chunkKey)) continue;
      candidates.push(this.chunkEntryToDelivery(entry));
    }

    for (const entry of this.overviewStore.allEntries()) {
      if (entry.lane !== "coarse") continue;
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (this.deliveryState.wasChunkSent(
        entry.imageId,
        entry.c,
        entry.chunkKey,
        entry.residencyTier,
      )) {
        continue;
      }
      if (this.rejectionTracker.has(entry.entityId, entry.chunkKey)) continue;
      candidates.push(this.chunkEntryToDelivery(entry));
    }

    for (const entry of this.proxyStore.iterateSeenAt(this.currentSubmitTick)) {
      if (this.deliveryState.wasProxySent(this.proxyKeyFromEntry(entry))) continue;
      candidates.push(this.proxyEntryToDelivery(entry));
    }

    candidates.sort((a, b) => this.compareDeliveries(a, b));
    yield* candidates;
  }

  markSent(delivery: ReadyDelivery): void {
    if (delivery.kind === "chunk") {
      this.deliveryState.markChunkSent(
        delivery.imageId, delivery.c, delivery.chunkKey, delivery.residencyTier,
      );
    } else {
      this.deliveryState.markProxySent(this.proxyKeyFromDelivery(delivery));
    }
  }

  markChunkEvicted(
    imageId: string,
    c: number,
    evicted: string[],
    skipped: string[],
  ): void {
    for (const key of evicted) {
      this.deliveryState.clearChunkSent(imageId, c, key);
    }
    for (const key of skipped) {
      this.deliveryState.clearChunkSent(imageId, c, key);
      const entry =
        this.chunkStore.findByImageChunk(imageId, c, key) ??
        this.overviewStore.findByImageChunk(imageId, c, key);
      this.markRejected(entry?.entityId ?? imageId, key);
    }
  }

  markChunkMissing(
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): void {
    this.deliveryState.clearChunkSent(imageId, c, chunkKey, tier);
  }

  markProxyMissing(key: string): void {
    this.deliveryState.clearProxySent(key);
  }

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

  telemetry(): CacheTelemetry {
    const now = performance.now();
    const counters = this.counters.snapshot(now);
    const mode = this.interactionDetector.current();

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

    const pendingOldestAgeMs = this.chunkScheduler.oldestPendingAgeMs(now);
    const tierDemand = this.computeTierDemandTelemetry();
    const tierQueues = this.computeTierQueueTelemetry();
    this.maybeLogSparseDetail(now, tierDemand);

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
      readyCount: Array.from(this.getDeliverable()).length,
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
      tierDemand,
      tierQueues,
      tierBudgets: {
        detailBytes: this.chunkStore.budgetBytes,
        coarseBytes: this.overviewStore.budgetBytes,
      },
    };
  }

  updateConfig(partial: Partial<CpuCacheConfig>): void {
    Object.assign(this.config, partial);
    this.applyElasticTierBudgets();
  }

  /** Searches detail then overview; proxies use {@link getCachedProxy}. */
  getCachedChunk(entityId: string, chunkKey: string): ReadyChunkDelivery | null {
    const entry =
      this.chunkStore.get(entityId, chunkKey) ??
      this.overviewStore.get(entityId, chunkKey);
    return entry ? this.chunkEntryToDelivery(entry) : null;
  }

  getCachedProxy(
    datasetId: string,
    entityId: string,
    kind: "GroupProxy3D" | "TileProxy3D",
    t: number,
    c: number,
  ): ReadyProxyDelivery | null {
    const entry = this.proxyStore.get(datasetId, proxyInnerKey({ entityId, kind, t, c }));
    if (!entry) return null;
    return this.proxyEntryToDelivery(entry);
  }

  isProxyInFlight(
    datasetId: string,
    entityId: string,
    kind: "GroupProxy3D" | "TileProxy3D",
    t: number,
    c: number,
  ): boolean {
    return this.proxyScheduler.hasInFlight(
      `${datasetId}|${proxyInnerKey({ entityId, kind, t, c })}`,
    );
  }

  /** Searches detail then overview; null when neither has the chunk. */
  getCachedChunkTier(entityId: string, chunkKey: string): EvictionTier | null {
    const entry =
      this.chunkStore.get(entityId, chunkKey) ??
      this.overviewStore.get(entityId, chunkKey);
    return entry?.tier ?? null;
  }

  getPendingSnapshot(): readonly ChunkRequest[] {
    return this.chunkScheduler.pendingSnapshot();
  }

  getPendingProxySnapshot(): readonly ProxyRequest[] {
    return this.proxyScheduler.pendingSnapshot();
  }

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

  getProxyCacheDump(): Array<{
    datasetId: string;
    entityId: string;
    proxyKind: "GroupProxy3D" | "TileProxy3D";
    t: number;
    c: number;
    bytes: number;
    insertedAt: number;
  }> {
    return this.proxyStore.dump();
  }

  /** Per-entry age (ms since enqueue) for the starvation panel. */
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

  reset(): void {
    this.chunkScheduler.reset();
    this.proxyScheduler.reset();

    this.chunkStore.reset();
    this.overviewStore.reset();
    this.proxyStore.reset();

    this.activeEntityIds.clear();
    this.activeEntityIdsThisRebuild.clear();
    this.interactionDetector.reset();
    this.failures.clear();
    this.chunkFailureStreak = 0;
    this.lastChunkFailureNotifyAt = -Infinity;
    this.chunkFailureSurfaced = false;
    this.rejectionTracker.clear();
    this.deliveryState.reset();
    this.inFlightChunkMeta.clear();
    this.inFlightProxyMeta.clear();
    this.lruCounter = 0;
    this.currentSubmitTick = 0;
    this.chunkStore.setBudgetBytes(this.config.mainBudgetBytes);
    this.overviewStore.setBudgetBytes(this.config.overviewBudgetBytes);

    this.listeners = [];

    // BurstLoggers are clock-relative; no explicit reset needed.
    this.counters.reset();
  }

  // Fetch + Decode

  private async fetchAndDecode(
    req: ChunkRequest,
    controller: AbortController,
    key: string,
    retryCount = 0,
    startedEpochs: SceneEpochs = { ...this.currentEpochs },
  ): Promise<void> {
    let result: FetchResult;
    try {
      result = await this.source.fetch(
        { datasetId: req.datasetId, imageId: req.imageId, chunkKey: req.chunkKey },
        controller.signal,
      );
    } catch (err: unknown) {
      const fe = classifyFetchError(err);

      if (fe.kind === "abort" || fe.kind === "pending") {
        this.chunkScheduler.markInFlightDone(key);
        this.inFlightChunkMeta.delete(key);
        if (fe.kind === "pending") this.drainSchedulers();
        return;
      }

      if (this.chunkRetryPolicy.shouldRetry(fe, retryCount)) {
        await new Promise(r => setTimeout(r, this.chunkRetryPolicy.delayMs(retryCount)));
        if (!this.chunkScheduler.hasInFlight(key)) return; // cancelled during wait
        return this.fetchAndDecode(req, controller, key, retryCount + 1, startedEpochs);
      }

      const isPermanent = fe.kind === "permanent";
      this.failures.set(key, {
        failedUntilContentEpoch: this.currentEpochs.content + 1,
        isPermanent,
      });
      this.counters.recordFetchFailure(isPermanent, fe.message);
      this.recordFailureForBurstDetection(isPermanent, fe.message);
      // Transient-kind failures (network blips, timeouts, the transport's
      // own disconnect rejections) belong to the reconnect machinery —
      // counting them would let an ordinary connection drop or laptop
      // sleep masquerade as a failing data source. Only permanent
      // failures feed the streak here; decode failures are counted at the
      // decode boundary below.
      if (isPermanent) this.recordChunkFailureForStreak(fe.message);
      this.chunkScheduler.markInFlightDone(key);
      this.inFlightChunkMeta.delete(key);
      return;
    }

    const responseBytes = result.bytes.byteLength;
    this.chunkScheduler.correctInFlightBytes(key, responseBytes);

    this.counters.recordCompletedFetch(responseBytes);

    let decoded: ArrayBuffer;
    try {
      const t0 = performance.now();
      decoded = await this.decode.decode(result.bytes, result.wireFormat);
      this.counters.recordDecode(performance.now() - t0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.counters.recordError(message);
      // A fetch that completes but cannot be decoded (wrong wire format,
      // corrupted bytes, an intercepting proxy answering with garbage) is
      // a delivery failure: a source failing every decode stalls the
      // canvas exactly like one failing every fetch.
      this.recordChunkFailureForStreak(`decode failed: ${message}`);
      this.chunkScheduler.markInFlightDone(key);
      this.inFlightChunkMeta.delete(key);
      return;
    }

    // Only a DELIVERED chunk — fetched AND decoded — proves the source is
    // serving usable data; a completed fetch alone can still be garbage.
    this.recordChunkDelivered();

    const latestMeta = this.inFlightChunkMeta.get(key);
    const effectiveReq = latestMeta?.request ?? req;
    const metaEpochs = latestMeta?.epochs ?? startedEpochs;
    const stale =
      latestMeta === undefined ||
      latestMeta.lastSeenTick !== this.currentSubmitTick ||
      isEpochStale(metaEpochs, this.currentEpochs);
    const lastSeenTick = stale ? -1 : latestMeta.lastSeenTick;

    this.chunkScheduler.markInFlightDone(key);
    if (this.inFlightChunkMeta.get(key) === latestMeta) {
      this.inFlightChunkMeta.delete(key);
    }

    // Cache even if cancelled during decode — the work is done.
    const lane = effectiveReq.lane;
    const tier = stale ? "demoted-detail" : this.laneToTier(lane);
    const cacheEntry: CacheEntry = {
      data: decoded,
      sizeBytes: decoded.byteLength,
      lane,
      tier,
      entityId: effectiveReq.entityId,
      imageId: effectiveReq.imageId,
      level: effectiveReq.level,
      t: effectiveReq.t,
      c: effectiveReq.c,
      z: effectiveReq.z,
      y: effectiveReq.y,
      x: effectiveReq.x,
      chunkKey: effectiveReq.chunkKey,
      insertedAt: this.lruCounter++,
      epochs: { ...metaEpochs },
      dataType: result.dataType,
      residencyTier: this.requestResidencyTier(effectiveReq),
      priority: stale ? Number.MAX_SAFE_INTEGER : effectiveReq.priority,
      lastSeenTick,
    };

    // minimap/overview/coarse route to the overview/coarse bucket (ADR 0023 + coarse/detail bridge).
    if (lane === "overview" || lane === "minimap" || lane === "coarse") {
      if (stale && this.overviewStore.bytes + cacheEntry.sizeBytes > this.overviewStore.budgetBytes) {
        this.drainSchedulers();
        return;
      }
      this.overviewStore.insert(cacheEntry);
    } else {
      if (stale && this.chunkStore.bytes + cacheEntry.sizeBytes > this.chunkStore.budgetBytes) {
        this.drainSchedulers();
        return;
      }
      this.chunkStore.insert(cacheEntry);
    }

    this.notifyListeners();

    this.drainSchedulers();
  }

  // Proxy Fetch

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
        this.inFlightProxyMeta.delete(key);
        return;
      }
      // Consulted for symmetry; NeverRetry always returns false.
      if (this.proxyRetryPolicy.shouldRetry(fe, 0)) {
        await new Promise(r => setTimeout(r, this.proxyRetryPolicy.delayMs(0)));
        if (!this.proxyScheduler.hasInFlight(key)) return;
        return this.fetchProxy(req, controller, key);
      }
      this.counters.recordError(fe.message);
      this.proxyScheduler.markInFlightDone(key);
      this.inFlightProxyMeta.delete(key);
      return;
    }

    const responseBytes = result.data.byteLength;
    this.proxyScheduler.correctInFlightBytes(key, responseBytes);

    const latestMeta = this.inFlightProxyMeta.get(key);
    const effectiveReq = latestMeta?.request ?? req;
    const lastSeenTick = latestMeta?.lastSeenTick ?? this.currentSubmitTick;

    const cacheEntry: ProxyCacheEntry = {
      header: result.header,
      data: result.data,
      bytes: responseBytes,
      datasetId: effectiveReq.datasetId,
      entityId: effectiveReq.entityId,
      imageId: effectiveReq.imageId,
      proxyKind: effectiveReq.kind,
      t: effectiveReq.t,
      c: effectiveReq.c,
      insertedAt: this.lruCounter++,
      epochs: { ...this.currentEpochs },
      priority: effectiveReq.priority,
      lastSeenTick,
    };

    this.proxyStore.insert(effectiveReq.datasetId, proxyInnerKey(effectiveReq), cacheEntry);

    this.proxyScheduler.markInFlightDone(key);
    if (this.inFlightProxyMeta.get(key) === latestMeta) {
      this.inFlightProxyMeta.delete(key);
    }

    this.notifyListeners();

    this.drainSchedulers();
  }

  private drainSchedulers(): void {
    const estimateBytes = () => this.counters.averageDecodedBytes();

    // The two schedulers share caps through `siblingInFlight`. Drain the
    // proxy side first so fallback assets cannot sit behind a saturated
    // detail queue until the next camera move/submission wakes them.
    this.proxyScheduler.drain(estimateBytes);
    this.chunkScheduler.drain(estimateBytes);
  }

  private orderChunkRequestsForTierAllocation(requests: ChunkRequest[]): ChunkRequest[] {
    const detail: ChunkRequest[] = [];
    const coarse: ChunkRequest[] = [];
    const other: ChunkRequest[] = [];

    for (const req of requests) {
      const tier = this.requestResidencyTier(req);
      if (tier === "detail") detail.push(req);
      else if (tier === "coarse") coarse.push(req);
      else other.push(req);
    }

    if (detail.length === 0 || coarse.length === 0) {
      return [...detail, ...coarse, ...other];
    }

    const ordered: ChunkRequest[] = [];
    const max = Math.max(detail.length, coarse.length);
    for (let i = 0; i < max; i++) {
      if (i < detail.length) ordered.push(detail[i]);
      if (i < coarse.length) ordered.push(coarse[i]);
    }
    ordered.push(...other);
    return ordered;
  }

  private applyElasticTierBudgets(): void {
    const detailDemand = this.desiredDetailKeysThisTick.size > 0;
    const coarseDemand = this.desiredCoarseKeysThisTick.size > 0;
    const protectedDetail = this.config.mainBudgetBytes;
    const protectedCoarse = this.config.overviewBudgetBytes;

    let detailBudget = protectedDetail;
    let coarseBudget = protectedCoarse;

    if (detailDemand && !coarseDemand) {
      detailBudget += Math.max(0, protectedCoarse - this.overviewStore.bytes);
    } else if (coarseDemand && !detailDemand) {
      coarseBudget += Math.max(0, protectedDetail - this.chunkStore.bytes);
    }

    this.chunkStore.setBudgetBytes(detailBudget);
    this.overviewStore.setBudgetBytes(coarseBudget);
  }

  private rememberInFlightChunk(
    key: string,
    req: ChunkRequest,
    epochs: SceneEpochs,
  ): void {
    this.inFlightChunkMeta.set(key, {
      request: req,
      lastSeenTick: this.currentSubmitTick,
      epochs,
    });
  }

  private rememberInFlightProxy(
    key: string,
    req: ProxyRequest,
    epochs: SceneEpochs,
  ): void {
    this.inFlightProxyMeta.set(key, {
      request: req,
      lastSeenTick: this.currentSubmitTick,
      epochs,
    });
  }

  private inFlightProxyKey(req: ProxyRequest): string {
    return `${req.datasetId}|${proxyInnerKey(req)}`;
  }

  private recordFailureForBurstDetection(isPermanent: boolean, message: string): void {
    this.burstFailures.recordBurst(4, (count) => ({
      failuresInLastSec: count,
      lastFailurePermanent: isPermanent,
      lastError: message,
    }));
  }

  /**
   * The transport reconnected: failures accumulated against the dropped
   * connection (or its reconnect window) say nothing about the restored
   * one, so the count starts over. The surfaced/notify bookkeeping is
   * deliberately left alone — a signal already shown to the owner is only
   * retired by an actual delivery (see [`recordChunkDelivered`]).
   */
  resetChunkFailureStreak(): void {
    this.chunkFailureStreak = 0;
  }

  /**
   * Count a delivery failure (a post-retry permanent fetch failure, or a
   * decode failure) toward the consecutive-failure streak and notify the
   * owner once it crosses the threshold — throttled while the streak
   * persists. This is the user-visible complement to the per-chunk failure
   * map: individual misses stay quiet, but a source that fails everything
   * (e.g. credentials lost after a successful open, which the server
   * reports per chunk as `source_chunk_status` and the content source
   * rejects as permanent) must not present as a silently stalling canvas.
   */
  private recordChunkFailureForStreak(message: string): void {
    this.chunkFailureStreak += 1;
    const notify = this.config.onChunkFailureStreak;
    if (!notify) return;
    if (this.chunkFailureStreak < CHUNK_FAILURE_STREAK_THRESHOLD) return;
    const now = performance.now();
    if (now - this.lastChunkFailureNotifyAt < CHUNK_FAILURE_NOTIFY_INTERVAL_MS) return;
    this.lastChunkFailureNotifyAt = now;
    this.chunkFailureSurfaced = true;
    notify(this.chunkFailureStreak, message);
  }

  /** A chunk was delivered (fetched AND decoded): the streak breaks, and a
   *  previously notified signal is retired via `onChunkFailureRecovered`.
   *  The notify throttle re-arms so a NEW streak after recovery is a new
   *  incident and may notify immediately. */
  private recordChunkDelivered(): void {
    this.chunkFailureStreak = 0;
    if (!this.chunkFailureSurfaced) return;
    this.chunkFailureSurfaced = false;
    this.lastChunkFailureNotifyAt = -Infinity;
    this.config.onChunkFailureRecovered?.();
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
      priority: entry.priority,
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
      residencyTier: entry.residencyTier,
      priority: entry.priority,
    };
  }

  private compareDeliveries(a: ReadyDelivery, b: ReadyDelivery): number {
    const priority = (a.priority ?? 0) - (b.priority ?? 0);
    if (priority !== 0) return priority;

    if (a.kind !== b.kind) {
      return a.kind === "proxy" ? -1 : 1;
    }

    if (a.kind === "proxy" && b.kind === "proxy") {
      return (
        a.datasetId.localeCompare(b.datasetId) ||
        a.entityId.localeCompare(b.entityId) ||
        a.proxyKind.localeCompare(b.proxyKind) ||
        a.t - b.t ||
        a.c - b.c
      );
    }

    if (a.kind === "chunk" && b.kind === "chunk") {
      return (
        a.imageId.localeCompare(b.imageId) ||
        a.level - b.level ||
        a.t - b.t ||
        a.z - b.z ||
        a.y - b.y ||
        a.x - b.x ||
        a.c - b.c ||
        a.chunkKey.localeCompare(b.chunkKey)
      );
    }

    return 0;
  }

  private proxyKeyFromEntry(entry: ProxyCacheEntry): string {
    return `${entry.datasetId}|${entry.entityId}|${entry.proxyKind}|${entry.t}|${entry.c}`;
  }

  private proxyKeyFromDelivery(delivery: ReadyProxyDelivery): string {
    return `${delivery.datasetId}|${delivery.entityId}|${delivery.proxyKind}|${delivery.t}|${delivery.c}`;
  }

  // Cache Management

  private lookupCachedEntry(req: ChunkRequest): CacheEntry | undefined {
    // minimap/overview/coarse share the overview/coarse cache.
    const usesOverviewCache =
      req.lane === "overview" || req.lane === "minimap" || req.lane === "coarse";
    const store = usesOverviewCache ? this.overviewStore : this.chunkStore;
    return store.get(req.entityId, req.chunkKey);
  }

  private laneToTier(lane: Lane): EvictionTier {
    if (lane === "prefetch") return "prefetch";
    // overview/minimap use LRU; tier is a no-op label there.
    if (lane === "overview" || lane === "minimap" || lane === "coarse") return "prefetch";
    return "active-detail";
  }

  private requestResidencyTier(req: ChunkRequest): ResidencyTier {
    if (req.tier) return req.tier;
    return req.lane === "coarse" || req.lane === "overview" || req.lane === "minimap"
      ? "coarse"
      : "detail";
  }

  private recordTierDemand(requests: ChunkRequest[]): void {
    for (const req of requests) {
      if (this.requestResidencyTier(req) === "detail") {
        this.desiredDetailKeysThisTick.add(this.inFlightKey(req));
      } else if (this.requestResidencyTier(req) === "coarse") {
        this.desiredCoarseKeysThisTick.add(this.inFlightKey(req));
      }
    }
  }

  private computeTierDemandTelemetry(): CacheTelemetry["tierDemand"] {
    let residentDetailChunks = 0;
    let residentDetailBytes = 0;
    let residentCoarseChunks = 0;
    let residentCoarseBytes = 0;

    for (const entry of this.chunkStore.allEntries()) {
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (entry.residencyTier === "detail" || entry.lane === "detail") {
        residentDetailChunks++;
        residentDetailBytes += entry.sizeBytes;
      }
    }
    for (const entry of this.overviewStore.allEntries()) {
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (entry.residencyTier === "coarse" || entry.lane === "coarse") {
        residentCoarseChunks++;
        residentCoarseBytes += entry.sizeBytes;
      }
    }

    const desiredDetail = this.desiredDetailKeysThisTick.size;
    const detailCoverageRatio =
      desiredDetail > 0 ? residentDetailChunks / desiredDetail : 1;
    const sparseDetail =
      desiredDetail >= SPARSE_DETAIL_MIN_DESIRED_CHUNKS &&
      detailCoverageRatio < SPARSE_DETAIL_COVERAGE_RATIO &&
      (
        this.chunkScheduler.pendingSize > 0 ||
        this.chunkScheduler.inFlightSize > 0 ||
        this.chunkStore.bytes >= this.config.mainBudgetBytes * 0.95
      );

    return {
      desired: {
        detailChunks: desiredDetail,
        coarseChunks: this.desiredCoarseKeysThisTick.size,
      },
      resident: {
        detailChunks: residentDetailChunks,
        coarseChunks: residentCoarseChunks,
        detailBytes: residentDetailBytes,
        coarseBytes: residentCoarseBytes,
      },
      detailCoverageRatio,
      sparseDetail,
    };
  }

  private computeTierQueueTelemetry(): CacheTelemetry["tierQueues"] {
    const queues: CacheTelemetry["tierQueues"] = {
      detail: { pending: 0, inFlight: 0, inFlightBytes: 0 },
      coarse: { pending: 0, inFlight: 0, inFlightBytes: 0 },
    };

    for (const req of this.chunkScheduler.pendingSnapshot()) {
      queues[this.requestResidencyTier(req)].pending++;
    }
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      const tier = this.requestResidencyTier(entry.request);
      queues[tier].inFlight++;
      queues[tier].inFlightBytes += entry.estimatedBytes;
    }
    return queues;
  }

  private maybeLogSparseDetail(
    now: number,
    tierDemand: CacheTelemetry["tierDemand"],
  ): void {
    if (!tierDemand.sparseDetail) {
      this.sparseDetailStreak = 0;
      return;
    }
    this.sparseDetailStreak++;
    if (this.sparseDetailStreak < SPARSE_DETAIL_STREAK_THRESHOLD) return;
    if (now - this.lastSparseDetailLogAt < SPARSE_DETAIL_LOG_RATE_LIMIT_MS) return;

    this.lastSparseDetailLogAt = now;
    debugLog("cache", "cache.sparse_detail", {
      desiredDetailChunks: tierDemand.desired.detailChunks,
      residentDetailChunks: tierDemand.resident.detailChunks,
      detailCoverageRatio: tierDemand.detailCoverageRatio,
      pendingChunks: this.chunkScheduler.pendingSize,
      inFlightChunks: this.chunkScheduler.inFlightSize,
      mainBytes: this.chunkStore.bytes,
      mainBudget: this.config.mainBudgetBytes,
      notice: "Detail coverage is budget-limited; lower the detail LOD explicitly for broader coverage.",
    });
  }

  private inFlightKey(req: ChunkRequest): string {
    return `${req.entityId}/${this.requestResidencyTier(req)}/${req.chunkKey}`;
  }
}

function isEpochStale(deliveryEpochs: SceneEpochs, currentEpochs: SceneEpochs): boolean {
  return (
    deliveryEpochs.selection < currentEpochs.selection ||
    deliveryEpochs.content < currentEpochs.content
  );
}
