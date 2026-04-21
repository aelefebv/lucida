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
  ProxyHeaderJs,
} from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type {
  RequestPlan,
  ChunkRequest,
  PlanningEpochs,
  CacheStateSnapshot,
  ProxyRequest,
} from "./planning.ts";
import { debugLog } from "../debug/logging.ts";

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
// Configuration
// ---------------------------------------------------------------------------

export interface CpuCacheConfig {
  mainBudgetBytes: number;
  overviewBudgetBytes: number;
  /**
   * Budget for the proxy tier in bytes. Proxies are a small middle layer
   * (between detail and overview) — see [`DEFAULT_PROXY_BUDGET`]. Eviction
   * tier order: detail > proxy > overview.
   */
  proxyBudgetBytes: number;
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Lane = "detail" | "prefetch" | "overview";
type InteractionMode = "panning" | "scrubbing" | "idle";
export type EvictionTier = "prefetch" | "demoted-detail" | "active-detail";

/**
 * A delivery from the CPU cache that the orchestrator routes to the GPU
 * worker. The discriminated union covers both regular chunks
 * (`kind: "chunk"`, the default for backward compat) and S5 proxy
 * deliveries (`kind: "proxy"`).
 *
 * Existing call sites that work with chunks should not need changes:
 * the `kind` field is optional on the chunk variant for source-level
 * compat, and the orchestrator narrows by inspecting the field.
 */
export type ReadyDelivery = ReadyChunkDelivery | ReadyProxyDelivery;

export interface ReadyChunkDelivery {
  /** Discriminant. Optional for backward compat — defaults to `"chunk"`. */
  kind?: "chunk";
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
  epochs: PlanningEpochs;
  lane: Lane;
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
  proxyKind: "WellProxy3D" | "FieldProxy3D";
  t: number;
  c: number;
  header: ProxyHeaderJs;
  data: ArrayBuffer;
  epochs: PlanningEpochs;
}

export interface CacheTelemetry {
  mainBytes: number;
  mainBudget: number;
  overviewBytes: number;
  overviewBudget: number;
  /** S5: proxy tier bytes / budget. */
  proxyBytes: number;
  proxyBudget: number;
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
  inFlightCount: number;
  inFlightBytes: number;
  /** S5: in-flight proxy fetches (count, estimated bytes). */
  inFlightProxyCount: number;
  inFlightProxyBytes: number;
  pendingCount: number;
  pendingProxyCount: number;
  /** Age (ms) of the longest-waiting entry in pendingRequests; 0 if empty. */
  pendingOldestAgeMs: number;
  /** Decoded chunks waiting for the orchestrator's drain pass. */
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
}

export interface TierResidencyEntry {
  count: number;
  bytes: number;
}

export interface TierCounters {
  activeDetail: number;
  demotedDetail: number;
  prefetch: number;
  overview: number;
  proxy: number;
}

interface CacheEntry {
  data: ArrayBuffer;
  sizeBytes: number;
  lane: Lane;
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
  epochs: PlanningEpochs;
  dataType: string;
}

interface InFlightEntry {
  request: ChunkRequest;
  controller: AbortController;
  estimatedBytes: number;
}

interface FailedEntry {
  failedUntilContentEpoch: number;
  isPermanent: boolean;
}

/** Per-entry record for the proxy cache. */
interface ProxyCacheEntry {
  header: ProxyHeaderJs;
  data: ArrayBuffer;
  bytes: number;
  datasetId: string;
  entityId: string;
  imageId: string;
  proxyKind: "WellProxy3D" | "FieldProxy3D";
  t: number;
  c: number;
  insertedAt: number;
  epochs: PlanningEpochs;
}

interface InFlightProxyEntry {
  request: ProxyRequest;
  controller: AbortController;
  estimatedBytes: number;
}

/**
 * Compose the inner proxy cache key. Entries are partitioned per-dataset
 * (outer Map) so dataset removal can drop the whole subtree at once.
 */
function proxyInnerKey(req: { entityId: string; kind: string; t: number; c: number }): string {
  return `${req.entityId}|${req.kind}|${req.t}|${req.c}`;
}

function freshTierCounters(): TierCounters {
  return { activeDetail: 0, demotedDetail: 0, prefetch: 0, overview: 0, proxy: 0 };
}

/** Pick a percentile from a numeric array. Sorts in place; copy first if needed. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// CpuCache
// ---------------------------------------------------------------------------

export class CpuCache {
  private source: ContentSource;
  private decode: DecodePool;
  private config: CpuCacheConfig;

  // Detail cache: entityId → chunkKey → CacheEntry
  private mainCache = new Map<string, Map<string, CacheEntry>>();
  private mainBytes = 0;

  // Overview cache: entityId → chunkKey → CacheEntry
  private overviewCache = new Map<string, Map<string, CacheEntry>>();
  private overviewBytes = 0;

  /**
   * Proxy cache (S5): datasetId → innerKey → ProxyCacheEntry where
   * innerKey is `${entityId}|${kind}|${t}|${c}`.
   *
   * Eviction tier order is detail > proxy > overview, so under memory
   * pressure proxies stick around longer than overview chunks but are
   * dropped before in-use detail chunks.
   */
  private proxyCache = new Map<string, Map<string, ProxyCacheEntry>>();
  private proxyBytes = 0;

  // Fetch scheduler state
  private pendingRequests: ChunkRequest[] = [];
  private inFlight = new Map<string, InFlightEntry>(); // inFlightKey → entry
  private inFlightBytes = 0;

  // Proxy fetch state
  private pendingProxyRequests: ProxyRequest[] = [];
  private inFlightProxy = new Map<string, InFlightProxyEntry>(); // datasetId|innerKey → entry
  private inFlightProxyBytes = 0;

  // Ready deliveries (not yet drained)
  private ready: ReadyDelivery[] = [];

  // Active set tracking
  private activeEntityIds = new Set<string>();

  // Epoch velocity tracking
  private epochHistory: PlanningEpochs[] = [];

  // Failure tracking
  private failures = new Map<string, FailedEntry>(); // inFlightKey → failure

  // Monotonic counter for LRU ordering
  private lruCounter = 0;

  // Listeners notified when new chunks become ready
  private listeners: (() => void)[] = [];

  // Telemetry
  private totalHits = 0;
  private totalRequests = 0;
  private evictionsSinceSnapshot = 0;
  /**
   * Per-tier eviction counts since the last `telemetry()` call. Reset on
   * each call so consumers see "evictions in the last window" rather
   * than cumulative since boot.
   */
  private evictionsByTierSinceSnapshot: TierCounters = freshTierCounters();
  private lastTelemetryTime = performance.now();
  private lastError: string | null = null;
  private decodeTimes: number[] = [];
  private transientFailures = 0;
  private permanentFailures = 0;

  /**
   * Enqueue timestamps for entries currently in `pendingRequests`.
   * Keyed by `inFlightKey(req)`. Used to surface starvation: the
   * oldest age tells you "longest a request has waited unfulfilled."
   * Cleared when an entry transitions to in-flight or is dropped.
   */
  private pendingEnqueuedAt = new Map<string, number>();

  // Running average of decoded chunk sizes for in-flight byte estimation
  private avgDecodedBytes = 0;
  private completedFetches = 0;

  // Decode throughput tracking
  private decodesSinceSnapshot = 0;

  // Rate-limited log state. One slot per event kind; we skip emission
  // if we logged within the last second, but track aggregate counts so
  // a burst still surfaces at most one summary per second.
  private cacheLogState = {
    backpressureLastAt: 0,
    backpressureSkipped: 0,
    failureLastAt: 0,
    failureBurstCount: 0,
  };

  // Current epochs (for failure clearing)
  private currentEpochs: PlanningEpochs = {
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

    // Track epoch velocity
    this.epochHistory.push({ ...plan.epochs });
    if (this.epochHistory.length > INTERACTION_MODE_WINDOW) {
      this.epochHistory.shift();
    }

    // Update active set → demotion
    const newActiveIds = new Set(plan.activeSet.map(e => e.entityId));
    for (const entityId of this.activeEntityIds) {
      if (!newActiveIds.has(entityId)) {
        this.demoteEntity(entityId);
      }
    }
    this.activeEntityIds = newActiveIds;

    // Build new pending queue: skip cached, in-flight, and failed
    // chunks. Re-build the enqueue-time map so dropped requests don't
    // leak entries (the dropped key won't be re-added below).
    this.pendingRequests = [];
    const nextEnqueuedAt = new Map<string, number>();
    const enqueueNow = performance.now();
    for (const req of plan.requests) {
      const key = this.inFlightKey(req);

      this.totalRequests++;

      // Already cached?
      if (this.isChunkCached(req)) {
        this.totalHits++;
        continue;
      }

      // Already in-flight?
      if (this.inFlight.has(key)) continue;

      // Failed and not cleared?
      const failure = this.failures.get(key);
      if (failure && this.currentEpochs.content < failure.failedUntilContentEpoch) continue;

      this.pendingRequests.push(req);
      // Preserve original enqueue time across re-submits so age reflects
      // "how long since the request first appeared," not "how long since
      // the most recent plan tick."
      nextEnqueuedAt.set(key, this.pendingEnqueuedAt.get(key) ?? enqueueNow);
    }
    this.pendingEnqueuedAt = nextEnqueuedAt;

    // S5: route proxy requests to fetchProxy. Mirrors the chunk path:
    // dedup against the proxy cache + in-flight map, then enqueue.
    const proxyRequests = plan.proxyRequests ?? [];

    this.pendingProxyRequests = [];
    for (const req of proxyRequests) {
      const key = this.inFlightProxyKey(req);

      // Already cached? Skip silently — mirrors the chunk path. The
      // orchestrator tracks delivered proxies separately and re-sends
      // via `getCachedProxy` when the worker reports an eviction.
      if (this.isProxyCached(req)) continue;

      // Already in-flight?
      if (this.inFlightProxy.has(key)) continue;

      this.pendingProxyRequests.push(req);
    }

    // Start new fetches
    this.startChunkFetches();
    this.startProxyFetches();
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

    // 1. In-flight chunk fetches.
    for (const [key, entry] of this.inFlight) {
      if (entityIdSet.has(entry.request.entityId)) {
        entry.controller.abort();
        this.inFlightBytes -= entry.estimatedBytes;
        this.inFlight.delete(key);
      }
    }

    // 2. In-flight proxy fetches.
    for (const [key, entry] of this.inFlightProxy) {
      if (entry.request.datasetId === datasetId) {
        entry.controller.abort();
        this.inFlightProxyBytes -= entry.estimatedBytes;
        this.inFlightProxy.delete(key);
      }
    }

    // 3. Pending chunk queue.
    for (const r of this.pendingRequests) {
      if (entityIdSet.has(r.entityId)) {
        this.pendingEnqueuedAt.delete(this.inFlightKey(r));
      }
    }
    this.pendingRequests = this.pendingRequests.filter(
      r => !entityIdSet.has(r.entityId),
    );

    // 4. Pending proxy queue.
    this.pendingProxyRequests = this.pendingProxyRequests.filter(
      r => r.datasetId !== datasetId,
    );

    // 5. Cached chunks (detail + overview).
    for (const entityId of entityIds) {
      const detailMap = this.mainCache.get(entityId);
      if (detailMap) {
        for (const entry of detailMap.values()) {
          this.mainBytes -= entry.sizeBytes;
        }
        this.mainCache.delete(entityId);
      }
      const overviewMap = this.overviewCache.get(entityId);
      if (overviewMap) {
        for (const entry of overviewMap.values()) {
          this.overviewBytes -= entry.sizeBytes;
        }
        this.overviewCache.delete(entityId);
      }
    }

    // 6. Cached proxies under this dataset.
    const proxyMap = this.proxyCache.get(datasetId);
    if (proxyMap) {
      for (const entry of proxyMap.values()) {
        this.proxyBytes -= entry.bytes;
      }
      this.proxyCache.delete(datasetId);
    }

    // 7. Ready deliveries.
    this.ready = this.ready.filter(d => {
      if (d.kind === "proxy") return d.datasetId !== datasetId;
      return !entityIdSet.has(d.entityId);
    });

    // 8. Failure map + activeEntityIds. Failure keys are
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

  /** Immutable snapshot of cached + in-flight keys for PlanningSnapshot. */
  snapshot(): CacheStateSnapshot {
    const cached = new Map<string, Set<string>>();
    for (const [entityId, chunks] of this.mainCache) {
      cached.set(entityId, new Set(chunks.keys()));
    }
    for (const [entityId, chunks] of this.overviewCache) {
      const existing = cached.get(entityId) ?? new Set();
      for (const key of chunks.keys()) existing.add(key);
      cached.set(entityId, existing);
    }

    const inFlight = new Map<string, Set<string>>();
    for (const [, entry] of this.inFlight) {
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
    const elapsed = (now - this.lastTelemetryTime) / 1000 || 1;
    const evictionsPerSec = this.evictionsSinceSnapshot / elapsed;
    const decodesPerSec = this.decodesSinceSnapshot / elapsed;
    const evictionsByTier = this.evictionsByTierSinceSnapshot;
    this.evictionsSinceSnapshot = 0;
    this.evictionsByTierSinceSnapshot = freshTierCounters();
    this.decodesSinceSnapshot = 0;
    this.lastTelemetryTime = now;

    const mode = this.detectInteractionMode();

    // Per-tier residency: walk every cached entry once and bin.
    const tierResidency = {
      activeDetail: { count: 0, bytes: 0 },
      demotedDetail: { count: 0, bytes: 0 },
      prefetch: { count: 0, bytes: 0 },
      overview: { count: 0, bytes: 0 },
      proxy: { count: 0, bytes: 0 },
    };
    for (const entityMap of this.mainCache.values()) {
      for (const e of entityMap.values()) {
        if (e.tier === "active-detail") {
          tierResidency.activeDetail.count++;
          tierResidency.activeDetail.bytes += e.sizeBytes;
        } else if (e.tier === "demoted-detail") {
          tierResidency.demotedDetail.count++;
          tierResidency.demotedDetail.bytes += e.sizeBytes;
        } else {
          tierResidency.prefetch.count++;
          tierResidency.prefetch.bytes += e.sizeBytes;
        }
      }
    }
    for (const entityMap of this.overviewCache.values()) {
      for (const e of entityMap.values()) {
        tierResidency.overview.count++;
        tierResidency.overview.bytes += e.sizeBytes;
      }
    }
    for (const datasetMap of this.proxyCache.values()) {
      for (const e of datasetMap.values()) {
        tierResidency.proxy.count++;
        tierResidency.proxy.bytes += e.bytes;
      }
    }

    // Pending-queue starvation signal: oldest enqueue timestamp wins.
    let pendingOldestAgeMs = 0;
    if (this.pendingEnqueuedAt.size > 0) {
      let oldest = now;
      for (const t of this.pendingEnqueuedAt.values()) {
        if (t < oldest) oldest = t;
      }
      pendingOldestAgeMs = now - oldest;
    }

    // Decode percentiles from the rolling window.
    let decodeP50Ms = 0;
    let decodeP95Ms = 0;
    let avgDecodeMs = 0;
    if (this.decodeTimes.length > 0) {
      avgDecodeMs = this.decodeTimes.reduce((a, b) => a + b, 0) / this.decodeTimes.length;
      const sorted = [...this.decodeTimes].sort((a, b) => a - b);
      decodeP50Ms = percentile(sorted, 0.5);
      decodeP95Ms = percentile(sorted, 0.95);
    }

    return {
      mainBytes: this.mainBytes,
      mainBudget: this.config.mainBudgetBytes,
      overviewBytes: this.overviewBytes,
      overviewBudget: this.config.overviewBudgetBytes,
      proxyBytes: this.proxyBytes,
      proxyBudget: this.config.proxyBudgetBytes,
      maxConcurrentFetches: this.config.maxConcurrentFetches,
      maxBytesInFlight: this.config.maxBytesInFlight,
      inFlightCount: this.inFlight.size,
      inFlightBytes: this.inFlightBytes,
      inFlightProxyCount: this.inFlightProxy.size,
      inFlightProxyBytes: this.inFlightProxyBytes,
      pendingCount: this.pendingRequests.length,
      pendingProxyCount: this.pendingProxyRequests.length,
      pendingOldestAgeMs,
      readyCount: this.ready.length,
      hitRate: this.totalRequests > 0 ? this.totalHits / this.totalRequests : 0,
      evictionsPerSec,
      evictionsByTier,
      interactionMode: mode,
      evictionTierOrder: this.getTierOrder(mode),
      failedChunks: { transient: this.transientFailures, permanent: this.permanentFailures },
      lastError: this.lastError,
      decodesPerSec,
      decodeWorkersTotal: this.decode.size,
      avgDecodeMs,
      decodeP50Ms,
      decodeP95Ms,
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
      this.mainCache.get(entityId)?.get(chunkKey) ??
      this.overviewCache.get(entityId)?.get(chunkKey) ??
      null;
    if (!entry) return null;
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
    const entry = this.proxyCache.get(datasetId)?.get(proxyInnerKey({ entityId, kind, t, c }));
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
    return this.inFlightProxy.has(`${datasetId}|${proxyInnerKey({ entityId, kind, t, c })}`);
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
      this.mainCache.get(entityId)?.get(chunkKey) ??
      this.overviewCache.get(entityId)?.get(chunkKey);
    return entry?.tier ?? null;
  }

  /**
   * Snapshot of the current `pendingRequests` (sorted by priority — the
   * order they will be dequeued). Used by the chunk-grid overlay to
   * color planned chunks by their queue rank, so "expected fetch order"
   * is visible alongside "actual cached state."
   */
  getPendingSnapshot(): readonly ChunkRequest[] {
    return [...this.pendingRequests];
  }

  /** Snapshot of pending proxy requests, sorted by priority. */
  getPendingProxySnapshot(): readonly ProxyRequest[] {
    return [...this.pendingProxyRequests];
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
    const out: ReturnType<CpuCache["getCacheDump"]> = [];
    for (const entityMap of this.mainCache.values()) {
      for (const e of entityMap.values()) {
        out.push({
          entityId: e.entityId, cache: "main", level: e.level, tier: e.tier,
          bytes: e.sizeBytes, chunkKey: e.chunkKey, insertedAt: e.insertedAt,
        });
      }
    }
    for (const entityMap of this.overviewCache.values()) {
      for (const e of entityMap.values()) {
        out.push({
          entityId: e.entityId, cache: "overview", level: e.level, tier: e.tier,
          bytes: e.sizeBytes, chunkKey: e.chunkKey, insertedAt: e.insertedAt,
        });
      }
    }
    return out;
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
    const out: ReturnType<CpuCache["getProxyCacheDump"]> = [];
    for (const [datasetId, inner] of this.proxyCache) {
      for (const e of inner.values()) {
        out.push({
          datasetId, entityId: e.entityId, proxyKind: e.proxyKind,
          t: e.t, c: e.c, bytes: e.bytes, insertedAt: e.insertedAt,
        });
      }
    }
    return out;
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
    return this.pendingRequests.map(r => {
      const enq = this.pendingEnqueuedAt.get(this.inFlightKey(r));
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
    // Cancel all in-flight
    for (const [, entry] of this.inFlight) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.inFlightBytes = 0;

    for (const [, entry] of this.inFlightProxy) {
      entry.controller.abort();
    }
    this.inFlightProxy.clear();
    this.inFlightProxyBytes = 0;

    // Clear caches
    this.mainCache.clear();
    this.mainBytes = 0;
    this.overviewCache.clear();
    this.overviewBytes = 0;
    this.proxyCache.clear();
    this.proxyBytes = 0;

    // Clear state
    this.pendingRequests = [];
    this.pendingProxyRequests = [];
    this.pendingEnqueuedAt.clear();
    this.ready = [];
    this.activeEntityIds.clear();
    this.epochHistory = [];
    this.failures.clear();
    this.lruCounter = 0;

    // Clear listeners
    this.listeners = [];

    // Reset telemetry
    this.totalHits = 0;
    this.totalRequests = 0;
    this.evictionsSinceSnapshot = 0;
    this.evictionsByTierSinceSnapshot = freshTierCounters();
    this.decodesSinceSnapshot = 0;
    this.lastTelemetryTime = performance.now();
    this.lastError = null;
    this.decodeTimes = [];
    this.transientFailures = 0;
    this.permanentFailures = 0;
    this.avgDecodedBytes = 0;
    this.completedFetches = 0;
  }

  // =========================================================================
  // Fetch Scheduler
  // =========================================================================

  private startChunkFetches(): void {
    while (
      this.pendingRequests.length > 0 &&
      this.inFlight.size < this.config.maxConcurrentFetches &&
      this.inFlightBytes < this.config.maxBytesInFlight
    ) {
      const req = this.pendingRequests.shift()!;
      this.pendingEnqueuedAt.delete(this.inFlightKey(req));
      this.startSingleFetch(req);
    }
    // If pending remain *because* we hit a limit, surface backpressure.
    // Rate-limit to ≤1/sec; aggregate skipped count so a sustained
    // queue still emits a periodic summary.
    if (
      this.pendingRequests.length > 0 &&
      (this.inFlight.size >= this.config.maxConcurrentFetches ||
        this.inFlightBytes >= this.config.maxBytesInFlight)
    ) {
      this.cacheLogState.backpressureSkipped += this.pendingRequests.length;
      const now = performance.now();
      if (now - this.cacheLogState.backpressureLastAt >= 1000) {
        debugLog("cache", "cache.backpressure", {
          pending: this.pendingRequests.length,
          inFlight: this.inFlight.size,
          maxConcurrent: this.config.maxConcurrentFetches,
          inFlightBytes: this.inFlightBytes,
          maxBytes: this.config.maxBytesInFlight,
          skippedSinceLastLog: this.cacheLogState.backpressureSkipped,
        });
        this.cacheLogState.backpressureLastAt = now;
        this.cacheLogState.backpressureSkipped = 0;
      }
    }
  }

  private startSingleFetch(req: ChunkRequest): void {
    const key = this.inFlightKey(req);
    const controller = new AbortController();
    const estimate = this.avgDecodedBytes;
    const entry: InFlightEntry = { request: req, controller, estimatedBytes: estimate };
    this.inFlightBytes += estimate;
    this.inFlight.set(key, entry);

    this.fetchAndDecode(req, controller, key).catch(() => {
      // Errors handled inside fetchAndDecode
    });
  }

  private async fetchAndDecode(
    req: ChunkRequest,
    controller: AbortController,
    key: string,
    retryCount = 0,
  ): Promise<void> {
    let result: FetchResult;
    try {
      result = await this.source.fetch(
        { datasetId: req.datasetId ?? req.entityId, imageId: req.imageId, chunkKey: req.chunkKey },
        controller.signal,
      );
    } catch (err: unknown) {
      // Aborted — clean and silent
      if (err instanceof DOMException && err.name === "AbortError") {
        this.inFlight.delete(key);
        return;
      }

      // Classify error
      const message = err instanceof Error ? err.message : String(err);
      const isPermanent = message.includes("404") || message.includes("malformed");

      if (!isPermanent && retryCount < MAX_TRANSIENT_RETRIES) {
        // Transient retry
        await new Promise(r => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
        if (!this.inFlight.has(key)) return; // cancelled during wait
        return this.fetchAndDecode(req, controller, key, retryCount + 1);
      }

      // Mark as failed
      this.failures.set(key, {
        failedUntilContentEpoch: this.currentEpochs.content + 1,
        isPermanent,
      });
      if (isPermanent) this.permanentFailures++;
      else this.transientFailures++;
      this.lastError = message;
      this.recordFailureForBurstDetection(isPermanent, message);
      const failedEntry = this.inFlight.get(key);
      if (failedEntry) this.inFlightBytes -= failedEntry.estimatedBytes;
      this.inFlight.delete(key);
      return;
    }

    // Correct in-flight bytes from estimate to actual
    const responseBytes = result.bytes.byteLength;
    const inFlightEntry = this.inFlight.get(key);
    if (inFlightEntry) {
      this.inFlightBytes += responseBytes - inFlightEntry.estimatedBytes;
      inFlightEntry.estimatedBytes = responseBytes;
    }

    // Update running average for future estimates
    this.completedFetches++;
    this.avgDecodedBytes += (responseBytes - this.avgDecodedBytes) / this.completedFetches;

    // Decode
    let decoded: ArrayBuffer;
    try {
      const t0 = performance.now();
      decoded = await this.decode.decode(result.bytes, result.wireFormat, result.dataType);
      this.decodeTimes.push(performance.now() - t0);
      if (this.decodeTimes.length > 100) this.decodeTimes.shift();
      this.decodesSinceSnapshot++;
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Guard: submit() may have already cancelled this entry during decode
      if (this.inFlight.has(key)) {
        this.inFlightBytes -= responseBytes;
        this.inFlight.delete(key);
      }
      return;
    }

    // Remove from in-flight (guard: submit() may have cancelled during decode)
    if (this.inFlight.has(key)) {
      this.inFlightBytes -= responseBytes;
      this.inFlight.delete(key);
    }

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
    };

    if (lane === "overview") {
      this.evictIfNeeded(this.overviewCache, this.config.overviewBudgetBytes, decoded.byteLength, "overview");
      this.insertEntry(this.overviewCache, cacheEntry);
      this.overviewBytes += decoded.byteLength;
    } else {
      this.evictIfNeeded(this.mainCache, this.config.mainBudgetBytes, decoded.byteLength, "main");
      this.insertEntry(this.mainCache, cacheEntry);
      this.mainBytes += decoded.byteLength;
    }

    // Mark as ready for drain
    this.ready.push({
      kind: "chunk",
      entityId: req.entityId,
      imageId: req.imageId,
      level: req.level,
      t: req.t,
      c: req.c,
      z: req.z,
      y: req.y,
      x: req.x,
      chunkKey: req.chunkKey,
      data: decoded,
      dataType: result.dataType,
      epochs: cacheEntry.epochs,
      lane,
    });

    // Notify listeners that a new chunk is ready
    this.notifyListeners();

    // Start next pending fetch
    this.startChunkFetches();
  }

  // =========================================================================
  // Proxy Fetch Scheduler (S5)
  // =========================================================================

  private startProxyFetches(): void {
    while (
      this.pendingProxyRequests.length > 0 &&
      // Share the chunk concurrency caps for now; proxies are a small minority.
      this.inFlight.size + this.inFlightProxy.size < this.config.maxConcurrentFetches &&
      this.inFlightBytes + this.inFlightProxyBytes < this.config.maxBytesInFlight
    ) {
      const req = this.pendingProxyRequests.shift()!;
      this.startSingleProxyFetch(req);
    }
  }

  private startSingleProxyFetch(req: ProxyRequest): void {
    const key = this.inFlightProxyKey(req);
    const controller = new AbortController();
    // We don't have a running average for proxy sizes yet; reuse the chunk
    // average as a rough estimate. Corrected to actual size once the
    // response arrives.
    const estimate = this.avgDecodedBytes;
    const entry: InFlightProxyEntry = { request: req, controller, estimatedBytes: estimate };
    this.inFlightProxyBytes += estimate;
    this.inFlightProxy.set(key, entry);

    this.fetchProxy(req, controller, key).catch(() => {
      // Errors handled inside fetchProxy
    });
  }

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
      if (err instanceof DOMException && err.name === "AbortError") {
        this.inFlightProxy.delete(key);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      const failed = this.inFlightProxy.get(key);
      if (failed) this.inFlightProxyBytes -= failed.estimatedBytes;
      this.inFlightProxy.delete(key);
      // No retry / failure tracking in S5 — orchestrator can resubmit on
      // the next plan if it still wants this proxy.
      return;
    }

    // Correct in-flight bytes accounting
    const responseBytes = result.data.byteLength;
    const inFlightEntry = this.inFlightProxy.get(key);
    if (inFlightEntry) {
      this.inFlightProxyBytes += responseBytes - inFlightEntry.estimatedBytes;
      inFlightEntry.estimatedBytes = responseBytes;
    }

    // Insert into proxy cache
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

    this.evictProxyIfNeeded(responseBytes);

    let datasetMap = this.proxyCache.get(req.datasetId);
    if (!datasetMap) {
      datasetMap = new Map();
      this.proxyCache.set(req.datasetId, datasetMap);
    }
    datasetMap.set(proxyInnerKey(req), cacheEntry);
    this.proxyBytes += responseBytes;

    if (this.inFlightProxy.has(key)) {
      this.inFlightProxyBytes -= responseBytes;
      this.inFlightProxy.delete(key);
    }

    // Mark as ready for drain
    this.ready.push(this.proxyEntryToDelivery(cacheEntry));
    this.notifyListeners();

    // Drain queue
    this.startProxyFetches();
  }

  private evictProxyIfNeeded(incomingBytes: number): void {
    if (this.proxyBytes + incomingBytes <= this.config.proxyBudgetBytes) return;
    const needed = this.proxyBytes + incomingBytes - this.config.proxyBudgetBytes;
    let freed = 0;

    // Flatten + sort by insertion order (LRU oldest first).
    const entries: { datasetId: string; key: string; entry: ProxyCacheEntry }[] = [];
    for (const [datasetId, inner] of this.proxyCache) {
      for (const [k, e] of inner) entries.push({ datasetId, key: k, entry: e });
    }
    entries.sort((a, b) => a.entry.insertedAt - b.entry.insertedAt);

    for (const { datasetId, key, entry } of entries) {
      if (freed >= needed) break;
      const inner = this.proxyCache.get(datasetId);
      if (inner) {
        inner.delete(key);
        if (inner.size === 0) this.proxyCache.delete(datasetId);
      }
      this.proxyBytes -= entry.bytes;
      freed += entry.bytes;
      this.evictionsSinceSnapshot++;
      this.evictionsByTierSinceSnapshot.proxy++;
    }
  }

  private isProxyCached(req: ProxyRequest): boolean {
    return this.proxyCache.get(req.datasetId)?.has(proxyInnerKey(req)) === true;
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
    const now = performance.now();
    if (now - this.cacheLogState.failureLastAt >= 1000) {
      // Window rolled — start a new one.
      this.cacheLogState.failureLastAt = now;
      this.cacheLogState.failureBurstCount = 1;
      return;
    }
    this.cacheLogState.failureBurstCount++;
    if (this.cacheLogState.failureBurstCount === 4) {
      // First time we cross the burst threshold within the window.
      debugLog("cache", "cache.failure_burst", {
        failuresInLastSec: this.cacheLogState.failureBurstCount,
        lastFailurePermanent: isPermanent,
        lastError: message,
      });
    }
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

  // =========================================================================
  // Cache Management
  // =========================================================================

  private insertEntry(cache: Map<string, Map<string, CacheEntry>>, entry: CacheEntry): void {
    let entityMap = cache.get(entry.entityId);
    if (!entityMap) {
      entityMap = new Map();
      cache.set(entry.entityId, entityMap);
    }
    entityMap.set(entry.chunkKey, entry);
  }

  private isChunkCached(req: ChunkRequest): boolean {
    const cache = req.lane === "overview" ? this.overviewCache : this.mainCache;
    return cache.get(req.entityId)?.has(req.chunkKey) === true;
  }

  private demoteEntity(entityId: string): void {
    const entityMap = this.mainCache.get(entityId);
    if (!entityMap) return;
    for (const entry of entityMap.values()) {
      if (entry.tier === "active-detail") {
        entry.tier = "demoted-detail";
      }
    }
  }

  private laneToTier(lane: Lane): EvictionTier {
    if (lane === "prefetch") return "prefetch";
    if (lane === "overview") return "prefetch"; // overview has simple LRU, tier doesn't matter
    return "active-detail";
  }

  // =========================================================================
  // Eviction
  // =========================================================================

  private evictIfNeeded(
    cache: Map<string, Map<string, CacheEntry>>,
    budget: number,
    incomingBytes: number,
    cacheType: "main" | "overview",
  ): void {
    const currentBytes = cacheType === "main" ? this.mainBytes : this.overviewBytes;
    if (currentBytes + incomingBytes <= budget) return;

    if (cacheType === "overview") {
      this.evictLRU(cache, currentBytes + incomingBytes - budget, cacheType);
    } else {
      this.evictTiered(cache, currentBytes + incomingBytes - budget);
    }
  }

  /** Simple LRU eviction for overview cache. */
  private evictLRU(
    cache: Map<string, Map<string, CacheEntry>>,
    bytesNeeded: number,
    cacheType: "main" | "overview",
  ): void {
    let freed = 0;
    const allEntries = this.collectEntries(cache);
    allEntries.sort((a, b) => a.insertedAt - b.insertedAt); // oldest first

    for (const entry of allEntries) {
      if (freed >= bytesNeeded) break;
      this.removeEntry(cache, entry, cacheType);
      freed += entry.sizeBytes;
    }
  }

  /** Three-tier adaptive eviction for detail cache. */
  private evictTiered(
    cache: Map<string, Map<string, CacheEntry>>,
    bytesNeeded: number,
  ): void {
    const mode = this.detectInteractionMode();
    const tierOrder = this.getTierOrder(mode);
    let freed = 0;
    let removed = 0;

    for (const tier of tierOrder) {
      if (freed >= bytesNeeded) break;
      const entries = this.collectEntriesByTier(cache, tier as EvictionTier);
      entries.sort((a, b) => a.insertedAt - b.insertedAt); // oldest first within tier

      for (const entry of entries) {
        if (freed >= bytesNeeded) break;
        this.removeEntry(cache, entry, "main");
        freed += entry.sizeBytes;
        removed++;
      }
    }
    if (removed >= 16) {
      debugLog("cache", "cache.eviction_burst", {
        cache: "main",
        removed,
        bytesFreed: freed,
        bytesNeeded,
        mode,
      });
    }
  }

  private removeEntry(
    cache: Map<string, Map<string, CacheEntry>>,
    entry: CacheEntry,
    cacheType: "main" | "overview",
  ): void {
    const entityMap = cache.get(entry.entityId);
    if (entityMap) {
      entityMap.delete(entry.chunkKey);
      if (entityMap.size === 0) cache.delete(entry.entityId);
    }
    if (cacheType === "main") this.mainBytes -= entry.sizeBytes;
    else this.overviewBytes -= entry.sizeBytes;
    this.evictionsSinceSnapshot++;
    if (cacheType === "overview") {
      this.evictionsByTierSinceSnapshot.overview++;
    } else if (entry.tier === "active-detail") {
      this.evictionsByTierSinceSnapshot.activeDetail++;
    } else if (entry.tier === "demoted-detail") {
      this.evictionsByTierSinceSnapshot.demotedDetail++;
    } else {
      this.evictionsByTierSinceSnapshot.prefetch++;
    }
  }

  private collectEntries(cache: Map<string, Map<string, CacheEntry>>): CacheEntry[] {
    const result: CacheEntry[] = [];
    for (const entityMap of cache.values()) {
      for (const entry of entityMap.values()) {
        result.push(entry);
      }
    }
    return result;
  }

  private collectEntriesByTier(
    cache: Map<string, Map<string, CacheEntry>>,
    tier: EvictionTier,
  ): CacheEntry[] {
    const result: CacheEntry[] = [];
    for (const entityMap of cache.values()) {
      for (const entry of entityMap.values()) {
        if (entry.tier === tier) result.push(entry);
      }
    }
    return result;
  }

  // =========================================================================
  // Interaction Detection
  // =========================================================================

  private detectInteractionMode(): InteractionMode {
    if (this.epochHistory.length < 2) return "idle";

    let viewBumps = 0;
    let selectionBumps = 0;
    for (let i = 1; i < this.epochHistory.length; i++) {
      if (this.epochHistory[i].view !== this.epochHistory[i - 1].view) viewBumps++;
      if (this.epochHistory[i].selection !== this.epochHistory[i - 1].selection) selectionBumps++;
    }

    if (selectionBumps > viewBumps && selectionBumps >= 2) return "scrubbing";
    if (viewBumps >= 2) return "panning";
    return "idle";
  }

  private getTierOrder(mode: InteractionMode): string[] {
    switch (mode) {
      case "panning":
        return ["prefetch", "demoted-detail", "active-detail"];
      case "scrubbing":
        return ["demoted-detail", "active-detail", "prefetch"];
      case "idle":
      default:
        return ["prefetch", "demoted-detail", "active-detail"];
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private inFlightKey(req: ChunkRequest): string {
    return `${req.entityId}/${req.chunkKey}`;
  }
}
