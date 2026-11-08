/**
 * CPU cache: holds decoded data between the network and the GPU.
 *
 * Owns the detail and overview stores with their eviction policies, the
 * priority-ordered fetch scheduler, and the submit/getDeliverable/
 * snapshot/telemetry API.
 */

import type { ChunkFailureKind, ContentSource, FetchResult } from "./contentSource.ts";
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
  TieredPolicy,
  WantedLastPolicy,
  getTierOrder,
} from "./eviction.ts";
import { ChunkStore } from "./chunkStore.ts";
import { Scheduler } from "./scheduler.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { CountedPhaseIndex, PointEvent, RowOutcome } from "../../trace/types.ts";
import { parseChunkKey } from "../../renderer/chunkKeys.ts";
import type { ChunkFeedbackReason } from "../../renderer/workerProtocol.ts";
import type { CacheSettleInputs } from "../settle.ts";
import {
  classifyFetchError,
  OnceTransientRetry,
  type RetryPolicy,
} from "./retry.ts";
import { RejectionTracker } from "./rejection.ts";
import { DeliveryState } from "./deliveryState.ts";
import { debugLog } from "../../debug/logging.ts";
import {
  LANES,
  type CacheEntry,
  type CacheTelemetry,
  type CpuCacheConfig,
  type EvictionTier,
  type Lane,
  type LaneOutstanding,
  type LevelResidency,
  type PoolResidencyReport,
  type ReadyChunkDelivery,
} from "./types.ts";
import { CEILING_BUDGETS } from "../../deviceBudget.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { WireGeneratedChunkStatusUpdate } from "../generatedAvailability.ts";

// Re-exported so existing `./cpuCache.ts` imports keep working.
export type {
  CacheEntry,
  CacheTelemetry,
  CpuCacheConfig,
  EvictionTier,
  Lane,
  ReadyChunkDelivery,
  TierCounters,
  TierResidencyEntry,
} from "./types.ts";

// The page passes budgets fitted to the device; these defaults are the
// ceiling it fits them under.
export const DEFAULT_MAIN_BUDGET = CEILING_BUDGETS.cpuMainBytes;
export const DEFAULT_OVERVIEW_BUDGET = CEILING_BUDGETS.cpuOverviewBytes;
export const DEFAULT_MAX_BYTES_IN_FLIGHT = CEILING_BUDGETS.cpuBytesInFlight;
export const FETCH_CONCURRENCY_MULTIPLIER = 3;
export const TRANSIENT_RETRY_DELAY_MS = 500;
export const MAX_TRANSIENT_RETRIES = 1;
/** Consecutive chunk-delivery failures, with no delivered chunk between them,
 *  before `onChunkFailureStreak` fires. Counted: permanent fetch rejections,
 *  every server-reported `source_chunk_status` failure (permanent or
 *  transient), and decode failures. Client-side transients (timeouts,
 *  disconnects) never count. High enough that isolated misses never trip it,
 *  low enough that a dead source crosses it within one viewport's requests. */
export const CHUNK_FAILURE_STREAK_THRESHOLD = 10;
/** Minimum spacing between `onChunkFailureStreak` calls while a streak
 *  persists, so the signal stays aggregate rather than per chunk. */
export const CHUNK_FAILURE_NOTIFY_INTERVAL_MS = 15_000;
export const INTERACTION_MODE_WINDOW = 10;
/**
 * How deep the pending queue may be before {@link CpuCache.settleInputs}
 * stops classifying it by lane. The predicate runs on the tick path and an
 * oversubscribed remote collection queues tens of thousands of requests, so
 * the scan is bounded; past this depth the answer is "not quiescent",
 * declared rather than guessed.
 */
const QUIESCENCE_PENDING_SCAN_CAP = 4096;

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
 * Least spacing between reconciles that availability updates call for. The
 * server publishes one update per generated chunk, and a reconcile walks the
 * whole wanted set, so a burst of updates folds into one walk per interval.
 */
export const AVAILABILITY_RECONCILE_INTERVAL_MS = 100;

/**
 * Nominal first backoff for a generated chunk answered pending. The
 * availability update that names the chunk is what asks for it again; this
 * only covers an update that never comes, such as work the server lost, so it
 * starts long rather than re-asking for a whole level every second.
 */
export const PENDING_BACKOFF_BASE_MS = 8_000;

/**
 * Capped exponential backoff for a transient failure's `attempt`-th record
 * (1-based). Jitter spreads below the cap, so entries that both reach the cap
 * still draw distinct delays instead of retrying in lockstep.
 */
export function backoffWithJitter(
  attempt: number,
  random: () => number,
  baseMs: number = FAILURE_BACKOFF_BASE_MS,
): number {
  const growth = baseMs *
    Math.pow(FAILURE_BACKOFF_FACTOR, Math.max(0, attempt - 1));
  const base = Math.min(FAILURE_BACKOFF_MAX_MS, growth);
  const floor = base * (1 - FAILURE_BACKOFF_JITTER_RATIO);
  return floor + random() * (base - floor);
}

/**
 * One per-key fetch-failure record. A key lives in exactly one of two
 * independently bounded stores, {@link CpuCache.permanentFailures} or
 * {@link CpuCache.transientFailures}, so a flood of one kind cannot evict the
 * other's records.
 */
interface FailureRecord {
  /** `permanent` is sticky (never time-eligible); `transient` self-heals
   *  after its backoff window. `pending` is a generated chunk the server has
   *  not made yet: not a failure, but it waits like a transient one, unless an
   *  availability update names the chunk first. */
  kind: "permanent" | "transient" | "pending";
  /** Why the server answered without bytes, when it said. */
  failure: ChunkFailureKind | null;
  /** The chunk's composite key, which is how an availability update names it. */
  chunk: string;
  /** `now()` at the moment the failure was recorded (the transient backoff
   *  anchor). */
  failedAt: number;
  /** How many times this key has failed transiently (>= 1); grows the
   *  backoff across successive records. Zero for a permanent record. */
  attempt: number;
  /** `now()` at or after which the key may be re-planned. `Infinity` for a
   *  permanent record, so time alone never frees it. */
  eligibleAt: number;
}

interface InFlightChunkMeta {
  request: ChunkRequest;
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

/** Priority first, then a total order on chunk identity so ties are stable. */
function compareDeliveries(a: ReadyChunkDelivery, b: ReadyChunkDelivery): number {
  return (
    (a.priority ?? 0) - (b.priority ?? 0) ||
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

export class CpuCache {
  private source: ContentSource;
  private decode: DecodePool;
  private config: CpuCacheConfig;

  /** Time source for failure-expiry decisions (injectable for tests). */
  private now: () => number;
  /** Randomness source for backoff jitter (injectable for tests). */
  private random: () => number;

  private chunkStore!: ChunkStore;

  /**
   * Serves the overview, minimap, and coarse lanes, apart from the detail
   * store so detail churn never evicts them.
   */
  private overviewStore!: ChunkStore;

  private chunkScheduler!: Scheduler<ChunkRequest>;

  readonly deliveryState = new DeliveryState();

  private activeEntityIds = new Set<string>();
  private activeEntityIdsThisRebuild = new Set<string>();
  /**
   * Each tile entity's target level from its most recent plan. The detail
   * store's eviction policy reads it so that a resident chunk finer than
   * the target goes first. The policy judges entries against
   * this map at eviction time, so a target change costs no pass over the
   * resident entries. An entity that left the view keeps its last target.
   */
  private targetLevelByEntity = new Map<string, number>();

  private interactionDetector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

  /**
   * Keys with a permanent fetch failure (a 404, or a source that rejects the
   * fetch outright). Sticky: they clear only on a successful delivery,
   * {@link CpuCache.reset}, or {@link CpuCache.cancelDataset}. FIFO-capped at
   * {@link MAX_TRACKED_FAILURES}, separately from {@link transientFailures},
   * so a flood of 404s cannot crowd out a transient's backoff record.
   */
  private permanentFailures = new Map<string, FailureRecord>();
  /**
   * Keys with a transient failure (timeout, disconnect, failed decode), or a
   * generated chunk answered pending, waiting out their backoff. FIFO-capped
   * at {@link MAX_TRACKED_FAILURES}, independently of the permanent store.
   */
  private transientFailures = new Map<string, FailureRecord>();

  /**
   * The request arrays submitted since the last plan rebuild, one per
   * dataset: the wanted set {@link reconcile} drives toward resident.
   */
  private wantedRequests: ChunkRequest[][] = [];
  /**
   * The one timer that wakes {@link reconcile}, and the `now()` it is due
   * at. Armed only while a wanted chunk waits out a backoff or an
   * availability update has freed one, so an idle cache holds no timer.
   */
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileAt = Infinity;
  private lastReconcileAt = -Infinity;
  /** In-flight chunk keys an availability update settled before they answered. */
  private settledWhileInFlight = new Set<string>();
  /**
   * Wanted chunks that arrived and found no room but at the cost of a chunk
   * at least as urgent. Not asked for again until the next plan, which is
   * what keeps two wanted chunks from evicting each other in turn.
   */
  private refusedThisPlan = new Set<string>();
  /**
   * Requests the plans since the last rebuild left out for want of room, per
   * tier: the coverage the view goes without.
   */
  private shortfallThisPlan: Record<ResidencyTier, number> = { detail: 0, coarse: 0 };
  /** Bytes of detail budget the plans since the last rebuild lent the coarse tier. */
  private coarseLoanThisPlan = 0;
  /**
   * Whether the plans since the last rebuild were admitted against the
   * budgets. Only then does the wanted set fit, and only then is an evicted
   * wanted chunk worth asking for again.
   */
  private plansAdmitted = false;
  /** Wanted chunks asked for again after an eviction since the last rebuild. */
  private retriedThisPlan = new Set<string>();

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
   * Keys demanded by the view's own coarse lane this tick (a strict
   * subset of `desiredCoarseKeysThisTick`, which also counts minimap
   * and overview demand). Feeds {@link resolveDemandLane}.
   */
  private viewCoarseKeysThisTick = new Set<string>();

  /**
   * Latest wanted metadata for in-flight fetches. The request object
   * passed to `fetchAndDecode` may have been queued under an older
   * camera/LOD plan; this map lets later submits refresh the generation
   * and lane while the bytes are still in flight.
   */
  private inFlightChunkMeta = new Map<string, InFlightChunkMeta>();

  /**
   * Worker-rejected (atlas full + too far) chunks. `submit()` skips
   * enqueuing and does not refresh `lastSeenTick`, so the active-detail
   * eviction can sweep cached-but-rejected copies before useful ones.
   */
  private rejectionTracker = new RejectionTracker();

  /** Reused by {@link levelResidency}; see its note on lifetime. */
  private readonly levelResidencyScratch: LevelResidency = { cached: [], inFlight: [] };

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

    const mainPolicy = new TieredPolicy(
      () => this.interactionDetector.current(),
      (entityId) => this.targetLevelByEntity.get(entityId),
    );
    // A wanted chunk more urgent than the one arriving stays: an insert
    // that could only make room by evicting one is refused instead.
    const protects = (resident: CacheEntry, incoming: CacheEntry): boolean =>
      resident.lastSeenTick === this.currentSubmitTick && resident.priority < incoming.priority;
    this.chunkStore = new ChunkStore({
      policy: mainPolicy,
      budgetBytes: this.config.mainBudgetBytes,
      evictionTier: (entry) => entry.tier,
      recordEviction: (tier, entry) => {
        this.counters.recordEviction(tier);
        traceRecorder.recordPointEvent(PointEvent.Eviction, "evicted", entry, eventTier(entry));
        this.noteEvicted(entry);
      },
      protects,
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
      policy: new WantedLastPolicy(() => this.currentSubmitTick),
      budgetBytes: this.config.overviewBudgetBytes,
      evictionTier: () => "overview",
      recordEviction: (tier, entry) => {
        this.counters.recordEviction(tier);
        traceRecorder.recordPointEvent(PointEvent.Eviction, "evicted", entry, eventTier(entry));
        this.noteEvicted(entry);
      },
      protects,
    });

    const burstBackpressure = new BurstLogger("cache", "cache.backpressure");
    this.chunkScheduler = new Scheduler<ChunkRequest>(
      {
        maxConcurrentFetches: this.config.maxConcurrentFetches,
        maxBytesInFlight: this.config.maxBytesInFlight,
        burstLogger: burstBackpressure,
      },
      (req) => this.inFlightKey(req),
      (req, controller, _estimate, key, admittedAtMs) => {
        const startedEpochs = { ...this.currentEpochs };
        this.rememberInFlightChunk(key, req, startedEpochs);
        // `fetchAndDecode` handles fetch and decode failures itself (retry,
        // failure records, streak); anything escaping here is an unexpected
        // pipeline error, so log it.
        this.fetchAndDecode(req, controller, key, 0, startedEpochs, false, admittedAtMs).catch((err: unknown) => {
          console.warn("[CpuCache] unexpected chunk pipeline error:", err);
        });
      },
    );
  }

  /**
   * Submit the current request plan. Re-submitting an unchanged plan is a
   * no-op. In-flight work for active entities that left the new plan is
   * preempted, so scrubbed-away T/Z/channel work does not hold scheduler
   * slots ahead of current requests.
   */
  submit(plan: RequestPlan): void {
    this.currentEpochs = plan.epochs;

    this.interactionDetector.push(plan.epochs);

    const newActiveIds = new Set<string>();
    for (const entry of plan.activeSet) {
      newActiveIds.add(entry.entityId);
      this.activeEntityIdsThisRebuild.add(entry.entityId);
      if (entry.kind === "tile" && entry.detailLevels.length > 0) {
        this.targetLevelByEntity.set(entry.entityId, entry.detailLevels[0]);
      }
    }

    // One pass derives every key and tier exactly once. `submit` receives the
    // dataset's complete wanted set on every rebuild (~21k entries at ~5/s on
    // a large remote collection), so the enqueue loop below reuses `keys[i]`
    // and `tiers[i]`. Tier demand is recorded over the full list before that
    // loop, so demand-lane resolution does not depend on request order.
    const requests = plan.requests;
    const keys = new Array<string>(requests.length);
    const tiers = new Array<ResidencyTier>(requests.length);
    // Seeded with this submit's active-entity in-flight keys; the pass below
    // strikes out each key the plan still wants, leaving the work to abort.
    // Bounded by the concurrency cap, so it stays a few dozen strings.
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

    if (plan.shortfall) {
      this.plansAdmitted = true;
      this.shortfallThisPlan.detail += plan.shortfall.detail;
      this.shortfallThisPlan.coarse += plan.shortfall.coarse;
    }
    this.coarseLoanThisPlan += plan.coarseLoanBytes ?? 0;
    this.applyElasticTierBudgets();
    this.cancelOmittedChunkWork(unwantedInFlightKeys);
    this.wantedRequests.push(requests);

    const pendingChunks: ChunkRequest[] = [];
    const pendingTiers: ResidencyTier[] = [];
    const pendingKeys = new Set<string>();
    const enqueueNow = performance.now();
    let nextRetryAt = Infinity;
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const key = keys[i];

      this.counters.recordRequest();

      // Worker-rejected under the current camera. Skip without
      // refreshing `lastSeenTick` so the cached copy can be evicted.
      if (this.rejectionTracker.has(req.entityId, req.chunkKey)) {
        continue;
      }
      if (this.refusedThisPlan.has(key)) continue;

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
        // attach itself is below the clock floor, so it is counted per tick;
        // the one fetch keeps the one row.
        traceRecorder.countPhase(CountedPhaseIndex.CoalesceAttach);
        this.rememberInFlightChunk(key, req, { ...this.currentEpochs });
        continue;
      }

      // Permanent failures stay excluded until reset or cancelDataset.
      // Transient and pending records self-heal, and the reconcile timer is
      // armed for the earliest one so the view need not plan again.
      const failure = this.excludingFailure(key);
      if (failure) {
        nextRetryAt = Math.min(nextRetryAt, failure.eligibleAt);
        continue;
      }

      // The minimap and coarse lanes can demand the same chunk (shared
      // residency tier + key); one fetch serves both. The first occurrence
      // keeps the queue slot, and plans arrive priority-sorted, so it is the
      // most urgent.
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
    // enqueues no chunks has no row to attribute, and would otherwise close a
    // plan pass that a tick opened long ago and publish the gap between them
    // as plan time.
    if (pendingChunks.length > 0) traceRecorder.notePlanEnqueue(enqueueNow);
    this.chunkScheduler.enqueue(
      orderChunkRequestsForTierAllocation(pendingChunks, pendingTiers),
      enqueueNow,
    );

    this.drainScheduler();
    this.armReconcile(nextRetryAt);
  }

  /**
   * Drive the wanted set toward resident without a new plan. Every wanted
   * chunk that is not resident, in flight, rejected, or waiting out a backoff
   * is queued again, and the timer is re-armed for the earliest backoff still
   * running. A static view plans once, so this is what asks again for a chunk
   * that was answered pending or failed.
   *
   * It runs only from the timer, which is armed only while there is such a
   * chunk to wait for, so a settled cache never wakes itself.
   */
  private reconcile(): void {
    // Its own plan pass: a row it queues would otherwise date its plan phase
    // from the last tick's pass and charge the whole wait to planning.
    traceRecorder.markPlanStart();
    const now = this.now();
    this.lastReconcileAt = now;
    let nextRetryAt = Infinity;
    const pending: ChunkRequest[] = [];
    const tiers: ResidencyTier[] = [];
    const seen = new Set<string>();
    for (const requests of this.wantedRequests) {
      for (const req of requests) {
        const key = chunkSchedulerKey(req, req.tier);
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.rejectionTracker.has(req.entityId, req.chunkKey)) continue;
        if (this.refusedThisPlan.has(key)) continue;
        if (this.lookupCachedEntry(req) || this.chunkScheduler.hasInFlight(key)) continue;
        const failure = this.excludingFailure(key, now);
        if (failure) {
          nextRetryAt = Math.min(nextRetryAt, failure.eligibleAt);
          continue;
        }
        pending.push(req);
        tiers.push(req.tier);
      }
    }
    if (pending.length > 0) {
      const enqueueNow = performance.now();
      traceRecorder.notePlanEnqueue(enqueueNow);
      // Replacing the queue drops nothing: whatever it held is wanted, absent
      // and not in flight, so it is in `pending` too, in the same order.
      this.chunkScheduler.enqueue(orderChunkRequestsForTierAllocation(pending, tiers), enqueueNow);
      this.drainScheduler();
      this.notifyListeners();
    }
    this.armReconcile(nextRetryAt);
  }

  /** Wake {@link reconcile} at `at` on the `now()` clock, unless it already wakes sooner. */
  private armReconcile(at: number): void {
    if (!(at < this.reconcileAt)) return;
    this.disarmReconcile();
    this.reconcileAt = at;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcileAt = Infinity;
      this.reconcile();
    }, Math.max(0, Math.ceil(at - this.now())));
  }

  private disarmReconcile(): void {
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    this.reconcileAt = Infinity;
  }

  /**
   * Generated chunks whose status the server published. A record for one
   * that settled, pending or failed, no longer says what a request would get,
   * so it clears and the chunk is asked for again without waiting out its
   * backoff. The server's answer to a request and its update for the same
   * chunk travel separately, so an update can overtake a pending answer still
   * on its way; the fetch it overtook is marked so that answer is not believed.
   */
  noteGeneratedAvailability(
    datasetId: string,
    chunks: readonly WireGeneratedChunkStatusUpdate[],
  ): void {
    const settled = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.status !== "pending") settled.add(`${datasetId}/${chunk.image_id}/${chunk.key}`);
    }
    if (settled.size === 0) return;
    for (const [key, { request }] of this.chunkScheduler.inFlightEntries()) {
      if (settled.has(`${request.datasetId}/${request.imageId}/${request.chunkKey}`)) {
        this.settledWhileInFlight.add(key);
      }
    }
    if (this.permanentFailures.size + this.transientFailures.size === 0) return;
    let freedWanted = false;
    for (const store of [this.permanentFailures, this.transientFailures]) {
      for (const [key, record] of store) {
        if (!settled.has(record.chunk)) continue;
        store.delete(key);
        freedWanted ||= this.isWanted(key);
      }
    }
    if (freedWanted) this.armReconcileForAvailability();
  }

  private armReconcileForAvailability(): void {
    this.armReconcile(Math.max(this.now(), this.lastReconcileAt + AVAILABILITY_RECONCILE_INTERVAL_MS));
  }

  private isWanted(key: string): boolean {
    return this.desiredDetailKeysThisTick.has(key) || this.desiredCoarseKeysThisTick.has(key);
  }

  /**
   * In-flight chunk keys whose entity is in `activeEntityIds`. Bounded by
   * the concurrency cap, so building it is cheap however large the wanted
   * set is.
   */
  private activeInFlightChunkKeys(activeEntityIds: Set<string>): Set<string> {
    const keys = new Set<string>();
    if (activeEntityIds.size === 0) return keys;
    for (const [key, entry] of this.chunkScheduler.inFlightEntries()) {
      if (activeEntityIds.has(entry.request.entityId)) keys.add(key);
    }
    return keys;
  }

  /**
   * Abort a still-active entity's in-flight chunks that its newest plan no
   * longer wants, so they release their concurrency slots now instead of at
   * the transfer timeout. `submit` runs once per dataset with that dataset's
   * complete request set, so for an entity in this submit's active set the
   * plan is authoritative. Entities outside it may belong to a dataset
   * submitted separately this rebuild; {@link onPlanRebuildStart} handles
   * entities that left the view.
   *
   * Only in-flight work is cancelled. `submit` replaces the pending queue
   * wholesale right after, so filtering it would change nothing.
   */
  private cancelOmittedChunkWork(unwantedInFlightKeys: Set<string>): void {
    if (unwantedInFlightKeys.size === 0) return;
    const cancelled = this.chunkScheduler.cancelInFlightWhere(
      (_entry, key) => unwantedInFlightKeys.has(key),
    );
    for (const key of cancelled) {
      this.forgetCancelledChunk(key);
    }
  }

  /**
   * Abort every in-flight and pending chunk fetch for an entity that left
   * the view, handing its concurrency and bytes slots back to the current
   * view instead of holding them until the transfer timeout. A returning
   * entity re-enqueues on its next submit.
   */
  private cancelChunkWorkForEntity(entityId: string): void {
    const cancelled = this.chunkScheduler.cancelWhere(
      (entry) => entry.request.entityId === entityId,
    );
    for (const key of cancelled) {
      this.forgetCancelledChunk(key);
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

    this.chunkStore.cancelDataset(entityIds);
    this.overviewStore.cancelDataset(entityIds);

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
        if (key.startsWith(prefix)) this.forgetCancelledChunk(key);
      }
      this.activeEntityIds.delete(entityId);
      this.activeEntityIdsThisRebuild.delete(entityId);
      this.targetLevelByEntity.delete(entityId);
      this.deliveryState.clearChunksForImage(entityId);
    }
    // A reconcile due before the next plan must not fetch for a dataset
    // that is gone.
    this.wantedRequests = this.wantedRequests.map(
      (requests) => requests.filter((req) => req.datasetId !== datasetId),
    );
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
      this.forgetCancelledChunk(key);
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
        // in-flight fetches so they release their concurrency slots to the
        // current view immediately, rather than holding them until the
        // transfer timeout. Its already-cached chunks are only demoted
        // (kept, evictable); if it returns, its next submit re-enqueues.
        this.cancelChunkWorkForEntity(entityId);
      }
    }
    this.activeEntityIds = this.activeEntityIdsThisRebuild;
    this.activeEntityIdsThisRebuild = new Set();
    this.currentSubmitTick++;
    this.desiredDetailKeysThisTick.clear();
    this.desiredCoarseKeysThisTick.clear();
    this.viewCoarseKeysThisTick.clear();
    this.rejectionTracker.clear();
    // The submits that follow carry the new wanted set and re-arm for it.
    this.wantedRequests = [];
    this.refusedThisPlan.clear();
    this.retriedThisPlan.clear();
    this.plansAdmitted = false;
    this.shortfallThisPlan = { detail: 0, coarse: 0 };
    this.coarseLoanThisPlan = 0;
    this.disarmReconcile();
  }

  *getDeliverable(): Iterable<ReadyChunkDelivery> {
    const candidates: ReadyChunkDelivery[] = [];

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

    candidates.sort(compareDeliveries);
    yield* candidates;
  }

  markSent(delivery: ReadyChunkDelivery): void {
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
  }

  /** The render worker wrote these chunks, or already held them. */
  markChunksHeld(imageId: string, c: number, tier: ResidencyTier, keys: readonly string[]): void {
    for (const key of keys) this.deliveryState.markChunkHeld(imageId, c, key, tier);
  }

  /**
   * The render worker did not place these chunks. `reason` is its own
   * account, forwarded so the trace names the refusal as the renderer did.
   * `atlas-policy` means the pool is full of nearer wanted chunks, so the
   * chunk is not asked for again until the next plan.
   */
  markChunksRefused(
    imageId: string,
    c: number,
    tier: ResidencyTier,
    keys: readonly string[],
    reason: ChunkFeedbackReason,
  ): void {
    for (const key of keys) {
      this.deliveryState.markChunkRefused(imageId, c, key, tier);
      const entry =
        this.chunkStore.findByImageChunk(imageId, c, key) ??
        this.overviewStore.findByImageChunk(imageId, c, key);
      if (reason === "atlas-policy") {
        this.markRejected(entry?.entityId ?? imageId, key);
      } else if (entry) {
        traceRecorder.recordPointEvent(PointEvent.Rejection, reason, entry, eventTier(entry));
      }
    }
  }

  /**
   * The render worker stopped holding these chunks. Only an eviction is
   * recorded: a freed pool or a re-cut plane is the view changing, not
   * pressure, and would put one event per chunk in the trace on every switch.
   */
  markChunksLost(
    imageId: string,
    c: number,
    tier: ResidencyTier,
    keys: readonly string[],
    reason: ChunkFeedbackReason,
  ): void {
    for (const key of keys) {
      this.deliveryState.markChunkLost(imageId, c, key, tier);
      if (reason !== "evicted") continue;
      const entry =
        this.chunkStore.findByImageChunk(imageId, c, key) ??
        this.overviewStore.findByImageChunk(imageId, c, key);
      if (entry) {
        traceRecorder.recordPointEvent(PointEvent.Eviction, reason, entry, eventTier(entry));
      }
    }
  }

  /**
   * The render worker's wanted set lists a chunk as not held. Returns
   * whether the residency mirror held it: a disagreement between the two
   * records, after which the chunk may be sent again.
   */
  markChunkMissing(
    imageId: string,
    c: number,
    chunkKey: string,
    tier: ResidencyTier,
  ): boolean {
    return this.deliveryState.markChunkMissing(imageId, c, chunkKey, tier);
  }

  /**
   * The renderer replaced its GPU device and holds nothing, so every chunk
   * is eligible to send again, the ones it refused included.
   */
  forgetDelivered(): void {
    this.deliveryState.reset();
    this.rejectionTracker.clear();
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
   * per-tick aggregates. Not {@link snapshot}, which allocates a Set per
   * entity and is too costly to run every tick. Both stores keep level
   * counts incrementally, and the in-flight map holds a few dozen fetches.
   *
   * Counts every resident chunk, not only the active set's, so the aggregate
   * does not understate what the cache holds.
   *
   * Returns reused arrays, valid until the next call: recording runs every
   * tick and must not allocate.
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
   * Every byte the CPU cache holds, across both stores. Separate from
   * {@link telemetry} because the trace samples this per planning pass and
   * `telemetry()` builds a whole report — including a materialised deliverable
   * list — to answer it.
   */
  residentBytes(): number {
    return this.chunkStore.bytes + this.overviewStore.bytes;
  }

  /**
   * Resident bytes against budget for each CPU-side pool. As cheap as
   * {@link residentBytes}, and separate from {@link telemetry} for the same
   * reason: the HUD reads this at its own cadence, and `telemetry()` builds
   * a whole report to answer it.
   */
  poolResidency(): PoolResidencyReport {
    return {
      main: { bytes: this.chunkStore.bytes, budgetBytes: this.chunkStore.budgetBytes },
      overview: { bytes: this.overviewStore.bytes, budgetBytes: this.overviewStore.budgetBytes },
    };
  }

  /**
   * What is in flight and what is queued, by lane, written into `out`.
   *
   * In flight is bounded by the concurrency cap, so it is always counted.
   * Pending is scanned under the same cap as {@link settleInputs}, and
   * past it the per-lane counts stay at zero while `pendingUnclassified`
   * says so, so a reader shows the total and states that the split is
   * unknown rather than paying for a backlog tens of thousands deep.
   */
  laneOutstanding(out: LaneOutstanding): LaneOutstanding {
    for (const lane of LANES) {
      out.inFlight[lane] = 0;
      out.pending[lane] = 0;
    }
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      out.inFlight[entry.request.lane]++;
    }
    out.pendingTotal = this.chunkScheduler.pendingSize;
    out.pendingScanCap = QUIESCENCE_PENDING_SCAN_CAP;
    out.pendingUnclassified = !this.chunkScheduler.forEachPending(
      QUIESCENCE_PENDING_SCAN_CAP,
      (req) => {
        out.pending[req.lane]++;
      },
    );
    return out;
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

    return {
      mainBytes: this.chunkStore.bytes,
      mainBudget: this.config.mainBudgetBytes,
      overviewBytes: this.overviewStore.bytes,
      overviewBudget: this.config.overviewBudgetBytes,
      inFlightCount: this.chunkScheduler.inFlightSize,
      inFlightBytes: this.chunkScheduler.inFlightBytes,
      pendingCount: this.chunkScheduler.pendingSize,
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
   * The cache's half of the quiescence predicate: everything the
   * view asked for is resident, with nothing pending or in flight. Writes
   * into `out` so the per-tick call does not allocate.
   *
   * Speculative prefetch is excluded from `pending` and `inFlight`, because
   * the prefetch lane keeps requesting future timepoints and a plain "queues
   * empty" test might never go true on a timeseries. It is reported beside
   * them. Demand counts stay prefetch-inclusive: resident and desired must be
   * counted the same way, and prefetch demand is finite per timepoint.
   *
   * `pendingUnclassified` is set when the queue is deeper than
   * {@link QUIESCENCE_PENDING_SCAN_CAP}. That reads as not quiescent, so a
   * deep queue keeps a run open instead of closing it on a guess.
   *
   * With nothing queued or in flight and demand still unmet, it also says
   * why each missing chunk is missing, which decides whether the view has
   * settled covering less or is waiting on something.
   */
  settleInputs(out: CacheSettleInputs): CacheSettleInputs {
    const demand = this.computeTierDemandTelemetry();

    let inFlight = 0;
    let speculativeInFlight = 0;
    for (const [, entry] of this.chunkScheduler.inFlightEntries()) {
      if (entry.request.lane === "prefetch") speculativeInFlight++;
      else inFlight++;
    }

    const speculativePending = this.chunkScheduler.countPending(
      req => req.lane === "prefetch",
      QUIESCENCE_PENDING_SCAN_CAP,
    );

    // The shortfall admission declared is wanted too, and never resident.
    const shortfall = this.shortfallThisPlan;
    out.desiredDetailChunks = demand.desired.detailChunks + shortfall.detail;
    out.residentDetailChunks = demand.resident.detailChunks;
    out.desiredCoarseChunks = demand.desired.coarseChunks + shortfall.coarse;
    out.residentCoarseChunks = demand.resident.coarseChunks;
    // The whole store against the budget eviction enforces, not the
    // wanted-and-resident subset above: a tier is full when everything it
    // holds fills it, whether or not the current plan asked for all of it.
    out.detailBytes = this.chunkStore.bytes;
    out.detailBudgetBytes = this.chunkStore.budgetBytes;
    out.coarseBytes = this.overviewStore.bytes;
    out.coarseBudgetBytes = this.overviewStore.budgetBytes;
    out.inFlight = inFlight;
    out.speculativeInFlight = speculativeInFlight;
    out.speculativePending = speculativePending ?? 0;
    out.pendingUnclassified = speculativePending === null;
    out.pending = this.chunkScheduler.pendingSize - (speculativePending ?? 0);
    out.failedDetailChunks = 0;
    out.failedCoarseChunks = 0;
    this.forEachFailedWantedKey((key) => {
      if (this.desiredDetailKeysThisTick.has(key)) out.failedDetailChunks++;
      else out.failedCoarseChunks++;
    });

    out.uploadsUnanswered = this.deliveryState.chunksUnanswered;
    out.shortDetailChunks = shortfall.detail;
    out.shortCoarseChunks = shortfall.coarse;
    out.serverPendingChunks = 0;
    out.retryingChunks = 0;
    out.unrequestedChunks = 0;
    const unmet =
      demand.resident.detailChunks < demand.desired.detailChunks ||
      demand.resident.coarseChunks < demand.desired.coarseChunks;
    if (unmet && out.pending === 0 && out.inFlight === 0 && !out.pendingUnclassified) {
      this.countMissing(out, {
        detail: tierFull(demand.resident.detailBytes, demand.resident.detailChunks, this.chunkStore.budgetBytes),
        coarse: tierFull(demand.resident.coarseBytes, demand.resident.coarseChunks, this.overviewStore.budgetBytes),
      });
    }
    return out;
  }

  /**
   * Sort each wanted chunk that is not resident by what it waits on. Walks
   * the wanted set, so {@link settleInputs} asks only while nothing is
   * queued or in flight, the one moment the answer can settle or stall the
   * view.
   *
   * A chunk the renderer refused for want of a slot is short of room too,
   * on the GPU rather than here.
   */
  private countMissing(out: CacheSettleInputs, full: Record<ResidencyTier, boolean>): void {
    const seen = new Set<string>();
    const short = (tier: ResidencyTier): void => {
      if (tier === "detail") out.shortDetailChunks++;
      else out.shortCoarseChunks++;
    };
    for (const requests of this.wantedRequests) {
      for (const req of requests) {
        const key = chunkSchedulerKey(req, req.tier);
        if (seen.has(key)) continue;
        seen.add(key);
        // Resident as the demand counts reckon it: held, and seen by this plan.
        const entry = this.lookupCachedEntry(req);
        if (entry && entry.lastSeenTick === this.currentSubmitTick) continue;
        if (this.rejectionTracker.has(req.entityId, req.chunkKey) || this.refusedThisPlan.has(key)) {
          short(req.tier);
          continue;
        }
        if (entry || this.chunkScheduler.hasInFlight(key)) continue;
        const record = this.getFailureRecord(key);
        // A permanent failure is counted with the failed chunks above.
        if (record?.kind === "permanent") continue;
        if (record?.kind === "pending") out.serverPendingChunks++;
        else if (record) out.retryingChunks++;
        else if (full[req.tier]) short(req.tier);
        else out.unrequestedChunks++;
      }
    }
  }

  /**
   * The wanted chunks the source failed for good, with the reason it gave
   * when it gave one. They are not asked for again until the dataset is
   * reopened, so the view settles without them.
   */
  failedWantedChunks(): Array<{ chunk: string; failure: ChunkFailureKind | null }> {
    const out: Array<{ chunk: string; failure: ChunkFailureKind | null }> = [];
    this.forEachFailedWantedKey((_key, record) => {
      out.push({ chunk: record.chunk, failure: record.failure });
    });
    return out;
  }

  /**
   * Visit each wanted key with a permanent failure record, walking whichever
   * of the two sets is smaller: both are bounded, but this runs every tick.
   */
  private forEachFailedWantedKey(visit: (key: string, record: FailureRecord) => void): void {
    const wanted = this.desiredDetailKeysThisTick.size + this.desiredCoarseKeysThisTick.size;
    if (this.permanentFailures.size <= wanted) {
      for (const [key, record] of this.permanentFailures) {
        if (this.isWanted(key)) visit(key, record);
      }
      return;
    }
    for (const keys of [this.desiredDetailKeysThisTick, this.desiredCoarseKeysThisTick]) {
      for (const key of keys) {
        const record = this.permanentFailures.get(key);
        if (record) visit(key, record);
      }
    }
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

  /** Searches detail then overview. */
  getCachedChunk(entityId: string, chunkKey: string): ReadyChunkDelivery | null {
    const entry =
      this.chunkStore.get(entityId, chunkKey) ??
      this.overviewStore.get(entityId, chunkKey);
    return entry ? this.chunkEntryToDelivery(entry) : null;
  }

  /**
   * A resident chunk's samples from either tier, without the delivery copy
   * {@link getCachedChunk} makes. Auto-contrast checks every chunk it reads
   * on each tick until they are all resident.
   */
  cachedSamples(entityId: string, chunkKey: string): { data: ArrayBuffer; dataType: string } | undefined {
    return this.chunkStore.get(entityId, chunkKey) ?? this.overviewStore.get(entityId, chunkKey);
  }

  /** Searches detail then overview; null when neither has the chunk. */
  getCachedChunkTier(entityId: string, chunkKey: string): EvictionTier | null {
    const entry =
      this.chunkStore.get(entityId, chunkKey) ??
      this.overviewStore.get(entityId, chunkKey);
    return entry?.tier ?? null;
  }

  /**
   * Whether the store a request's lane fills holds its chunk. One key can be
   * resident in either tier alone, so {@link getCachedChunk} cannot answer this.
   */
  holds(req: ChunkRequest): boolean {
    return this.lookupCachedEntry(req) !== undefined;
  }

  getPendingSnapshot(): readonly ChunkRequest[] {
    return this.chunkScheduler.pendingSnapshot();
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

    this.activeEntityIds.clear();
    this.activeEntityIdsThisRebuild.clear();
    this.targetLevelByEntity.clear();
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
    this.wantedRequests = [];
    this.disarmReconcile();
    this.lastReconcileAt = -Infinity;
    this.settledWhileInFlight.clear();
    this.lruCounter = 0;
    this.currentSubmitTick = 0;
    this.chunkStore.setBudgetBytes(this.config.mainBudgetBytes);
    this.overviewStore.setBudgetBytes(this.config.overviewBudgetBytes);

    this.listeners = [];

    // BurstLoggers are clock-relative; no explicit reset needed.
    this.counters.reset();
  }

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
    // next attempt opens a fresh one rather than overwriting its timings.
    //
    // The row opens at dispatch, when `plan` and `queue` are already over, so
    // one call closes both and starts `wire`. This runs thousands of times in
    // one submit, and three calls would triple the event count the
    // recorder's tick budget allows.
    const rowTier = req.tier === "coarse" ? 1 : 0;
    const traceRow = traceRecorder.beginChunkRow(req, rowTier, admittedAtMs);

    let result: FetchResult;
    try {
      result = await this.source.fetch(
        { datasetId: req.datasetId, imageId: req.imageId, chunkKey: req.chunkKey },
        controller.signal,
        // The transport's label for this chunk. When this fetch coalesced onto
        // one already in flight it is the first sender's, so every row that
        // waited on a request points at that request.
        label => traceRecorder.labelRow(traceRow, label),
      );
    } catch (err: unknown) {
      traceRecorder.finishRow(traceRow, RowOutcome.Retired);
      const fe = classifyFetchError(err);

      if (fe.kind === "abort") {
        // A silent teardown: the caller cancelled. Release only what this
        // settle still owns (see {@link settleFetch}).
        this.settleFetch(key, controller);
        return;
      }
      if (fe.kind === "pending") {
        // Generated bytes not made yet. Not a failure, so no streak and no
        // failure counters, but a record all the same: the chunk waits for an
        // availability update naming it, or its backoff, rather than being
        // asked for on every plan or never again. An update that already
        // overtook this answer has nothing left to wait for.
        const overtaken = this.settledWhileInFlight.has(key);
        if (this.settleFetch(key, controller)) {
          if (!overtaken) {
            this.recordFailure(key, "pending", req);
          } else {
            if (this.isWanted(key)) this.armReconcileForAvailability();
            this.notifyListeners();
          }
          this.drainScheduler();
        }
        return;
      }

      // Whether this fetch lifecycle has already fed the failure streak. The
      // recursion carries it across in-fetch retries, so one failed delivery
      // counts once. A re-plan re-fetch is a fresh lifecycle and counts
      // again, so a persistently dead source stays surfaced.
      let fed = fedStreak;

      // A server-reported failure (a `source_chunk_status` frame) feeds the
      // streak before the retry branch, whatever its retry classification, so
      // a source whose failures are each transient still surfaces.
      if (fe.serverReported && !fed) {
        this.recordChunkFailureForStreak(fe.message);
        fed = true;
      }

      if (this.chunkRetryPolicy.shouldRetry(fe, retryCount)) {
        traceRecorder.recordPointEvent(PointEvent.Retry, fe.failure ?? fe.kind, req, rowTier);
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
      if (this.settleFetch(key, controller)) {
        this.recordFailure(key, isPermanent ? "permanent" : "transient", req, fe.failure);
        this.counters.recordFetchFailure(isPermanent, fe.message);
        this.recordFailureForBurstDetection(isPermanent, fe.message);
        traceRecorder.recordPointEvent(PointEvent.Failure, fe.failure ?? fe.kind, req, rowTier);
      }
      return;
    }

    // Closes `wire` and opens `decode` — adjacent phases share the slot
    // between them — and records what the wire delivered. The pool closes
    // `decode` on its own onmessage, and the row completes when a frame has
    // drawn the chunk.
    traceRecorder.noteBytesReceived(traceRow, result.bytes.byteLength);

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
      if (this.settleFetch(key, controller)) {
        if (!fedStreak) {
          this.recordChunkFailureForStreak(streakMessage);
        }
        this.recordFailure(key, "transient", req);
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

    // Only a delivered chunk, fetched and decoded, proves the source is
    // serving usable data; a completed fetch alone can still be garbage. When
    // this settle still owns the key, the streak resets and the key's failure
    // record clears so its attempt/backoff bookkeeping starts clean; a
    // superseded settle leaves the successor's slot, metadata, and failure
    // state untouched.
    if (this.settleFetch(key, controller)) {
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

    // Coarse-tier lanes share the overview store.
    if (lane === "overview" || lane === "minimap" || lane === "coarse") {
      if (stale && this.overviewStore.bytes + cacheEntry.sizeBytes > this.overviewStore.budgetBytes) {
        // Decoded and then dropped on the floor: the row ends here, and
        // saying so is the difference between a chunk that stalled and one
        // that was never going to arrive.
        traceRecorder.finishRow(traceRow, RowOutcome.Retired);
        this.drainScheduler();
        return;
      }
      if (!this.overviewStore.insert(cacheEntry)) {
        this.refuseArrival(key, traceRow);
        return;
      }
    } else {
      if (stale && this.chunkStore.bytes + cacheEntry.sizeBytes > this.chunkStore.budgetBytes) {
        traceRecorder.finishRow(traceRow, RowOutcome.Retired);
        this.drainScheduler();
        return;
      }
      if (!this.chunkStore.insert(cacheEntry)) {
        this.refuseArrival(key, traceRow);
        return;
      }
    }
    // Cache admission: the moment decoded bytes become resident. Counted, not
    // timed — the insert is well under the platform's clock floor.
    traceRecorder.countPhase(CountedPhaseIndex.CacheAdmission);

    this.notifyListeners();

    this.drainScheduler();
  }

  private drainScheduler(): void {
    this.chunkScheduler.drain(() => this.counters.averageDecodedBytes());
  }

  private applyElasticTierBudgets(): void {
    const detailDemand = this.desiredDetailKeysThisTick.size > 0;
    const coarseDemand = this.desiredCoarseKeysThisTick.size > 0;
    const loan = Math.min(this.coarseLoanThisPlan, this.config.mainBudgetBytes);
    const protectedDetail = this.config.mainBudgetBytes - loan;
    const protectedCoarse = this.config.overviewBudgetBytes + loan;

    let detailBudget = protectedDetail;
    let coarseBudget = protectedCoarse;

    if (detailDemand && !coarseDemand) {
      detailBudget += Math.max(0, protectedCoarse - this.overviewStore.bytes);
    } else if (coarseDemand && !detailDemand && loan === 0) {
      coarseBudget += Math.max(0, protectedDetail - this.chunkStore.bytes);
    }

    this.chunkStore.setBudgetBytes(detailBudget);
    this.overviewStore.setBudgetBytes(coarseBudget);
  }

  /**
   * The room the budgets give each tier before any plan takes it: what
   * capacity-aware admission admits a plan against.
   */
  tierCapacity(): Record<ResidencyTier, number> {
    return { detail: this.config.mainBudgetBytes, coarse: this.config.overviewBudgetBytes };
  }

  /** An arrival its store refused: the row ends, and the plan stops asking for it. */
  private refuseArrival(key: string, traceRow: number): void {
    this.refusedThisPlan.add(key);
    traceRecorder.finishRow(traceRow, RowOutcome.Retired);
    this.drainScheduler();
  }

  /**
   * A chunk the plan still wants left its store. Ask for it again, as the
   * reconcile asks for any wanted chunk that is missing: admission keeps the
   * wanted set within the budgets, so it comes back without displacing
   * another chunk the plan wants.
   */
  private noteEvicted(entry: CacheEntry): void {
    if (!this.plansAdmitted || entry.lastSeenTick !== this.currentSubmitTick) return;
    if (entry.lane === "prefetch") return;
    const key = chunkSchedulerKey(entry, entry.residencyTier);
    // A second eviction in one plan means the budgets hold less than
    // admission reckoned, so the chunk is short rather than asked for again.
    if (this.retriedThisPlan.has(key)) {
      this.refusedThisPlan.add(key);
      return;
    }
    this.retriedThisPlan.add(key);
    this.armReconcileForAvailability();
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

  /** Drop what the cache keeps beside a chunk fetch it cancelled. */
  private forgetCancelledChunk(key: string): void {
    this.inFlightChunkMeta.delete(key);
    this.settledWhileInFlight.delete(key);
  }

  /**
   * Release the scheduler slot and in-flight metadata for a completion, but
   * only when the settling controller still owns the key. Every completion
   * exit routes through here, so a settle that arrives after its key was
   * cancelled and re-enqueued (a tile scrubbed away and straight back) frees
   * nothing and cannot start a duplicate fetch. Returns whether this settle
   * owned the key; callers gate per-key bookkeeping on it.
   */
  private settleFetch(key: string, controller: AbortController): boolean {
    if (!this.chunkScheduler.markInFlightDoneIfCurrent(key, controller)) return false;
    this.inFlightChunkMeta.delete(key);
    this.settledWhileInFlight.delete(key);
    return true;
  }

  /** The failure record for `key`, from whichever store holds it (a key
   *  lives in at most one). */
  private getFailureRecord(key: string): FailureRecord | undefined {
    return this.permanentFailures.get(key) ?? this.transientFailures.get(key);
  }

  /** The record excluding `key` from fetching, if any: a permanent record
   *  (never time-eligible), or a transient or pending one still inside its
   *  backoff window. */
  private excludingFailure(key: string, now?: number): FailureRecord | undefined {
    const record = this.getFailureRecord(key);
    if (record === undefined) return undefined;
    return (now ?? this.now()) < record.eligibleAt ? record : undefined;
  }

  /**
   * Record an unsuccessful settle for `key` in the matching store, and wake
   * the page so it publishes the settle. A key can flip kind between
   * records, so it is cleared from both first. A transient or pending record
   * grows its attempt count from the prior one, which lengthens the capped
   * backoff, and arms the reconcile timer while the chunk is still wanted.
   * Each store is FIFO-capped independently, so a flood of permanents cannot
   * evict a transient's backoff.
   */
  private recordFailure(
    key: string,
    kind: FailureRecord["kind"],
    req: ChunkRequest,
    failure: ChunkFailureKind | null = null,
  ): void {
    const chunk = `${req.datasetId}/${req.imageId}/${req.chunkKey}`;
    if (kind === "permanent") {
      this.transientFailures.delete(key);
      // Delete-then-set refreshes FIFO recency, so a re-reported permanent
      // is not the first to be dropped under cap pressure.
      this.permanentFailures.delete(key);
      this.permanentFailures.set(key, {
        kind,
        failure,
        chunk,
        failedAt: this.now(),
        attempt: 0,
        eligibleAt: Infinity,
      });
      this.evictOldestWhileOverCap(this.permanentFailures);
      this.notifyListeners();
      return;
    }

    const prev = this.transientFailures.get(key);
    const failedAt = this.now();
    const attempt = (prev?.attempt ?? 0) + 1;
    const eligibleAt = failedAt + this.backoffMs(attempt, kind);

    this.permanentFailures.delete(key);
    // Delete-then-set keeps Map iteration order == insertion recency, so
    // FIFO eviction drops the genuinely oldest transient.
    this.transientFailures.delete(key);
    this.transientFailures.set(key, {
      kind,
      failure,
      chunk,
      failedAt,
      attempt,
      eligibleAt,
    });
    this.evictOldestWhileOverCap(this.transientFailures);
    if (this.isWanted(key)) this.armReconcile(eligibleAt);
    this.notifyListeners();
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
   * Backoff for a transient or pending record's `attempt`-th record
   * (1-based), with jitter from the injected `random()` (see
   * {@link backoffWithJitter}).
   */
  private backoffMs(attempt: number, kind: "transient" | "pending"): number {
    const base = kind === "pending" ? PENDING_BACKOFF_BASE_MS : FAILURE_BACKOFF_BASE_MS;
    return backoffWithJitter(attempt, this.random, base);
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
   * Count a streak-eligible delivery failure and notify the owner once the
   * streak crosses the threshold, throttled while it persists. The caller
   * feeds each failed delivery once per fetch lifecycle (see
   * {@link CpuCache.fetchAndDecode}). Individual misses stay quiet, but a
   * source that fails everything, such as lost credentials or a backend that
   * stays down, must not look like a silently stalled canvas.
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

  /** A chunk was delivered (fetched and decoded): the streak breaks and a
   *  surfaced signal is retired via `onChunkFailureRecovered`. The notify
   *  throttle re-arms, so a new streak after recovery may notify at once. */
  private recordChunkDelivered(): void {
    this.chunkFailureStreak = 0;
    if (!this.chunkFailureSurfaced) return;
    this.chunkFailureSurfaced = false;
    this.lastChunkFailureNotifyAt = -Infinity;
    this.config.onChunkFailureRecovered?.();
  }

  private chunkEntryToDelivery(entry: CacheEntry): ReadyChunkDelivery {
    return {
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


  private lookupCachedEntry(req: ChunkRequest): CacheEntry | undefined {
    // minimap/overview/coarse share the overview/coarse cache.
    const usesOverviewCache =
      req.lane === "overview" || req.lane === "minimap" || req.lane === "coarse";
    const store = usesOverviewCache ? this.overviewStore : this.chunkStore;
    return store.get(req.entityId, req.chunkKey);
  }

  /**
   * Lane a chunk entry should carry given all of this tick's demand. Minimap
   * and coarse share a tier and dedup key, so one fetch serves both, but
   * {@link getDeliverable} only hands `"coarse"` entries to the view. If the
   * view's coarse lane wanted the chunk this tick it is relabelled coarse;
   * otherwise idle fill stalls until a rebuild relabels it. Chunks only the
   * minimap wanted keep their lane.
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
function chunkSchedulerKey(req: Pick<ChunkRequest, "entityId" | "chunkKey">, tier: ResidencyTier): string {
  return `${req.entityId}/${tier}/${req.chunkKey}`;
}

/**
 * Interleave detail and coarse requests so neither tier exhausts the fetch
 * slots before the other gets any. The two caches have separate budgets, and
 * a priority-sorted run of one tier would otherwise fill the queue head.
 * `tiers[i]` is the residency tier of `requests[i]`, precomputed by
 * {@link CpuCache.submit}.
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

/**
 * Whether the chunks a tier holds for the view leave no room for one more of
 * their size. Counted over the wanted chunks rather than the whole store,
 * because a chunk the view no longer wants gives its room up to one it does.
 */
function tierFull(wantedBytes: number, wantedChunks: number, budgetBytes: number): boolean {
  if (wantedChunks === 0) return budgetBytes <= 0;
  return wantedBytes + wantedBytes / wantedChunks > budgetBytes;
}

function isEpochStale(deliveryEpochs: SceneEpochs, currentEpochs: SceneEpochs): boolean {
  return (
    deliveryEpochs.selection < currentEpochs.selection ||
    deliveryEpochs.content < currentEpochs.content
  );
}
