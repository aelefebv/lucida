/**
 * Shared types for the fetch/decode subsystem.
 *
 * Lives separately from `cpuCache.ts` so the per-cache stores
 * (`chunkStore.ts`, `proxyStore.ts`), the eviction policies
 * (`eviction.ts`), and the telemetry counters (`telemetry.ts`) can
 * import the cache-shape types without back-pointing to the
 * coordinator. The barrel (`index.ts`) re-exports the public-surface
 * types from here as well.
 *
 * Pure type definitions: no runtime, no class. The `CpuCacheConfig`
 * defaults live in `cpuCache.ts` next to the constants they use.
 */

import type { SceneEpochs } from "../epochs.ts";
import type { ProxyHeaderJs } from "./contentSource.ts";
import type { InteractionMode } from "./interactionMode.ts";

export interface CpuCacheConfig {
  mainBudgetBytes: number;
  overviewBudgetBytes: number;
  /**
   * Budget for the proxy tier in bytes. Proxies are a small middle layer
   * (between detail and overview). Eviction tier order: detail > proxy
   * > overview.
   */
  proxyBudgetBytes: number;
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
  /**
   * Invoked when chunk deliveries keep failing with no delivered (fetched
   * AND decoded) chunk in between — permanent fetch failures (e.g. access
   * revoked after a successful open) and decode failures (e.g. a source
   * answering with the wrong wire format) both count — so the owner can
   * show a user-visible signal instead of a silently stalling canvas.
   * Transient-kind fetch failures never count: they are the reconnect
   * machinery's business (see also `CpuCache.resetChunkFailureStreak`).
   * Aggregated and throttled by the cache: at most one call per notify
   * interval, and only once the consecutive-failure streak reaches its
   * threshold — healthy operation (including mixed success/failure) never
   * triggers it.
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
 * Logical lane each request travels on. `minimap` and `overview` share
 * the overview store (see ADR 0023); `detail` and `prefetch` live in
 * the main chunk store.
 */
export type ResidencyTier = "detail" | "coarse";

export type Lane = "minimap" | "detail" | "coarse" | "prefetch" | "overview";

/**
 * Eviction tier label stamped on each main-store entry. Drives the
 * tier-walk eviction order in {@link import("./eviction.ts").TieredPolicy}.
 * Overview-store entries carry `prefetch` cosmetically; the active /
 * demoted / prefetch distinctions only matter for the main store.
 */
export type EvictionTier = "prefetch" | "demoted-detail" | "active-detail";

/**
 * A delivery from the CPU cache that the orchestrator routes to the GPU
 * worker. The discriminated union covers both regular chunks
 * (`kind: "chunk"`) and proxy deliveries (`kind: "proxy"`); both
 * variants stamp the discriminator explicitly so consumers narrow
 * unambiguously.
 */
export type ReadyDelivery = ReadyChunkDelivery | ReadyProxyDelivery;

export interface ReadyChunkDelivery {
  kind: "chunk";
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
  residencyTier?: ResidencyTier;
  /** Lower numbers are delivered first when present on CpuCache output. */
  priority?: number;
}

/**
 * A delivered proxy asset. Carries the parsed header + raw u16 voxel
 * bytes. The orchestrator forwards this to the worker via
 * `client.proxyAssetData(...)`.
 */
export interface ReadyProxyDelivery {
  kind: "proxy";
  datasetId: string;
  entityId: string;
  imageId: string;
  proxyKind: "GroupProxy3D" | "TileProxy3D";
  t: number;
  c: number;
  header: ProxyHeaderJs;
  data: ArrayBuffer;
  epochs: SceneEpochs;
  /** Lower numbers are delivered first when present on CpuCache output. */
  priority?: number;
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
  residencyTier?: ResidencyTier;
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
  sparseDetail: boolean;
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
  proxy: number;
}

export interface CacheTelemetry {
  mainBytes: number;
  mainBudget: number;
  overviewBytes: number;
  overviewBudget: number;
  /** Proxy tier bytes / budget. */
  proxyBytes: number;
  proxyBudget: number;
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
  inFlightCount: number;
  inFlightBytes: number;
  /** In-flight proxy fetches (count, estimated bytes). */
  inFlightProxyCount: number;
  inFlightProxyBytes: number;
  pendingCount: number;
  pendingProxyCount: number;
  /**
   * Age (ms) of the longest-waiting entry in the chunk scheduler's
   * ADMISSION WINDOW — the bounded front of the pending queue the
   * scheduler has committed to fetching soon (ADR 0044); 0 if empty.
   *
   * This is a drain-health signal, not a time-since-first-wanted one. On
   * an oversubscribed collection the backlog behind the window can be
   * tens of thousands deep, and the honest wait for a tile at the back of
   * it is `pendingCount / fetch rate` — read those two together. Before
   * the window existed this field pinned near the age of the whole
   * session on such a collection and told you nothing.
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
    proxy: TierResidencyEntry;
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
