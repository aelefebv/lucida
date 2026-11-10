/**
 * Shared types for the fetch/decode subsystem. Kept apart from `cpuCache.ts`
 * so the stores, eviction policies, and telemetry can import cache shapes
 * without importing the coordinator. `CpuCacheConfig` defaults live in
 * `cpuCache.ts` next to the constants they use.
 */

import type { SceneEpochs } from "../epochs.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { InteractionMode } from "./interactionMode.ts";
import type { SpatialAxis } from "../../renderer/slicePlane.ts";

export interface CpuCacheConfig {
  mainBudgetBytes: number;
  overviewBudgetBytes: number;
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
  /**
   * Invoked when chunk deliveries keep failing with no fetched and decoded
   * chunk in between, so the owner can show a visible signal instead of a
   * silently stalling canvas. Permanent fetch failures and decode failures
   * count. Transient fetch failures never do: reconnect owns those. At most
   * one call per notify interval, and only once the streak reaches its
   * threshold, so mixed success and failure never triggers it.
   */
  onChunkFailureStreak?: (consecutiveFailures: number, lastError: string) => void;
  /**
   * Invoked once when a chunk is delivered after `onChunkFailureStreak`
   * has fired, so the owner can retire the visible signal — the failure
   * evidently did not persist.
   */
  onChunkFailureRecovered?: () => void;
  /**
   * Monotonic time source (milliseconds) used for the transient-failure
   * self-heal backoff. Defaults to `() => performance.now()`. Injectable
   * so the re-eligibility decision can be driven by a controlled clock.
   */
  now?: () => number;
  /**
   * Randomness source in `[0, 1)` used for backoff jitter. Defaults to
   * `Math.random`. Injectable so jitter is deterministic under test.
   */
  random?: () => number;
}

/**
 * Logical lane each request travels on. `minimap`, `coarse`, and
 * `overview` share the overview store. `detail` and
 * `prefetch` live in the main chunk store. The planner does not emit
 * `overview`; it stays for the trace's lane column and store routing.
 */
export type Lane = "minimap" | "detail" | "coarse" | "prefetch" | "overview";

/** Every lane, in the order a reader lists them: the view's own work first. */
export const LANES = ["detail", "coarse", "minimap", "prefetch", "overview"] as const satisfies readonly Lane[];

/**
 * Resident and in-flight chunk counts per pyramid level, indexed by level.
 * Sparse levels read as zero. The cache reuses one of these across calls, so
 * a reader consumes it before the next tick rather than holding onto it.
 */
export interface LevelResidency {
  cached: number[];
  inFlight: number[];
}

/**
 * Eviction tier label stamped on each main-store entry. Drives the
 * tier-walk eviction order in {@link import("./eviction.ts").TieredPolicy}.
 * Overview-store entries carry `prefetch` cosmetically; the active /
 * demoted / prefetch distinctions only matter for the main store.
 */
export type EvictionTier = "prefetch" | "demoted-detail" | "active-detail";

/** A decoded chunk the CPU cache hands the orchestrator for the GPU worker. */
export interface ReadyChunkDelivery {
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  chunkKey: string;
  data: ArrayBuffer;
  dataType: string;
  epochs: SceneEpochs;
  lane: Lane;
  residencyTier: ResidencyTier;
  /** Lower numbers are delivered first when present on CpuCache output. */
  priority?: number;
  /**
   * Handle for this chunk's trace lifecycle row, carried from the fetch that
   * produced it so the `upload` and `present` phases land on the same row as
   * `wire` and `decode`. -1 when no run was open at fetch time.
   */
  traceRow?: number;
  /**
   * The planes `data` holds, half-open along the chunk's {@link planeAxis}.
   * Absent when it holds the whole chunk.
   */
  planes?: readonly [number, number];
  /** The axis {@link planes} lie along. Absent: Z. */
  planeAxis?: SpatialAxis;
}

/**
 * Internal cache entry stored by `ChunkStore` (both main + overview).
 * Exported so the {@link import("./eviction.ts").EvictionPolicy}
 * implementations can operate on cache contents.
 */
export interface CacheEntry {
  data: ArrayBuffer;
  sizeBytes: number;
  lane: Lane;
  residencyTier: ResidencyTier;
  tier: EvictionTier;
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  chunkKey: string;
  insertedAt: number;
  epochs: SceneEpochs;
  dataType: string;
  /**
   * Priority recorded the last time this chunk appeared in a plan
   * (lower = more urgent; mirrors `ChunkRequest.priority`). Used as the
   * secondary sort key for active-detail eviction so distant chunks go
   * before focal ones. Refreshed on every `submit()` that includes the
   * chunk; can be stale for chunks not currently planned (frustum-culled,
   * out-of-LOD-range), but `lastSeenTick` handles that case.
   */
  priority: number;
  /**
   * Submit-tick counter from the last `submit()` that planned this
   * chunk. Primary sort key for active-detail eviction: chunks not
   * present in the current plan get evicted before chunks that are.
   */
  lastSeenTick: number;
  /**
   * Handle for this chunk's trace lifecycle row. Set once by the fetch that
   * produced the entry and cleared when the chunk is handed to the renderer,
   * so a chunk re-delivered after an eviction does not re-stamp a row whose
   * life is already over. -1 when no run was open at fetch time.
   */
  traceRow?: number;
  /**
   * For a chunk decoded before the view wanted it, as a prefetched one is:
   * NaN until a plan wants it, then when one first did, so its row's
   * `upload` can leave out the wait for the view. Absent for a chunk the
   * view wanted as it was decoded.
   */
  wantedAtMs?: number;
  /**
   * The planes `data` holds, half-open along the chunk's {@link planeAxis}:
   * what a request for some planes fetched. Absent when it holds the whole
   * chunk. One entry per chunk either way, so a whole chunk that arrives
   * replaces its planes.
   */
  planes?: readonly [number, number];
  /** The axis {@link planes} lie along. Absent: Z. */
  planeAxis?: SpatialAxis;
}

export interface TierResidencyEntry {
  count: number;
  bytes: number;
}

export interface TierDemandTelemetry {
  desired: {
    detailChunks: number;
    coarseChunks: number;
  };
  resident: {
    detailChunks: number;
    coarseChunks: number;
    detailBytes: number;
    coarseBytes: number;
  };
  detailCoverageRatio: number;
}

export interface TierQueueTelemetry {
  pending: number;
  inFlight: number;
  inFlightBytes: number;
}

export interface TierCounters {
  activeDetail: number;
  demotedDetail: number;
  prefetch: number;
  overview: number;
}

export interface CacheTelemetry {
  mainBytes: number;
  mainBudget: number;
  overviewBytes: number;
  overviewBudget: number;
  inFlightCount: number;
  inFlightBytes: number;
  pendingCount: number;
  /**
   * Age (ms) of the longest-waiting entry in the chunk scheduler's
   * admission window; 0 if empty. A drain-health signal, not time since
   * first wanted: the wait for a tile at the back of the backlog is
   * `pendingCount / fetch rate`.
   */
  pendingOldestAgeMs: number;
  /** Cached, wanted, unsent deliverables currently visible to upload. */
  readyCount: number;
  hitRate: number;
  evictionsPerSec: number;
  /** Eviction count per tier in the last telemetry window. Resets on each call. */
  evictionsByTier: TierCounters;
  interactionMode: InteractionMode;
  evictionTierOrder: string[];
  failedChunks: { transient: number; permanent: number };
  lastError: string | null;
  decodesPerSec: number;
  decodeWorkersTotal: number;
  avgDecodeMs: number;
  /** 50th and 95th percentile decode latency from a rolling 100-sample window. */
  decodeP50Ms: number;
  decodeP95Ms: number;
  /** Cached chunks broken down by eviction tier (count + bytes per tier). */
  tierResidency: {
    activeDetail: TierResidencyEntry;
    demotedDetail: TierResidencyEntry;
    prefetch: TierResidencyEntry;
    overview: TierResidencyEntry;
  };
  /** Current-plan wanted vs CPU-resident chunk coverage by coarse/detail tier. */
  tierDemand: TierDemandTelemetry;
  /** Queue depth split by chunk residency tier. */
  tierQueues: {
    detail: TierQueueTelemetry;
    coarse: TierQueueTelemetry;
  };
  /** Effective elastic budgets for the CPU chunk tier buckets. */
  tierBudgets: {
    detailBytes: number;
    coarseBytes: number;
  };
}

/** Resident bytes against budget for one CPU-side pool. */
export interface PoolResidency {
  bytes: number;
  /**
   * The elastic budget in force, since a pool that stopped growing stopped
   * at that and not at the configured split.
   */
  budgetBytes: number;
}

/** The two CPU-side pools, as `CpuCache.poolResidency()` reports them. */
export interface PoolResidencyReport {
  main: PoolResidency;
  overview: PoolResidency;
}

/**
 * Outstanding work by lane: what is in flight and what is queued, counted
 * per lane. Filled in place by `CpuCache.laneOutstanding()`.
 */
export interface LaneOutstanding {
  inFlight: Record<Lane, number>;
  pending: Record<Lane, number>;
  /** Every pending entry, classified or not. */
  pendingTotal: number;
  /**
   * True when the chunk queue was deeper than {@link pendingScanCap}, so the
   * per-lane pending counts are zero and only the total is known.
   */
  pendingUnclassified: boolean;
  pendingScanCap: number;
}
