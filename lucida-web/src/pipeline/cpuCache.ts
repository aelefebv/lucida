/**
 * CPU Cache — holds decompressed data between network and GPU.
 *
 * Owns detail/overview caches with three-tier adaptive eviction,
 * a priority-ordered fetch scheduler, and the submit/drain/snapshot/telemetry API.
 *
 * See docs/cpu-cache-spec.md for the full specification.
 */

import type { ContentSource, FetchResult } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { RequestPlan, ChunkRequest, ActiveSetEntry, PlanningEpochs, CacheStateSnapshot } from "./planning.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DETAIL_BUDGET = 512 * 1024 * 1024;
export const DEFAULT_OVERVIEW_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
export const FETCH_CONCURRENCY_MULTIPLIER = 3;
export const TRANSIENT_RETRY_DELAY_MS = 500;
export const MAX_TRANSIENT_RETRIES = 1;
export const EPOCH_VELOCITY_WINDOW = 10;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CpuCacheConfig {
  detailBudgetBytes: number;
  overviewBudgetBytes: number;
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Lane = "detail" | "runway" | "overview";
type InteractionMode = "panning" | "scrubbing" | "idle";
type EvictionTier = "runway" | "demoted-detail" | "active-detail";

export interface ReadyDelivery {
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

export interface CacheTelemetry {
  detailBytes: number;
  detailBudget: number;
  overviewBytes: number;
  overviewBudget: number;
  inFlightCount: number;
  inFlightBytes: number;
  queueDepth: number;
  hitRate: number;
  evictionsPerSec: number;
  interactionMode: InteractionMode;
  evictionTierOrder: string[];
  failedChunks: { transient: number; permanent: number };
  lastError: string | null;
  decodeWorkersBusy: number;
  decodeWorkersTotal: number;
  avgDecodeMs: number;
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

// ---------------------------------------------------------------------------
// CpuCache
// ---------------------------------------------------------------------------

export class CpuCache {
  private source: ContentSource;
  private decode: DecodePool;
  private config: CpuCacheConfig;

  // Detail cache: entityId → chunkKey → CacheEntry
  private detailCache = new Map<string, Map<string, CacheEntry>>();
  private detailBytes = 0;

  // Overview cache: entityId → chunkKey → CacheEntry
  private overviewCache = new Map<string, Map<string, CacheEntry>>();
  private overviewBytes = 0;

  // Fetch scheduler state
  private pendingQueue: ChunkRequest[] = [];
  private inFlight = new Map<string, InFlightEntry>(); // compositeKey → entry
  private inFlightBytes = 0;

  // Ready deliveries (not yet drained)
  private ready: ReadyDelivery[] = [];

  // Active set tracking
  private activeEntityIds = new Set<string>();

  // Epoch velocity tracking
  private epochHistory: PlanningEpochs[] = [];

  // Failure tracking
  private failures = new Map<string, FailedEntry>(); // compositeKey → failure

  // Monotonic counter for LRU ordering
  private insertCounter = 0;

  // Listeners notified when new chunks become ready
  private listeners: (() => void)[] = [];

  // Telemetry
  private totalHits = 0;
  private totalRequests = 0;
  private evictionCount = 0;
  private lastEvictionTime = 0;
  private lastError: string | null = null;
  private decodeTimes: number[] = [];
  private transientFailures = 0;
  private permanentFailures = 0;

  // Current epochs (for failure clearing)
  private currentEpochs: PlanningEpochs = {
    content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0,
  };

  constructor(source: ContentSource, decode: DecodePool, config?: Partial<CpuCacheConfig>) {
    this.source = source;
    this.decode = decode;
    this.config = {
      detailBudgetBytes: config?.detailBudgetBytes ?? DEFAULT_DETAIL_BUDGET,
      overviewBudgetBytes: config?.overviewBudgetBytes ?? DEFAULT_OVERVIEW_BUDGET,
      maxConcurrentFetches: config?.maxConcurrentFetches ?? (decode.size * FETCH_CONCURRENCY_MULTIPLIER),
      maxBytesInFlight: config?.maxBytesInFlight ?? DEFAULT_MAX_BYTES_IN_FLIGHT,
    };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Diff against in-flight, cancel stale, update eviction tiers, start new fetches. */
  submit(plan: RequestPlan): void {
    this.currentEpochs = plan.epochs;

    // Track epoch velocity
    this.epochHistory.push({ ...plan.epochs });
    if (this.epochHistory.length > EPOCH_VELOCITY_WINDOW) {
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

    // Build set of requested composite keys
    const requestedKeys = new Set(plan.requests.map(r => this.compositeKey(r)));

    // Cancel in-flight fetches not in new plan
    for (const [key, entry] of this.inFlight) {
      if (!requestedKeys.has(key)) {
        entry.controller.abort();
        this.inFlightBytes -= entry.estimatedBytes;
        this.inFlight.delete(key);
      }
    }

    // Build new pending queue: skip cached, in-flight, and failed chunks
    this.pendingQueue = [];
    for (const req of plan.requests) {
      const key = this.compositeKey(req);

      this.totalRequests++;

      // Already cached?
      if (this.isCached(req)) {
        this.totalHits++;
        continue;
      }

      // Already in-flight?
      if (this.inFlight.has(key)) continue;

      // Failed and not cleared?
      const failure = this.failures.get(key);
      if (failure && this.currentEpochs.content < failure.failedUntilContentEpoch) continue;

      this.pendingQueue.push(req);
    }

    // Start new fetches
    this.startFetches();
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
    for (const [entityId, chunks] of this.detailCache) {
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
    const elapsed = (now - this.lastEvictionTime) / 1000 || 1;
    const mode = this.detectInteractionMode();

    return {
      detailBytes: this.detailBytes,
      detailBudget: this.config.detailBudgetBytes,
      overviewBytes: this.overviewBytes,
      overviewBudget: this.config.overviewBudgetBytes,
      inFlightCount: this.inFlight.size,
      inFlightBytes: this.inFlightBytes,
      queueDepth: this.pendingQueue.length,
      hitRate: this.totalRequests > 0 ? this.totalHits / this.totalRequests : 0,
      evictionsPerSec: this.evictionCount / elapsed,
      interactionMode: mode,
      evictionTierOrder: this.getTierOrder(mode),
      failedChunks: { transient: this.transientFailures, permanent: this.permanentFailures },
      lastError: this.lastError,
      decodeWorkersBusy: this.decode.activeCount(),
      decodeWorkersTotal: this.decode.size,
      avgDecodeMs: this.decodeTimes.length > 0
        ? this.decodeTimes.reduce((a, b) => a + b, 0) / this.decodeTimes.length
        : 0,
    };
  }

  /**
   * Look up a cached chunk by entity and chunk key.
   * Returns a ReadyDelivery if the chunk is in the detail or overview cache, null otherwise.
   * Used by the Orchestrator for re-sending chunks evicted from the worker.
   */
  getCached(entityId: string, chunkKey: string): ReadyDelivery | null {
    const entry =
      this.detailCache.get(entityId)?.get(chunkKey) ??
      this.overviewCache.get(entityId)?.get(chunkKey) ??
      null;
    if (!entry) return null;
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
    };
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

    // Clear caches
    this.detailCache.clear();
    this.detailBytes = 0;
    this.overviewCache.clear();
    this.overviewBytes = 0;

    // Clear state
    this.pendingQueue = [];
    this.ready = [];
    this.activeEntityIds.clear();
    this.epochHistory = [];
    this.failures.clear();
    this.insertCounter = 0;

    // Clear listeners
    this.listeners = [];

    // Reset telemetry
    this.totalHits = 0;
    this.totalRequests = 0;
    this.evictionCount = 0;
    this.lastEvictionTime = 0;
    this.lastError = null;
    this.decodeTimes = [];
    this.transientFailures = 0;
    this.permanentFailures = 0;
  }

  // =========================================================================
  // Fetch Scheduler
  // =========================================================================

  private startFetches(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.inFlight.size < this.config.maxConcurrentFetches &&
      this.inFlightBytes < this.config.maxBytesInFlight
    ) {
      const req = this.pendingQueue.shift()!;
      this.startSingleFetch(req);
    }
  }

  private startSingleFetch(req: ChunkRequest): void {
    const key = this.compositeKey(req);
    const controller = new AbortController();
    // Estimate: we don't know size until response arrives. Use 0 for concurrency-based throttling.
    // Bytes-in-flight is updated when the response size is known.
    const entry: InFlightEntry = { request: req, controller, estimatedBytes: 0 };
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
      this.inFlight.delete(key);
      return;
    }

    // Update in-flight bytes tracking
    const responseBytes = result.bytes.byteLength;
    const inFlightEntry = this.inFlight.get(key);
    if (inFlightEntry) {
      inFlightEntry.estimatedBytes = responseBytes;
      this.inFlightBytes += responseBytes;
    }

    // Decode
    let decoded: ArrayBuffer;
    try {
      const t0 = performance.now();
      decoded = await this.decode.decode(result.bytes, result.wireFormat, result.dataType);
      this.decodeTimes.push(performance.now() - t0);
      if (this.decodeTimes.length > 100) this.decodeTimes.shift();
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.inFlightBytes -= responseBytes;
      this.inFlight.delete(key);
      return;
    }

    // Remove from in-flight
    this.inFlightBytes -= responseBytes;
    this.inFlight.delete(key);

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
      insertedAt: this.insertCounter++,
      epochs: { ...this.currentEpochs },
      dataType: result.dataType,
    };

    if (lane === "overview") {
      this.evictIfNeeded(this.overviewCache, this.config.overviewBudgetBytes, decoded.byteLength, "overview");
      this.insertEntry(this.overviewCache, cacheEntry);
      this.overviewBytes += decoded.byteLength;
    } else {
      this.evictIfNeeded(this.detailCache, this.config.detailBudgetBytes, decoded.byteLength, "detail");
      this.insertEntry(this.detailCache, cacheEntry);
      this.detailBytes += decoded.byteLength;
    }

    // Mark as ready for drain
    this.ready.push({
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
    this.startFetches();
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

  private isCached(req: ChunkRequest): boolean {
    const cache = req.lane === "overview" ? this.overviewCache : this.detailCache;
    return cache.get(req.entityId)?.has(req.chunkKey) === true;
  }

  private demoteEntity(entityId: string): void {
    const entityMap = this.detailCache.get(entityId);
    if (!entityMap) return;
    for (const entry of entityMap.values()) {
      if (entry.tier === "active-detail") {
        entry.tier = "demoted-detail";
      }
    }
  }

  private laneToTier(lane: Lane): EvictionTier {
    if (lane === "runway") return "runway";
    if (lane === "overview") return "runway"; // overview has simple LRU, tier doesn't matter
    return "active-detail";
  }

  // =========================================================================
  // Eviction
  // =========================================================================

  private evictIfNeeded(
    cache: Map<string, Map<string, CacheEntry>>,
    budget: number,
    incomingBytes: number,
    cacheType: "detail" | "overview",
  ): void {
    const currentBytes = cacheType === "detail" ? this.detailBytes : this.overviewBytes;
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
    cacheType: "detail" | "overview",
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

    for (const tier of tierOrder) {
      if (freed >= bytesNeeded) break;
      const entries = this.collectEntriesByTier(cache, tier as EvictionTier);
      entries.sort((a, b) => a.insertedAt - b.insertedAt); // oldest first within tier

      for (const entry of entries) {
        if (freed >= bytesNeeded) break;
        this.removeEntry(cache, entry, "detail");
        freed += entry.sizeBytes;
      }
    }
  }

  private removeEntry(
    cache: Map<string, Map<string, CacheEntry>>,
    entry: CacheEntry,
    cacheType: "detail" | "overview",
  ): void {
    const entityMap = cache.get(entry.entityId);
    if (entityMap) {
      entityMap.delete(entry.chunkKey);
      if (entityMap.size === 0) cache.delete(entry.entityId);
    }
    if (cacheType === "detail") this.detailBytes -= entry.sizeBytes;
    else this.overviewBytes -= entry.sizeBytes;
    this.evictionCount++;
    this.lastEvictionTime = performance.now();
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
        return ["runway", "demoted-detail", "active-detail"];
      case "scrubbing":
        return ["demoted-detail", "active-detail", "runway"];
      case "idle":
      default:
        return ["runway", "demoted-detail", "active-detail"];
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private compositeKey(req: ChunkRequest): string {
    return `${req.entityId}/${req.chunkKey}`;
  }
}
