import { describe, it, expect, vi, beforeEach } from "vitest";
import { CpuCache, type ReadyDelivery, type CpuCacheConfig } from "./cpuCache.ts";
import type { ContentSource, FetchRequest, FetchResult } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { ChunkRequest, ActiveSetEntry, PlanningEpochs, RequestPlan } from "./planning.ts";

// ---------------------------------------------------------------------------
// Test Factories
// ---------------------------------------------------------------------------

interface MockContentSource extends ContentSource {
  pendingFetches: Map<string, { resolve: (r: FetchResult) => void; reject: (e: Error) => void }>;
  fetchCount: number;
  lastSignal: AbortSignal | null;
  resolve(compositeKey: string, bytes?: ArrayBuffer, dataType?: string): void;
  reject(compositeKey: string, error: Error): void;
  /** Auto-resolve mode: immediately resolves fetches with a buffer of the given size. */
  autoResolveBytes: number | null;
}

function createMockContentSource(): MockContentSource {
  const pendingFetches = new Map<string, { resolve: (r: FetchResult) => void; reject: (e: Error) => void }>();
  let fetchCount = 0;
  let lastSignal: AbortSignal | null = null;
  let autoResolveBytes: number | null = null;

  const source: MockContentSource = {
    pendingFetches,
    fetchCount: 0,
    lastSignal: null,
    autoResolveBytes: null,

    fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
      fetchCount++;
      source.fetchCount = fetchCount;
      lastSignal = signal;
      source.lastSignal = signal;

      const key = `${request.datasetId}/${request.imageId}/${request.chunkKey}`;

      if (autoResolveBytes !== null || source.autoResolveBytes !== null) {
        const size = source.autoResolveBytes ?? autoResolveBytes ?? 64;
        return Promise.resolve({
          bytes: new ArrayBuffer(size),
          wireFormat: { Raw: { data_type: "uint16" } },
          dataType: "uint16",
        });
      }

      return new Promise<FetchResult>((resolve, reject) => {
        pendingFetches.set(key, { resolve, reject });
        signal.addEventListener("abort", () => {
          pendingFetches.delete(key);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },

    resolve(compositeKey: string, bytes?: ArrayBuffer, dataType?: string) {
      const entry = pendingFetches.get(compositeKey);
      if (entry) {
        pendingFetches.delete(compositeKey);
        entry.resolve({
          bytes: bytes ?? new ArrayBuffer(64),
          wireFormat: { Raw: { data_type: dataType ?? "uint16" } },
          dataType: dataType ?? "uint16",
        });
      }
    },

    reject(compositeKey: string, error: Error) {
      const entry = pendingFetches.get(compositeKey);
      if (entry) {
        pendingFetches.delete(compositeKey);
        entry.reject(error);
      }
    },
  };

  return source;
}

/** Synchronous pass-through decode — no workers, returns input as-is. */
function createSyncDecode(): DecodePool {
  return {
    decode: (bytes: ArrayBuffer) => Promise.resolve(bytes),
    activeCount: () => 0,
    get size() { return 3; },
    terminate: () => {},
  } as unknown as DecodePool;
}

function makeRequest(overrides?: Partial<ChunkRequest>): ChunkRequest {
  return {
    entityId: "entity-1",
    imageId: "image-1",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    lane: "detail",
    priority: 0,
    chunkKey: `${overrides?.level ?? 0}/${overrides?.t ?? 0}/${overrides?.c ?? 0}/${overrides?.z ?? 0}/${overrides?.y ?? 0}/${overrides?.x ?? 0}`,
    ...overrides,
  };
}

function makePlan(
  requests: ChunkRequest[],
  activeSet?: ActiveSetEntry[],
  epochs?: Partial<PlanningEpochs>,
): RequestPlan {
  return {
    requests,
    activeSet: activeSet ?? [{
      entityId: "entity-1",
      imageId: "image-1",
      representation: "detail",
      targetLod: 0,
      seedDetailLod: 2,
      detailOwnedLodRange: [0, 2],
    }],
    epochs: {
      content: 1,
      layout: 1,
      view: 1,
      selection: 1,
      asset: 0,
      request: 1,
      ...epochs,
    },
  };
}

function makeActiveEntry(entityId: string, imageId?: string): ActiveSetEntry {
  return {
    entityId,
    imageId: imageId ?? entityId.replace("entity", "image"),
    representation: "detail",
    targetLod: 0,
    seedDetailLod: 2,
    detailOwnedLodRange: [0, 2],
  };
}

function createTestCache(configOverrides?: Partial<CpuCacheConfig>) {
  const source = createMockContentSource();
  const decode = createSyncDecode();
  const cache = new CpuCache(source, decode, configOverrides);
  return { cache, source, decode };
}

/** Flush microtask queue to let async fetch/decode complete. */
async function flush() {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CpuCache", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Submit/drain lifecycle
  // =========================================================================

  describe("submit/drain lifecycle", () => {
    it("submit plan → source resolves → drain returns delivery", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ x: 0, y: 0, z: 0 });
      cache.submit(makePlan([req]));

      // Source should have been called
      expect(source.fetchCount).toBe(1);

      // Resolve the fetch
      source.resolve("entity-1/image-1/0/0/0/0/0/0");
      await flush();

      // Drain should return the delivery
      const deliveries = cache.drain(Infinity);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].entityId).toBe("entity-1");
      expect(deliveries[0].chunkKey).toBe("0/0/0/0/0/0");
      expect(deliveries[0].lane).toBe("detail");
    });

    it("drain returns empty when nothing ready", () => {
      const { cache } = createTestCache();
      expect(cache.drain(Infinity)).toHaveLength(0);
    });

    it("drain respects budget", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 100;
      const reqs = [
        makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" }),
      ];
      cache.submit(makePlan(reqs));
      await flush();

      // Only drain 150 bytes worth (should get 2 of 3 at 100 bytes each)
      const first = cache.drain(150);
      expect(first).toHaveLength(2);

      // Remaining delivery available on next drain
      const second = cache.drain(Infinity);
      expect(second).toHaveLength(1);
    });

    it("drained deliveries are not re-returned", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.submit(makePlan([makeRequest()]));
      await flush();

      cache.drain(Infinity);
      expect(cache.drain(Infinity)).toHaveLength(0);
    });
  });

  // =========================================================================
  // In-flight dedup
  // =========================================================================

  describe("in-flight dedup", () => {
    it("does not duplicate fetches for same chunk in consecutive submits", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest();
      cache.submit(makePlan([req]));
      cache.submit(makePlan([req]));

      expect(source.fetchCount).toBe(1);
    });

    it("does not re-fetch cached chunks", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest();
      source.autoResolveBytes = 64;
      cache.submit(makePlan([req]));
      await flush();

      // Submit again — should be a cache hit
      source.fetchCount = 0;
      cache.submit(makePlan([req]));
      expect(source.fetchCount).toBe(0);
    });
  });

  // =========================================================================
  // Fetch cancellation
  // =========================================================================

  describe("fetch cancellation", () => {
    it("aborts in-flight fetches not in new plan", async () => {
      const { cache, source } = createTestCache();
      const reqA = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const reqB = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });

      cache.submit(makePlan([reqA]));
      expect(source.pendingFetches.size).toBe(1);

      // Submit new plan with only reqB — reqA should be aborted
      cache.submit(makePlan([reqB]));

      // reqA's fetch should have been aborted (removed from pending)
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
      // reqB should be in-flight
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/1")).toBe(true);
    });
  });

  // =========================================================================
  // Cache snapshot
  // =========================================================================

  describe("cache snapshot", () => {
    it("returns cached and in-flight keys", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      const cached = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([cached]));
      await flush();

      // Add an in-flight request
      source.autoResolveBytes = null;
      const inflight = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([cached, inflight]));

      const snap = cache.snapshot();
      expect(snap.cached.get("entity-1")?.has("0/0/0/0/0/0")).toBe(true);
      expect(snap.inFlight.get("entity-1")?.has("0/0/0/0/0/1")).toBe(true);
    });
  });

  // =========================================================================
  // Multi-channel
  // =========================================================================

  describe("multi-channel", () => {
    it("caches channels independently", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      const c0 = makeRequest({ c: 0, chunkKey: "0/0/0/0/0/0" });
      const c2 = makeRequest({ c: 2, chunkKey: "0/0/2/0/0/0" });

      cache.submit(makePlan([c0, c2]));
      await flush();

      const snap = cache.snapshot();
      const keys = snap.cached.get("entity-1")!;
      expect(keys.has("0/0/0/0/0/0")).toBe(true);
      expect(keys.has("0/0/2/0/0/0")).toBe(true);
    });
  });

  // =========================================================================
  // Demotion
  // =========================================================================

  describe("demotion", () => {
    it("demotes entity entries when entity leaves active set", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      const req = makeRequest({ entityId: "entity-1", chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([req], [makeActiveEntry("entity-1")]));
      await flush();

      // Submit new plan without entity-1 in active set
      cache.submit(makePlan([], [makeActiveEntry("entity-2")]));

      // Entity-1 should still be cached (demoted, not evicted)
      const snap = cache.snapshot();
      expect(snap.cached.get("entity-1")?.has("0/0/0/0/0/0")).toBe(true);
    });
  });

  // =========================================================================
  // Eviction tiers
  // =========================================================================

  describe("eviction tiers", () => {
    it("evicts runway before active-detail under budget pressure", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ detailBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Insert a detail chunk and a runway chunk
      const detail = makeRequest({ x: 0, lane: "detail", chunkKey: "0/0/0/0/0/0" });
      const runway = makeRequest({ x: 1, lane: "runway", chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([detail, runway]));
      await flush();

      // Both should be cached (200 bytes < 256 budget)
      let snap = cache.snapshot();
      expect(snap.cached.get("entity-1")?.size).toBe(2);

      // Insert another chunk that forces eviction (300 > 256)
      const extra = makeRequest({ x: 2, lane: "detail", chunkKey: "0/0/0/0/0/2" });
      cache.submit(makePlan([detail, runway, extra]));
      await flush();

      // Runway should be evicted first
      snap = cache.snapshot();
      const keys = snap.cached.get("entity-1")!;
      expect(keys.has("0/0/0/0/0/1")).toBe(false); // runway evicted
      expect(keys.has("0/0/0/0/0/0")).toBe(true);  // detail kept
      expect(keys.has("0/0/0/0/0/2")).toBe(true);  // new detail kept
    });

    it("evicts demoted before active-detail", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ detailBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Insert chunk for entity-1
      const e1 = makeRequest({ entityId: "entity-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([e1], [makeActiveEntry("entity-1")]));
      await flush();

      // Demote entity-1 by submitting with entity-2 as active
      const e2 = makeRequest({ entityId: "entity-2", imageId: "image-2", chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([e2], [makeActiveEntry("entity-2")]));
      await flush();

      // Both cached (200 < 256)
      let snap = cache.snapshot();
      expect(snap.cached.has("entity-1")).toBe(true);
      expect(snap.cached.has("entity-2")).toBe(true);

      // Insert another chunk for entity-2 to trigger eviction
      const e2b = makeRequest({ entityId: "entity-2", imageId: "image-2", x: 1, chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([e2, e2b], [makeActiveEntry("entity-2")]));
      await flush();

      // Demoted entity-1 should be evicted first
      snap = cache.snapshot();
      expect(snap.cached.has("entity-1")).toBe(false); // demoted, evicted
      expect(snap.cached.get("entity-2")?.size).toBe(2); // active, kept
    });
  });

  // =========================================================================
  // Adaptive eviction
  // =========================================================================

  describe("adaptive eviction", () => {
    it("detects panning from viewEpoch velocity", () => {
      const { cache } = createTestCache();

      // Simulate rapid viewEpoch bumps
      for (let i = 0; i < 5; i++) {
        cache.submit(makePlan([], [], { view: i + 1, selection: 1 }));
      }

      const tel = cache.telemetry();
      expect(tel.interactionMode).toBe("panning");
    });

    it("detects scrubbing from selectionEpoch velocity", () => {
      const { cache } = createTestCache();

      // Simulate rapid selectionEpoch bumps
      for (let i = 0; i < 5; i++) {
        cache.submit(makePlan([], [], { view: 1, selection: i + 1 }));
      }

      const tel = cache.telemetry();
      expect(tel.interactionMode).toBe("scrubbing");
    });

    it("reports idle when no epochs bumping", () => {
      const { cache } = createTestCache();

      // Same epochs every submit
      for (let i = 0; i < 5; i++) {
        cache.submit(makePlan([], [], { view: 1, selection: 1 }));
      }

      const tel = cache.telemetry();
      expect(tel.interactionMode).toBe("idle");
    });

    it("scrubbing mode protects runway over demoted", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ detailBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Force scrubbing mode via selectionEpoch velocity
      for (let i = 0; i < 5; i++) {
        cache.submit(makePlan([], [], { view: 1, selection: i + 1 }));
      }

      // Insert a detail chunk for entity-1 (will be demoted later)
      const e1detail = makeRequest({ entityId: "entity-1", imageId: "image-1", lane: "detail", chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([e1detail], [makeActiveEntry("entity-1")], { view: 1, selection: 6 }));
      await flush();

      // Demote entity-1 by switching active set to entity-2, and add a runway chunk
      const runway = makeRequest({ entityId: "entity-2", imageId: "image-2", lane: "runway", chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([e1detail, runway], [makeActiveEntry("entity-2")], { view: 1, selection: 7 }));
      await flush();

      // Add one more active-detail to force eviction (300 > 256)
      const e2detail = makeRequest({ entityId: "entity-2", imageId: "image-2", lane: "detail", chunkKey: "0/0/0/0/0/2" });
      cache.submit(makePlan([e1detail, runway, e2detail], [makeActiveEntry("entity-2")], { view: 1, selection: 8 }));
      await flush();

      // In scrubbing mode: demoted evicts first, runway protected
      const snap = cache.snapshot();
      expect(snap.cached.has("entity-1")).toBe(false); // demoted-detail, evicted first
      expect(snap.cached.get("entity-2")?.has("0/0/0/0/0/1")).toBe(true); // runway, protected
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe("error handling", () => {
    it("retries transient errors once", async () => {
      vi.useFakeTimers();
      const { cache, source } = createTestCache();
      const req = makeRequest();
      cache.submit(makePlan([req]));

      // Reject with a transient error
      source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("Network error"));
      await vi.advanceTimersByTimeAsync(0);

      // After retry delay, should try again
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);

      // Should have a second pending fetch
      expect(source.fetchCount).toBe(2);
    });

    it("does not retry permanent errors", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest();
      cache.submit(makePlan([req]));

      source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("404 not found"));
      await flush();

      expect(source.fetchCount).toBe(1); // no retry
    });

    it("excludes failed chunks from future submits until contentEpoch changes", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest();
      cache.submit(makePlan([req], undefined, { content: 1 }));

      source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("404 not found"));
      // Multiple flushes to ensure the async error handling chain completes
      await flush();
      await flush();

      // Submit again with same contentEpoch — should not re-fetch
      const fetchesBefore = source.fetchCount;
      cache.submit(makePlan([req], undefined, { content: 1 }));
      expect(source.fetchCount).toBe(fetchesBefore); // no new fetch

      // Submit with bumped contentEpoch — should re-fetch
      const fetchesBefore2 = source.fetchCount;
      cache.submit(makePlan([req], undefined, { content: 2 }));
      expect(source.fetchCount).toBe(fetchesBefore2 + 1);
    });

    it("reports errors in telemetry", async () => {
      const { cache, source } = createTestCache();
      cache.submit(makePlan([makeRequest()]));
      source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("404 not found"));
      await flush();

      const tel = cache.telemetry();
      expect(tel.failedChunks.permanent).toBe(1);
      expect(tel.lastError).toContain("404");
    });
  });

  // =========================================================================
  // Budget enforcement
  // =========================================================================

  describe("budget enforcement", () => {
    it("evicts when exceeding detail budget", async () => {
      const budget = 200;
      const { cache, source } = createTestCache({ detailBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Insert 3 chunks (300 bytes > 200 budget)
      const reqs = [
        makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" }),
      ];
      cache.submit(makePlan(reqs));
      await flush();

      // Should have evicted to stay under budget
      const tel = cache.telemetry();
      expect(tel.detailBytes).toBeLessThanOrEqual(budget);
    });

    it("overview and detail budgets are independent", async () => {
      const { cache, source } = createTestCache({
        detailBudgetBytes: 200,
        overviewBudgetBytes: 200,
      });
      source.autoResolveBytes = 100;

      // Fill detail
      const detail = [
        makeRequest({ lane: "detail", x: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ lane: "detail", x: 1, chunkKey: "0/0/0/0/0/1" }),
      ];
      cache.submit(makePlan(detail));
      await flush();

      // Fill overview
      const overview = [
        makeRequest({ lane: "overview", x: 0, chunkKey: "0/0/0/0/0/2" }),
        makeRequest({ lane: "overview", x: 1, chunkKey: "0/0/0/0/0/3" }),
      ];
      cache.submit(makePlan([...detail, ...overview]));
      await flush();

      const tel = cache.telemetry();
      expect(tel.detailBytes).toBe(200);
      expect(tel.overviewBytes).toBe(200);
    });
  });

  // =========================================================================
  // getCached
  // =========================================================================

  describe("getCached", () => {
    it("returns cached detail entry", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ x: 0, y: 0, z: 0 });
      cache.submit(makePlan([req]));

      source.resolve("entity-1/image-1/0/0/0/0/0/0", new ArrayBuffer(64), "uint16");
      await flush();

      const result = cache.getCached("entity-1", "0/0/0/0/0/0");
      expect(result).not.toBeNull();
      expect(result!.entityId).toBe("entity-1");
      expect(result!.imageId).toBe("image-1");
      expect(result!.chunkKey).toBe("0/0/0/0/0/0");
      expect(result!.lane).toBe("detail");
      expect(result!.dataType).toBe("uint16");
      expect(result!.data.byteLength).toBe(64);
    });

    it("returns null for missing chunk", () => {
      const { cache } = createTestCache();
      expect(cache.getCached("no-such-entity", "0/0/0/0/0/0")).toBeNull();
    });

    it("returns entry after drain", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      const req = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([req]));
      await flush();

      // Drain removes from ready queue but NOT from cache
      cache.drain(Infinity);

      const result = cache.getCached("entity-1", "0/0/0/0/0/0");
      expect(result).not.toBeNull();
      expect(result!.entityId).toBe("entity-1");
      expect(result!.chunkKey).toBe("0/0/0/0/0/0");
    });

    it("returns null after eviction", async () => {
      const budget = 200;
      const { cache, source } = createTestCache({ detailBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Insert 2 chunks (200 bytes = budget, oldest first)
      const first = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([first]));
      await flush();

      const second = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([first, second]));
      await flush();

      // Both cached at this point
      expect(cache.getCached("entity-1", "0/0/0/0/0/0")).not.toBeNull();
      expect(cache.getCached("entity-1", "0/0/0/0/0/1")).not.toBeNull();

      // Insert a third chunk to trigger eviction (300 > 200)
      const third = makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" });
      cache.submit(makePlan([first, second, third]));
      await flush();

      // Oldest chunk should have been evicted
      expect(cache.getCached("entity-1", "0/0/0/0/0/0")).toBeNull();
      // Newer chunks should still be cached
      expect(cache.getCached("entity-1", "0/0/0/0/0/1")).not.toBeNull();
      expect(cache.getCached("entity-1", "0/0/0/0/0/2")).not.toBeNull();
    });
  });

  // =========================================================================
  // Reset
  // =========================================================================

  describe("reset", () => {
    it("clears all state", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.submit(makePlan([makeRequest()]));
      await flush();

      cache.reset();

      const snap = cache.snapshot();
      expect(snap.cached.size).toBe(0);
      expect(snap.inFlight.size).toBe(0);
      expect(cache.drain(Infinity)).toHaveLength(0);

      const tel = cache.telemetry();
      expect(tel.detailBytes).toBe(0);
      expect(tel.overviewBytes).toBe(0);
    });
  });
});

// Re-export for use in error handling tests with fake timers
import { TRANSIENT_RETRY_DELAY_MS } from "./cpuCache.ts";
