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
} from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type {
  RequestPlan,
  ChunkRequest,
  CacheStateSnapshot,
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
import { Scheduler, type SchedulableRequest } from "./scheduler.ts";
import { FairPriorityQueue } from "./fairPriorityQueue.ts";
import {
  classifyFetchError,
  OnceTransientRetry,
  type RetryPolicy,
} from "./retry.ts";
import { RejectionTracker } from "./rejection.ts";
import { DeliveryState } from "./deliveryState.ts";
import { debugLog } from "../../debug/logging.ts";
import {
  chunkContractsEqual,
} from "../../chunkContract.ts";
import { chunkFrameByteLength } from "../../chunkFrame.ts";
import type {
  CacheEntry,
  CacheTelemetry,
  CpuCacheConfig,
  EvictionTier,
  Lane,
  ReadyChunkDelivery,
  ReadyDelivery,
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
  ResidencyTier,
  TierCounters,
  TierResidencyEntry,
} from "./types.ts";

export const DEFAULT_MAIN_BUDGET = 512 * 1024 * 1024;
export const DEFAULT_OVERVIEW_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
export const FETCH_CONCURRENCY_MULTIPLIER = 3;
export const TRANSIENT_RETRY_DELAY_MS = 500;
export const MAX_TRANSIENT_RETRIES = 1;
/** Consecutive chunk-delivery failures with no delivered chunk in between
 *  before the `onChunkFailureStreak` config callback fires. What counts:
 *  permanent-kind fetch rejections, every server-reported per-chunk
 *  `source_chunk_status` failure (store failures — revoked access, backend
 *  faults, throttling — whether classified permanent or transient), and
 *  decode failures. Client-side transient failures (timeouts, disconnect
 *  rejections) never count. High enough that a few isolated misses never
 *  trip it; a systemically dead source crosses it within one viewport's
 *  requests. */
export const CHUNK_FAILURE_STREAK_THRESHOLD = 10;
/** Minimum spacing between `onChunkFailureStreak` calls while a streak
 *  persists — an aggregate signal, never per-chunk spam. */
export const CHUNK_FAILURE_NOTIFY_INTERVAL_MS = 15_000;
export const INTERACTION_MODE_WINDOW = 10;
const SPARSE_DETAIL_MIN_DESIRED_CHUNKS = 4;
const SPARSE_DETAIL_COVERAGE_RATIO = 0.25;
const SPARSE_DETAIL_STREAK_THRESHOLD = 3;
const SPARSE_DETAIL_LOG_RATE_LIMIT_MS = 5000;

/** Nominal (pre-jitter) first-attempt backoff before a transient failure
 *  is retried. */
export const FAILURE_BACKOFF_BASE_MS = 500;
/** Each successive transient re-attempt multiplies the backoff by this. */
export const FAILURE_BACKOFF_FACTOR = 2;
/** Cap the jittered transient backoff stays strictly below. */
export const FAILURE_BACKOFF_MAX_MS = 30_000;
/** Width of the jitter band, as a fraction of the (capped) backoff: the
 *  returned delay is spread across `[base·(1 − ratio), base)`, so it keeps
 *  varying even once the backoff pins to the cap. */
export const FAILURE_BACKOFF_JITTER_RATIO = 0.5;
/** Hard cap on tracked failure entries per store. The permanent and
 *  transient failure stores are bounded independently at this size, each
 *  FIFO-dropping its oldest entry past the cap, so total tracked entries
 *  never exceed `2 · MAX_TRACKED_FAILURES`. */
export const MAX_TRACKED_FAILURES = 8192;

/**
 * Capped exponential backoff with jitter for a transient failure's
 * `attempt`-th record (1-based). The growth term doubles each attempt and
 * is capped at {@link FAILURE_BACKOFF_MAX_MS}; jitter is then applied as a
 * band *below* that cap — `[base·(1 − ratio), base)` — so two entries that
 * both reach the cap still draw distinct, de-correlated delays instead of
 * collapsing onto one synchronized retry instant. The result is always
 * greater than zero and strictly below the cap.
 */
export function backoffWithJitter(attempt: number, random: () => number): number {
  const growth = FAILURE_BACKOFF_BASE_MS *
    Math.pow(FAILURE_BACKOFF_FACTOR, Math.max(0, attempt - 1));
  const base = Math.min(FAILURE_BACKOFF_MAX_MS, growth);
  const floor = base * (1 - FAILURE_BACKOFF_JITTER_RATIO);
  return floor + random() * (base - floor);
}

/**
 * One per-key fetch-failure record. A key lives in exactly one of the two
 * independently-bounded stores that hold these — {@link CpuCache.permanentFailures}
 * (sticky) or {@link CpuCache.transientFailures} (self-healing) — so a flood of
 * one kind can never evict the other's slot.
 */
interface FailureRecord {
  /** `permanent` is sticky (never time-eligible); `transient` self-heals
   *  after its backoff window. */
  kind: "permanent" | "transient";
  /** `now()` at the moment the failure was recorded (the transient backoff
   *  anchor). */
  failedAt: number;
  /** How many times this key has failed transiently (>= 1); grows the
   *  backoff across successive records. Zero for a permanent record. */
  attempt: number;
  /**
   * Wall-clock (in `now()`'s frame) at or after which the key may be
   * re-planned. The plan-time gate skips the key until `now()` reaches it;
   * a permanent record sets this to `Infinity` so it is never freed by the
   * passage of time.
   */
  eligibleAt: number;
}

interface InFlightChunkMeta {
  request: ChunkRequest;
  lastSeenTick: number;
  epochs: SceneEpochs;
}

export interface DatasetPlanPublication {
  datasetId: string;
  plan: RequestPlan;
}

/**
 * Owner-scoped wanted-set delta. `upserts` contains entered requests plus
 * metadata changes (priority/lane/epochs); `removed` contains the prior
 * request objects whose keys left this dataset. Stable requests are omitted.
 */
export interface DatasetPlanDeltaPublication {
  datasetId: string;
  upserts: readonly ChunkRequest[];
  removed: readonly ChunkRequest[];
  activeSet: RequestPlan["activeSet"];
  epochs: SceneEpochs;
}

interface DatasetWantedState {
  requests: Map<string, ChunkRequest>;
  activeEntityIds: Set<string>;
  epochs: SceneEpochs;
}

export class CpuCache {
  private source: ContentSource;
  private decode: DecodePool;
  private config: CpuCacheConfig;

  /** Time source for failure-expiry decisions (injectable for tests). */
  private now: () => number;
  /** Randomness source for backoff jitter (injectable for tests). */
  private random: () => number;

  private chunkStore!: ChunkStore;

  /** Serves both lane="overview" and lane="minimap" (ADR 0023). */
  private overviewStore!: ChunkStore;

  private chunkScheduler!: Scheduler<ChunkRequest>;

  /**
   * Persistent wanted ownership. A dataset replacement mutates only its map;
   * sequential publications therefore compose into one workspace wanted set.
   */
  private wantedByDataset = new Map<string, DatasetWantedState>();
  private wantedByKey = new Map<string, ChunkRequest>();

  /** Cached, wanted, unsent deliveries maintained incrementally on changes. */
  private readyQueue!: FairPriorityQueue<ReadyChunkDelivery>;
  private readyTierByKey = new Map<string, ResidencyTier>();
  private readyDetailCount = 0;
  private readyCoarseCount = 0;

  readonly deliveryState = new DeliveryState();

  private activeEntityIds = new Map<string, Set<string>>();
  private activeEntityIdsThisRebuild = new Map<string, Set<string>>();

  private interactionDetector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

  /**
   * Keys with a PERMANENT fetch failure — one that
   * {@link classifyFetchError} tagged `permanent` (e.g. an HTTP 404 /
   * not-found, or a source that rejects the fetch outright, such as no
   * wire format registered for the image). Permanent records are sticky:
   * their `eligibleAt` is `Infinity`, so the plan-time gate never frees
   * them by the passage of time; they clear only on a subsequent
   * successful delivery, {@link CpuCache.reset}, or
   * {@link CpuCache.cancelDataset}.
   *
   * Map iteration is insertion-order FIFO, so once it reaches
   * {@link MAX_TRACKED_FAILURES} the oldest permanent key is dropped to hold
   * the memory bound. Kept independent from {@link transientFailures} so a
   * flood of permanents (e.g. a malformed collection emitting thousands of
   * 404s) can never crowd out a transient's backoff slot — and vice versa.
   */
  private permanentFailures = new Map<string, FailureRecord>();
  /**
   * Keys with an outstanding TRANSIENT fetch failure (a timeout, disconnect,
   * failed decode, or other retryable rejection) awaiting their self-heal
   * backoff. Each record carries when it failed, its attempt count (grows
   * the backoff), and the instant it becomes re-eligible for planning.
   * Bounded independently at {@link MAX_TRACKED_FAILURES} with FIFO eviction
   * of the oldest entry, so backoff slots survive no matter how many
   * permanent failures exist.
   */
  private transientFailures = new Map<string, FailureRecord>();

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

  /** Plan-rebuild generation stamped onto wanted cache entries. */
  private currentSubmitTick = 0;
  private desiredDetailKeysThisTick = new Set<string>();
  private desiredCoarseKeysThisTick = new Set<string>();
  /**
   * Keys demanded by the VIEW's own coarse lane this tick (a strict
   * subset of `desiredCoarseKeysThisTick`, which also counts minimap
   * and minimap demand). Feeds {@link resolveDemandLane}.
   */
  private viewCoarseKeysThisTick = new Set<string>();
  private sparseDetailStreak = 0;
  private lastSparseDetailLogAt = -Infinity;

  /**
   * Latest wanted metadata for in-flight fetches. The request object
   * passed to `fetchAndDecode` may have been queued under an older
   * camera/LOD plan; these maps let later submits refresh the generation
   * and lane while the bytes are still in flight.
   */
  private inFlightChunkMeta = new Map<string, InFlightChunkMeta>();
  /** Monotonic per-image invalidation generation. A decode already running
   * when a refreshed manifest changes its contract must never cache its old
   * bytes after cancellation. */
  private imageInvalidationGeneration = new Map<string, number>();

  /**
   * Worker-rejected (atlas full + too far) chunks. `submit()` skips
   * enqueuing and does NOT refresh `lastSeenTick`, so the active-detail
   * eviction can sweep cached-but-rejected copies before useful ones.
   */
  private rejectionTracker = new RejectionTracker();

  private listeners: (() => void)[] = [];

  private currentEpochs: SceneEpochs = {
    content: 0, layout: 0, view: 0, selection: 0, request: 0,
  };

  constructor(source: ContentSource, decode: DecodePool, config?: Partial<CpuCacheConfig>) {
    this.source = source;
    this.decode = decode;
    this.config = {
      mainBudgetBytes: config?.mainBudgetBytes ?? DEFAULT_MAIN_BUDGET,
      overviewBudgetBytes: config?.overviewBudgetBytes ?? DEFAULT_OVERVIEW_BUDGET,
      maxConcurrentFetches: config?.maxConcurrentFetches ?? (decode.size * FETCH_CONCURRENCY_MULTIPLIER),
      maxBytesInFlight: config?.maxBytesInFlight ?? DEFAULT_MAX_BYTES_IN_FLIGHT,
      onChunkFailureStreak: config?.onChunkFailureStreak,
      onChunkFailureRecovered: config?.onChunkFailureRecovered,
      now: config?.now,
      random: config?.random,
    };

    this.now = config?.now ?? (() => performance.now());
    this.random = config?.random ?? Math.random;

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
    const burstBackpressure = new BurstLogger("cache", "cache.backpressure");
    this.chunkScheduler = new Scheduler<ChunkRequest>(
      {
        maxConcurrentFetches: this.config.maxConcurrentFetches,
        maxBytesInFlight: this.config.maxBytesInFlight,
        burstLogger: burstBackpressure,
      },
      (req) => this.inFlightKey(req),
      (req, controller, _estimate, key) => {
        const startedEpochs = { ...this.epochsForDataset(req.datasetId) };
        this.rememberInFlightChunk(key, req, startedEpochs);
        // `fetchAndDecode` handles fetch/decode failures internally (retry,
        // failure map, streak surfacing); anything escaping here is an
        // unexpected pipeline error — keep it out of the void.
        this.fetchAndDecode(req, controller, key, 0, startedEpochs).catch((err: unknown) => {
          console.warn("[CpuCache] unexpected chunk pipeline error:", err);
        });
      },
      {
        // Dataset+tier buckets preserve the existing detail/coarse
        // interleaving while adding fairness across datasets. Within a bucket,
        // planner priority remains authoritative.
        bucketOf: (req) => `${req.datasetId}:${this.requestResidencyTier(req)}`,
        compare: (a, b) => this.compareChunkRequests(a, b),
        equals: (a, b) => this.requestsEquivalent(a, b),
      },
    );
    this.readyQueue = new FairPriorityQueue<ReadyChunkDelivery>({
      keyOf: (delivery) => this.deliveryKey(delivery),
      compare: (a, b) => this.compareDeliveries(a, b),
      equals: (a, b) => this.deliveriesEquivalent(a, b),
    });
  }

  // Public API

  /**
   * Compatibility surface for one owner. Unlike the historical global
   * snapshot contract, replacing this plan cannot erase another dataset's
   * pending work. Production rebuilds use {@link publishPlanningCycle} so the
   * whole workspace commits and drains once.
   */
  submit(plan: RequestPlan): void {
    const datasetId = this.datasetIdForPlan(plan);
    this.applyDatasetReplacement(datasetId, plan, this.canonicalRequestMap(plan.requests));
    this.applyElasticTierBudgets();
    this.drainSchedulers();
  }

  /**
   * Atomically replace the complete workspace wanted set. Validation and
   * canonicalisation finish before any queue/cache mutation; once committed,
   * every owner is installed and the fair scheduler drains once. Datasets
   * omitted from `publications` are the only owners cancelled.
   */
  publishPlanningCycle(
    publications: readonly DatasetPlanPublication[],
    options: { resetDelivery?: boolean; replaceWorkspace?: boolean } = {},
  ): void {
    const prepared = publications.map(({ datasetId, plan }) => {
      for (const req of plan.requests) {
        if (req.datasetId !== datasetId) {
          throw new Error(
            `CpuCache publication for ${datasetId} contains request owned by ${req.datasetId}`,
          );
        }
      }
      return { datasetId, plan, requests: this.canonicalRequestMap(plan.requests) };
    });
    const ownerIds = new Set<string>();
    for (const p of prepared) {
      if (ownerIds.has(p.datasetId)) {
        throw new Error(`CpuCache publication contains duplicate dataset ${p.datasetId}`);
      }
      ownerIds.add(p.datasetId);
    }

    this.beginPublishedCycle(options.resetDelivery ?? true);
    if (options.replaceWorkspace ?? true) {
      for (const datasetId of [...this.wantedByDataset.keys()]) {
        if (!ownerIds.has(datasetId)) this.dropWantedDataset(datasetId);
      }
    }
    for (const p of prepared) {
      this.applyDatasetReplacement(p.datasetId, p.plan, p.requests);
    }
    this.commitActiveEntityUnion();
    this.applyElasticTierBudgets();
    this.drainSchedulers();
  }

  /**
   * Apply owner-scoped entered/changed/removed requests. Stable wanted work,
   * queue age, in-flight fetches, and ready entries are untouched. This is the
   * O(delta) publication contract; callers may fall back to a full cycle at any
   * time and the resulting wanted set is identical.
   */
  publishPlanDeltas(publications: readonly DatasetPlanDeltaPublication[]): void {
    // Validate the whole batch before mutating any owner.
    for (const p of publications) {
      if (!this.wantedByDataset.has(p.datasetId)) {
        throw new Error(`CpuCache cannot apply a delta before ${p.datasetId} has a full plan`);
      }
      for (const req of [...p.upserts, ...p.removed]) {
        if (req.datasetId !== p.datasetId) {
          throw new Error(
            `CpuCache delta for ${p.datasetId} contains request owned by ${req.datasetId}`,
          );
        }
      }
    }

    this.currentSubmitTick++;
    for (const p of publications) this.applyDatasetDelta(p);
    this.commitActiveEntityUnion();
    this.applyElasticTierBudgets();
    this.drainSchedulers();
  }

  private beginPublishedCycle(resetDelivery: boolean): void {
    this.currentSubmitTick++;
    this.desiredDetailKeysThisTick.clear();
    this.desiredCoarseKeysThisTick.clear();
    this.viewCoarseKeysThisTick.clear();
    this.sparseDetailStreak = 0;
    this.rejectionTracker.clear();
    if (resetDelivery) {
      this.deliveryState.onPlanRebuildStart();
      this.clearReadyQueue();
    }
  }

  private applyDatasetReplacement(
    datasetId: string,
    plan: RequestPlan,
    requests: Map<string, ChunkRequest>,
  ): void {
    this.currentEpochs = plan.epochs;
    this.interactionDetector.push(plan.epochs);

    const previous = this.wantedByDataset.get(datasetId);
    if (previous) {
      this.removeTierDemand(previous.requests.values());
      const removedKeys: string[] = [];
      for (const key of previous.requests.keys()) {
        if (!requests.has(key)) removedKeys.push(key);
      }
      this.removeWantedKeys(datasetId, removedKeys);
    }

    const activeEntityIds = new Set(plan.activeSet.map((entry) => entry.entityId));
    this.wantedByDataset.set(datasetId, {
      requests,
      activeEntityIds,
      epochs: plan.epochs,
    });
    this.activeEntityIdsThisRebuild.set(datasetId, new Set(activeEntityIds));
    for (const [key, req] of requests) this.wantedByKey.set(key, req);
    this.recordTierDemand(requests.values());

    const pending = this.processWantedUpserts([...requests.values()]);
    this.chunkScheduler.replaceDataset(datasetId, pending, performance.now());
  }

  private applyDatasetDelta(publication: DatasetPlanDeltaPublication): void {
    const state = this.wantedByDataset.get(publication.datasetId)!;
    this.currentEpochs = publication.epochs;
    this.interactionDetector.push(publication.epochs);

    const removedKeys = publication.removed.map((req) => this.inFlightKey(req));
    this.removeTierDemand(publication.removed);
    this.removeWantedKeys(publication.datasetId, removedKeys);
    for (const req of publication.upserts) {
      const key = this.inFlightKey(req);
      const prior = state.requests.get(key);
      if (prior) this.removeTierDemand([prior]);
      state.requests.set(key, req);
      this.wantedByKey.set(key, req);
    }
    state.activeEntityIds = new Set(publication.activeSet.map((entry) => entry.entityId));
    state.epochs = publication.epochs;
    this.recordTierDemand(publication.upserts);

    const pending = this.processWantedUpserts(publication.upserts);
    const upsertKeys = publication.upserts.map((req) => this.inFlightKey(req));
    this.chunkScheduler.applyDatasetDelta(
      publication.datasetId,
      pending,
      [...removedKeys, ...upsertKeys],
      performance.now(),
    );
  }

  private processWantedUpserts(requests: readonly ChunkRequest[]): ChunkRequest[] {
    const pending: ChunkRequest[] = [];
    for (const req of requests) {
      const key = this.inFlightKey(req);
      this.counters.recordRequest();
      if (this.rejectionTracker.has(
        req.datasetId,
        req.imageId,
        this.requestResidencyTier(req),
        req.chunkKey,
      )) {
        this.removeReady(key);
        continue;
      }

      const cachedEntry = this.lookupCachedEntry(req);
      if (cachedEntry) {
        this.counters.recordHit();
        const lane = this.resolveDemandLane(req.lane, key);
        cachedEntry.lane = lane;
        cachedEntry.residencyTier = this.requestResidencyTier(req);
        cachedEntry.tier = this.laneToTier(lane);
        cachedEntry.priority = lane === req.lane
          ? req.priority
          : Math.min(cachedEntry.priority, req.priority);
        cachedEntry.wanted = true;
        cachedEntry.lastSeenTick = this.currentSubmitTick;
        this.queueReadyEntry(cachedEntry);
        continue;
      }

      if (this.chunkScheduler.hasInFlight(key)) {
        this.rememberInFlightChunk(key, req, { ...this.epochsForDataset(req.datasetId) });
        continue;
      }
      if (this.isFailureExcluded(key)) continue;
      pending.push(req);
    }
    return pending;
  }

  private removeWantedKeys(datasetId: string, keys: readonly string[]): void {
    if (keys.length === 0) return;
    const keySet = new Set(keys);
    const state = this.wantedByDataset.get(datasetId);
    for (const key of keys) {
      const request = state?.requests.get(key);
      if (request) {
        const cachedEntry = this.lookupCachedEntry(request);
        if (cachedEntry) {
          cachedEntry.wanted = false;
          if (cachedEntry.tier === "active-detail") cachedEntry.tier = "demoted-detail";
        }
      }
      state?.requests.delete(key);
      this.wantedByKey.delete(key);
      this.removeReady(key);
    }
    const cancelled = this.chunkScheduler.cancelWhere((entry) =>
      entry.request.datasetId === datasetId && keySet.has(this.inFlightKey(entry.request)),
    );
    for (const key of cancelled) this.inFlightChunkMeta.delete(key);
  }

  private dropWantedDataset(datasetId: string): void {
    const state = this.wantedByDataset.get(datasetId);
    if (!state) return;
    this.removeTierDemand(state.requests.values());
    this.removeWantedKeys(datasetId, [...state.requests.keys()]);
    this.wantedByDataset.delete(datasetId);
  }

  private commitActiveEntityUnion(): void {
    const next = new Map<string, Set<string>>();
    for (const [datasetId, state] of this.wantedByDataset) {
      next.set(datasetId, new Set(state.activeEntityIds));
    }
    for (const [datasetId, entityIds] of this.activeEntityIds) {
      const nextEntityIds = next.get(datasetId);
      for (const entityId of entityIds) {
        if (nextEntityIds?.has(entityId)) continue;
        this.chunkStore.demoteEntity(datasetId, entityId);
        this.cancelChunkWorkForEntity(datasetId, entityId);
      }
    }
    this.activeEntityIds = next;
    this.activeEntityIdsThisRebuild = new Map(
      [...next].map(([datasetId, entityIds]) => [datasetId, new Set(entityIds)]),
    );
  }

  /**
   * Abort every in-flight (and drop every pending) chunk fetch for
   * `entityId` and clear its in-flight metadata. Used when an entity
   * leaves the view entirely. Returning its fetch slot to the current view
   * immediately instead
   * of holding them until the transfer timeout. A returning entity
   * re-enqueues normally on its next submit.
   */
  private cancelChunkWorkForEntity(datasetId: string, entityId: string): void {
    const cancelled = this.chunkScheduler.cancelWhere(
      (entry) => entry.request.datasetId === datasetId && entry.request.entityId === entityId,
    );
    for (const key of cancelled) {
      this.inFlightChunkMeta.delete(key);
    }
  }

  /**
   * Drop all state for a removed dataset. The orchestrator owns the
   * dataset → entityIds mapping; pass the full set. Not called for
   * view/layout/selection bumps — those must not abort fetches.
   */
  cancelDataset(datasetId: string): void {
    this.dropWantedDataset(datasetId);

    this.chunkScheduler.cancelDataset(
      (entry) => entry.request.datasetId === datasetId,
    );

    this.chunkStore.cancelDataset(datasetId);
    this.overviewStore.cancelDataset(datasetId);

    const prefix = this.datasetKeyPrefix(datasetId);
    for (const key of [...this.permanentFailures.keys(), ...this.transientFailures.keys()]) {
      if (key.startsWith(prefix)) this.clearFailure(key);
    }
    for (const key of this.inFlightChunkMeta.keys()) {
      if (key.startsWith(prefix)) this.inFlightChunkMeta.delete(key);
    }
    this.activeEntityIds.delete(datasetId);
    this.activeEntityIdsThisRebuild.delete(datasetId);
    this.rejectionTracker.clearDataset(datasetId);
    this.deliveryState.clearDataset(datasetId);
    this.removeReadyMatching((delivery) => delivery.datasetId === datasetId);
  }

  /**
   * Cancel and forget only images whose refreshed manifest contract changed
   * or disappeared. Unchanged sibling images stay decoded and deliverable.
   * The generation bump also tombstones a decode that was already executing
   * when its scheduler entry was cancelled.
   */
  invalidateDatasetImages(
    datasetId: string,
    images: readonly { imageId: string; entityId: string }[],
  ): void {
    if (images.length === 0) return;
    const imageIds = new Set(images.map((image) => image.imageId));
    const entityIds = new Set(images.map((image) => image.entityId));
    for (const imageId of imageIds) {
      const generationKey = this.imageGenerationKey(datasetId, imageId);
      this.imageInvalidationGeneration.set(
        generationKey,
        (this.imageInvalidationGeneration.get(generationKey) ?? 0) + 1,
      );
      this.deliveryState.clearChunksForImage(datasetId, imageId);
    }

    const state = this.wantedByDataset.get(datasetId);
    if (state) {
      const removedKeys: string[] = [];
      for (const [key, request] of state.requests) {
        if (!imageIds.has(request.imageId)) continue;
        removedKeys.push(key);
      }
      this.removeTierDemand(removedKeys.flatMap((key) => {
        const request = state.requests.get(key);
        return request ? [request] : [];
      }));
      for (const key of removedKeys) {
        state.requests.delete(key);
        this.wantedByKey.delete(key);
        this.removeReady(key);
      }
    }

    const cancelled = this.chunkScheduler.cancelWhere((entry) =>
      entry.request.datasetId === datasetId && imageIds.has(entry.request.imageId)
    );
    for (const key of cancelled) this.inFlightChunkMeta.delete(key);
    this.chunkStore.cancelImages(datasetId, imageIds);
    this.overviewStore.cancelImages(datasetId, imageIds);
    this.removeReadyMatching((delivery) =>
      delivery.datasetId === datasetId && imageIds.has(delivery.imageId)
    );
    for (const imageId of imageIds) {
      const prefix = this.imageKeyPrefix(datasetId, imageId);
      for (const key of [...this.permanentFailures.keys(), ...this.transientFailures.keys()]) {
        if (key.startsWith(prefix)) this.clearFailure(key);
      }
      this.rejectionTracker.clearImage(datasetId, imageId);
    }
    for (const entityId of entityIds) {
      this.activeEntityIds.get(datasetId)?.delete(entityId);
      this.activeEntityIdsThisRebuild.get(datasetId)?.delete(entityId);
    }
    this.notifyListeners();
    this.drainSchedulers();
  }

  /** Worker resources for this dataset were rebuilt. Keep decoded bytes warm,
   * but clear optimistic sent facts and make still-wanted cached chunks
   * deliverable to the fresh worker pools again. */
  invalidateDatasetDelivery(datasetId: string): void {
    this.deliveryState.clearDataset(datasetId);
    for (const entry of this.chunkStore.allEntries()) {
      if (entry.datasetId === datasetId) this.queueReadyEntry(entry);
    }
    for (const entry of this.overviewStore.allEntries()) {
      if (entry.datasetId === datasetId) this.queueReadyEntry(entry);
    }
  }

  /**
   * Worker reports a chunk was skipped (atlas full + too far). Aborts
   * the in-flight fetch if any; subsequent `submit()` calls skip
   * enqueuing and don't refresh `lastSeenTick`. Cleared on every
   * cold-state rebuild via {@link clearRejected}.
   */
  markRejected(
    datasetId: string,
    imageId: string,
    tier: ResidencyTier,
    chunkKey: string,
  ): void {
    const wasNew = this.rejectionTracker.mark(datasetId, imageId, tier, chunkKey);
    if (!wasNew) return;

    const cancelled = this.chunkScheduler.cancelWhere((entry) => (
      entry.request.imageId === imageId &&
      entry.request.datasetId === datasetId &&
      this.requestResidencyTier(entry.request) === tier &&
      entry.request.chunkKey === chunkKey
    ));
    for (const key of cancelled) {
      this.inFlightChunkMeta.delete(key);
    }
    this.removeReadyMatching(
      (delivery) => delivery.datasetId === datasetId &&
        delivery.imageId === imageId &&
        delivery.chunkKey === chunkKey &&
        (delivery.residencyTier ??
          (delivery.lane === "coarse" || delivery.lane === "minimap" ? "coarse" : "detail")) === tier,
    );
  }

  clearRejected(): void {
    this.rejectionTracker.clear();
  }

  onPlanRebuildStart(): void {
    for (const [datasetId, entityIds] of this.activeEntityIds) {
      const nextEntityIds = this.activeEntityIdsThisRebuild.get(datasetId);
      for (const entityId of entityIds) {
        if (nextEntityIds?.has(entityId)) continue;
        this.chunkStore.demoteEntity(datasetId, entityId);
        // The entity was active last rebuild but the just-completed one
        // never requested it: it has left the view entirely. Abort its
        // in-flight chunk fetches so they release their concurrency slots
        // to the current view immediately, rather than
        // holding them until the transfer timeout. Its already-cached
        // chunks are only demoted (kept, evictable); if it returns, its
        // next submit re-enqueues.
        this.cancelChunkWorkForEntity(datasetId, entityId);
      }
    }
    this.activeEntityIds = this.activeEntityIdsThisRebuild;
    this.activeEntityIdsThisRebuild = new Map();
    this.currentSubmitTick++;
    this.desiredDetailKeysThisTick.clear();
    this.desiredCoarseKeysThisTick.clear();
    this.viewCoarseKeysThisTick.clear();
    this.sparseDetailStreak = 0;
    this.rejectionTracker.clear();
    this.deliveryState.onPlanRebuildStart();
    this.clearReadyQueue();
  }

  *getDeliverable(): Iterable<ReadyDelivery> {
    // `shift()` is O(log n) and round-robins datasets. Keep yielded-but-unsent
    // entries aside for this iterator so a diagnostic Array.from() sees each
    // ready key once; restore them in `finally`. The upload path marks each
    // successful delivery sent before requesting the next item, so sent keys
    // disappear instead of being restored.
    const yielded: ReadyChunkDelivery[] = [];
    try {
      for (;;) {
        const delivery = this.readyQueue.shift();
        if (!delivery) break;
        yielded.push(delivery);
        yield delivery;
      }
    } finally {
      for (const delivery of yielded) {
        const key = this.deliveryKey(delivery);
        if (!this.readyTierByKey.has(key)) continue;
        if (this.deliveryState.wasChunkSent(
          delivery.datasetId,
          delivery.imageId,
          delivery.c,
          delivery.chunkKey,
          delivery.residencyTier,
        )) {
          this.removeReady(key);
          continue;
        }
        this.readyQueue.upsert(delivery);
      }
    }
  }

  /** Constant-time tier presence for Uploader budget splitting. */
  getDeliverableTierDemand(): { detail: boolean; coarse: boolean } {
    return {
      detail: this.readyDetailCount > 0,
      coarse: this.readyCoarseCount > 0,
    };
  }

  markSent(delivery: ReadyDelivery): void {
    this.deliveryState.markChunkSent(
      delivery.datasetId, delivery.imageId, delivery.c, delivery.chunkKey, delivery.residencyTier,
    );
    this.removeReady(this.deliveryKey(delivery));
  }

  /**
   * Whether a planned chunk has already been posted to the worker (per
   * the optimistic delivery ledger) for its residency tier. Feeds the
   * per-member sent counts in the debug panel.
   */
  isChunkSent(req: ChunkRequest): boolean {
    return this.deliveryState.wasChunkSent(
      req.datasetId, req.imageId, req.c, req.chunkKey, this.requestResidencyTier(req),
    );
  }

  markChunkEvicted(
    datasetId: string,
    imageId: string,
    c: number,
    tier: ResidencyTier,
    evicted: string[],
    skipped: string[],
  ): void {
    for (const key of evicted) {
      this.deliveryState.clearChunkSent(datasetId, imageId, c, key, tier);
      const store = tier === "detail" ? this.chunkStore : this.overviewStore;
      const entry = store.findByImageChunk(datasetId, imageId, c, key);
      if (entry) this.queueReadyEntry(entry);
    }
    for (const key of skipped) {
      this.deliveryState.clearChunkSent(datasetId, imageId, c, key, tier);
      this.markRejected(datasetId, imageId, tier, key);
    }
  }

  markChunkMissing(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
    tier: ResidencyTier,
  ): void {
    this.deliveryState.clearChunkSent(datasetId, imageId, c, chunkKey, tier);
    const store = tier === "detail" ? this.chunkStore : this.overviewStore;
    const entry = store.findByImageChunk(datasetId, imageId, c, chunkKey);
    if (entry) this.queueReadyEntry(entry);
  }

  snapshot(): CacheStateSnapshot {
    type TierSets = Map<ResidencyTier, Set<string>>;
    type ImageTierSets = Map<string, TierSets>;
    const cached = new Map<string, ImageTierSets>();
    const add = (
      target: Map<string, ImageTierSets>,
      datasetId: string,
      imageId: string,
      tier: ResidencyTier,
      chunkKey: string,
    ): void => {
      let byImage = target.get(datasetId);
      if (!byImage) {
        byImage = new Map();
        target.set(datasetId, byImage);
      }
      let byTier = byImage.get(imageId);
      if (!byTier) {
        byTier = new Map();
        byImage.set(imageId, byTier);
      }
      let keys = byTier.get(tier);
      if (!keys) {
        keys = new Set();
        byTier.set(tier, keys);
      }
      keys.add(chunkKey);
    };
    for (const entry of this.chunkStore.allEntries()) {
      add(cached, entry.datasetId, entry.imageId, "detail", entry.chunkKey);
    }
    for (const entry of this.overviewStore.allEntries()) {
      add(cached, entry.datasetId, entry.imageId, "coarse", entry.chunkKey);
    }

    const inFlight = new Map<string, ImageTierSets>();
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      add(
        inFlight,
        entry.request.datasetId,
        entry.request.imageId,
        this.requestResidencyTier(entry.request),
        entry.request.chunkKey,
      );
    }

    return { cached, inFlight };
  }

  telemetry(): CacheTelemetry {
    const now = performance.now();
    const counters = this.counters.snapshot(now);
    const mode = this.interactionDetector.current();

    const mainTiers = this.chunkStore.tierResidency();
    const overviewTotals = this.overviewStore.totalResidency();
    const tierResidency = {
      activeDetail: mainTiers.activeDetail,
      demotedDetail: mainTiers.demotedDetail,
      prefetch: mainTiers.prefetch,
      overview: overviewTotals,
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
      maxConcurrentFetches: this.config.maxConcurrentFetches,
      maxBytesInFlight: this.config.maxBytesInFlight,
      inFlightCount: this.chunkScheduler.inFlightSize,
      inFlightBytes: this.chunkScheduler.inFlightBytes,
      pendingCount: this.chunkScheduler.pendingSize,
      pendingOldestAgeMs,
      readyCount: this.readyTierByKey.size,
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
    if (partial.now) this.now = partial.now;
    if (partial.random) this.random = partial.random;
    this.applyElasticTierBudgets();
  }

  /** Searches the detail then coarse chunk stores. */
  getCachedChunk(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    tier?: ResidencyTier,
  ): ReadyChunkDelivery | null {
    const entry = tier === "detail"
      ? this.chunkStore.get(datasetId, imageId, chunkKey)
      : tier === "coarse"
        ? this.overviewStore.get(datasetId, imageId, chunkKey)
        : this.chunkStore.get(datasetId, imageId, chunkKey) ??
          this.overviewStore.get(datasetId, imageId, chunkKey);
    return entry ? this.chunkEntryToDelivery(entry) : null;
  }

  /** Searches detail then overview; null when neither has the chunk. */
  getCachedChunkTier(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    residencyTier?: ResidencyTier,
  ): EvictionTier | null {
    const entry = residencyTier === "detail"
      ? this.chunkStore.get(datasetId, imageId, chunkKey)
      : residencyTier === "coarse"
        ? this.overviewStore.get(datasetId, imageId, chunkKey)
        : this.chunkStore.get(datasetId, imageId, chunkKey) ??
          this.overviewStore.get(datasetId, imageId, chunkKey);
    return entry?.tier ?? null;
  }

  getPendingSnapshot(): readonly ChunkRequest[] {
    return this.chunkScheduler.pendingSnapshot();
  }

  /** Diagnostic/test copy of the persistent workspace wanted set. */
  getWantedSnapshot(datasetId?: string): readonly ChunkRequest[] {
    const requests = datasetId
      ? [...(this.wantedByDataset.get(datasetId)?.requests.values() ?? [])]
      : [...this.wantedByKey.values()];
    return requests.sort((a, b) =>
      a.datasetId.localeCompare(b.datasetId) || this.compareChunkRequests(a, b),
    );
  }

  getCacheDump(): Array<{
    datasetId: string;
    entityId: string;
    imageId: string;
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

  /** Per-entry age (ms since enqueue) for the starvation panel. */
  getPendingDump(): Array<{
    datasetId: string;
    chunkKey: string;
    entityId: string;
    imageId: string;
    lane: Lane;
    priority: number;
    ageMs: number;
  }> {
    const now = performance.now();
    return this.chunkScheduler.pendingSnapshot().map(r => {
      const enq = this.chunkScheduler.enqueueTimeFor(this.inFlightKey(r));
      return {
        datasetId: r.datasetId,
        chunkKey: r.chunkKey,
        entityId: r.entityId,
        imageId: r.imageId,
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
    this.chunkStore.reset();
    this.overviewStore.reset();
    this.wantedByDataset.clear();
    this.wantedByKey.clear();
    this.clearReadyQueue();
    this.activeEntityIds.clear();
    this.activeEntityIdsThisRebuild.clear();
    this.viewCoarseKeysThisTick.clear();
    this.interactionDetector.reset();
    this.permanentFailures.clear();
    this.transientFailures.clear();
    this.chunkFailureStreak = 0;
    this.lastChunkFailureNotifyAt = -Infinity;
    this.chunkFailureSurfaced = false;
    this.rejectionTracker.clear();
    this.deliveryState.reset();
    this.inFlightChunkMeta.clear();
    this.imageInvalidationGeneration.clear();
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
    fedStreak = false,
    startedImageGeneration = this.imageGeneration(req.datasetId, req.imageId),
  ): Promise<void> {
    let result: FetchResult;
    try {
      result = await this.source.fetch(
        {
          datasetId: req.datasetId,
          imageId: req.imageId,
          chunkKey: req.chunkKey,
          expectedResponseBytes: this.estimateResponseBytes(req),
        },
        controller.signal,
      );
    } catch (err: unknown) {
      const fe = classifyFetchError(err);

      if (fe.kind === "abort" || fe.kind === "pending") {
        // A silent teardown: the caller cancelled, or generated bytes are not
        // ready yet. No failure entry, no streak — just release the slot and
        // metadata this settle still owns (see {@link settleFetch}).
        if (this.settleFetch(this.chunkScheduler, this.inFlightChunkMeta, key, controller)) {
          if (fe.kind === "pending") this.drainSchedulers();
        }
        return;
      }

      // Whether THIS fetch lifecycle has already fed the delivery-failure
      // streak. Carried across the lifecycle's own in-fetch retries by the
      // recursion argument, so a single failed delivery counts once no matter
      // how many times it is retried before giving up. The dedup is scoped to
      // the lifecycle only: a chunk that keeps failing across re-plan
      // re-fetches (each a fresh lifecycle, once its backoff expires) must
      // re-contribute every time, so the streak keeps measuring consecutive
      // failed deliveries and a persistently dead source stays surfaced.
      let fed = fedStreak;

      // A server-reported failure (a `source_chunk_status` frame: the source
      // answered the request with a failure) is a real delivery failure and
      // feeds the streak now, before the retry branch and regardless of its
      // retry classification. A persistently-failing source thus surfaces
      // even when each failure is individually transient (self-healing), and
      // the count still resets the moment any chunk is delivered.
      if (fe.serverReported && !fed) {
        this.recordChunkFailureForStreak(fe.message);
        fed = true;
      }

      if (this.chunkRetryPolicy.shouldRetry(fe, retryCount)) {
        await new Promise(r => setTimeout(r, this.chunkRetryPolicy.delayMs(retryCount)));
        if (!this.chunkScheduler.hasInFlight(key)) return; // cancelled during wait
        return this.fetchAndDecode(
          req,
          controller,
          key,
          retryCount + 1,
          startedEpochs,
          fed,
          startedImageGeneration,
        );
      }

      const isPermanent = fe.kind === "permanent";
      // A post-retry permanent failure is streak-eligible; a client-side
      // transient (network blip, timeout, the transport's own disconnect
      // rejection) belongs to the reconnect machinery and stays exempt, so an
      // ordinary connection drop cannot masquerade as a failing data source.
      // Feeding runs before the ownership gate so it reflects the failure the
      // source reported; the per-key record it feeds through is written only
      // when this settle still owns the key.
      if (isPermanent && !fed) {
        this.recordChunkFailureForStreak(fe.message);
        fed = true;
      }
      if (this.settleFetch(this.chunkScheduler, this.inFlightChunkMeta, key, controller)) {
        this.recordFailure(key, isPermanent);
        this.counters.recordFetchFailure(isPermanent, fe.message);
        this.recordFailureForBurstDetection(isPermanent, fe.message);
      }
      return;
    }

    this.counters.recordCompletedFetch(result.bytes.byteLength);
    // Correct the in-flight byte estimate only while this settle still owns
    // the slot; a superseded successor keeps its own accounting.
    if (this.chunkScheduler.isCurrent(key, controller)) {
      this.chunkScheduler.correctInFlightBytes(key, result.bytes.byteLength);
    }

    let decoded: ArrayBuffer;
    try {
      const t0 = performance.now();
      decoded = await this.decode.decode(result.bytes, result.wireFormat, req.contract);
      this.counters.recordDecode(performance.now() - t0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // A fetch that completes but cannot be decoded (wrong wire format,
      // corrupted bytes, an intermediary answering with garbage) is a
      // delivery failure: a source failing every decode stalls the canvas
      // exactly like one failing every fetch. It records a self-healing
      // transient backoff so the key is not re-fetched every rebuild, and
      // feeds the streak once.
      const streakMessage = `decode failed: ${message}`;
      if (this.settleFetch(this.chunkScheduler, this.inFlightChunkMeta, key, controller)) {
        if (!fedStreak) {
          this.recordChunkFailureForStreak(streakMessage);
        }
        this.recordFailure(key, false);
        this.counters.recordFetchFailure(false, streakMessage);
        this.recordFailureForBurstDetection(false, streakMessage);
      }
      return;
    }

    if (this.imageGeneration(req.datasetId, req.imageId) !== startedImageGeneration) {
      this.settleFetch(this.chunkScheduler, this.inFlightChunkMeta, key, controller);
      this.drainSchedulers();
      return;
    }

    const latestMeta = this.inFlightChunkMeta.get(key);
    const currentlyWanted = this.wantedByKey.get(key);
    const effectiveReq = currentlyWanted ?? latestMeta?.request ?? req;
    const metaEpochs = latestMeta?.epochs ?? startedEpochs;
    const ownerEpochs = this.epochsForDataset(effectiveReq.datasetId);
    const stale =
      latestMeta === undefined ||
      currentlyWanted === undefined ||
      isEpochStale(metaEpochs, ownerEpochs);
    const lastSeenTick = stale ? -1 : latestMeta.lastSeenTick;

    // Only a DELIVERED chunk — fetched AND decoded — proves the source is
    // serving usable data; a completed fetch alone can still be garbage. When
    // this settle still owns the key, the streak resets and the key's failure
    // record clears so its attempt/backoff bookkeeping starts clean; a
    // superseded settle leaves the successor's slot, metadata, and failure
    // state untouched.
    if (this.settleFetch(this.chunkScheduler, this.inFlightChunkMeta, key, controller)) {
      this.recordChunkDelivered();
      this.clearFailure(key);
    }

    // Cache even if cancelled during decode — the work is done. The
    // lane is demand-resolved: an arrival the view's coarse lane also
    // wanted must be deliverable now, not after the next rebuild
    // happens to relabel it.
    const lane = this.resolveDemandLane(effectiveReq.lane, key);
    const tier = stale ? "demoted-detail" : this.laneToTier(lane);
    const cacheEntry: CacheEntry = {
      data: decoded,
      contract: req.contract,
      sizeBytes: decoded.byteLength,
      lane,
      tier,
      datasetId: effectiveReq.datasetId,
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
      wanted: !stale,
      residencyTier: this.requestResidencyTier(effectiveReq),
      priority: stale ? Number.MAX_SAFE_INTEGER : effectiveReq.priority,
      lastSeenTick,
    };

    // Minimap/coarse route to the shared coarse bucket (ADR 0023).
    if (lane === "minimap" || lane === "coarse") {
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

    this.queueReadyEntry(cacheEntry);

    this.notifyListeners();

    this.drainSchedulers();
  }

  private drainSchedulers(): void {
    // The server replies with the exact decompressed source slice described by
    // the immutable chunk contract. Charge the complete binary frame before
    // dispatch; a cold cache must not treat the first burst as zero bytes.
    const estimateBytes = (req: ChunkRequest) => this.estimateResponseBytes(req);
    this.chunkScheduler.drain(estimateBytes);
  }

  private estimateResponseBytes(req: ChunkRequest): number {
    return chunkFrameByteLength(
      req.datasetId,
      req.imageId,
      req.chunkKey,
      req.contract.sourceExpectedBytes,
    );
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

  private epochsForDataset(datasetId: string): SceneEpochs {
    return this.wantedByDataset.get(datasetId)?.epochs ?? this.currentEpochs;
  }

  /**
   * Release the scheduler slot and drop the in-flight metadata for a
   * completion, but only when the settling controller still owns the key.
   * Every fetch-completion exit (failure, decode failure,
   * success, abort/pending) routes through here so the identity guard holds
   * by construction: a settle arriving after its key was cancelled and
   * re-enqueued under a fresh controller (the same tile scrubbed away and
   * straight back within a rebuild's detection lag) frees nothing, leaving
   * the live successor's slot, metadata, and failure state intact — rather
   * than under-counting concurrency and starting a duplicate fetch. Returns
   * whether this settle owned the key, so callers gate their per-key
   * bookkeeping (failure record, streak reset, recovery) on ownership.
   */
  private settleFetch<Req extends SchedulableRequest, M>(
    scheduler: Scheduler<Req>,
    meta: Map<string, M>,
    key: string,
    controller: AbortController,
  ): boolean {
    if (!scheduler.markInFlightDoneIfCurrent(key, controller)) return false;
    meta.delete(key);
    return true;
  }

  /** The failure record for `key`, from whichever store holds it (a key
   *  lives in at most one). */
  private getFailureRecord(key: string): FailureRecord | undefined {
    return this.permanentFailures.get(key) ?? this.transientFailures.get(key);
  }

  /** Whether `key` is currently excluded from planning by a failure record:
   *  a permanent record (never time-eligible) or a transient record still
   *  inside its backoff window. */
  private isFailureExcluded(key: string): boolean {
    const record = this.getFailureRecord(key);
    return record !== undefined && this.now() < record.eligibleAt;
  }

  /**
   * Record a fetch failure for `key`, routing it to the matching store.
   *
   * A key can flip kind between records (a timeout that later resolves to a
   * 404, or a 404 that later times out), so both stores are cleared of the
   * key first — it must live in exactly one. A permanent record is sticky
   * (`eligibleAt` = `Infinity`). A transient record grows its attempt count
   * from any prior transient record (so the backoff lengthens, capped) and
   * records its re-eligibility instant.
   *
   * Each store is bounded independently at {@link MAX_TRACKED_FAILURES} with
   * FIFO eviction of its oldest entry. Because the stores are separate, a
   * flood of permanents cannot evict a transient's backoff slot: a transient
   * always retains its own record and thus its backoff, even when the
   * permanent store is saturated. Total tracked entries stay bounded at
   * `2 · MAX_TRACKED_FAILURES`.
   */
  private recordFailure(key: string, isPermanent: boolean): void {
    if (isPermanent) {
      this.transientFailures.delete(key);
      // Delete-then-set refreshes FIFO recency, so a re-reported permanent
      // is not the first to be dropped under cap pressure.
      this.permanentFailures.delete(key);
      this.permanentFailures.set(key, {
        kind: "permanent",
        failedAt: this.now(),
        attempt: 0,
        eligibleAt: Infinity,
      });
      this.evictOldestWhileOverCap(this.permanentFailures);
      return;
    }

    const prev = this.transientFailures.get(key);
    const failedAt = this.now();
    const attempt = (prev?.attempt ?? 0) + 1;
    const eligibleAt = failedAt + this.backoffMs(attempt);

    this.permanentFailures.delete(key);
    // Delete-then-set keeps Map iteration order == insertion recency, so
    // FIFO eviction drops the genuinely oldest transient.
    this.transientFailures.delete(key);
    this.transientFailures.set(key, {
      kind: "transient",
      failedAt,
      attempt,
      eligibleAt,
    });
    this.evictOldestWhileOverCap(this.transientFailures);
  }

  /**
   * Drop the oldest (first-inserted) entries from a failure store until it
   * is back within {@link MAX_TRACKED_FAILURES}. A `Map` iterates in
   * insertion order, so `keys().next()` yields the oldest key.
   */
  private evictOldestWhileOverCap(store: Map<string, FailureRecord>): void {
    while (store.size > MAX_TRACKED_FAILURES) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  /** Remove a key's failure record from both stores (used by success-path
   *  recovery and {@link cancelDataset}). A key lives in at most one store,
   *  but deleting from both is cheap and keeps callers from having to know
   *  which. */
  private clearFailure(key: string): void {
    this.permanentFailures.delete(key);
    this.transientFailures.delete(key);
  }

  /**
   * Short, capped exponential backoff with jitter for a transient
   * failure's `attempt`-th record (1-based). Jitter is drawn from the
   * injected `random()` so retries across many tiles de-correlate — and
   * still de-correlate at the cap (see {@link backoffWithJitter}).
   */
  private backoffMs(attempt: number): number {
    return backoffWithJitter(attempt, this.random);
  }

  /** Total tracked failure entries (permanent + transient), across both
   *  independently-bounded stores. */
  failuresTracked(): number {
    return this.permanentFailures.size + this.transientFailures.size;
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
   * Count a streak-eligible delivery failure toward the consecutive-failure
   * streak and notify the owner once it crosses the threshold — throttled
   * while the streak persists. Eligible failures are a server-reported
   * per-chunk failure (any retry classification), a post-retry permanent
   * failure, or a decode failure; the caller feeds each failed delivery here
   * exactly once per fetch lifecycle — a delivery's own attempt and its
   * in-fetch retries count once, deduped by the recursion-carried flag in
   * {@link CpuCache.fetchAndDecode}, while a chunk that keeps failing across
   * re-plan re-fetches re-contributes each lifecycle so the count keeps
   * tracking consecutive failed deliveries. This is the
   * user-visible complement to the per-key failure records: individual misses
   * stay quiet, but a source that fails everything (e.g. credentials lost
   * after a successful open, or a backend that stays unavailable — both
   * reported per chunk as `source_chunk_status`, whether the content source
   * rejects them as permanent or as self-healing transient) must not present
   * as a silently stalling canvas.
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

  private datasetIdForPlan(plan: RequestPlan): string {
    const fromRequest = plan.requests[0]?.datasetId;
    if (fromRequest) return fromRequest;
    if (this.wantedByDataset.size === 1) {
      return this.wantedByDataset.keys().next().value as string;
    }
    return plan.activeSet[0]?.entityId ?? "__legacy__";
  }

  private canonicalRequestMap(requests: readonly ChunkRequest[]): Map<string, ChunkRequest> {
    const result = new Map<string, ChunkRequest>();
    for (const req of requests) {
      const key = this.inFlightKey(req);
      const previous = result.get(key);
      if (!previous || this.preferRequest(req, previous)) result.set(key, req);
    }
    return result;
  }

  private preferRequest(candidate: ChunkRequest, current: ChunkRequest): boolean {
    const laneRank = (lane: Lane): number => {
      if (lane === "detail" || lane === "coarse") return 0;
      if (lane === "prefetch") return 1;
      return 2; // minimap-only demand must not mask view-coarse demand
    };
    return (
      laneRank(candidate.lane) < laneRank(current.lane) ||
      (
        laneRank(candidate.lane) === laneRank(current.lane) &&
        this.compareChunkRequests(candidate, current) < 0
      )
    );
  }

  private compareChunkRequests(a: ChunkRequest, b: ChunkRequest): number {
    return (
      a.priority - b.priority ||
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

  private requestsEquivalent(a: ChunkRequest, b: ChunkRequest): boolean {
    return (
      a.datasetId === b.datasetId &&
      a.entityId === b.entityId &&
      a.imageId === b.imageId &&
      a.chunkKey === b.chunkKey &&
      a.lane === b.lane &&
      this.requestResidencyTier(a) === this.requestResidencyTier(b) &&
      a.priority === b.priority
      && chunkContractsEqual(a.contract, b.contract)
    );
  }

  private deliveryKey(delivery: ReadyDelivery): string {
    const tier = delivery.residencyTier ??
      (delivery.lane === "coarse" || delivery.lane === "minimap" ? "coarse" : "detail");
    return this.imageKeyPrefix(delivery.datasetId, delivery.imageId) +
      this.identityPart(tier) +
      this.identityPart(delivery.chunkKey);
  }

  private deliveriesEquivalent(a: ReadyChunkDelivery, b: ReadyChunkDelivery): boolean {
    return (
      this.deliveryKey(a) === this.deliveryKey(b) &&
      a.priority === b.priority &&
      a.lane === b.lane &&
      a.data === b.data &&
      chunkContractsEqual(a.contract, b.contract) &&
      a.epochs.content === b.epochs.content &&
      a.epochs.selection === b.epochs.selection &&
      a.epochs.request === b.epochs.request
    );
  }

  private queueReadyEntry(entry: CacheEntry): void {
    const delivery = this.chunkEntryToDelivery(entry);
    const key = this.deliveryKey(delivery);
    if (
      !this.wantedByKey.has(key) ||
      (entry.lane !== "detail" && entry.lane !== "coarse") ||
      this.deliveryState.wasChunkSent(
        entry.datasetId,
        entry.imageId,
        entry.c,
        entry.chunkKey,
        entry.residencyTier,
      ) ||
      this.rejectionTracker.has(
        entry.datasetId,
        entry.imageId,
        entry.residencyTier ?? (entry.lane === "coarse" ? "coarse" : "detail"),
        entry.chunkKey,
      )
    ) {
      this.removeReady(key);
      return;
    }

    const tier = this.requestResidencyTier(this.wantedByKey.get(key)!);
    const oldTier = this.readyTierByKey.get(key);
    if (oldTier !== tier) {
      if (oldTier === "detail") this.readyDetailCount--;
      if (oldTier === "coarse") this.readyCoarseCount--;
      if (tier === "detail") this.readyDetailCount++;
      else this.readyCoarseCount++;
      this.readyTierByKey.set(key, tier);
    }
    this.readyQueue.upsert(delivery);
  }

  private removeReady(key: string): void {
    this.readyQueue.delete(key);
    const tier = this.readyTierByKey.get(key);
    if (!tier) return;
    this.readyTierByKey.delete(key);
    if (tier === "detail") this.readyDetailCount--;
    else this.readyCoarseCount--;
  }

  private removeReadyMatching(predicate: (delivery: ReadyChunkDelivery) => boolean): void {
    for (const delivery of this.readyQueue.snapshotFair()) {
      if (predicate(delivery)) this.removeReady(this.deliveryKey(delivery));
    }
  }

  private clearReadyQueue(): void {
    this.readyQueue?.clear();
    this.readyTierByKey.clear();
    this.readyDetailCount = 0;
    this.readyCoarseCount = 0;
  }

  private chunkEntryToDelivery(entry: CacheEntry): ReadyChunkDelivery {
    return {
      kind: "chunk",
      datasetId: entry.datasetId,
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
      contract: entry.contract,
      epochs: entry.epochs,
      lane: entry.lane,
      residencyTier: entry.residencyTier,
      priority: entry.priority,
    };
  }

  private compareDeliveries(a: ReadyDelivery, b: ReadyDelivery): number {
    const priority = (a.priority ?? 0) - (b.priority ?? 0);
    if (priority !== 0) return priority;

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

  // Cache Management

  private lookupCachedEntry(req: ChunkRequest): CacheEntry | undefined {
    // Minimap/coarse share the coarse cache.
    const usesOverviewCache =
      req.lane === "minimap" || req.lane === "coarse";
    const store = usesOverviewCache ? this.overviewStore : this.chunkStore;
    return store.get(req.datasetId, req.imageId, req.chunkKey);
  }

  /**
   * Lane a chunk entry should carry given everything demanding it this
   * tick. The minimap and coarse lanes share a residency tier and a
   * dedup key, so one fetch (or one cached entry) serves both — but
   * {@link getDeliverable} only hands lane `"coarse"` entries to the
   * main view. When the view's own coarse lane demanded the chunk this
   * tick, a minimap-lane fetch or refresh must not leave the entry
   * undeliverable until an interaction-triggered rebuild relabels it:
   * that stalls idle fill at zero regardless of fetch rate. Chunks only
   * the minimap wanted keep their lane — nothing becomes deliverable
   * that the view never asked for.
   */
  private resolveDemandLane(lane: Lane, key: string): Lane {
    if (lane === "minimap" && this.viewCoarseKeysThisTick.has(key)) return "coarse";
    return lane;
  }

  private laneToTier(lane: Lane): EvictionTier {
    if (lane === "prefetch") return "prefetch";
    // Minimap/coarse use LRU; tier is a no-op label there.
    if (lane === "minimap" || lane === "coarse") return "prefetch";
    return "active-detail";
  }

  private requestResidencyTier(req: ChunkRequest): ResidencyTier {
    if (req.tier) return req.tier;
    return req.lane === "coarse" || req.lane === "minimap"
      ? "coarse"
      : "detail";
  }

  private recordTierDemand(requests: Iterable<ChunkRequest>): void {
    for (const req of requests) {
      if (this.requestResidencyTier(req) === "detail") {
        this.desiredDetailKeysThisTick.add(this.inFlightKey(req));
      } else if (this.requestResidencyTier(req) === "coarse") {
        const key = this.inFlightKey(req);
        this.desiredCoarseKeysThisTick.add(key);
        // Recorded over the FULL request list before the enqueue loop
        // runs, so demand-lane resolution is independent of the order
        // in which a chunk's minimap and coarse requests appear.
        if (req.lane === "coarse") this.viewCoarseKeysThisTick.add(key);
      }
    }
  }

  private removeTierDemand(requests: Iterable<ChunkRequest>): void {
    for (const req of requests) {
      const key = this.inFlightKey(req);
      if (this.requestResidencyTier(req) === "detail") {
        this.desiredDetailKeysThisTick.delete(key);
      } else {
        this.desiredCoarseKeysThisTick.delete(key);
        if (req.lane === "coarse") this.viewCoarseKeysThisTick.delete(key);
      }
    }
  }

  private computeTierDemandTelemetry(): CacheTelemetry["tierDemand"] {
    let residentDetailChunks = 0;
    let residentDetailBytes = 0;
    let residentCoarseChunks = 0;
    let residentCoarseBytes = 0;

    for (const entry of this.chunkStore.allEntries()) {
      if (!this.wantedByKey.has(this.deliveryKey(this.chunkEntryToDelivery(entry)))) continue;
      if (entry.residencyTier === "detail" || entry.lane === "detail") {
        residentDetailChunks++;
        residentDetailBytes += entry.sizeBytes;
      }
    }
    for (const entry of this.overviewStore.allEntries()) {
      if (!this.wantedByKey.has(this.deliveryKey(this.chunkEntryToDelivery(entry)))) continue;
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
    return this.imageKeyPrefix(req.datasetId, req.imageId) +
      this.identityPart(this.requestResidencyTier(req)) +
      this.identityPart(req.chunkKey);
  }

  private identityPart(value: string): string {
    return `${value.length}:${value}`;
  }

  private datasetKeyPrefix(datasetId: string): string {
    return this.identityPart(datasetId);
  }

  private imageKeyPrefix(datasetId: string, imageId: string): string {
    return this.datasetKeyPrefix(datasetId) + this.identityPart(imageId);
  }

  private imageGenerationKey(datasetId: string, imageId: string): string {
    return `${datasetId.length}:${datasetId}${imageId.length}:${imageId}`;
  }

  private imageGeneration(datasetId: string, imageId: string): number {
    return this.imageInvalidationGeneration.get(this.imageGenerationKey(datasetId, imageId)) ?? 0;
  }
}

function isEpochStale(deliveryEpochs: SceneEpochs, currentEpochs: SceneEpochs): boolean {
  return (
    deliveryEpochs.selection < currentEpochs.selection ||
    deliveryEpochs.content < currentEpochs.content
  );
}
