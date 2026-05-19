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
export const INTERACTION_MODE_WINDOW = 10;

interface FailedEntry {
  failedUntilContentEpoch: number;
  isPermanent: boolean;
}

interface InFlightChunkMeta {
  request: ChunkRequest;
  lastSeenTick: number;
}

interface InFlightProxyMeta {
  request: ProxyRequest;
  lastSeenTick: number;
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

  private chunkRetryPolicy: RetryPolicy = new OnceTransientRetry(TRANSIENT_RETRY_DELAY_MS);

  /** Proxies are not retried in-fetch; orchestrator resubmits next tick. */
  private proxyRetryPolicy: RetryPolicy = new NeverRetry();

  /** Plan-rebuild generation stamped onto wanted cache entries. */
  private currentSubmitTick = 0;

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
        this.rememberInFlightChunk(key, req);
        this.fetchAndDecode(req, controller, key).catch(() => {});
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
        this.rememberInFlightProxy(key, req);
        this.fetchProxy(req, controller, key).catch(() => {});
      },
    );
  }

  // Public API

  /**
   * Purely additive. Re-submitting an unchanged plan is a no-op for
   * the fetch queue; cancellation goes through {@link cancelDataset}.
   */
  submit(plan: RequestPlan): void {
    this.currentEpochs = plan.epochs;

    this.interactionDetector.push(plan.epochs);

    const newActiveIds = new Set(plan.activeSet.map(e => e.entityId));
    for (const entityId of newActiveIds) this.activeEntityIdsThisRebuild.add(entityId);

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
        this.rememberInFlightChunk(key, req);
        continue;
      }

      const failure = this.failures.get(key);
      if (failure && this.currentEpochs.content < failure.failedUntilContentEpoch) continue;

      pendingChunks.push(req);
    }
    this.chunkScheduler.enqueue(pendingChunks, enqueueNow);

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
        this.rememberInFlightProxy(key, req);
        continue;
      }

      pendingProxies.push(req);
    }
    this.proxyScheduler.enqueue(pendingProxies, enqueueNow);

    this.drainSchedulers();
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
    // contain slashes (plate naming, e.g. "plateId:A/1/0"), so
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

    const key = this.inFlightKey({ entityId, chunkKey } as ChunkRequest);
    this.chunkScheduler.cancelOne(key);
    this.inFlightChunkMeta.delete(key);
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
    this.rejectionTracker.clear();
    this.deliveryState.onPlanRebuildStart();
  }

  *getDeliverable(): Iterable<ReadyDelivery> {
    const candidates: ReadyDelivery[] = [];

    for (const entry of this.chunkStore.iterateTier("active-detail")) {
      if (entry.lane !== "detail") continue;
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (this.deliveryState.wasChunkSent(entry.imageId, entry.c, entry.chunkKey)) {
        continue;
      }
      if (this.rejectionTracker.has(entry.entityId, entry.chunkKey)) continue;
      candidates.push(this.chunkEntryToDelivery(entry));
    }

    for (const entry of this.overviewStore.allEntries()) {
      if (entry.lane !== "coarse") continue;
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (this.deliveryState.wasChunkSent(entry.imageId, entry.c, entry.chunkKey)) {
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
        delivery.imageId, delivery.c, delivery.chunkKey,
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

  markChunkMissing(imageId: string, c: number, chunkKey: string): void {
    this.deliveryState.clearChunkSent(imageId, c, chunkKey);
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
    };
  }

  updateConfig(partial: Partial<CpuCacheConfig>): void {
    Object.assign(this.config, partial);
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
    kind: "WellProxy3D" | "FieldProxy3D",
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
    kind: "WellProxy3D" | "FieldProxy3D",
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
    proxyKind: "WellProxy3D" | "FieldProxy3D";
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
    this.rejectionTracker.clear();
    this.deliveryState.reset();
    this.inFlightChunkMeta.clear();
    this.inFlightProxyMeta.clear();
    this.lruCounter = 0;
    this.currentSubmitTick = 0;

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
  ): Promise<void> {
    let result: FetchResult;
    try {
      result = await this.source.fetch(
        { datasetId: req.datasetId, imageId: req.imageId, chunkKey: req.chunkKey },
        controller.signal,
      );
    } catch (err: unknown) {
      const fe = classifyFetchError(err);

      if (fe.kind === "abort") {
        this.chunkScheduler.markInFlightDone(key);
        this.inFlightChunkMeta.delete(key);
        return;
      }

      if (this.chunkRetryPolicy.shouldRetry(fe, retryCount)) {
        await new Promise(r => setTimeout(r, this.chunkRetryPolicy.delayMs(retryCount)));
        if (!this.chunkScheduler.hasInFlight(key)) return; // cancelled during wait
        return this.fetchAndDecode(req, controller, key, retryCount + 1);
      }

      const isPermanent = fe.kind === "permanent";
      this.failures.set(key, {
        failedUntilContentEpoch: this.currentEpochs.content + 1,
        isPermanent,
      });
      this.counters.recordFetchFailure(isPermanent, fe.message);
      this.recordFailureForBurstDetection(isPermanent, fe.message);
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
      this.counters.recordError(err instanceof Error ? err.message : String(err));
      this.chunkScheduler.markInFlightDone(key);
      this.inFlightChunkMeta.delete(key);
      return;
    }

    const latestMeta = this.inFlightChunkMeta.get(key);
    const effectiveReq = latestMeta?.request ?? req;
    const lastSeenTick = latestMeta?.lastSeenTick ?? this.currentSubmitTick;

    this.chunkScheduler.markInFlightDone(key);
    if (this.inFlightChunkMeta.get(key) === latestMeta) {
      this.inFlightChunkMeta.delete(key);
    }

    // Cache even if cancelled during decode — the work is done.
    const lane = effectiveReq.lane;
    const tier = this.laneToTier(lane);
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
      epochs: { ...this.currentEpochs },
      dataType: result.dataType,
      residencyTier: this.requestResidencyTier(effectiveReq),
      priority: effectiveReq.priority,
      lastSeenTick,
    };

    // minimap/overview/coarse route to the overview/coarse bucket (ADR 0023 + coarse/detail bridge).
    if (lane === "overview" || lane === "minimap" || lane === "coarse") {
      this.overviewStore.insert(cacheEntry);
    } else {
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

  private rememberInFlightChunk(key: string, req: ChunkRequest): void {
    this.inFlightChunkMeta.set(key, {
      request: req,
      lastSeenTick: this.currentSubmitTick,
    });
  }

  private rememberInFlightProxy(key: string, req: ProxyRequest): void {
    this.inFlightProxyMeta.set(key, {
      request: req,
      lastSeenTick: this.currentSubmitTick,
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

  private inFlightKey(req: ChunkRequest): string {
    return `${req.entityId}/${req.chunkKey}`;
  }
}
