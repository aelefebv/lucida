import { describe, it, expect, vi, beforeEach } from "vitest";
import { CpuCache, type CpuCacheConfig } from "./cpuCache.ts";
import type {
  ContentSource,
  FetchRequest,
  FetchResult,
  FetchProxyRequest,
  FetchProxyResult,
  ProxyHeaderJs,
} from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type {
  ChunkRequest,
  ActiveSetEntry,
  ProxyRequest,
  RequestPlan,
} from "./planning/index.ts";
import type { SceneEpochs } from "./epochs.ts";
import { emptyPlanStats } from "./planning/index.ts";

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

  // Proxy fetch state — mirrors the chunk side.
  fetchProxyCount: number;
  fetchProxyCalls: FetchProxyRequest[];
  /** Default header used when auto-resolving proxies. */
  proxyHeader: ProxyHeaderJs;
  /** Auto-resolve proxies with this many voxel bytes. */
  autoResolveProxyBytes: number | null;
}

function createMockContentSource(): MockContentSource {
  const pendingFetches = new Map<string, { resolve: (r: FetchResult) => void; reject: (e: Error) => void }>();
  let fetchCount = 0;
  const autoResolveBytes: number | null = null;

  const source: MockContentSource = {
    pendingFetches,
    fetchCount: 0,
    lastSignal: null,
    autoResolveBytes: null,

    fetchProxyCount: 0,
    fetchProxyCalls: [],
    proxyHeader: {
      algorithmVersion: 1,
      sourceContentHash: new Uint8Array(32),
      dims: [4, 4, 4],
      dtype: "u16",
    },
    autoResolveProxyBytes: 4 * 4 * 4 * 2,

    fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
      fetchCount++;
      source.fetchCount = fetchCount;
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

    fetchProxy(request: FetchProxyRequest, _signal: AbortSignal): Promise<FetchProxyResult> {
      source.fetchProxyCount++;
      source.fetchProxyCalls.push(request);
      const bytes = source.autoResolveProxyBytes ?? 64;
      return Promise.resolve({
        header: source.proxyHeader,
        data: new ArrayBuffer(bytes),
        wireFormat: { Raw: { data_type: "uint16" } },
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
    datasetId: "entity-1",
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
  epochs?: Partial<SceneEpochs>,
): RequestPlan {
  // PRD #563 / Slice 4: ActiveSetEntry is a discriminated union; the
  // default fixture builds a single FieldEntry.
  const resolvedActiveSet: ActiveSetEntry[] = activeSet ?? [{
    kind: "field",
    entityId: "entity-1",
    imageId: "image-1",
    mode: "fields-with-detail",
    targetLod: 0,
    coarsestDetailLod: 2,
    detailOwnedLodRange: [0, 2],
    proxyKind: undefined,
    proxyAvailable: false,
    wellProxyAvailable: false,
  }];
  return {
    requests,
    activeSet: resolvedActiveSet,
    proxyRequests: [],
    epochs: {
      content: 1,
      layout: 1,
      view: 1,
      selection: 1,
      asset: 0,
      request: 1,
      ...epochs,
    },
    stats: emptyPlanStats(),
    // PRD #563 / Slice 3: nextState mirrors what plan() returns —
    // `previousActiveSet: activeSet` for the v1 single-field state.
    nextState: { previousActiveSet: resolvedActiveSet },
  };
}

function makeActiveEntry(entityId: string, imageId?: string): ActiveSetEntry {
  return {
    kind: "field",
    entityId,
    imageId: imageId ?? entityId.replace("entity", "image"),
    mode: "fields-with-detail",
    targetLod: 0,
    coarsestDetailLod: 2,
    detailOwnedLodRange: [0, 2],
    proxyKind: undefined,
    proxyAvailable: false,
    wellProxyAvailable: false,
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
      const delivery = deliveries[0];
      if (delivery.kind === "proxy") throw new Error("expected chunk delivery");
      expect(delivery.chunkKey).toBe("0/0/0/0/0/0");
      expect(delivery.lane).toBe("detail");
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
  // Fetch lifecycle decoupled from plan omission (PRD #420)
  // =========================================================================

  describe("fetch lifecycle decoupled from plan omission", () => {
    it("submit twice with overlapping requests does not cancel first batch's in-flight", async () => {
      const { cache, source } = createTestCache();
      const reqA = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const reqB = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });

      cache.submit(makePlan([reqA, reqB]));
      expect(source.pendingFetches.size).toBe(2);

      // Submit again with only reqB — reqA must remain in-flight.
      cache.submit(makePlan([reqB]));

      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/1")).toBe(true);
      expect(cache.telemetry().inFlightCount).toBe(2);
    });

    it("submit with smaller plan keeps prior in-flight alive", async () => {
      const { cache, source } = createTestCache();
      const reqA = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const reqB = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });

      cache.submit(makePlan([reqA, reqB]));
      expect(cache.telemetry().inFlightCount).toBe(2);

      // Smaller plan that omits reqA. The in-flight fetch must persist.
      cache.submit(makePlan([reqB]));
      expect(cache.telemetry().inFlightCount).toBe(2);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);
    });

    it("submit with empty plan does not cancel in-flight", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });

      cache.submit(makePlan([req]));
      expect(cache.telemetry().inFlightCount).toBe(1);

      // Empty plan must not abort prior in-flight fetches.
      cache.submit(makePlan([]));
      expect(cache.telemetry().inFlightCount).toBe(1);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);
    });

    it("re-submitting an unchanged plan is a no-op for the fetch queue", () => {
      const { cache, source } = createTestCache();
      const req = makeRequest();

      cache.submit(makePlan([req]));
      expect(source.fetchCount).toBe(1);

      cache.submit(makePlan([req]));
      cache.submit(makePlan([req]));
      expect(source.fetchCount).toBe(1);
    });

    it("submit with empty proxy plan does not cancel in-flight proxy", () => {
      const { cache, source } = createTestCache();
      const proxyReq: ProxyRequest = {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "FieldProxy3D",
        t: 0,
        c: 0,
        priority: 0,
      };

      // Block fetchProxy by overriding to never resolve.
      let proxyResolve: (() => void) | null = null;
      source.fetchProxy = (_req, signal) => {
        source.fetchProxyCount++;
        return new Promise((resolve, reject) => {
          proxyResolve = () => resolve({
            header: source.proxyHeader,
            data: new ArrayBuffer(64),
            wireFormat: { Raw: { data_type: "uint16" } },
          });
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };

      cache.submit({
        requests: [],
        activeSet: [],
        proxyRequests: [proxyReq],
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        stats: emptyPlanStats(),
        nextState: { previousActiveSet: [] },
      });
      expect(cache.telemetry().inFlightProxyCount).toBe(1);

      // Submit again with no proxies — must not abort.
      cache.submit(makePlan([]));
      expect(cache.telemetry().inFlightProxyCount).toBe(1);

      // Cleanup so promise doesn't dangle.
      void proxyResolve;
    });
  });

  // =========================================================================
  // cancelDataset (PRD #420)
  // =========================================================================

  describe("cancelDataset", () => {
    function makeProxyRequest(overrides?: Partial<ProxyRequest>): ProxyRequest {
      return {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "FieldProxy3D",
        t: 0,
        c: 0,
        priority: 0,
        ...overrides,
      };
    }

    function makeProxyPlan(
      proxyRequests: ProxyRequest[],
      epochs?: Partial<SceneEpochs>,
    ): RequestPlan {
      return {
        requests: [],
        activeSet: [],
        proxyRequests,
        epochs: {
          content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1,
          ...epochs,
        },
        stats: emptyPlanStats(),
        nextState: { previousActiveSet: [] },
      };
    }

    it("cancels in-flight chunks matching entityIds; preserves bytes accounting", () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ entityId: "entity-1" });

      cache.submit(makePlan([req]));
      expect(cache.telemetry().inFlightCount).toBe(1);

      cache.cancelDataset("ds-1", ["entity-1"]);

      expect(cache.telemetry().inFlightCount).toBe(0);
      expect(cache.telemetry().inFlightBytes).toBe(0);
      // Source's pending fetch should have been removed (abort triggers reject).
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
    });

    it("cancels in-flight proxies matching datasetId; preserves bytes accounting", () => {
      const { cache, source } = createTestCache();
      const proxyReq = makeProxyRequest();

      // Block fetchProxy with a never-resolving promise so the entry stays in-flight.
      let pendingResolve: ((v: FetchProxyResult) => void) | null = null;
      source.fetchProxy = (_req, signal) => {
        source.fetchProxyCount++;
        return new Promise<FetchProxyResult>((resolve, reject) => {
          pendingResolve = resolve;
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };
      cache.submit(makeProxyPlan([proxyReq]));
      expect(cache.telemetry().inFlightProxyCount).toBe(1);

      cache.cancelDataset("ds-1", []);

      expect(cache.telemetry().inFlightProxyCount).toBe(0);
      expect(cache.telemetry().inFlightProxyBytes).toBe(0);
      void pendingResolve;
    });

    it("clears pending queue entries (chunks + proxies)", () => {
      const { cache } = createTestCache({
        maxConcurrentFetches: 1,
        maxBytesInFlight: 1, // throttle so subsequent requests sit in pending queue
      });
      const reqA = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const reqB = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });
      const proxyReq: ProxyRequest = {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "FieldProxy3D",
        t: 0, c: 0, priority: 0,
      };

      cache.submit({
        requests: [reqA, reqB],
        activeSet: [],
        proxyRequests: [proxyReq],
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        stats: emptyPlanStats(),
        nextState: { previousActiveSet: [] },
      });

      // At least one request should be queued.
      const tel = cache.telemetry();
      expect(tel.pendingCount + tel.inFlightCount).toBeGreaterThan(0);

      cache.cancelDataset("ds-1", ["entity-1"]);

      const after = cache.telemetry();
      expect(after.pendingCount).toBe(0);
      expect(after.pendingProxyCount).toBe(0);
    });

    it("drops cached chunks (detail + overview); subtracts bytes", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 100;

      const detailReq = makeRequest({ entityId: "entity-1", lane: "detail", chunkKey: "0/0/0/0/0/0" });
      const overviewReq = makeRequest({ entityId: "entity-1", lane: "overview", chunkKey: "0/0/0/0/0/1" });

      cache.submit(makePlan([detailReq, overviewReq]));
      await flush();

      expect(cache.telemetry().mainBytes).toBe(100);
      expect(cache.telemetry().overviewBytes).toBe(100);
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/0")).not.toBeNull();
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/1")).not.toBeNull();

      cache.cancelDataset("ds-1", ["entity-1"]);

      expect(cache.telemetry().mainBytes).toBe(0);
      expect(cache.telemetry().overviewBytes).toBe(0);
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/0")).toBeNull();
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/1")).toBeNull();
    });

    it("drops cached proxies; subtracts bytes", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveProxyBytes = 256;

      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      expect(cache.telemetry().proxyBytes).toBe(256);
      expect(cache.getCachedProxy("ds-1", "entity-1", "FieldProxy3D", 0, 0)).not.toBeNull();

      cache.cancelDataset("ds-1", ["entity-1"]);

      expect(cache.telemetry().proxyBytes).toBe(0);
      expect(cache.getCachedProxy("ds-1", "entity-1", "FieldProxy3D", 0, 0)).toBeNull();
    });

    it("clears ready deliveries", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      cache.submit(makePlan([
        makeRequest({ entityId: "entity-1", chunkKey: "0/0/0/0/0/0" }),
      ]));
      await flush();
      // Don't drain — leave delivery in the ready queue.

      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      cache.cancelDataset("ds-1", ["entity-1"]);

      expect(cache.drain(Infinity)).toHaveLength(0);
    });

    it("clears failures map entries for entityIds", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ entityId: "entity-1" });
      cache.submit(makePlan([req]));

      source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("404 not found"));
      await flush();
      await flush();

      expect(cache.telemetry().failedChunks.permanent).toBe(1);

      // After cancelDataset, re-submitting with the same content epoch should
      // re-fetch (failure entry was cleared).
      cache.cancelDataset("ds-1", ["entity-1"]);
      const fetchesBefore = source.fetchCount;
      cache.submit(makePlan([req], undefined, { content: 1 }));
      expect(source.fetchCount).toBe(fetchesBefore + 1);
    });

    it("removes activeEntityIds entries", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      // Insert + cache a detail chunk for entity-1, marked active.
      const req = makeRequest({ entityId: "entity-1", chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([req], [makeActiveEntry("entity-1")]));
      await flush();

      cache.cancelDataset("ds-1", ["entity-1"]);

      // Now submit a plan with NO entity-1 in activeSet. If activeEntityIds
      // still contained "entity-1", demoteEntity would be called — but the
      // detail map is already empty, so this is a sanity check that no entry
      // remains. We assert via the mainCache being empty (already covered)
      // and that re-adding entity-1 then dropping it from the active set
      // doesn't crash.
      cache.submit(makePlan([], [makeActiveEntry("entity-2")]));

      // No crash, snapshot should reflect entity-1 fully gone.
      const snap = cache.snapshot();
      expect(snap.cached.has("entity-1")).toBe(false);
      expect(snap.inFlight.has("entity-1")).toBe(false);
    });

    it("does not touch other datasets' state", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      source.autoResolveProxyBytes = 128;

      // Dataset A
      const reqA = makeRequest({ entityId: "entity-A", imageId: "image-A", chunkKey: "0/0/0/0/0/0" });
      const proxyA: ProxyRequest = {
        datasetId: "ds-A", entityId: "entity-A", imageId: "image-A",
        kind: "FieldProxy3D", t: 0, c: 0, priority: 0,
      };
      cache.submit({
        requests: [reqA],
        activeSet: [makeActiveEntry("entity-A", "image-A")],
        proxyRequests: [proxyA],
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        stats: emptyPlanStats(),
        nextState: { previousActiveSet: [] },
      });
      await flush();

      // Dataset B
      const reqB = makeRequest({ entityId: "entity-B", imageId: "image-B", chunkKey: "0/0/0/0/0/0" });
      const proxyB: ProxyRequest = {
        datasetId: "ds-B", entityId: "entity-B", imageId: "image-B",
        kind: "FieldProxy3D", t: 0, c: 0, priority: 0,
      };
      cache.submit({
        requests: [reqB],
        activeSet: [makeActiveEntry("entity-B", "image-B")],
        proxyRequests: [proxyB],
        epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
        stats: emptyPlanStats(),
        nextState: { previousActiveSet: [] },
      });
      await flush();

      const beforeDetailB = cache.getCachedChunk("entity-B", "0/0/0/0/0/0");
      const beforeProxyB = cache.getCachedProxy("ds-B", "entity-B", "FieldProxy3D", 0, 0);
      expect(beforeDetailB).not.toBeNull();
      expect(beforeProxyB).not.toBeNull();
      const mainBytesBoth = cache.telemetry().mainBytes;
      const proxyBytesBoth = cache.telemetry().proxyBytes;

      cache.cancelDataset("ds-A", ["entity-A"]);

      // Dataset A is gone.
      expect(cache.getCachedChunk("entity-A", "0/0/0/0/0/0")).toBeNull();
      expect(cache.getCachedProxy("ds-A", "entity-A", "FieldProxy3D", 0, 0)).toBeNull();
      // Dataset B is intact.
      expect(cache.getCachedChunk("entity-B", "0/0/0/0/0/0")).not.toBeNull();
      expect(cache.getCachedProxy("ds-B", "entity-B", "FieldProxy3D", 0, 0)).not.toBeNull();
      // Bytes accounting reflects only A's data was subtracted.
      expect(cache.telemetry().mainBytes).toBe(mainBytesBoth - 64);
      expect(cache.telemetry().proxyBytes).toBe(proxyBytesBoth - 128);
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
    it("evicts prefetch before active-detail under budget pressure", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ mainBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Insert a detail chunk and a prefetch chunk
      const detail = makeRequest({ x: 0, lane: "detail", chunkKey: "0/0/0/0/0/0" });
      const prefetch = makeRequest({ x: 1, lane: "prefetch", chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([detail, prefetch]));
      await flush();

      // Both should be cached (200 bytes < 256 budget)
      let snap = cache.snapshot();
      expect(snap.cached.get("entity-1")?.size).toBe(2);

      // Insert another chunk that forces eviction (300 > 256)
      const extra = makeRequest({ x: 2, lane: "detail", chunkKey: "0/0/0/0/0/2" });
      cache.submit(makePlan([detail, prefetch, extra]));
      await flush();

      // Prefetch should be evicted first
      snap = cache.snapshot();
      const keys = snap.cached.get("entity-1")!;
      expect(keys.has("0/0/0/0/0/1")).toBe(false); // prefetch evicted
      expect(keys.has("0/0/0/0/0/0")).toBe(true);  // detail kept
      expect(keys.has("0/0/0/0/0/2")).toBe(true);  // new detail kept
    });

    it("evicts demoted before active-detail", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ mainBudgetBytes: budget });
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

    it("scrubbing mode protects prefetch over demoted", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ mainBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Force scrubbing mode via selectionEpoch velocity
      for (let i = 0; i < 5; i++) {
        cache.submit(makePlan([], [], { view: 1, selection: i + 1 }));
      }

      // Insert a detail chunk for entity-1 (will be demoted later)
      const e1detail = makeRequest({ entityId: "entity-1", imageId: "image-1", lane: "detail", chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([e1detail], [makeActiveEntry("entity-1")], { view: 1, selection: 6 }));
      await flush();

      // Demote entity-1 by switching active set to entity-2, and add a prefetch chunk
      const prefetch = makeRequest({ entityId: "entity-2", imageId: "image-2", lane: "prefetch", chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([e1detail, prefetch], [makeActiveEntry("entity-2")], { view: 1, selection: 7 }));
      await flush();

      // Add one more active-detail to force eviction (300 > 256)
      const e2detail = makeRequest({ entityId: "entity-2", imageId: "image-2", lane: "detail", chunkKey: "0/0/0/0/0/2" });
      cache.submit(makePlan([e1detail, prefetch, e2detail], [makeActiveEntry("entity-2")], { view: 1, selection: 8 }));
      await flush();

      // In scrubbing mode: demoted evicts first, prefetch protected
      const snap = cache.snapshot();
      expect(snap.cached.has("entity-1")).toBe(false); // demoted-detail, evicted first
      expect(snap.cached.get("entity-2")?.has("0/0/0/0/0/1")).toBe(true); // prefetch, protected
    });
  });

  // =========================================================================
  // Minimap lane routing (Slice 5 / ADR 0023)
  // =========================================================================
  //
  // Minimap chunks land in the overview cache (most-protected eviction
  // tier) so they survive memory pressure that would clear the main
  // cache. Combined with the planner emitting minimap at priority 0
  // (highest), the effect is "fetched first, evicted last."

  describe("minimap lane routing (Slice 5)", () => {
    it("routes lane: \"minimap\" chunks to the overview cache", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 100;

      const minimapReq = makeRequest({
        entityId: "entity-mini",
        lane: "minimap",
        chunkKey: "3/0/0/0/0/0",
      });
      cache.submit(makePlan([minimapReq]));
      await flush();

      // Bytes accounted to the overview cache, not main.
      expect(cache.telemetry().overviewBytes).toBe(100);
      expect(cache.telemetry().mainBytes).toBe(0);
    });

    it("survives main-cache eviction pressure that would clear detail chunks", async () => {
      // Set the main cache budget very small so detail must evict, but
      // leave the overview cache with its default 64 MB budget — way
      // more than this test will produce — so a minimap chunk has no
      // reason to drop.
      const { cache, source } = createTestCache({ mainBudgetBytes: 256 });
      source.autoResolveBytes = 200;

      // Insert a detail chunk that nearly fills the main cache (200/256).
      const detail = makeRequest({
        entityId: "entity-d",
        lane: "detail",
        chunkKey: "0/0/0/0/0/0",
      });
      // Insert a minimap chunk too (lands in overview cache, separate budget).
      const minimap = makeRequest({
        entityId: "entity-mini",
        lane: "minimap",
        chunkKey: "3/0/0/0/0/0",
      });
      cache.submit(makePlan([detail, minimap]));
      await flush();
      expect(cache.telemetry().overviewBytes).toBe(200);
      expect(cache.telemetry().mainBytes).toBe(200);

      // Force pressure on the main cache with two more detail chunks
      // (200 + 200 + 200 = 600 > 256 budget). Even with the most
      // aggressive eviction pattern, the minimap chunk lives in the
      // overview cache and is untouchable from this side.
      const detail2 = makeRequest({
        entityId: "entity-d",
        lane: "detail",
        chunkKey: "0/0/0/0/0/1",
      });
      const detail3 = makeRequest({
        entityId: "entity-d",
        lane: "detail",
        chunkKey: "0/0/0/0/0/2",
      });
      cache.submit(makePlan([detail, detail2, detail3, minimap]));
      await flush();

      // Main cache evicted things to fit the new detail chunks.
      expect(cache.telemetry().mainBytes).toBeLessThanOrEqual(256);
      // Minimap is intact — overview cache wasn't touched.
      const snap = cache.snapshot();
      expect(snap.cached.get("entity-mini")?.has("3/0/0/0/0/0")).toBe(true);
      expect(cache.telemetry().overviewBytes).toBe(200);
    });

    it("dedups against the overview cache on cache-hit lookups", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      const req = makeRequest({
        entityId: "entity-mini",
        lane: "minimap",
        chunkKey: "3/0/0/0/0/0",
      });
      cache.submit(makePlan([req]));
      await flush();
      expect(source.fetchCount).toBe(1);

      // Re-submit the same minimap request — should be a cache hit
      // (lookup must check the overview cache, not just mainCache).
      cache.submit(makePlan([req]));
      expect(source.fetchCount).toBe(1);
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
      const { cache, source } = createTestCache({ mainBudgetBytes: budget });
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
      expect(tel.mainBytes).toBeLessThanOrEqual(budget);
    });

    it("overview and detail budgets are independent", async () => {
      const { cache, source } = createTestCache({
        mainBudgetBytes: 200,
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
      expect(tel.mainBytes).toBe(200);
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

      const result = cache.getCachedChunk("entity-1", "0/0/0/0/0/0");
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
      expect(cache.getCachedChunk("no-such-entity", "0/0/0/0/0/0")).toBeNull();
    });

    it("returns entry after drain", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      const req = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([req]));
      await flush();

      // Drain removes from ready queue but NOT from cache
      cache.drain(Infinity);

      const result = cache.getCachedChunk("entity-1", "0/0/0/0/0/0");
      expect(result).not.toBeNull();
      expect(result!.entityId).toBe("entity-1");
      expect(result!.chunkKey).toBe("0/0/0/0/0/0");
    });

    it("returns null after eviction", async () => {
      const budget = 200;
      const { cache, source } = createTestCache({ mainBudgetBytes: budget });
      source.autoResolveBytes = 100;

      // Insert 2 chunks (200 bytes = budget, oldest first)
      const first = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([first]));
      await flush();

      const second = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });
      cache.submit(makePlan([first, second]));
      await flush();

      // Both cached at this point
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/0")).not.toBeNull();
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/1")).not.toBeNull();

      // Insert a third chunk to trigger eviction (300 > 200)
      const third = makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" });
      cache.submit(makePlan([first, second, third]));
      await flush();

      // Oldest chunk should have been evicted
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/0")).toBeNull();
      // Newer chunks should still be cached
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/1")).not.toBeNull();
      expect(cache.getCachedChunk("entity-1", "0/0/0/0/0/2")).not.toBeNull();
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
      expect(tel.mainBytes).toBe(0);
      expect(tel.overviewBytes).toBe(0);
      expect(tel.proxyBytes).toBe(0);
    });
  });

  // =========================================================================
  // Proxy tier (S5)
  // =========================================================================

  describe("proxy tier", () => {
    function makeProxyRequest(overrides?: Partial<ProxyRequest>): ProxyRequest {
      return {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "FieldProxy3D",
        t: 0,
        c: 0,
        priority: 0,
        ...overrides,
      };
    }

    function makeProxyPlan(
      proxyRequests: ProxyRequest[],
      epochs?: Partial<SceneEpochs>,
    ): RequestPlan {
      return {
        requests: [],
        activeSet: [],
        proxyRequests,
        epochs: {
          content: 1,
          layout: 1,
          view: 1,
          selection: 1,
          asset: 0,
          request: 1,
          ...epochs,
        },
        stats: emptyPlanStats(),
        nextState: { previousActiveSet: [] },
      };
    }

    it("submit with proxy request → fetchProxy called once", async () => {
      const { cache, source } = createTestCache();
      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      expect(source.fetchProxyCount).toBe(1);
      expect(source.fetchProxyCalls[0]).toMatchObject({
        datasetId: "ds-1",
        entityId: "entity-1",
        kind: "FieldProxy3D",
        t: 0,
        c: 0,
      });
    });

    it("drain returns a proxy delivery with kind: proxy and header", async () => {
      const { cache, source } = createTestCache();
      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      const deliveries = cache.drain(Infinity);
      expect(deliveries).toHaveLength(1);
      const d = deliveries[0];
      expect(d.kind).toBe("proxy");
      if (d.kind !== "proxy") throw new Error("expected proxy delivery");
      expect(d.datasetId).toBe("ds-1");
      expect(d.entityId).toBe("entity-1");
      expect(d.proxyKind).toBe("FieldProxy3D");
      expect(d.t).toBe(0);
      expect(d.c).toBe(0);
      expect(d.header).toEqual(source.proxyHeader);
      expect(d.data.byteLength).toBe(source.autoResolveProxyBytes);
    });

    it("does not re-fetch a cached proxy on second submit (cache hit)", async () => {
      const { cache, source } = createTestCache();
      const req = makeProxyRequest();
      cache.submit(makeProxyPlan([req]));
      await flush();
      // Drain the first delivery.
      cache.drain(Infinity);

      const fetchesBefore = source.fetchProxyCount;
      cache.submit(makeProxyPlan([req]));
      await flush();

      // No new network fetch.
      expect(source.fetchProxyCount).toBe(fetchesBefore);

      // PRD #409 / S2: cache-hit submit() is a no-op for proxies (mirrors
      // the chunk path). The orchestrator now resends evicted proxies via
      // `getCachedProxy`, so `submit()` no longer needs to push to ready.
      const replays = cache.drain(Infinity);
      expect(replays).toHaveLength(0);
    });

    it("submit() with already-cached proxy does not push to ready", async () => {
      const { cache } = createTestCache();
      const req = makeProxyRequest();
      cache.submit(makeProxyPlan([req]));
      await flush();
      // Drain the initial decode delivery.
      const initial = cache.drain(Infinity);
      expect(initial).toHaveLength(1);

      // Second submit of the same plan: nothing should land in `ready`.
      cache.submit(makeProxyPlan([req]));
      await flush();
      expect(cache.drain(Infinity)).toHaveLength(0);
    });

    it("notifyListeners is not called on re-submit-cached-proxy", async () => {
      const { cache } = createTestCache();
      const req = makeProxyRequest();

      let notifyCount = 0;
      cache.subscribe(() => {
        notifyCount++;
      });

      cache.submit(makeProxyPlan([req]));
      await flush();
      // First decode notifies (from fetchProxy).
      const afterFirst = notifyCount;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // Second submit hits the cache → no new ready, no new notify.
      cache.submit(makeProxyPlan([req]));
      await flush();
      expect(notifyCount).toBe(afterFirst);
    });

    it("getCachedProxy returns null for misses and the entry for hits", async () => {
      const { cache } = createTestCache();
      expect(
        cache.getCachedProxy("ds-1", "entity-x", "FieldProxy3D", 0, 0),
      ).toBeNull();

      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      const hit = cache.getCachedProxy(
        "ds-1",
        "entity-1",
        "FieldProxy3D",
        0,
        0,
      );
      expect(hit).not.toBeNull();
      expect(hit!.kind).toBe("proxy");
      expect(hit!.entityId).toBe("entity-1");
    });

    it("telemetry reports proxy bytes, budget, and queue depth", async () => {
      const { cache, source } = createTestCache({ proxyBudgetBytes: 1024 });
      source.autoResolveProxyBytes = 256;

      cache.submit(makeProxyPlan([makeProxyRequest({ t: 0 })]));
      await flush();
      cache.submit(makeProxyPlan([makeProxyRequest({ t: 1 })]));
      await flush();

      const tel = cache.telemetry();
      expect(tel.proxyBudget).toBe(1024);
      expect(tel.proxyBytes).toBe(512);
    });

    it("evicts oldest proxies when over budget", async () => {
      const budget = 256;
      const { cache, source } = createTestCache({ proxyBudgetBytes: budget });
      source.autoResolveProxyBytes = 100;

      cache.submit(makeProxyPlan([makeProxyRequest({ t: 0 })]));
      await flush();
      cache.submit(makeProxyPlan([makeProxyRequest({ t: 1 })]));
      await flush();
      // Both fit (200 <= 256).
      expect(cache.telemetry().proxyBytes).toBe(200);

      cache.submit(makeProxyPlan([makeProxyRequest({ t: 2 })]));
      await flush();
      // 300 > 256 → oldest (t=0) was evicted.
      expect(cache.telemetry().proxyBytes).toBeLessThanOrEqual(budget);
      expect(
        cache.getCachedProxy("ds-1", "entity-1", "FieldProxy3D", 0, 0),
      ).toBeNull();
      expect(
        cache.getCachedProxy("ds-1", "entity-1", "FieldProxy3D", 2, 0),
      ).not.toBeNull();
    });

    it("reset clears proxy cache state", async () => {
      const { cache, source } = createTestCache();
      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();
      expect(cache.telemetry().proxyBytes).toBeGreaterThan(0);

      cache.reset();
      expect(cache.telemetry().proxyBytes).toBe(0);
      expect(
        cache.getCachedProxy("ds-1", "entity-1", "FieldProxy3D", 0, 0),
      ).toBeNull();
      // Counter sanity check — fetchProxy not called again on reset.
      const before = source.fetchProxyCount;
      cache.drain(Infinity);
      expect(source.fetchProxyCount).toBe(before);
    });
  });
});

// Re-export for use in error handling tests with fake timers
import { TRANSIENT_RETRY_DELAY_MS } from "./cpuCache.ts";
