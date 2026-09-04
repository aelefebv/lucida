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
import { Scheduler, type SchedulableRequest } from "./scheduler.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { Boundary, CountedPhaseIndex, PointEvent, RowOutcome } from "../../trace/types.ts";
import { parseChunkKey } from "../../renderer/chunkKeys.ts";
import type { ChunkFeedbackReason } from "../../renderer/workerProtocol.ts";
import type { CacheQuiescenceInputs } from "../../trace/quiescence.ts";
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
  LevelResidency,
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
} from "./types.ts";
import type { ResidencyTier } from "../residencyTier.ts";

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
/**
 * How deep the pending queue may be before {@link CpuCache.quiescenceInputs}
 * stops classifying it by lane. The predicate runs on the tick path and an
 * oversubscribed remote collection queues tens of thousands of requests, so
 * the scan is bounded; past this depth the answer is "not quiescent",
 * declared rather than guessed.
 */
const QUIESCENCE_PENDING_SCAN_CAP = 4096;
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

interface InFlightProxyMeta {
  request: ProxyRequest;
  lastSeenTick: number;
  epochs: SceneEpochs;
}

/**
 * The residency tier a point event carries, read off the entry rather than
 * assumed from the store it came out of. Row identity includes the tier
 * because a chunk key legitimately exists under both, so an event that
 * guessed it could not be joined to its own lifecycle row.
 */
function eventTier(entry: CacheEntry): 0 | 1 {
  return entry.residencyTier === "coarse" ? 1 : 0;
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

  private proxyStore!: ProxyStore;

  private chunkScheduler!: Scheduler<ChunkRequest>;

  /** Shares concurrency / bytes caps with `chunkScheduler` via `siblingInFlight`. */
  private proxyScheduler!: Scheduler<ProxyRequest>;

  readonly deliveryState = new DeliveryState();

  private activeEntityIds = new Set<string>();
  private activeEntityIdsThisRebuild = new Set<string>();

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

  /** Proxies are not retried in-fetch; orchestrator resubmits next tick. */
  private proxyRetryPolicy: RetryPolicy = new NeverRetry();

  /** Plan-rebuild generation stamped onto wanted cache entries. */
  private currentSubmitTick = 0;
  private desiredDetailKeysThisTick = new Set<string>();
  private desiredCoarseKeysThisTick = new Set<string>();
  /**
   * Keys demanded by the VIEW's own coarse lane this tick (a strict
   * subset of `desiredCoarseKeysThisTick`, which also counts minimap
   * and overview demand). Feeds {@link resolveDemandLane}.
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
  private inFlightProxyMeta = new Map<string, InFlightProxyMeta>();

  /**
   * Worker-rejected (atlas full + too far) chunks. `submit()` skips
   * enqueuing and does NOT refresh `lastSeenTick`, so the active-detail
   * eviction can sweep cached-but-rejected copies before useful ones.
   */
  private rejectionTracker = new RejectionTracker();

  /** Reused by {@link levelResidency}; see its note on lifetime. */
  private readonly levelResidencyScratch: LevelResidency = { cached: [], inFlight: [] };

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
      recordEviction: (tier, entry) => {
        this.counters.recordEviction(tier);
        traceRecorder.recordPointEvent(PointEvent.Eviction, "evicted", entry, eventTier(entry));
      },
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
      recordEviction: (tier, entry) => {
        this.counters.recordEviction(tier);
        traceRecorder.recordPointEvent(PointEvent.Eviction, "evicted", entry, eventTier(entry));
      },
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
      (req, controller, _estimate, key, admittedAtMs) => {
        const startedEpochs = { ...this.currentEpochs };
        this.rememberInFlightChunk(key, req, startedEpochs);
        // `fetchAndDecode` handles fetch/decode failures internally (retry,
        // failure map, streak surfacing); anything escaping here is an
        // unexpected pipeline error — keep it out of the void.
        this.fetchAndDecode(req, controller, key, 0, startedEpochs, false, admittedAtMs).catch((err: unknown) => {
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

    // One pass over the request list builds every derived key exactly
    // once (issue #900). The planner hands `submit` the dataset's
    // COMPLETE wanted set on every rebuild — ~21k entries at ~5/s on a
    // large remote collection — so re-deriving `inFlightKey` separately
    // for the planned-key set, the tier-demand pass, and the enqueue
    // loop cost three string builds and ~six residency-tier calls per
    // request per rebuild. `keys[i]` and `tiers[i]` are read back by the
    // enqueue loop below. Order of effects is unchanged: tier demand is
    // still recorded over the FULL list before the enqueue loop, so
    // demand-lane resolution stays independent of request order.
    const requests = plan.requests;
    const keys = new Array<string>(requests.length);
    const tiers = new Array<ResidencyTier>(requests.length);
    // Seeded with every in-flight key belonging to an entity in THIS
    // submit's active set; the pass below strikes out each key the plan
    // still wants, leaving the omitted work to abort. Bounded by the
    // concurrency cap, so this replaces a ~21k-entry planned-key set with
    // a set of at most a couple of dozen strings.
    const unwantedInFlightKeys = this.activeInFlightChunkKeys(newActiveIds);
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const tier = req.tier;
      const key = chunkSchedulerKey(req, tier);
      keys[i] = key;
      tiers[i] = tier;
      if (unwantedInFlightKeys.size > 0) unwantedInFlightKeys.delete(key);
      if (tier === "detail") {
        this.desiredDetailKeysThisTick.add(key);
      } else if (tier === "coarse") {
        this.desiredCoarseKeysThisTick.add(key);
        if (req.lane === "coarse") this.viewCoarseKeysThisTick.add(key);
      }
    }

    this.applyElasticTierBudgets();
    this.cancelOmittedChunkWork(unwantedInFlightKeys);

    const pendingChunks: ChunkRequest[] = [];
    const pendingTiers: ResidencyTier[] = [];
    const pendingKeys = new Set<string>();
    const enqueueNow = performance.now();
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const key = keys[i];

      this.counters.recordRequest();

      // Worker-rejected under the current camera. Skip without
      // refreshing `lastSeenTick` so the cached copy can be evicted.
      if (this.rejectionTracker.has(req.entityId, req.chunkKey)) {
        continue;
      }

      // Refresh lane/tier/priority/lastSeenTick on cached entries so
      // deliverability and eviction reflect the current plan. The lane
      // is demand-resolved: a chunk the view's coarse lane also wants
      // this tick must not end up labelled "minimap" (undeliverable)
      // just because the minimap request happened to be processed last.
      const cachedEntry = this.lookupCachedEntry(req);
      if (cachedEntry) {
        this.counters.recordHit();
        const lane = this.resolveDemandLane(req.lane, key);
        cachedEntry.lane = lane;
        cachedEntry.residencyTier = tiers[i];
        cachedEntry.tier = this.laneToTier(lane);
        // A relabelled minimap request must not overwrite the view's
        // own (more urgent) delivery priority for the same chunk.
        cachedEntry.priority = lane === req.lane
          ? req.priority
          : Math.min(cachedEntry.priority, req.priority);
        cachedEntry.lastSeenTick = this.currentSubmitTick;
        continue;
      }

      if (this.chunkScheduler.hasInFlight(key)) {
        // A second demand attaching to a fetch already on the wire. The
        // attach itself is below the clock floor, so it is counted per tick
        // (ADR 0047); the one fetch keeps the one row.
        traceRecorder.countPhase(CountedPhaseIndex.CoalesceAttach);
        this.rememberInFlightChunk(key, req, { ...this.currentEpochs });
        continue;
      }

      // Permanent failures stay excluded for the session (their `eligibleAt`
      // is `Infinity`, until reset / cancelDataset). Transient failures
      // self-heal: once a re-planned key has waited out its (jittered,
      // capped-exponential) backoff, it is re-enqueued. Re-eligibility is
      // evaluated lazily here at plan time — there is no timer re-arming
      // failed tiles on its own.
      if (this.isFailureExcluded(key)) continue;

      // The minimap and coarse lanes can demand the same chunk (shared
      // residency tier + key); one fetch serves both, and the most
      // urgent occurrence — plans arrive priority-sorted — keeps the
      // queue slot.
      if (pendingKeys.has(key)) {
        traceRecorder.countPhase(CountedPhaseIndex.CoalesceAttach);
        continue;
      }
      pendingKeys.add(key);
      pendingChunks.push(req);
      pendingTiers.push(tiers[i]);
    }
    // Closes the plan phase at the exact instant the scheduler took the
    // requests, so a row's plan end and its queue start are one number rather
    // than two readings of the clock that nearly agree.
    //
    // Only when this submit actually enqueued something. A submit that
    // enqueues no chunks has no row to attribute, and one arriving from
    // outside a tick — `requestTestProxy` is the only such caller — would
    // otherwise close a plan pass that a tick opened long ago and publish the
    // gap between them as plan time.
    if (pendingChunks.length > 0) traceRecorder.notePlanEnqueue(enqueueNow);
    this.chunkScheduler.enqueue(
      orderChunkRequestsForTierAllocation(pendingChunks, pendingTiers),
      enqueueNow,
    );

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

  /**
   * Abort a still-active entity's in-flight chunks that the entity's own
   * newest plan no longer wants. `submit` runs once per dataset with that
   * dataset's complete request set, so for an entity present in this
   * submit's active set, `plannedChunkKeys` is authoritative: any of its
   * in-flight chunks absent from it (scrubbed-away T/Z/channel work) is
   * genuinely unwanted and must release its concurrency slot now rather
   * than hold it until the transfer timeout. Entities NOT in this submit's
   * active set are left untouched here — another still-visible dataset may
   * simply be submitted in a separate call this rebuild; departure of an
   * entity from the view entirely is handled at the rebuild boundary in
   * {@link onPlanRebuildStart}.
   *
   * `unwantedInFlightKeys` is computed by {@link submit}'s derivation pass
   * (issue #900): it starts as this submit's active-entity in-flight keys
   * and has every key the plan still wants struck out of it, so what
   * remains is exactly the set to abort — a handful of keys, rather than a
   * membership test against a ~21k planned-key set.
   *
   * Only IN-FLIGHT work is cancelled. The pending queue is deliberately
   * left alone: `submit` replaces it wholesale a few statements later with
   * exactly this plan's request set, so filtering the outgoing queue is
   * work with no observable effect — and on a large remote collection that
   * filter walked ~21k entries, allocating a synthetic entry and rebuilding
   * a key string for every one of them, on every rebuild.
   */
  /**
   * In-flight chunk keys whose entity is in `activeEntityIds`. Bounded by
   * the concurrency cap, so building it is cheap regardless of how large
   * the wanted set is. Empty when no entity is active — the caller then
   * has nothing to cancel.
   */
  private activeInFlightChunkKeys(activeEntityIds: Set<string>): Set<string> {
    const keys = new Set<string>();
    if (activeEntityIds.size === 0) return keys;
    for (const [key, entry] of this.chunkScheduler.inFlightEntries()) {
      if (activeEntityIds.has(entry.request.entityId)) keys.add(key);
    }
    return keys;
  }

  private cancelOmittedChunkWork(unwantedInFlightKeys: Set<string>): void {
    if (unwantedInFlightKeys.size === 0) return;
    const cancelled = this.chunkScheduler.cancelInFlightWhere(
      (_entry, key) => unwantedInFlightKeys.has(key),
    );
    for (const key of cancelled) {
      this.inFlightChunkMeta.delete(key);
    }
  }

  /**
   * Abort every in-flight (and drop every pending) chunk fetch for
   * `entityId` and clear its in-flight metadata. Used when an entity
   * leaves the view entirely. The chunk and proxy schedulers share the
   * concurrency/bytes caps (via `siblingInFlight`), so a departed
   * entity's chunk and proxy fetches are both released — this handles
   * the chunk side, {@link cancelProxyWorkForEntity} the proxy side —
   * returning those shared slots to the current view immediately instead
   * of holding them until the transfer timeout. A returning entity
   * re-enqueues normally on its next submit.
   */
  private cancelChunkWorkForEntity(entityId: string): void {
    const cancelled = this.chunkScheduler.cancelWhere(
      (entry) => entry.request.entityId === entityId,
    );
    for (const key of cancelled) {
      this.inFlightChunkMeta.delete(key);
    }
  }

  /**
   * Abort every in-flight (and drop every pending) PER-ENTITY proxy fetch
   * for `entityId` and clear its in-flight metadata. The proxy counterpart
   * to {@link cancelChunkWorkForEntity}, called at the same rebuild boundary
   * when an entity leaves the view entirely: because both schedulers share
   * the concurrency/bytes caps, a departed entity's outstanding per-tile
   * proxy would otherwise hold a shared slot until the proxy timeout,
   * starving the current view. Proxies are {@link NeverRetry}; a returning
   * entity re-fetches its proxy on the orchestrator's next submit.
   */
  private cancelProxyWorkForEntity(entityId: string): void {
    const cancelled = this.proxyScheduler.cancelWhere(
      (entry) =>
        entry.request.entityId === entityId &&
        // Exclude group proxies: a `GroupProxy3D` is keyed by its group id
        // rather than a per-tile active entity, so one tile leaving the
        // active set does not make it unwanted — the same shared fallback
        // can stay continuously requested by the tiles that remain visible.
        // A group proxy's wantedness is governed by plan membership (it is
        // kept while the plan still requests it), handled separately, not by
        // any single entity's departure.
        entry.request.kind !== "GroupProxy3D",
    );
    for (const key of cancelled) {
      this.inFlightProxyMeta.delete(key);
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
    // prefix-match on `entityId + "/"` rather than splitting. Snapshot both
    // stores' keys before mutating them.
    for (const entityId of entityIds) {
      const prefix = `${entityId}/`;
      for (const key of [...this.permanentFailures.keys(), ...this.transientFailures.keys()]) {
        if (key.startsWith(prefix)) this.clearFailure(key);
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

    // The renderer's own reason for a skip: the atlas was full and the
    // incoming chunk was farther out than everything already in it. The
    // resident copy carries the image id when there is one; a chunk rejected
    // before it ever arrived is still worth a point event, so the coordinates
    // come off the key instead.
    const resident =
      this.chunkStore.get(entityId, chunkKey) ?? this.overviewStore.get(entityId, chunkKey);
    const coords = resident ? null : parseChunkKey(chunkKey);
    if (resident) {
      traceRecorder.recordPointEvent(
        PointEvent.Rejection, "atlas-policy", resident, eventTier(resident),
      );
    } else if (coords) {
      traceRecorder.recordPointEvent(
        PointEvent.Rejection,
        "atlas-policy",
        {
          entityId,
          imageId: "",
          level: coords.level,
          t: coords.t,
          c: coords.c,
          z: coords.z,
          y: coords.y,
          x: coords.x,
        },
        0,
      );
    }

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
        // The entity was active last rebuild but the just-completed one
        // never requested it: it has left the view entirely. Abort its
        // in-flight chunk and proxy fetches so they release their shared
        // concurrency slots to the current view immediately, rather than
        // holding them until the transfer timeout. Its already-cached
        // chunks are only demoted (kept, evictable); if it returns, its
        // next submit re-enqueues.
        this.cancelChunkWorkForEntity(entityId);
        this.cancelProxyWorkForEntity(entityId);
      }
    }
    this.activeEntityIds = this.activeEntityIdsThisRebuild;
    this.activeEntityIdsThisRebuild = new Set();
    this.currentSubmitTick++;
    this.desiredDetailKeysThisTick.clear();
    this.desiredCoarseKeysThisTick.clear();
    this.viewCoarseKeysThisTick.clear();
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
      // Handed to the renderer. The row's `upload` phase runs until the next
      // frame proves the worker has written it; the handle is cleared off the
      // entry so a re-delivery after an eviction cannot re-stamp a row whose
      // life is already over.
      if ((delivery.traceRow ?? -1) >= 0) {
        traceRecorder.noteHandedToRenderer(delivery.traceRow!);
        const entry =
          this.chunkStore.get(delivery.entityId, delivery.chunkKey) ??
          this.overviewStore.get(delivery.entityId, delivery.chunkKey);
        if (entry) entry.traceRow = -1;
      }
      this.deliveryState.markChunkSent(
        delivery.imageId, delivery.c, delivery.chunkKey, delivery.residencyTier,
      );
    } else {
      this.deliveryState.markProxySent(this.proxyKeyFromDelivery(delivery));
    }
  }

  /**
   * `reason` is the renderer's own account of why the chunks came back — its
   * chunk feedback vocabulary, forwarded rather than re-derived, so the trace
   * can distinguish an atlas eviction from a stale epoch or a radius filter.
   */
  markChunkEvicted(
    imageId: string,
    c: number,
    evicted: string[],
    skipped: string[],
    reason: ChunkFeedbackReason = "evicted",
  ): void {
    for (const key of evicted) {
      this.deliveryState.clearChunkSent(imageId, c, key);
      const entry =
        this.chunkStore.findByImageChunk(imageId, c, key) ??
        this.overviewStore.findByImageChunk(imageId, c, key);
      if (entry) {
        traceRecorder.recordPointEvent(PointEvent.Eviction, reason, entry, eventTier(entry));
      }
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

  /**
   * Resident and in-flight chunk counts per pyramid level, for the trace's
   * per-tick aggregates. Deliberately not {@link snapshot}: that one
   * allocates a Set per entity and walks every resident chunk, which is
   * affordable once per rebuild behind a debug toggle and not affordable on
   * every tick with recording always on. Both stores keep their level counts
   * incrementally, and the in-flight map holds only dispatched fetches — a
   * few dozen — so this is a short walk over small numbers.
   *
   * Counts every resident chunk, not only the active set's: an aggregate that
   * quietly excluded demoted or prefetched residency would understate what
   * the cache is actually holding.
   *
   * Returns the cache's own reused arrays, valid until the next call —
   * recording is unconditional and per tick, so this may not allocate.
   */
  levelResidency(): LevelResidency {
    const { cached, inFlight } = this.levelResidencyScratch;
    cached.fill(0);
    inFlight.fill(0);

    for (const store of [this.chunkStore, this.overviewStore]) {
      const counts = store.levelResidency();
      for (let level = 0; level < counts.length; level++) {
        if (counts[level] === 0) continue;
        while (cached.length <= level) cached.push(0);
        cached[level] += counts[level];
      }
    }

    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      const level = entry.request.level;
      if (!Number.isInteger(level) || level < 0) continue;
      while (inFlight.length <= level) inFlight.push(0);
      inFlight[level]++;
    }

    return this.levelResidencyScratch;
  }

  /**
   * Every byte the CPU cache holds, across all three stores. Separate from
   * {@link telemetry} because the trace samples this per planning pass and
   * `telemetry()` builds a whole report — including a materialised deliverable
   * list — to answer it.
   */
  residentBytes(): number {
    return this.chunkStore.bytes + this.overviewStore.bytes + this.proxyStore.bytes;
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

  /**
   * The cache's half of the published quiescence predicate (ADR 0051):
   * everything the view asked for is resident, with nothing pending or in
   * flight.
   *
   * Writes into `out` and returns it. The render loop calls this every tick
   * and owns one instance, because ADR 0049 asks the monitor not to allocate
   * in steady state — an allocating recorder produces GC pauses that show up
   * as stalls in its own trace.
   *
   * **Where prefetch is excluded, and where it is not.** ADR 0051 excludes
   * speculative prefetch from the predicate because the prefetch lane keeps
   * requesting future timepoints, so a naive "queues empty" test may never
   * go true on a timeseries. That hazard lives in the *queues*, and that is
   * where the exclusion is applied: `pending` and `inFlight` count
   * non-speculative work only, and the speculative remainder is reported
   * beside them rather than hidden. The demand counts stay on the same
   * prefetch-inclusive basis the cache already publishes — resident and
   * desired must be counted the same way or the ratio is nonsense, and
   * prefetch demand is finite per timepoint and becomes resident like any
   * other chunk, so including it cannot make quiescence unreachable.
   *
   * `pendingUnclassified` is set when the pending queue is deeper than
   * {@link QUIESCENCE_PENDING_SCAN_CAP}. That bounds the scan to the tick it
   * runs in, and reads as *not* quiescent, so a deep queue keeps a run open
   * rather than closing one early on a guess.
   */
  quiescenceInputs(out: CacheQuiescenceInputs): CacheQuiescenceInputs {
    const demand = this.computeTierDemandTelemetry();

    let inFlight = this.proxyScheduler.inFlightSize;
    let speculativeInFlight = 0;
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      if (entry.request.lane === "prefetch") speculativeInFlight++;
      else inFlight++;
    }

    const speculativePending = this.chunkScheduler.countPending(
      req => req.lane === "prefetch",
      QUIESCENCE_PENDING_SCAN_CAP,
    );

    out.desiredDetailChunks = demand.desired.detailChunks;
    out.residentDetailChunks = demand.resident.detailChunks;
    out.desiredCoarseChunks = demand.desired.coarseChunks;
    out.residentCoarseChunks = demand.resident.coarseChunks;
    out.inFlight = inFlight;
    out.speculativeInFlight = speculativeInFlight;
    out.speculativePending = speculativePending ?? 0;
    out.pendingUnclassified = speculativePending === null;
    out.pending =
      this.chunkScheduler.pendingSize - (speculativePending ?? 0) + this.proxyScheduler.pendingSize;
    return out;
  }

  /** Live config, for surfaces that edit it (Dev controls) — read-only. */
  getConfig(): Readonly<CpuCacheConfig> {
    return this.config;
  }

  updateConfig(partial: Partial<CpuCacheConfig>): void {
    Object.assign(this.config, partial);
    if (partial.now) this.now = partial.now;
    if (partial.random) this.random = partial.random;
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
    fedStreak = false,
    admittedAtMs?: number,
  ): Promise<void> {
    // One row per fetch attempt, so an in-fetch retry retires its row and the
    // next attempt opens a fresh one rather than overwriting the first
    // attempt's timings.
    //
    // Three boundaries land in this one call, because the row is opened at
    // dispatch and the two phases behind it are already over: `plan` (the
    // tick's wanted-set computation) and `queue` (admitted to the scheduler →
    // dispatched). `wire` — request sent → bytes in hand — starts now, and is
    // the bracket the server's own rows nest inside once they arrive.
    //
    // One call rather than three: this loop runs up to 2,943 times in a single
    // submit, so the extra calls were three times the event count ADR 0049's
    // tick ceiling was derived from (#949).
    const rowTier = req.tier === "coarse" ? 1 : 0;
    const traceRow = traceRecorder.beginChunkRow(req, rowTier, admittedAtMs);

    let result: FetchResult;
    try {
      result = await this.source.fetch(
        { datasetId: req.datasetId, imageId: req.imageId, chunkKey: req.chunkKey },
        controller.signal,
        // The label the transport sent this chunk under — the first
        // sender's when this fetch coalesced onto one already in flight, so
        // every row that waited on a request points at that request.
        label => traceRecorder.labelRow(traceRow, label),
      );
    } catch (err: unknown) {
      traceRecorder.finishRow(traceRow, RowOutcome.Retired);
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
        traceRecorder.recordPointEvent(PointEvent.Retry, fe.kind, req, rowTier);
        await new Promise(r => setTimeout(r, this.chunkRetryPolicy.delayMs(retryCount)));
        if (!this.chunkScheduler.hasInFlight(key)) return; // cancelled during wait
        return this.fetchAndDecode(
          req, controller, key, retryCount + 1, startedEpochs, fed, admittedAtMs,
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
        traceRecorder.recordPointEvent(PointEvent.Failure, fe.kind, req, rowTier);
      }
      return;
    }

    // Closes `wire` and opens `decode` — adjacent phases share the slot
    // between them. The pool closes `decode` on its own onmessage, and the
    // row completes when a frame has drawn the chunk.
    traceRecorder.stamp(traceRow, Boundary.DecodeStart);

    this.counters.recordCompletedFetch(result.bytes.byteLength);
    // Correct the in-flight byte estimate only while this settle still owns
    // the slot; a superseded successor keeps its own accounting.
    if (this.chunkScheduler.isCurrent(key, controller)) {
      this.chunkScheduler.correctInFlightBytes(key, result.bytes.byteLength);
    }

    let decoded: ArrayBuffer;
    try {
      const t0 = performance.now();
      decoded = await this.decode.decode(result.bytes, result.wireFormat, traceRow);
      this.counters.recordDecode(performance.now() - t0);
    } catch (err: unknown) {
      traceRecorder.finishRow(traceRow, RowOutcome.Retired);
      const message = err instanceof Error ? err.message : String(err);
      // A fetch that completes but cannot be decoded (wrong wire format,
      // corrupted bytes, an intercepting proxy answering with garbage) is a
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
        // Bytes that arrived and could not be decoded fail the delivery just
        // as a dead fetch does, and self-heal the same way, so they borrow
        // the same `transient` code rather than inventing a decode reason.
        traceRecorder.recordPointEvent(PointEvent.Failure, "transient", req, rowTier);
      }
      return;
    }

    const latestMeta = this.inFlightChunkMeta.get(key);
    const effectiveReq = latestMeta?.request ?? req;
    const metaEpochs = latestMeta?.epochs ?? startedEpochs;
    const stale =
      latestMeta === undefined ||
      latestMeta.lastSeenTick !== this.currentSubmitTick ||
      isEpochStale(metaEpochs, this.currentEpochs);
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
      residencyTier: effectiveReq.tier,
      priority: stale ? Number.MAX_SAFE_INTEGER : effectiveReq.priority,
      lastSeenTick,
      // Carries the chunk's lifecycle row the rest of the way, so `upload`
      // and `present` land on the same row as `wire` and `decode`.
      traceRow,
    };

    // Coarse-tier lanes share the overview store (ADR 0023, ADR 0039).
    if (lane === "overview" || lane === "minimap" || lane === "coarse") {
      if (stale && this.overviewStore.bytes + cacheEntry.sizeBytes > this.overviewStore.budgetBytes) {
        // Decoded and then dropped on the floor: the row ends here, and
        // saying so is the difference between a chunk that stalled and one
        // that was never going to arrive.
        traceRecorder.finishRow(traceRow, RowOutcome.Retired);
        this.drainSchedulers();
        return;
      }
      this.overviewStore.insert(cacheEntry);
    } else {
      if (stale && this.chunkStore.bytes + cacheEntry.sizeBytes > this.chunkStore.budgetBytes) {
        traceRecorder.finishRow(traceRow, RowOutcome.Retired);
        this.drainSchedulers();
        return;
      }
      this.chunkStore.insert(cacheEntry);
    }
    // Cache admission: the moment decoded bytes become resident. Counted, not
    // timed — the insert is well under the platform's clock floor.
    traceRecorder.countPhase(CountedPhaseIndex.CacheAdmission);

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
        this.settleFetch(this.proxyScheduler, this.inFlightProxyMeta, key, controller);
        return;
      }
      // Consulted for symmetry; NeverRetry always returns false.
      if (this.proxyRetryPolicy.shouldRetry(fe, 0)) {
        await new Promise(r => setTimeout(r, this.proxyRetryPolicy.delayMs(0)));
        if (!this.proxyScheduler.hasInFlight(key)) return;
        return this.fetchProxy(req, controller, key);
      }
      // Proxies carry no per-key failure record or delivery streak; the
      // orchestrator resubmits next tick if still wanted.
      if (this.settleFetch(this.proxyScheduler, this.inFlightProxyMeta, key, controller)) {
        this.counters.recordError(fe.message);
      }
      return;
    }

    const responseBytes = result.data.byteLength;
    // Correct the in-flight byte estimate only while this settle still owns
    // the slot; a superseded successor keeps its own accounting.
    if (this.proxyScheduler.isCurrent(key, controller)) {
      this.proxyScheduler.correctInFlightBytes(key, responseBytes);
    }

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

    // Cache even if superseded during the fetch — the bytes are valid; the
    // settle below releases the slot and metadata only when this controller
    // still owns the key.
    this.proxyStore.insert(effectiveReq.datasetId, proxyInnerKey(effectiveReq), cacheEntry);

    this.settleFetch(this.proxyScheduler, this.inFlightProxyMeta, key, controller);

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

  /**
   * Release the scheduler slot and drop the in-flight metadata for a
   * completion, but only when the settling controller still owns the key.
   * Every fetch-completion exit (chunk and proxy; failure, decode failure,
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
      traceRow: entry.traceRow,
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
    // overview/minimap use LRU; tier is a no-op label there.
    if (lane === "overview" || lane === "minimap" || lane === "coarse") return "prefetch";
    return "active-detail";
  }

  private computeTierDemandTelemetry(): CacheTelemetry["tierDemand"] {
    let residentDetailChunks = 0;
    let residentDetailBytes = 0;
    let residentCoarseChunks = 0;
    let residentCoarseBytes = 0;

    for (const entry of this.chunkStore.allEntries()) {
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (entry.residencyTier === "detail") {
        residentDetailChunks++;
        residentDetailBytes += entry.sizeBytes;
      }
    }
    for (const entry of this.overviewStore.allEntries()) {
      if (entry.lastSeenTick !== this.currentSubmitTick) continue;
      if (entry.residencyTier === "coarse") {
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
      queues[req.tier].pending++;
    }
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      const tier = entry.request.tier;
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
    return chunkSchedulerKey(req, req.tier);
  }
}

/**
 * The scheduler key for a chunk request at a known residency tier. Sole
 * definition of that string: `CpuCache.submit` derives the tier once per
 * request and calls this directly, while {@link CpuCache.inFlightKey}
 * resolves the tier first and then calls it — so the two paths cannot
 * drift into producing different keys for the same request.
 */
function chunkSchedulerKey(req: ChunkRequest, tier: ResidencyTier): string {
  return `${req.entityId}/${tier}/${req.chunkKey}`;
}

/**
 * Interleave detail and coarse requests so neither tier can exhaust the
 * fetch slots before the other gets any — the two caches have separate
 * budgets, and a priority-sorted run of one tier would otherwise fill
 * the queue head. `tiers[i]` is the residency tier of `requests[i]`,
 * precomputed by {@link CpuCache.submit}'s single derivation pass so a
 * large wanted set is not re-classified here (issue #900).
 */
function orderChunkRequestsForTierAllocation(
  requests: ChunkRequest[],
  tiers: ResidencyTier[],
): ChunkRequest[] {
  const detail: ChunkRequest[] = [];
  const coarse: ChunkRequest[] = [];
  const other: ChunkRequest[] = [];

  for (let i = 0; i < requests.length; i++) {
    const tier = tiers[i];
    if (tier === "detail") detail.push(requests[i]);
    else if (tier === "coarse") coarse.push(requests[i]);
    else other.push(requests[i]);
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

function isEpochStale(deliveryEpochs: SceneEpochs, currentEpochs: SceneEpochs): boolean {
  return (
    deliveryEpochs.selection < currentEpochs.selection ||
    deliveryEpochs.content < currentEpochs.content
  );
}
