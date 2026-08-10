import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});
import { debugLog } from "../../debug/logging.ts";

import {
  CpuCache,
  CHUNK_FAILURE_STREAK_THRESHOLD,
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_FACTOR,
  FAILURE_BACKOFF_MAX_MS,
  FAILURE_BACKOFF_JITTER_RATIO,
  MAX_TRACKED_FAILURES,
  backoffWithJitter,
  type CpuCacheConfig,
  type ReadyDelivery,
} from "./cpuCache.ts";
import { ProxiedContentSource } from "./contentSource.ts";
import { FetchError } from "./retry.ts";
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
} from "../planning/index.ts";
import type { SceneEpochs } from "../epochs.ts";
import { emptyPlanStats } from "../planning/index.ts";

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
  /**
   * Auto-resolve proxies with this many voxel bytes. Set to `null` to hold
   * proxy fetches in-flight (like the chunk `pendingFetches` map) so the
   * scheduler slot stays occupied until {@link resolveProxy} or an abort.
   */
  autoResolveProxyBytes: number | null;
  /** Held proxy fetches when `autoResolveProxyBytes` is null. */
  pendingProxyFetches: Map<string, { resolve: (r: FetchProxyResult) => void; reject: (e: Error) => void }>;
  resolveProxy(key: string, bytes?: number): void;
}

function createMockContentSource(): MockContentSource {
  const pendingFetches = new Map<string, { resolve: (r: FetchResult) => void; reject: (e: Error) => void }>();
  const pendingProxyFetches = new Map<string, { resolve: (r: FetchProxyResult) => void; reject: (e: Error) => void }>();
  let fetchCount = 0;
  const autoResolveBytes: number | null = null;

  const source: MockContentSource = {
    pendingFetches,
    fetchCount: 0,
    lastSignal: null,
    autoResolveBytes: null,

    fetchProxyCount: 0,
    fetchProxyCalls: [],
    pendingProxyFetches,
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

    fetchProxy(request: FetchProxyRequest, signal: AbortSignal): Promise<FetchProxyResult> {
      source.fetchProxyCount++;
      source.fetchProxyCalls.push(request);

      if (source.autoResolveProxyBytes !== null) {
        return Promise.resolve({
          header: source.proxyHeader,
          data: new ArrayBuffer(source.autoResolveProxyBytes),
        });
      }

      const key = `${request.datasetId}|${request.entityId}|${request.kind}|${request.t}|${request.c}`;
      return new Promise<FetchProxyResult>((resolve, reject) => {
        pendingProxyFetches.set(key, { resolve, reject });
        signal.addEventListener("abort", () => {
          pendingProxyFetches.delete(key);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },

    handleBinary(_key: string, _data: ArrayBuffer): void {},

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

    resolveProxy(key: string, bytes = 64) {
      const entry = pendingProxyFetches.get(key);
      if (entry) {
        pendingProxyFetches.delete(key);
        entry.resolve({
          header: source.proxyHeader,
          data: new ArrayBuffer(bytes),
        });
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
  const resolvedActiveSet: ActiveSetEntry[] = activeSet ?? [{
    kind: "tile",
    entityId: "entity-1",
    imageId: "image-1",
    mode: "tiles-with-detail",
    targetLod: 0,
    coarsestDetailLod: 2,
    detailOwnedLodRange: [0, 2],
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
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
    nextState: { previousActiveSet: resolvedActiveSet },
  };
}

function makeActiveEntry(entityId: string, imageId?: string): ActiveSetEntry {
  return {
    kind: "tile",
    entityId,
    imageId: imageId ?? entityId.replace("entity", "image"),
    mode: "tiles-with-detail",
    targetLod: 0,
    coarsestDetailLod: 2,
    detailOwnedLodRange: [0, 2],
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
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

function consumeDeliverables(cache: CpuCache, budgetBytes = Infinity): ReadyDelivery[] {
  const deliveries: ReadyDelivery[] = [];
  let remaining = budgetBytes;
  for (const delivery of cache.getDeliverable()) {
    if (remaining <= 0) break;
    deliveries.push(delivery);
    cache.markSent(delivery);
    remaining -= delivery.data.byteLength;
  }
  return deliveries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CpuCache", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Submit/deliverable lifecycle
  // =========================================================================

  describe("submit/deliverable lifecycle", () => {
    it("submit plan → source resolves → getDeliverable returns delivery", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ x: 0, y: 0, z: 0 });
      cache.submit(makePlan([req]));

      // Source should have been called
      expect(source.fetchCount).toBe(1);

      // Resolve the fetch
      source.resolve("entity-1/image-1/0/0/0/0/0/0");
      await flush();

      // getDeliverable should return the delivery.
      const deliveries = consumeDeliverables(cache);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].entityId).toBe("entity-1");
      const delivery = deliveries[0];
      if (delivery.kind === "proxy") throw new Error("expected chunk delivery");
      expect(delivery.chunkKey).toBe("0/0/0/0/0/0");
      expect(delivery.lane).toBe("detail");
    });

    it("getDeliverable returns empty when nothing is cached and wanted", () => {
      const { cache } = createTestCache();
      expect(consumeDeliverables(cache)).toHaveLength(0);
    });

    it("delivery consumption respects the one-item soft budget", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 100;
      const reqs = [
        makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" }),
      ];
      cache.submit(makePlan(reqs));
      await flush();

      // Only consume 150 bytes worth (should get 2 of 3 at 100 bytes each).
      const first = consumeDeliverables(cache, 150);
      expect(first).toHaveLength(2);

      // Remaining delivery available on next consumption.
      const second = consumeDeliverables(cache);
      expect(second).toHaveLength(1);
    });

    it("sent deliveries are not re-returned", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.submit(makePlan([makeRequest()]));
      await flush();

      consumeDeliverables(cache);
      expect(consumeDeliverables(cache)).toHaveLength(0);
    });
  });

  describe("getDeliverable", () => {
    function makeProxyRequest(overrides?: Partial<ProxyRequest>): ProxyRequest {
      return {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "TileProxy3D",
        t: 0,
        c: 0,
        priority: 0,
        ...overrides,
      };
    }

    function makePlanWithProxies(
      requests: ChunkRequest[],
      proxyRequests: ProxyRequest[],
    ): RequestPlan {
      return {
        ...makePlan(requests),
        proxyRequests,
      };
    }

    it("merges chunks and proxies in priority order", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      source.autoResolveProxyBytes = 32;
      cache.onPlanRebuildStart();

      cache.submit(makePlanWithProxies(
        [makeRequest({ priority: 100 })],
        [makeProxyRequest({ priority: 10 })],
      ));
      await flush();

      expect(Array.from(cache.getDeliverable()).map(d => d.kind)).toEqual([
        "proxy",
        "chunk",
      ]);
    });

    it("interleaves equal-priority multi-channel chunks by spatial cell", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();

      const reqs = [
        makeRequest({ c: 0, x: 0, chunkKey: "0/0/0/0/0/0", priority: 10 }),
        makeRequest({ c: 0, x: 1, chunkKey: "0/0/0/0/0/1", priority: 10 }),
        makeRequest({ c: 1, x: 0, chunkKey: "0/0/1/0/0/0", priority: 10 }),
        makeRequest({ c: 1, x: 1, chunkKey: "0/0/1/0/0/1", priority: 10 }),
      ];
      cache.submit(makePlan(reqs));
      await flush();

      expect(Array.from(cache.getDeliverable()).map(d =>
        d.kind === "chunk" ? [d.x, d.c] : ["proxy", -1],
      )).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]);
    });

    it("filters non-detail chunks, sent chunks, and rejected chunks", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();

      const detail = makeRequest({
        entityId: "image-1",
        imageId: "image-1",
        chunkKey: "0/0/0/0/0/0",
        lane: "detail",
      });
      const prefetch = makeRequest({
        entityId: "image-1",
        imageId: "image-1",
        chunkKey: "0/0/0/0/0/1",
        x: 1,
        lane: "prefetch",
      });
      cache.submit(makePlan([detail, prefetch], [makeActiveEntry("image-1", "image-1")]));
      await flush();

      const first = Array.from(cache.getDeliverable());
      expect(first.map(d => d.kind === "chunk" ? d.chunkKey : "proxy")).toEqual([
        detail.chunkKey,
      ]);

      cache.markSent(first[0]);
      expect(Array.from(cache.getDeliverable())).toEqual([]);

      cache.markChunkEvicted(detail.imageId, detail.c, [detail.chunkKey], []);
      expect(Array.from(cache.getDeliverable()).map(d => d.kind)).toEqual(["chunk"]);

      cache.markSent(first[0]);
      expect(Array.from(cache.getDeliverable())).toEqual([]);

      cache.markChunkMissing(detail.imageId, detail.c, detail.chunkKey);
      expect(Array.from(cache.getDeliverable()).map(d => d.kind)).toEqual(["chunk"]);

      cache.markChunkEvicted(detail.imageId, detail.c, [], [detail.chunkKey]);
      expect(Array.from(cache.getDeliverable())).toEqual([]);
    });

    it("delivers coarse chunks from the overview/coarse bucket when wanted", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();

      const coarse = makeRequest({
        entityId: "image-1",
        imageId: "image-1",
        level: 2,
        chunkKey: "2/0/0/0/0/0",
        lane: "coarse",
        tier: "coarse",
      });
      cache.submit(makePlan([coarse], [makeActiveEntry("image-1", "image-1")]));
      await flush();

      expect(cache.telemetry().overviewBytes).toBe(64);
      const deliveries = Array.from(cache.getDeliverable());
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        kind: "chunk",
        lane: "coarse",
        residencyTier: "coarse",
        chunkKey: "2/0/0/0/0/0",
      });
    });

    it("keeps identical detail and coarse chunk keys deliverable as separate residency tiers", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();

      const detail = makeRequest({
        entityId: "image-1",
        imageId: "image-1",
        level: 1,
        chunkKey: "1/0/0/0/0/0",
        lane: "detail",
        tier: "detail",
        priority: 10,
      });
      const coarse = makeRequest({
        entityId: "image-1",
        imageId: "image-1",
        level: 1,
        chunkKey: "1/0/0/0/0/0",
        lane: "coarse",
        tier: "coarse",
        priority: 20,
      });

      cache.submit(makePlan([detail, coarse], [makeActiveEntry("image-1", "image-1")]));
      await flush();

      expect(source.fetchCount).toBe(2);
      expect(cache.telemetry().mainBytes).toBe(64);
      expect(cache.telemetry().overviewBytes).toBe(64);

      const deliveries = Array.from(cache.getDeliverable());
      expect(deliveries.map((d) => d.kind === "chunk" ? d.residencyTier : "proxy")).toEqual([
        "detail",
        "coarse",
      ]);

      cache.markSent(deliveries[0]);
      expect(Array.from(cache.getDeliverable()).map((d) =>
        d.kind === "chunk" ? d.residencyTier : "proxy",
      )).toEqual(["coarse"]);
    });

    it("resolves skipped chunk feedback from imageId back to entityId", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();

      const detail = makeRequest({
        entityId: "tile-entity",
        imageId: "tile-image",
        chunkKey: "0/0/0/0/0/0",
        lane: "detail",
      });
      cache.submit(makePlan([detail], [makeActiveEntry("tile-entity", "tile-image")]));
      await flush();

      expect(Array.from(cache.getDeliverable())).toHaveLength(1);

      cache.markChunkEvicted(detail.imageId, detail.c, [], [detail.chunkKey]);

      expect(Array.from(cache.getDeliverable())).toEqual([]);
    });

    it("advances wanted generation once per rebuild, not per submit", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      cache.onPlanRebuildStart();
      const a = makeRequest({ entityId: "entity-a", imageId: "image-a", chunkKey: "0/0/0/0/0/0" });
      const b = makeRequest({ entityId: "entity-b", imageId: "image-b", chunkKey: "0/0/0/0/0/1", x: 1 });
      cache.submit(makePlan([a], [makeActiveEntry("entity-a", "image-a")]));
      cache.submit(makePlan([b], [makeActiveEntry("entity-b", "image-b")]));
      await flush();

      expect(Array.from(cache.getDeliverable()).map(d =>
        d.kind === "chunk" ? d.entityId : "proxy",
      ).sort()).toEqual(["entity-a", "entity-b"]);

      cache.onPlanRebuildStart();
      cache.submit(makePlan([b], [makeActiveEntry("entity-b", "image-b")]));

      expect(Array.from(cache.getDeliverable()).map(d =>
        d.kind === "chunk" ? d.entityId : "proxy",
      )).toEqual(["entity-b"]);
    });

    it("proxy sent state survives rebuild and clears on missing feedback", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveProxyBytes = 32;
      const req = makeProxyRequest();

      cache.onPlanRebuildStart();
      cache.submit(makePlanWithProxies([], [req]));
      await flush();
      const [proxy] = Array.from(cache.getDeliverable());
      expect(proxy.kind).toBe("proxy");
      cache.markSent(proxy);

      cache.onPlanRebuildStart();
      cache.submit(makePlanWithProxies([], [req]));
      expect(Array.from(cache.getDeliverable())).toEqual([]);

      cache.markProxyMissing("ds-1|entity-1|TileProxy3D|0|0");
      expect(Array.from(cache.getDeliverable()).map(d => d.kind)).toEqual(["proxy"]);
    });

    it("cancels stale in-flight chunks omitted by a newer rebuild", async () => {
      const { cache, source } = createTestCache();
      const staleLowRes = makeRequest({
        level: 2,
        chunkKey: "2/0/0/0/0/0",
        priority: 100,
      });
      const currentHighRes = makeRequest({
        level: 0,
        chunkKey: "0/0/0/0/0/0",
        priority: 1,
      });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([staleLowRes]));

      cache.onPlanRebuildStart();
      cache.submit(makePlan([currentHighRes]));

      expect(source.pendingFetches.has("entity-1/image-1/2/0/0/0/0/0")).toBe(false);
      source.resolve("entity-1/image-1/2/0/0/0/0/0");
      await flush();

      expect(cache.getCachedChunk("entity-1", staleLowRes.chunkKey)).toBeNull();
      expect(Array.from(cache.getDeliverable())).toEqual([]);
    });

    it("refreshes in-flight chunks that remain wanted in a newer rebuild", async () => {
      const { cache, source } = createTestCache();
      const first = makeRequest({
        chunkKey: "0/0/0/0/0/0",
        priority: 100,
      });
      const refreshed = makeRequest({
        chunkKey: "0/0/0/0/0/0",
        priority: 1,
      });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([first]));

      cache.onPlanRebuildStart();
      cache.submit(makePlan([refreshed]));

      source.resolve("entity-1/image-1/0/0/0/0/0/0");
      await flush();

      const deliveries = Array.from(cache.getDeliverable());
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].priority).toBe(1);
    });

    it("promotes an in-flight prefetch chunk when the newer rebuild wants it as detail", async () => {
      const { cache, source } = createTestCache();
      const prefetch = makeRequest({
        lane: "prefetch",
        chunkKey: "0/1/0/0/0/0",
        t: 1,
      });
      const detail = makeRequest({
        lane: "detail",
        chunkKey: "0/1/0/0/0/0",
        t: 1,
      });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([prefetch]));

      cache.onPlanRebuildStart();
      cache.submit(makePlan([detail]));

      source.resolve("entity-1/image-1/0/1/0/0/0/0");
      await flush();

      const deliveries = Array.from(cache.getDeliverable());
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        kind: "chunk",
        lane: "detail",
        chunkKey: "0/1/0/0/0/0",
      });
    });

    it("promotes a cached prefetch chunk when the newer rebuild wants it as detail", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      const prefetch = makeRequest({
        lane: "prefetch",
        chunkKey: "0/1/0/0/0/0",
        t: 1,
      });
      const detail = makeRequest({
        lane: "detail",
        chunkKey: "0/1/0/0/0/0",
        t: 1,
        priority: 1,
      });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([prefetch]));
      await flush();

      expect(Array.from(cache.getDeliverable())).toEqual([]);
      expect(cache.getCacheDump()).toMatchObject([
        { chunkKey: "0/1/0/0/0/0", tier: "prefetch" },
      ]);

      cache.onPlanRebuildStart();
      cache.submit(makePlan([detail]));

      const deliveries = Array.from(cache.getDeliverable());
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        kind: "chunk",
        lane: "detail",
        chunkKey: "0/1/0/0/0/0",
        priority: 1,
      });
      expect(cache.getCacheDump()).toMatchObject([
        { chunkKey: "0/1/0/0/0/0", tier: "active-detail" },
      ]);
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
  // Fetch lifecycle preempted by plan omission
  // =========================================================================

  describe("fetch lifecycle preempted by plan omission", () => {
    it("submit twice with overlapping requests cancels omitted in-flight work for active entities", async () => {
      const { cache, source } = createTestCache();
      const reqA = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const reqB = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });

      cache.submit(makePlan([reqA, reqB]));
      expect(source.pendingFetches.size).toBe(2);

      // Submit again with only reqB — reqA is stale and should free a slot.
      cache.submit(makePlan([reqB]));

      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/1")).toBe(true);
      expect(cache.telemetry().inFlightCount).toBe(1);
    });

    it("submit with smaller plan drops prior in-flight for the same active entity", async () => {
      const { cache, source } = createTestCache();
      const reqA = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const reqB = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });

      cache.submit(makePlan([reqA, reqB]));
      expect(cache.telemetry().inFlightCount).toBe(2);

      // Smaller plan that omits reqA. The stale fetch is cancelled.
      cache.submit(makePlan([reqB]));
      expect(cache.telemetry().inFlightCount).toBe(1);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
    });

    it("submit with empty plan cancels in-flight work for the active entity", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });

      cache.submit(makePlan([req]));
      expect(cache.telemetry().inFlightCount).toBe(1);

      // Empty plan means no chunks remain wanted for the active entity.
      cache.submit(makePlan([]));
      expect(cache.telemetry().inFlightCount).toBe(0);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
    });

    it("cancels an entity's in-flight once it leaves the view, freeing the slot the current view needs", async () => {
      // One concurrency slot models the wide-collection queue: the current
      // view cannot start a fetch until a scrolled-away one releases its slot.
      const { cache, source } = createTestCache({ maxConcurrentFetches: 1 });
      const away = makeRequest({
        datasetId: "entity-1", entityId: "entity-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0",
      });
      const current = makeRequest({
        datasetId: "entity-2", entityId: "entity-2", imageId: "image-2", chunkKey: "0/0/0/0/0/0",
      });

      // entity-1 is the active view; its fetch takes the single slot.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([away], [makeActiveEntry("entity-1", "image-1")]));
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);

      // entity-1 leaves the view; entity-2 is the current view now, but its
      // fetch cannot start — entity-1 still holds the only slot.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([current], [makeActiveEntry("entity-2", "image-2")]));
      expect(source.pendingFetches.has("entity-2/image-2/0/0/0/0/0/0")).toBe(false);

      // Next rebuild: entity-1 has been absent for a full rebuild, so its
      // in-flight is aborted at the boundary. The freed slot lets the current
      // view acquire it at once — no wait for the transfer timeout.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([current], [makeActiveEntry("entity-2", "image-2")]));
      await flush();

      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
      expect(source.pendingFetches.has("entity-2/image-2/0/0/0/0/0/0")).toBe(true);
      expect(cache.telemetry().inFlightCount).toBe(1);
    });

    it("does not cancel a still-visible dataset's in-flight when another dataset submits separately", () => {
      // Two datasets, submitted in separate calls within one rebuild — the
      // per-dataset submit loop. Neither submit may cancel the other's fetch.
      const { cache, source } = createTestCache();
      const dsA = makeRequest({
        datasetId: "entity-A", entityId: "entity-A", imageId: "image-A", chunkKey: "0/0/0/0/0/0",
      });
      const dsB = makeRequest({
        datasetId: "entity-B", entityId: "entity-B", imageId: "image-B", chunkKey: "0/0/0/0/0/0",
      });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([dsA], [makeActiveEntry("entity-A", "image-A")]));
      cache.submit(makePlan([dsB], [makeActiveEntry("entity-B", "image-B")]));
      expect(cache.telemetry().inFlightCount).toBe(2);

      // Both datasets stay visible and are each re-submitted next rebuild.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([dsA], [makeActiveEntry("entity-A", "image-A")]));
      cache.submit(makePlan([dsB], [makeActiveEntry("entity-B", "image-B")]));

      // Nothing was cancelled at the boundary: both fetches are still live.
      expect(cache.telemetry().inFlightCount).toBe(2);
      expect(source.pendingFetches.has("entity-A/image-A/0/0/0/0/0/0")).toBe(true);
      expect(source.pendingFetches.has("entity-B/image-B/0/0/0/0/0/0")).toBe(true);
    });

    it("does not cancel a still-wanted in-flight chunk when the plan is re-submitted", () => {
      const { cache, source } = createTestCache();
      const keep = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      const drop = makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([keep, drop]));
      expect(cache.telemetry().inFlightCount).toBe(2);

      // Re-plan the same active entity but drop one chunk. The still-wanted
      // chunk stays; only the omitted one is cancelled.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([keep]));
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/1")).toBe(false);
      expect(cache.telemetry().inFlightCount).toBe(1);
    });

    it("re-enqueues a returned entity's chunk after its scrolled-away in-flight was cancelled", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({
        entityId: "entity-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0",
      });

      cache.onPlanRebuildStart();
      cache.submit(makePlan([req], [makeActiveEntry("entity-1", "image-1")]));
      expect(source.fetchCount).toBe(1);

      // entity-1 leaves the view for a full rebuild → its in-flight is aborted.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));
      cache.onPlanRebuildStart();
      cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));
      await flush();
      expect(cache.telemetry().inFlightCount).toBe(0);

      // entity-1 returns (scrub oscillation): the cancelled key must re-fetch
      // — a client re-enqueue the server single-flights onto any still-running
      // task — not stay permanently suppressed.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([req], [makeActiveEntry("entity-1", "image-1")]));
      expect(source.fetchCount).toBe(2);
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);
    });

    it("a returning entity re-enqueued the same tick as its cancel keeps its live slot when the abort settles", async () => {
      // Scrub away from a tile and straight back within one rebuild's
      // detection lag: the departed-entity cancel aborts the in-flight fetch
      // synchronously, but the abort's rejection settles a microtask later —
      // after the returning submit has already started a fresh fetch under a
      // new controller. That late settle must not free the successor's slot.
      const { cache, source } = createTestCache();
      const req = makeRequest({
        entityId: "entity-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0",
      });
      const key = "entity-1/image-1/0/0/0/0/0/0";

      cache.onPlanRebuildStart();
      cache.submit(makePlan([req], [makeActiveEntry("entity-1", "image-1")]));
      expect(source.fetchCount).toBe(1);

      // entity-1 scrolls out of the active set (detection lag, not cancelled yet).
      cache.onPlanRebuildStart();
      cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));

      // Rebuild boundary detects the departure and aborts the fetch. Its
      // rejection is queued as a microtask; it has not run yet.
      cache.onPlanRebuildStart();
      // Same tick: entity-1 returns and re-requests the same chunk. The just-
      // cancelled key is no longer in flight, so a fresh fetch starts.
      cache.submit(makePlan([req], [makeActiveEntry("entity-1", "image-1")]));
      expect(source.fetchCount).toBe(2);
      expect(source.pendingFetches.has(key)).toBe(true);
      expect(cache.telemetry().inFlightCount).toBe(1);

      // The superseded fetch's abort now settles. It owns nothing anymore, so
      // it must leave the live fetch's slot and dedup record untouched.
      await flush();
      expect(cache.telemetry().inFlightCount).toBe(1);
      expect(source.pendingFetches.has(key)).toBe(true);

      // A later rebuild that still wants the chunk dedups onto the live fetch —
      // no second concurrent fetch of the same chunk.
      cache.onPlanRebuildStart();
      cache.submit(makePlan([req], [makeActiveEntry("entity-1", "image-1")]));
      expect(source.fetchCount).toBe(2);
      expect(cache.telemetry().inFlightCount).toBe(1);
    });

    it("omitted stale work frees scheduler capacity for the newer request", async () => {
      const { cache, source } = createTestCache({ maxConcurrentFetches: 1 });
      const staleT = makeRequest({ t: 0, chunkKey: "0/0/0/0/0/0" });
      const currentT = makeRequest({ t: 1, chunkKey: "0/1/0/0/0/0" });

      cache.submit(makePlan([staleT]));
      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(true);

      cache.submit(makePlan([currentT]));

      expect(source.pendingFetches.has("entity-1/image-1/0/0/0/0/0/0")).toBe(false);
      expect(source.pendingFetches.has("entity-1/image-1/0/1/0/0/0/0")).toBe(true);
      expect(cache.telemetry().inFlightCount).toBe(1);
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
        kind: "TileProxy3D",
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
  // cancelDataset
  // =========================================================================

  describe("cancelDataset", () => {
    function makeProxyRequest(overrides?: Partial<ProxyRequest>): ProxyRequest {
      return {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "TileProxy3D",
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
        kind: "TileProxy3D",
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
      expect(cache.getCachedProxy("ds-1", "entity-1", "TileProxy3D", 0, 0)).not.toBeNull();

      cache.cancelDataset("ds-1", ["entity-1"]);

      expect(cache.telemetry().proxyBytes).toBe(0);
      expect(cache.getCachedProxy("ds-1", "entity-1", "TileProxy3D", 0, 0)).toBeNull();
    });

    it("clears ready deliveries", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;

      cache.submit(makePlan([
        makeRequest({ entityId: "entity-1", chunkKey: "0/0/0/0/0/0" }),
      ]));
      await flush();
      // Don't consume — leave delivery eligible.

      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      cache.cancelDataset("ds-1", ["entity-1"]);

      expect(consumeDeliverables(cache)).toHaveLength(0);
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
        kind: "TileProxy3D", t: 0, c: 0, priority: 0,
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
        kind: "TileProxy3D", t: 0, c: 0, priority: 0,
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
      const beforeProxyB = cache.getCachedProxy("ds-B", "entity-B", "TileProxy3D", 0, 0);
      expect(beforeDetailB).not.toBeNull();
      expect(beforeProxyB).not.toBeNull();
      const mainBytesBoth = cache.telemetry().mainBytes;
      const proxyBytesBoth = cache.telemetry().proxyBytes;

      cache.cancelDataset("ds-A", ["entity-A"]);

      // Dataset A is gone.
      expect(cache.getCachedChunk("entity-A", "0/0/0/0/0/0")).toBeNull();
      expect(cache.getCachedProxy("ds-A", "entity-A", "TileProxy3D", 0, 0)).toBeNull();
      // Dataset B is intact.
      expect(cache.getCachedChunk("entity-B", "0/0/0/0/0/0")).not.toBeNull();
      expect(cache.getCachedProxy("ds-B", "entity-B", "TileProxy3D", 0, 0)).not.toBeNull();
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
      const { cache, source } = createTestCache({ mainBudgetBytes: budget, overviewBudgetBytes: 0 });
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
      const { cache, source } = createTestCache({ mainBudgetBytes: budget, overviewBudgetBytes: 0 });
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
  // Minimap lane routing (ADR 0023)
  // =========================================================================

  describe("minimap lane routing", () => {
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
  // Dual-lane demand: minimap seeding + the view's coarse lane
  // =========================================================================
  //
  // The minimap and coarse lanes share a residency tier and a dedup
  // key, so one fetch (or one cached entry) can serve both. Whichever
  // lane's request holds the queue slot, an arrival the VIEW demanded
  // this tick must be deliverable immediately — idle fill must not wait
  // for the next interaction-triggered rebuild to relabel the entry.
  // Chunks only the minimap wanted stay off the view's delivery path.

  describe("dual-lane minimap/coarse demand", () => {
    const dualChunkKey = "3/0/0/0/0/0";
    const dualFetchKey = "entity-1/image-1/3/0/0/0/0/0";

    function minimapReq(priority = 0): ChunkRequest {
      return makeRequest({ lane: "minimap", tier: "coarse", level: 3, priority });
    }
    function coarseReq(): ChunkRequest {
      return makeRequest({ lane: "coarse", tier: "coarse", level: 3, priority: 2400 });
    }
    function deliverableChunkKeys(cache: CpuCache): string[] {
      return Array.from(cache.getDeliverable()).flatMap((d) =>
        d.kind === "chunk" ? [d.chunkKey] : [],
      );
    }

    it("delivers a chunk demanded by both lanes when the minimap-lane fetch resolves, without a rebuild", async () => {
      // Concurrency 1 models the wide-collection queue: the coarse copy
      // of a dual-demand chunk never reaches a fetch slot itself.
      const { cache, source } = createTestCache({ maxConcurrentFetches: 1 });
      cache.onPlanRebuildStart();
      cache.submit(makePlan([minimapReq(), coarseReq()]));

      source.resolve(dualFetchKey);
      await flush();

      expect(deliverableChunkKeys(cache)).toContain(dualChunkKey);
      expect(cache.telemetry().readyCount).toBeGreaterThan(0);
    });

    it("fetches a dual-demand chunk exactly once", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();
      cache.submit(makePlan([minimapReq(), coarseReq()]));
      await flush();
      expect(source.fetchCount).toBe(1);
    });

    it("delivers when a coarse request dedups onto an in-flight minimap fetch, in any request order", async () => {
      const { cache, source } = createTestCache();
      cache.onPlanRebuildStart();
      cache.submit(makePlan([minimapReq()]));

      // Rebuild while the fetch is in flight: the view's coarse request
      // rides the same fetch. The minimap request is deliberately LAST
      // (its bulk-demoted sort position) so the freshest in-flight
      // metadata carries lane "minimap".
      cache.onPlanRebuildStart();
      cache.submit(makePlan([coarseReq(), minimapReq(2600)]));

      source.resolve(dualFetchKey);
      await flush();

      expect(deliverableChunkKeys(cache)).toContain(dualChunkKey);
    });

    it("keeps a cached dual-demand chunk deliverable when the minimap request sorts after coarse", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();
      cache.submit(makePlan([minimapReq()]));
      await flush(); // cached under lane "minimap"

      cache.onPlanRebuildStart();
      cache.submit(makePlan([coarseReq(), minimapReq(2600)]));

      expect(deliverableChunkKeys(cache)).toContain(dualChunkKey);
    });

    it("keeps the view's delivery priority on a cached dual-demand chunk", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();
      cache.submit(makePlan([minimapReq()]));
      await flush();

      cache.onPlanRebuildStart();
      cache.submit(makePlan([coarseReq(), minimapReq(2600)]));

      const chunk = Array.from(cache.getDeliverable()).find(
        (d) => d.kind === "chunk" && d.chunkKey === dualChunkKey,
      );
      expect(chunk).toBeDefined();
      // The bulk-demoted minimap refresh (2600) must not displace the
      // coarse lane's own urgency (2400) in delivery ordering.
      expect(chunk!.priority).toBe(2400);
    });

    it("never delivers a minimap-only chunk to the view", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();
      cache.submit(makePlan([minimapReq()]));
      await flush();

      expect(deliverableChunkKeys(cache)).toHaveLength(0);
      // The minimap path still reads it from the cache by key.
      expect(cache.getCachedChunk("entity-1", dualChunkKey)).not.toBeNull();
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

    it("treats generated pending as non-failure and re-requests on later submit", async () => {
      const { cache, source } = createTestCache();
      const req = makeRequest({ level: 2, lane: "coarse", tier: "coarse" });
      cache.submit(makePlan([req]));

      source.reject(
        "entity-1/image-1/2/0/0/0/0/0",
        new FetchError("generated pending", { kind: "pending" }),
      );
      await flush();

      let tel = cache.telemetry();
      expect(tel.failedChunks.permanent).toBe(0);
      expect(tel.failedChunks.transient).toBe(0);
      expect(tel.inFlightCount).toBe(0);
      expect(source.fetchCount).toBe(1);

      cache.submit(makePlan([req]));
      expect(source.fetchCount).toBe(2);
      source.resolve("entity-1/image-1/2/0/0/0/0/0", new ArrayBuffer(8));
      await flush();

      tel = cache.telemetry();
      expect(tel.failedChunks.permanent).toBe(0);
      const deliveries = Array.from(cache.getDeliverable()).filter(d => d.kind === "chunk");
      expect(deliveries[0]).toMatchObject({ chunkKey: "2/0/0/0/0/0", lane: "coarse" });
    });

    it("self-heals a transient failure after its backoff; permanent stays excluded", async () => {
      vi.useFakeTimers();
      try {
        let clock = 0;
        const { cache, source } = createTestCache({
          now: () => clock,
          random: () => 0,
        });

        // --- Transient key: fails, backs off, then re-fetches by time. ---
        const transientReq = makeRequest({ x: 0 });
        cache.submit(makePlan([transientReq]));
        // First transient rejection triggers the one in-fetch retry…
        source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("Network error"));
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
        // …and the retry also fails, so the key lands in the failure map.
        source.reject("entity-1/image-1/0/0/0/0/0/0", new Error("Network error"));
        await vi.advanceTimersByTimeAsync(0);

        expect(cache.failuresTracked()).toBe(1);
        const fetchesAfterFail = source.fetchCount;

        // Re-planned immediately (clock unchanged): still inside backoff.
        cache.submit(makePlan([transientReq]));
        expect(source.fetchCount).toBe(fetchesAfterFail);

        // Advance the injected clock past the backoff → re-eligible.
        clock += FAILURE_BACKOFF_MAX_MS + 1;
        cache.submit(makePlan([transientReq]));
        expect(source.fetchCount).toBe(fetchesAfterFail + 1);

        // A clean re-fetch clears the failure record.
        source.resolve("entity-1/image-1/0/0/0/0/0/0");
        await vi.advanceTimersByTimeAsync(0);
        expect(cache.failuresTracked()).toBe(0);

        // --- Permanent key: excluded regardless of elapsed time. ---
        const permanentReq = makeRequest({ x: 1 });
        cache.submit(makePlan([permanentReq]));
        source.reject("entity-1/image-1/0/0/0/0/0/1", new Error("404 not found"));
        await vi.advanceTimersByTimeAsync(0);
        expect(cache.failuresTracked()).toBe(1);

        const fetchesAfterPermanent = source.fetchCount;
        clock += FAILURE_BACKOFF_MAX_MS * 1000;
        cache.submit(makePlan([permanentReq]));
        expect(source.fetchCount).toBe(fetchesAfterPermanent); // never re-fetched
      } finally {
        vi.useRealTimers();
      }
    });

    it("records a decode failure as a self-healing transient backoff", async () => {
      vi.useFakeTimers();
      try {
        let clock = 0;
        const source = createMockContentSource();
        let failDecode = true;
        const decode = {
          decode: (bytes: ArrayBuffer) =>
            failDecode
              ? Promise.reject(new Error("length mismatch for wire format"))
              : Promise.resolve(bytes),
          activeCount: () => 0,
          get size() { return 3; },
          terminate: () => {},
        } as unknown as DecodePool;
        const cache = new CpuCache(source, decode, {
          now: () => clock,
          random: () => 0,
        });

        const req = makeRequest();
        const composite = "entity-1/image-1/0/0/0/0/0/0";

        // Fetch completes; the bytes cannot be decoded.
        cache.submit(makePlan([req]));
        source.resolve(composite);
        await vi.advanceTimersByTimeAsync(0);

        // A backoff entry is tracked and attributed to the transient bucket —
        // not left unrecorded to re-fetch every rebuild.
        expect(cache.failuresTracked()).toBe(1);
        expect(cache.telemetry().failedChunks.transient).toBe(1);
        expect(cache.telemetry().failedChunks.permanent).toBe(0);

        // Re-planned immediately (clock unchanged): still inside backoff, so
        // no retry storm.
        const fetchesAfterFail = source.fetchCount;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetchesAfterFail);

        // Past the backoff it self-heals: re-fetched, and this time it decodes
        // and delivers, clearing the record.
        failDecode = false;
        clock += FAILURE_BACKOFF_MAX_MS + 1;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetchesAfterFail + 1);
        source.resolve(composite);
        await vi.advanceTimersByTimeAsync(0);
        expect(cache.failuresTracked()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("grows the transient backoff on each re-attempt (capped)", async () => {
      vi.useFakeTimers();
      try {
        let clock = 0;
        const { cache, source } = createTestCache({
          now: () => clock,
          random: () => 0, // random()==0 returns the jitter band's floor
        });
        const req = makeRequest();
        const composite = "entity-1/image-1/0/0/0/0/0/0";

        // With random()==0 the returned delay is the floor of the band:
        // growth * (1 - ratio). It stays strictly monotonic in `attempt`.
        const backoff = (attempt: number) =>
          FAILURE_BACKOFF_BASE_MS *
          FAILURE_BACKOFF_FACTOR ** (attempt - 1) *
          (1 - FAILURE_BACKOFF_JITTER_RATIO);

        async function failTransientlyOnce() {
          source.reject(composite, new Error("Network error"));
          await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
          source.reject(composite, new Error("Network error"));
          await vi.advanceTimersByTimeAsync(0);
        }

        // Attempt 1 recorded at clock 0 → eligible at backoff(1).
        cache.submit(makePlan([req]));
        await failTransientlyOnce();

        // Just before attempt-1's backoff elapses: still skipped.
        clock = backoff(1) - 1;
        let fetches = source.fetchCount;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetches);

        // At backoff(1): re-eligible → attempt 2 fetch fires and fails.
        clock = backoff(1);
        fetches = source.fetchCount;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetches + 1);
        const secondFailAt = clock;
        await failTransientlyOnce();

        // Attempt 2's backoff is longer: attempt-1's span no longer frees it.
        clock = secondFailAt + backoff(1);
        fetches = source.fetchCount;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetches);

        // Past the grown backoff → re-eligible.
        clock = secondFailAt + backoff(2);
        fetches = source.fetchCount;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetches + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps backoff jitter alive at the cap so retries de-correlate", () => {
      // attempt 9 pins the growth term well past the cap.
      const cappedAttempt = 9;
      const low = backoffWithJitter(cappedAttempt, () => 0.2);
      const high = backoffWithJitter(cappedAttempt, () => 0.9);

      // Two entries at the cap with different random() get different delays
      // (the whole point of jitter during a synchronized outage).
      expect(low).not.toBe(high);
      expect(high).toBeGreaterThan(low);

      // …never zero/negative, never at or above the cap.
      for (const value of [low, high]) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(FAILURE_BACKOFF_MAX_MS);
      }
    });

    it("keeps every backoff within its band and below the cap", () => {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const floor = backoffWithJitter(attempt, () => 0);
        const ceilingSample = backoffWithJitter(attempt, () => 1 - 1e-9);
        expect(floor).toBeGreaterThan(0);
        expect(ceilingSample).toBeGreaterThanOrEqual(floor);
        expect(ceilingSample).toBeLessThan(FAILURE_BACKOFF_MAX_MS);
      }
    });

    it("bounds the tracked failures map and keeps retained permanents excluded", async () => {
      const { cache, source } = createTestCache({
        maxConcurrentFetches: 100_000,
        maxBytesInFlight: 1e12,
        now: () => 0,
        random: () => 0,
      });

      const count = MAX_TRACKED_FAILURES + 512;
      const reqs = Array.from({ length: count }, (_, i) =>
        makeRequest({ x: i, chunkKey: `0/0/0/0/0/${i}` }),
      );
      cache.submit(makePlan(reqs));

      for (let i = 0; i < count; i++) {
        source.reject(`entity-1/image-1/0/0/0/0/0/${i}`, new Error("404 not found"));
      }
      await flush();

      // Memory stays bounded at the cap.
      expect(cache.failuresTracked()).toBe(MAX_TRACKED_FAILURES);

      // A retained permanent (the most-recent record survives the FIFO drop
      // of the oldest permanents) stays excluded: re-planning it must NOT
      // issue a new fetch. Merely counting entries would miss a regression
      // where the gate re-enqueued an evicted-then-forgotten key.
      const retained = makeRequest({
        x: count - 1,
        chunkKey: `0/0/0/0/0/${count - 1}`,
      });
      const fetchesBefore = source.fetchCount;
      cache.submit(makePlan([retained]));
      expect(source.fetchCount).toBe(fetchesBefore);
    });

    it("retains a fresh transient's backoff even when the permanent store is full", async () => {
      // The compound exposure: a malformed collection floods the map with
      // permanent 404s AND a throttling backend produces transient timeouts.
      // The transient store is independent, so the transient keeps its own
      // backoff slot instead of being crowded out — no no-backoff retry storm
      // against the throttling backend.
      vi.useFakeTimers();
      try {
        let clock = 0;
        const { cache, source } = createTestCache({
          maxConcurrentFetches: 1_000_000,
          maxBytesInFlight: 1e12,
          now: () => clock,
          random: () => 0, // returns each backoff band's floor
        });

        // Saturate the PERMANENT store to capacity with 404s.
        const permReqs = Array.from({ length: MAX_TRACKED_FAILURES }, (_, i) =>
          makeRequest({ x: i, chunkKey: `0/0/0/0/0/${i}` }),
        );
        cache.submit(makePlan(permReqs));
        for (let i = 0; i < MAX_TRACKED_FAILURES; i++) {
          source.reject(`entity-1/image-1/0/0/0/0/0/${i}`, new Error("404 not found"));
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(cache.failuresTracked()).toBe(MAX_TRACKED_FAILURES);

        // A brand-new TRANSIENT failure arrives while permanents are full.
        const tIdx = MAX_TRACKED_FAILURES;
        const transientReq = makeRequest({ x: tIdx, chunkKey: `0/0/0/0/0/${tIdx}` });
        const transientComposite = `entity-1/image-1/0/0/0/0/0/${tIdx}`;
        cache.submit(makePlan([transientReq]));
        source.reject(transientComposite, new Error("Network error"));
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
        source.reject(transientComposite, new Error("Network error"));
        await vi.advanceTimersByTimeAsync(0);

        // The transient got its OWN store slot — permanents did not evict it.
        expect(cache.failuresTracked()).toBe(MAX_TRACKED_FAILURES + 1);

        // The regression this fixes: the transient is RETAINED with its
        // backoff. Re-planning it before its eligibility instant issues NO
        // new fetch — with a single saturated map it would have been evicted
        // and re-fetched with no backoff every tick.
        const backoffFloor =
          FAILURE_BACKOFF_BASE_MS * (1 - FAILURE_BACKOFF_JITTER_RATIO);
        clock = backoffFloor - 1;
        let fetchesBefore = source.fetchCount;
        cache.submit(makePlan([transientReq]));
        expect(source.fetchCount).toBe(fetchesBefore);

        // Permanents stay sticky through the transient churn: neither the
        // FIFO-oldest nor the most-recent permanent re-fetches.
        cache.submit(makePlan([makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" })]));
        cache.submit(makePlan([
          makeRequest({
            x: MAX_TRACKED_FAILURES - 1,
            chunkKey: `0/0/0/0/0/${MAX_TRACKED_FAILURES - 1}`,
          }),
        ]));
        expect(source.fetchCount).toBe(fetchesBefore);

        // And self-heal still works: past the backoff the transient re-fetches.
        clock = backoffFloor;
        fetchesBefore = source.fetchCount;
        cache.submit(makePlan([transientReq]));
        expect(source.fetchCount).toBe(fetchesBefore + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a key flips transient → permanent and becomes sticky (leaves the transient store)", async () => {
      vi.useFakeTimers();
      try {
        let clock = 0;
        const { cache, source } = createTestCache({ now: () => clock, random: () => 0 });
        const req = makeRequest();
        const composite = "entity-1/image-1/0/0/0/0/0/0";

        // First incident: transient. Fails, retries once, fails again → the
        // key lands in the transient store with a backoff.
        cache.submit(makePlan([req]));
        source.reject(composite, new Error("Network error"));
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
        source.reject(composite, new Error("Network error"));
        await vi.advanceTimersByTimeAsync(0);
        expect(cache.failuresTracked()).toBe(1);

        // Backoff elapses → re-planned, re-fetched. This time it is a 404.
        clock += FAILURE_BACKOFF_MAX_MS + 1;
        cache.submit(makePlan([req]));
        source.reject(composite, new Error("404 not found"));
        await vi.advanceTimersByTimeAsync(0);

        // Still exactly one tracked entry — it moved stores, not duplicated.
        expect(cache.failuresTracked()).toBe(1);

        // Now sticky: no elapsed time makes it re-fetch.
        const fetchesBefore = source.fetchCount;
        clock += FAILURE_BACKOFF_MAX_MS * 1000;
        cache.submit(makePlan([req]));
        expect(source.fetchCount).toBe(fetchesBefore);
      } finally {
        vi.useRealTimers();
      }
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

    it("'no wire format registered' classifies as permanent — no retry", async () => {
      // End-to-end via ProxiedContentSource so the full fetch path is
      // exercised, not just the classifier.
      vi.useFakeTimers();
      try {
        const sentMessages: string[] = [];
        const realSource = new ProxiedContentSource(
          (json) => sentMessages.push(json),
        );
        // Without registerImage, `fetch` rejects with the typed
        // permanent FetchError.
        const decode = createSyncDecode();
        const cache = new CpuCache(realSource, decode);

        const req = makeRequest();
        const beforeFetches = sentMessages.length;
        cache.submit(makePlan([req]));

        // Flush microtasks so the synchronous rejection from `fetch`
        // is caught and the failure-map entry is recorded. We also
        // advance well past the retry delay to prove no retry fires.
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS * 4);

        // No additional chunk_request frames went out — the cache did
        // not retry.
        const afterFetches = sentMessages.length;
        expect(afterFetches).toBe(beforeFetches);

        // Telemetry attributes the failure to the permanent bucket.
        const tel = cache.telemetry();
        expect(tel.failedChunks.permanent).toBe(1);
        expect(tel.failedChunks.transient).toBe(0);
        expect(tel.lastError).toMatch(/No wire format registered/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // Delivery failure streak surfacing
  // =========================================================================

  describe("delivery failure streak surfacing", () => {
    it("notifies once when a failure streak reaches the threshold, throttled thereafter", async () => {
      const onChunkFailureStreak = vi.fn();
      const { cache, source } = createTestCache({
        maxConcurrentFetches: 32,
        onChunkFailureStreak,
      });

      const reqs = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD }, (_, i) =>
        makeRequest({ x: i }),
      );
      cache.submit(makePlan(reqs));
      for (let i = 0; i < reqs.length; i++) {
        source.reject(`entity-1/image-1/0/0/0/0/0/${i}`, new Error("404 not found"));
      }
      await flush();

      expect(onChunkFailureStreak).toHaveBeenCalledExactlyOnceWith(
        CHUNK_FAILURE_STREAK_THRESHOLD,
        "404 not found",
      );

      // Failures continuing inside the throttle window stay silent — the
      // signal is an aggregate, never per-chunk spam.
      cache.submit(makePlan([makeRequest({ y: 1 }), makeRequest({ y: 1, x: 1 })]));
      source.reject("entity-1/image-1/0/0/0/0/1/0", new Error("404 not found"));
      source.reject("entity-1/image-1/0/0/0/0/1/1", new Error("404 not found"));
      await flush();

      expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
    });

    it("a delivered chunk resets the streak — mixed success/failure never notifies", async () => {
      const onChunkFailureStreak = vi.fn();
      const { cache, source } = createTestCache({
        maxConcurrentFetches: 32,
        onChunkFailureStreak,
      });

      // One below the threshold fails…
      const firstBatch = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD - 1 }, (_, i) =>
        makeRequest({ x: i }),
      );
      cache.submit(makePlan(firstBatch));
      for (let i = 0; i < firstBatch.length; i++) {
        source.reject(`entity-1/image-1/0/0/0/0/0/${i}`, new Error("404 not found"));
      }
      await flush();

      // …then one success resets the streak…
      cache.submit(makePlan([makeRequest({ y: 2 })]));
      source.resolve("entity-1/image-1/0/0/0/0/2/0");
      await flush();

      // …so another below-threshold run of failures still stays silent.
      const secondBatch = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD - 1 }, (_, i) =>
        makeRequest({ y: 3, x: i }),
      );
      cache.submit(makePlan(secondBatch));
      for (let i = 0; i < secondBatch.length; i++) {
        source.reject(`entity-1/image-1/0/0/0/0/3/${i}`, new Error("404 not found"));
      }
      await flush();

      expect(onChunkFailureStreak).not.toHaveBeenCalled();
    });

    it("transient failures (disconnect rejections, timeouts) never feed the streak", async () => {
      vi.useFakeTimers();
      try {
        const onChunkFailureStreak = vi.fn();
        const { cache, source } = createTestCache({
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
        });

        const reqs = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD + 2 }, (_, i) =>
          makeRequest({ x: i }),
        );
        cache.submit(makePlan(reqs));
        // First attempt: reject everything the way the transport does when
        // the bridge drops mid-flight. The cache retries transient once.
        for (let i = 0; i < reqs.length; i++) {
          source.reject(
            `entity-1/image-1/0/0/0/0/0/${i}`,
            new FetchError("Bridge disconnected", { kind: "transient" }),
          );
        }
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
        // Retry attempt: the socket is still down, so these time out /
        // reject transiently too — the post-retry failures are recorded,
        // but a connection drop must not read as a failing data source.
        for (let i = 0; i < reqs.length; i++) {
          source.reject(
            `entity-1/image-1/0/0/0/0/0/${i}`,
            new FetchError("Chunk timed out", { kind: "transient" }),
          );
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(onChunkFailureStreak).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resetChunkFailureStreak (reconnect) starts the count over", async () => {
      const onChunkFailureStreak = vi.fn();
      const { cache, source } = createTestCache({
        maxConcurrentFetches: 32,
        onChunkFailureStreak,
      });

      const rejectBatch = async (y: number, count: number) => {
        const reqs = Array.from({ length: count }, (_, i) => makeRequest({ y, x: i }));
        cache.submit(makePlan(reqs));
        for (let i = 0; i < count; i++) {
          source.reject(`entity-1/image-1/0/0/0/0/${y}/${i}`, new Error("404 not found"));
        }
        await flush();
      };

      await rejectBatch(0, 6);
      cache.resetChunkFailureStreak();
      await rejectBatch(1, 6);
      // 6 + 6 would have crossed the threshold without the reset.
      expect(onChunkFailureStreak).not.toHaveBeenCalled();

      // Sanity: the counter still works after a reset — 4 more failures
      // complete a fresh run of 10 consecutive.
      await rejectBatch(2, 4);
      expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
    });

    it("decode failures count toward the streak, and fetch completion alone does not reset it", async () => {
      const onChunkFailureStreak = vi.fn();
      const source = createMockContentSource();
      let failDecode = false;
      const decode = {
        decode: (bytes: ArrayBuffer) =>
          failDecode
            ? Promise.reject(new Error("length mismatch for wire format"))
            : Promise.resolve(bytes),
        activeCount: () => 0,
        get size() { return 3; },
        terminate: () => {},
      } as unknown as DecodePool;
      const cache = new CpuCache(source, decode, {
        maxConcurrentFetches: 32,
        onChunkFailureStreak,
      });

      // One short of the threshold fails at the fetch boundary…
      const reqs = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD }, (_, i) =>
        makeRequest({ x: i }),
      );
      cache.submit(makePlan(reqs));
      for (let i = 0; i < CHUNK_FAILURE_STREAK_THRESHOLD - 1; i++) {
        source.reject(`entity-1/image-1/0/0/0/0/0/${i}`, new Error("404 not found"));
      }
      // …then the last fetch COMPLETES but its bytes cannot be decoded
      // (e.g. a source answering 200 with the wrong wire format). That is
      // a delivery failure, not a recovery.
      failDecode = true;
      source.resolve(`entity-1/image-1/0/0/0/0/0/${CHUNK_FAILURE_STREAK_THRESHOLD - 1}`);
      await flush();

      expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
      expect(onChunkFailureStreak.mock.calls[0][1]).toContain("decode failed");
    });

    it("server-reported source-chunk failures feed the streak (dead source becomes visible)", async () => {
      // End-to-end through the real ProxiedContentSource: the server's
      // `source_chunk_status` frames (store failures after a successful
      // open — revoked access, backend down) are server-reported failures,
      // so both the permanent (`failed_permanent`) and the self-healing
      // transient (`unavailable`) frames feed the streak. A persistently
      // dead source thus surfaces instead of dying as streak-exempt
      // client-side transient timeouts.
      const onChunkFailureStreak = vi.fn();
      const sentMessages: string[] = [];
      const realSource = new ProxiedContentSource((json) => sentMessages.push(json));
      realSource.registerImage("image-1", { Raw: { data_type: "uint16" } });
      const cache = new CpuCache(realSource, createSyncDecode(), {
        maxConcurrentFetches: 32,
        onChunkFailureStreak,
      });

      const reqs = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD }, (_, i) =>
        makeRequest({ x: i }),
      );
      cache.submit(makePlan(reqs));
      for (let i = 0; i < reqs.length; i++) {
        // Both wire statuses count identically.
        const status = i % 2 === 0 ? "failed_permanent" : "unavailable";
        realSource.handleSourceChunkStatus(
          "entity-1",
          "image-1",
          `0/0/0/0/0/${i}`,
          status,
          "access to the dataset store was denied",
        );
      }
      await flush();

      expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
      expect(onChunkFailureStreak.mock.calls[0][0]).toBe(CHUNK_FAILURE_STREAK_THRESHOLD);
      expect(onChunkFailureStreak.mock.calls[0][1]).toContain(
        "access to the dataset store was denied",
      );
    });

    it("a server-reported unavailable failure feeds the streak yet stays self-healing", async () => {
      // `unavailable` is server-reported, so it must surface a persistently
      // dead source through the streak — but it keeps its transient
      // classification: it retries, recovers on the retry, and is never
      // recorded as a sticky permanent failure. Both properties at once.
      vi.useFakeTimers();
      try {
        const onChunkFailureStreak = vi.fn();
        const onChunkFailureRecovered = vi.fn();
        const realSource = new ProxiedContentSource(() => {});
        realSource.registerImage("image-1", { Raw: { data_type: "uint16" } });
        const cache = new CpuCache(realSource, createSyncDecode(), {
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
          onChunkFailureRecovered,
        });

        const reqs = Array.from({ length: CHUNK_FAILURE_STREAK_THRESHOLD }, (_, i) =>
          makeRequest({ x: i }),
        );
        cache.submit(makePlan(reqs));

        // Every chunk comes back `unavailable` — a transient, retryable
        // failure that nonetheless feeds the streak because the source
        // itself reported it.
        for (let i = 0; i < reqs.length; i++) {
          realSource.handleSourceChunkStatus(
            "entity-1",
            "image-1",
            `0/0/0/0/0/${i}`,
            "unavailable",
            "backend temporarily unavailable",
          );
        }
        await vi.advanceTimersByTimeAsync(0);

        // Surfaced: a source that keeps answering `unavailable` is visibly
        // failing rather than silently self-healing forever.
        expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
        expect(onChunkFailureStreak.mock.calls[0][0]).toBe(CHUNK_FAILURE_STREAK_THRESHOLD);
        expect(onChunkFailureStreak.mock.calls[0][1]).toContain(
          "backend temporarily unavailable",
        );

        // Self-healing: the transient classification is intact, so each chunk
        // is retried. When the backend recovers, the retries deliver…
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
        for (let i = 0; i < reqs.length; i++) {
          realSource.handleChunkData(`entity-1/image-1/0/0/0/0/0/${i}`, new ArrayBuffer(64));
        }
        await vi.advanceTimersByTimeAsync(0);

        // …which retires the surfaced signal and proves the failures were
        // never turned into sticky permanent entries.
        expect(onChunkFailureRecovered).toHaveBeenCalledTimes(1);
        expect(cache.telemetry().failedChunks.permanent).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a server-reported transient that also fails its retry feeds the streak once, not twice", async () => {
      // The recoverable-throttle case: every chunk comes back `unavailable`
      // (server-reported, transient), is retried once, and
      // the retry ALSO comes back `unavailable`. Each such chunk produces two
      // physical rejections but is a single failed delivery: it must feed the
      // streak exactly once. If the retry double-counted, half a threshold of
      // distinct throttled chunks would trip the aggregate "loading is failing"
      // signal on a source that is merely rate-limiting and self-heals.
      vi.useFakeTimers();
      try {
        const onChunkFailureStreak = vi.fn();
        const realSource = new ProxiedContentSource(() => {});
        realSource.registerImage("image-1", { Raw: { data_type: "uint16" } });
        const cache = new CpuCache(realSource, createSyncDecode(), {
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
        });

        const half = CHUNK_FAILURE_STREAK_THRESHOLD / 2;
        const throttled = Array.from({ length: half }, (_, i) => makeRequest({ x: i }));
        cache.submit(makePlan(throttled));

        // First attempt: every chunk is reported `unavailable`.
        for (let i = 0; i < throttled.length; i++) {
          realSource.handleSourceChunkStatus(
            "entity-1", "image-1", `0/0/0/0/0/${i}`,
            "unavailable", "backend throttled",
          );
        }
        await vi.advanceTimersByTimeAsync(0);

        // Retry attempt (still within the fetch timeout window): the source
        // reports `unavailable` a second time for the same chunks. Two physical
        // rejections per chunk, but the streak must not double-count them.
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
        for (let i = 0; i < throttled.length; i++) {
          realSource.handleSourceChunkStatus(
            "entity-1", "image-1", `0/0/0/0/0/${i}`,
            "unavailable", "backend throttled",
          );
        }
        await vi.advanceTimersByTimeAsync(0);

        // `half` distinct throttled chunks contribute `half` to the streak —
        // below the threshold — so a self-healing throttle stays quiet even
        // though it emitted a full threshold of physical rejections.
        expect(onChunkFailureStreak).not.toHaveBeenCalled();
        // No sticky permanents: the transient classification survived intact.
        expect(cache.telemetry().failedChunks.permanent).toBe(0);

        // Proof each throttled chunk contributed exactly one (not zero): a
        // further batch of distinct server-reported failures completes exactly
        // one full threshold and fires the signal once.
        const dead = Array.from(
          { length: CHUNK_FAILURE_STREAK_THRESHOLD - half },
          (_, i) => makeRequest({ y: 1, x: i }),
        );
        cache.submit(makePlan(dead));
        for (let i = 0; i < dead.length; i++) {
          realSource.handleSourceChunkStatus(
            "entity-1", "image-1", `0/0/0/0/1/${i}`,
            "failed_permanent", "credentials revoked",
          );
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
        expect(onChunkFailureStreak.mock.calls[0][0]).toBe(CHUNK_FAILURE_STREAK_THRESHOLD);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a chunk whose client transient is retried into a server-reported failure feeds the streak once", async () => {
      // The undercount case: a chunk's FIRST attempt is a client-side
      // transient (streak-exempt, retried) and its RETRY comes back
      // server-reported. The eligible failure lands on the retry, not the
      // first attempt, so it must still feed the streak exactly once — a
      // whole viewport of such chunks against a source that flaps then fails
      // has to surface, not stay silent.
      vi.useFakeTimers();
      try {
        const onChunkFailureStreak = vi.fn();
        const { cache, source } = createTestCache({
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
        });

        const reqs = Array.from(
          { length: CHUNK_FAILURE_STREAK_THRESHOLD },
          (_, i) => makeRequest({ x: i }),
        );
        cache.submit(makePlan(reqs));

        // First attempt: a client-side transient (streak-exempt) that is retried.
        for (let i = 0; i < reqs.length; i++) {
          source.reject(`entity-1/image-1/0/0/0/0/0/${i}`, new Error("Network error"));
        }
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);

        // Retry: the source now answers with a server-reported failure.
        for (let i = 0; i < reqs.length; i++) {
          source.reject(
            `entity-1/image-1/0/0/0/0/0/${i}`,
            new FetchError("backend unavailable", {
              kind: "transient",
              serverReported: true,
            }),
          );
        }
        await vi.advanceTimersByTimeAsync(0);

        // Each chunk fed exactly once → a full threshold → one notification.
        expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
        expect(onChunkFailureStreak.mock.calls[0][0]).toBe(CHUNK_FAILURE_STREAK_THRESHOLD);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a delivered chunk retires a notified streak exactly once and re-arms the notifier", async () => {
      const onChunkFailureStreak = vi.fn();
      const onChunkFailureRecovered = vi.fn();
      const { cache, source } = createTestCache({
        maxConcurrentFetches: 32,
        onChunkFailureStreak,
        onChunkFailureRecovered,
      });

      const rejectBatch = async (y: number, count: number) => {
        const reqs = Array.from({ length: count }, (_, i) => makeRequest({ y, x: i }));
        cache.submit(makePlan(reqs));
        for (let i = 0; i < count; i++) {
          source.reject(`entity-1/image-1/0/0/0/0/${y}/${i}`, new Error("404 not found"));
        }
        await flush();
      };

      await rejectBatch(0, CHUNK_FAILURE_STREAK_THRESHOLD);
      expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
      expect(onChunkFailureRecovered).not.toHaveBeenCalled();

      // A delivered (fetched AND decoded) chunk retires the signal…
      cache.submit(makePlan([makeRequest({ y: 1 })]));
      source.resolve("entity-1/image-1/0/0/0/0/1/0");
      await flush();
      expect(onChunkFailureRecovered).toHaveBeenCalledTimes(1);

      // …exactly once: further healthy deliveries stay silent.
      cache.submit(makePlan([makeRequest({ y: 2 })]));
      source.resolve("entity-1/image-1/0/0/0/0/2/0");
      await flush();
      expect(onChunkFailureRecovered).toHaveBeenCalledTimes(1);

      // A NEW streak after recovery is a new incident: it notifies
      // immediately instead of waiting out the previous throttle window.
      await rejectBatch(3, CHUNK_FAILURE_STREAK_THRESHOLD);
      expect(onChunkFailureStreak).toHaveBeenCalledTimes(2);
    });

    it("re-surfaces after a delivery reset when a re-planned source stays dead", async () => {
      // The streak counts CONSECUTIVE failed deliveries: once a delivery
      // resets it, a chunk that keeps failing across later re-plan cycles must
      // re-contribute — otherwise a partially-dead source surfaces once, one
      // unrelated chunk arrives, and the still-massively-failing chunks can
      // never re-trip the alarm (a silent stall).
      vi.useFakeTimers();
      try {
        let clock = 0;
        const onChunkFailureStreak = vi.fn();
        const onChunkFailureRecovered = vi.fn();
        const source = createMockContentSource();
        let decodeSucceeds = false;
        const decode = {
          decode: (bytes: ArrayBuffer) =>
            decodeSucceeds
              ? Promise.resolve(bytes)
              : Promise.reject(new Error("length mismatch for wire format")),
          activeCount: () => 0,
          get size() { return 3; },
          terminate: () => {},
        } as unknown as DecodePool;
        const cache = new CpuCache(source, decode, {
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
          onChunkFailureRecovered,
          now: () => clock,
          random: () => 0,
        });

        const dead = Array.from(
          { length: CHUNK_FAILURE_STREAK_THRESHOLD },
          (_, i) => makeRequest({ x: i }),
        );
        const deadComposites = dead.map(
          (_, i) => `entity-1/image-1/0/0/0/0/0/${i}`,
        );
        const failAllDead = async () => {
          cache.submit(makePlan(dead));
          for (const composite of deadComposites) source.resolve(composite);
          await vi.advanceTimersByTimeAsync(0);
        };

        // A full threshold of un-decodable deliveries surfaces the alarm.
        await failAllDead();
        expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);

        // One unrelated healthy chunk delivers: the streak resets and the
        // alarm is retired.
        decodeSucceeds = true;
        cache.submit(makePlan([makeRequest({ y: 1 })]));
        source.resolve("entity-1/image-1/0/0/0/0/1/0");
        await vi.advanceTimersByTimeAsync(0);
        expect(onChunkFailureRecovered).toHaveBeenCalledTimes(1);

        // The source is still dead. Past their backoff the same chunks re-plan,
        // re-fetch, and fail again — and must re-surface rather than stay
        // silently stalled behind a one-shot dedup.
        decodeSucceeds = false;
        clock += FAILURE_BACKOFF_MAX_MS + 1;
        await failAllDead();
        expect(onChunkFailureStreak).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-surfaces after resetChunkFailureStreak when the same source stays dead", async () => {
      // resetChunkFailureStreak (reconnect) zeroes the count. A source that is
      // still dead after the reconnect — the exact case the reset exists for —
      // must be able to re-count its already-failed chunks; otherwise the
      // count can never climb again and the alarm never re-fires.
      vi.useFakeTimers();
      try {
        let clock = 0;
        const onChunkFailureStreak = vi.fn();
        const source = createMockContentSource();
        const decode = {
          decode: () => Promise.reject(new Error("length mismatch for wire format")),
          activeCount: () => 0,
          get size() { return 3; },
          terminate: () => {},
        } as unknown as DecodePool;
        const cache = new CpuCache(source, decode, {
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
          now: () => clock,
          random: () => 0,
        });

        const belowThreshold = CHUNK_FAILURE_STREAK_THRESHOLD - 4;
        const dead = Array.from(
          { length: belowThreshold },
          (_, i) => makeRequest({ x: i }),
        );
        const deadComposites = dead.map(
          (_, i) => `entity-1/image-1/0/0/0/0/0/${i}`,
        );
        const failAllDead = async () => {
          cache.submit(makePlan(dead));
          for (const composite of deadComposites) source.resolve(composite);
          await vi.advanceTimersByTimeAsync(0);
        };

        // Below-threshold failures stay quiet.
        await failAllDead();
        expect(onChunkFailureStreak).not.toHaveBeenCalled();

        // The transport reconnects: the count starts over.
        cache.resetChunkFailureStreak();

        // The source is still dead. Past their backoff the same chunks re-plan
        // and fail again — they must re-contribute to the fresh count…
        clock += FAILURE_BACKOFF_MAX_MS + 1;
        await failAllDead();

        // …so four more distinct dead chunks complete a full threshold and
        // surface the alarm. If the reconnect-reset left the already-failed
        // chunks barred from re-counting, the count would stall at four.
        const rest = Array.from({ length: 4 }, (_, i) => makeRequest({ y: 1, x: i }));
        cache.submit(makePlan(rest));
        for (let i = 0; i < rest.length; i++) {
          source.resolve(`entity-1/image-1/0/0/0/0/1/${i}`);
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
        expect(onChunkFailureStreak.mock.calls[0][0]).toBe(CHUNK_FAILURE_STREAK_THRESHOLD);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a dead source touching a small distinct-chunk set surfaces across re-plan cycles", async () => {
      // The viewport touches fewer distinct chunks than the threshold. Each
      // must be able to contribute on every re-plan failure, or the count can
      // never reach the threshold no matter how long the source stays dead.
      vi.useFakeTimers();
      try {
        let clock = 0;
        const onChunkFailureStreak = vi.fn();
        const source = createMockContentSource();
        const decode = {
          decode: () => Promise.reject(new Error("length mismatch for wire format")),
          activeCount: () => 0,
          get size() { return 3; },
          terminate: () => {},
        } as unknown as DecodePool;
        const cache = new CpuCache(source, decode, {
          maxConcurrentFetches: 32,
          onChunkFailureStreak,
          now: () => clock,
          random: () => 0,
        });

        // Two distinct chunks — far below the threshold.
        const reqs = [makeRequest({ x: 0 }), makeRequest({ x: 1 })];
        const composites = [
          "entity-1/image-1/0/0/0/0/0/0",
          "entity-1/image-1/0/0/0/0/0/1",
        ];

        const cycles = CHUNK_FAILURE_STREAK_THRESHOLD / reqs.length;
        for (let cycle = 0; cycle < cycles; cycle++) {
          cache.submit(makePlan(reqs));
          for (const composite of composites) source.resolve(composite);
          await vi.advanceTimersByTimeAsync(0);
          // Past any backoff so the next submit re-plans and re-fetches.
          clock += FAILURE_BACKOFF_MAX_MS + 1;
        }

        // Two chunks across five re-plan cycles = a full threshold of
        // consecutive failed deliveries → surfaced.
        expect(onChunkFailureStreak).toHaveBeenCalledTimes(1);
        expect(onChunkFailureStreak.mock.calls[0][0]).toBe(CHUNK_FAILURE_STREAK_THRESHOLD);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // Budget enforcement
  // =========================================================================

  describe("budget enforcement", () => {
    it("detail borrows unused coarse budget while coarse is idle, then evicts back to its protected budget", async () => {
      const { cache, source } = createTestCache({
        mainBudgetBytes: 200,
        overviewBudgetBytes: 100,
      });
      source.autoResolveBytes = 100;

      const details = [0, 1, 2].map((x) =>
        makeRequest({ x, lane: "detail", chunkKey: `0/0/0/0/0/${x}` }),
      );
      cache.submit(makePlan(details));
      await flush();

      let tel = cache.telemetry();
      expect(tel.mainBytes).toBe(300);
      expect(tel.tierBudgets.detailBytes).toBe(300);

      const coarse = makeRequest({
        lane: "coarse",
        tier: "coarse",
        level: 2,
        chunkKey: "2/0/0/0/0/0",
      });
      cache.submit(makePlan([...details, coarse]));
      await flush();

      tel = cache.telemetry();
      expect(tel.tierBudgets.detailBytes).toBe(200);
      expect(tel.tierBudgets.coarseBytes).toBe(100);
      expect(tel.mainBytes).toBeLessThanOrEqual(200);
      expect(tel.overviewBytes).toBe(100);
    });

    it("coarse borrows unused detail budget while detail is idle", async () => {
      const { cache, source } = createTestCache({
        mainBudgetBytes: 200,
        overviewBudgetBytes: 100,
      });
      source.autoResolveBytes = 100;

      const coarse = [0, 1, 2].map((x) =>
        makeRequest({
          x,
          lane: "coarse",
          tier: "coarse",
          level: 2,
          chunkKey: `2/0/0/0/0/${x}`,
        }),
      );
      cache.submit(makePlan(coarse));
      await flush();

      const tel = cache.telemetry();
      expect(tel.overviewBytes).toBe(300);
      expect(tel.tierBudgets.coarseBytes).toBe(300);
    });

    it("evicts when exceeding detail budget", async () => {
      const budget = 200;
      const { cache, source } = createTestCache({ mainBudgetBytes: budget, overviewBudgetBytes: 0 });
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

    it("returns cached entry after delivery consumption", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      const req = makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" });
      cache.submit(makePlan([req]));
      await flush();

      // Delivery consumption marks sent but does NOT remove from cache.
      consumeDeliverables(cache);

      const result = cache.getCachedChunk("entity-1", "0/0/0/0/0/0");
      expect(result).not.toBeNull();
      expect(result!.entityId).toBe("entity-1");
      expect(result!.chunkKey).toBe("0/0/0/0/0/0");
    });

    it("returns null after eviction", async () => {
      const budget = 200;
      const { cache, source } = createTestCache({ mainBudgetBytes: budget, overviewBudgetBytes: 0 });
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
      expect(consumeDeliverables(cache)).toHaveLength(0);

      const tel = cache.telemetry();
      expect(tel.mainBytes).toBe(0);
      expect(tel.overviewBytes).toBe(0);
      expect(tel.proxyBytes).toBe(0);
    });
  });

  // =========================================================================
  // Proxy tier
  // =========================================================================

  describe("proxy tier", () => {
    function makeProxyRequest(overrides?: Partial<ProxyRequest>): ProxyRequest {
      return {
        datasetId: "ds-1",
        entityId: "entity-1",
        imageId: "image-1",
        kind: "TileProxy3D",
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
        kind: "TileProxy3D",
        t: 0,
        c: 0,
      });
    });

    it("getDeliverable returns a proxy delivery with kind: proxy and header", async () => {
      const { cache, source } = createTestCache();
      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      const deliveries = consumeDeliverables(cache);
      expect(deliveries).toHaveLength(1);
      const d = deliveries[0];
      expect(d.kind).toBe("proxy");
      if (d.kind !== "proxy") throw new Error("expected proxy delivery");
      expect(d.datasetId).toBe("ds-1");
      expect(d.entityId).toBe("entity-1");
      expect(d.proxyKind).toBe("TileProxy3D");
      expect(d.t).toBe(0);
      expect(d.c).toBe(0);
      expect(d.header).toEqual(source.proxyHeader);
      expect(d.data.byteLength).toBe(source.autoResolveProxyBytes);
    });

    it("starts proxy fallback work even when chunk capacity is saturated", async () => {
      const { cache, source } = createTestCache({ maxConcurrentFetches: 1 });
      const chunkReq = makeRequest({ chunkKey: "0/0/0/0/0/0" });
      const proxyReq = makeProxyRequest();

      cache.submit({
        ...makePlan([chunkReq]),
        proxyRequests: [proxyReq],
      });

      expect(source.fetchProxyCount).toBe(1);
      expect(source.fetchCount).toBe(0);

      await flush();

      expect(source.fetchCount).toBe(1);
    });

    it("does not re-fetch a cached proxy on second submit (cache hit)", async () => {
      const { cache, source } = createTestCache();
      const req = makeProxyRequest();
      cache.submit(makeProxyPlan([req]));
      await flush();
      // Mark the first delivery sent.
      consumeDeliverables(cache);

      const fetchesBefore = source.fetchProxyCount;
      cache.submit(makeProxyPlan([req]));
      await flush();

      // No new network fetch.
      expect(source.fetchProxyCount).toBe(fetchesBefore);

      // TickCoordinator resends evicted proxies via `getCachedProxy`.
      const replays = consumeDeliverables(cache);
      expect(replays).toHaveLength(0);
    });

    it("submit() with already-cached proxy does not push to ready", async () => {
      const { cache } = createTestCache();
      const req = makeProxyRequest();
      cache.submit(makeProxyPlan([req]));
      await flush();
      // Mark the initial decode delivery sent.
      const initial = consumeDeliverables(cache);
      expect(initial).toHaveLength(1);

      // Second submit of the same plan: nothing should land in `ready`.
      cache.submit(makeProxyPlan([req]));
      await flush();
      expect(consumeDeliverables(cache)).toHaveLength(0);
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
        cache.getCachedProxy("ds-1", "entity-x", "TileProxy3D", 0, 0),
      ).toBeNull();

      cache.submit(makeProxyPlan([makeProxyRequest()]));
      await flush();

      const hit = cache.getCachedProxy(
        "ds-1",
        "entity-1",
        "TileProxy3D",
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
        cache.getCachedProxy("ds-1", "entity-1", "TileProxy3D", 0, 0),
      ).toBeNull();
      expect(
        cache.getCachedProxy("ds-1", "entity-1", "TileProxy3D", 2, 0),
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
        cache.getCachedProxy("ds-1", "entity-1", "TileProxy3D", 0, 0),
      ).toBeNull();
      // Counter sanity check — fetchProxy not called again on reset.
      const before = source.fetchProxyCount;
      consumeDeliverables(cache);
      expect(source.fetchProxyCount).toBe(before);
    });

    describe("departed-entity proxy cancel", () => {
      const AWAY_KEY = "ds-1|entity-1|TileProxy3D|0|0";
      const CURRENT_KEY = "ds-2|entity-2|TileProxy3D|0|0";

      /** A plan whose active set names `entityId` and that requests its proxy. */
      function proxyPlanFor(
        datasetId: string,
        entityId: string,
        imageId: string,
      ): RequestPlan {
        return {
          ...makePlan([], [makeActiveEntry(entityId, imageId)]),
          proxyRequests: [makeProxyRequest({ datasetId, entityId, imageId })],
        };
      }

      it("cancels a departed entity's in-flight proxy at the rebuild boundary", async () => {
        const { cache, source } = createTestCache();
        source.autoResolveProxyBytes = null; // hold the proxy in-flight

        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));
        expect(source.fetchProxyCount).toBe(1);
        expect(cache.telemetry().inFlightProxyCount).toBe(1);
        expect(source.pendingProxyFetches.has(AWAY_KEY)).toBe(true);

        // entity-1 leaves the view; entity-2 is the current view now. The
        // departure is only detected at the NEXT rebuild boundary.
        cache.onPlanRebuildStart();
        cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));
        expect(cache.telemetry().inFlightProxyCount).toBe(1);

        // entity-1 absent for a full rebuild → its proxy is aborted at the
        // boundary, releasing the shared concurrency slot to the current view.
        cache.onPlanRebuildStart();
        cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));
        await flush();

        expect(cache.telemetry().inFlightProxyCount).toBe(0);
        expect(source.pendingProxyFetches.has(AWAY_KEY)).toBe(false);
      });

      it("frees the shared single slot for the current view's proxy", async () => {
        // One shared concurrency slot: the chunk and proxy schedulers share
        // the cap, so a departed entity's proxy holding it starves the view.
        const { cache, source } = createTestCache({ maxConcurrentFetches: 1 });
        source.autoResolveProxyBytes = null;

        // entity-1's proxy takes the single shared slot.
        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));
        expect(source.fetchProxyCount).toBe(1);

        // entity-1 leaves; entity-2 (current view) wants its proxy but cannot
        // start — the only slot is still held by the departed entity.
        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-2", "entity-2", "image-2"));
        expect(source.pendingProxyFetches.has(CURRENT_KEY)).toBe(false);

        // Next rebuild: entity-1 absent for a full rebuild → its proxy is
        // cancelled at the boundary, freeing the slot for the current view.
        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-2", "entity-2", "image-2"));
        await flush();

        expect(source.pendingProxyFetches.has(AWAY_KEY)).toBe(false);
        expect(source.pendingProxyFetches.has(CURRENT_KEY)).toBe(true);
        expect(cache.telemetry().inFlightProxyCount).toBe(1);
      });

      it("re-fetches a returning entity's proxy after its departure cancel", async () => {
        const { cache, source } = createTestCache();
        source.autoResolveProxyBytes = null;

        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));
        expect(source.fetchProxyCount).toBe(1);

        // entity-1 leaves for a full rebuild → its in-flight proxy is aborted.
        cache.onPlanRebuildStart();
        cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));
        cache.onPlanRebuildStart();
        cache.submit(makePlan([], [makeActiveEntry("entity-2", "image-2")]));
        await flush();
        expect(cache.telemetry().inFlightProxyCount).toBe(0);

        // entity-1 returns: proxies are NeverRetry, so the orchestrator's
        // resubmit is the only path back — it must re-fetch, not stay dropped.
        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));
        expect(source.fetchProxyCount).toBe(2);
        expect(source.pendingProxyFetches.has(AWAY_KEY)).toBe(true);
      });

      it("does not cancel a still-visible entity's in-flight proxy", () => {
        const { cache, source } = createTestCache();
        source.autoResolveProxyBytes = null;

        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));
        expect(cache.telemetry().inFlightProxyCount).toBe(1);

        // entity-1 stays visible across rebuilds; its in-flight proxy persists
        // (a re-submit finds it in-flight and does not re-enqueue or cancel it).
        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));
        cache.onPlanRebuildStart();
        cache.submit(proxyPlanFor("ds-1", "entity-1", "image-1"));

        expect(cache.telemetry().inFlightProxyCount).toBe(1);
        expect(source.fetchProxyCount).toBe(1);
        expect(source.pendingProxyFetches.has(AWAY_KEY)).toBe(true);
      });

      it("keeps a still-wanted group proxy when its group leaves the active set on a zoom-in", async () => {
        // Group-to-tile zoom-in: the group first renders as a single
        // GroupProxy3D (the group is the active entity), then resolves into
        // individual tiles that share that SAME group proxy as their fallback.
        // The group id leaves the active set, but the group proxy — keyed by
        // the group id, not a per-tile entity — stays continuously requested.
        // The per-entity departure cancel must NOT abort it (that would churn
        // a large shared fallback with an abort + refetch every zoom-in).
        const { cache, source } = createTestCache();
        source.autoResolveProxyBytes = null; // hold the proxy in-flight

        const GROUP_KEY = "ds-1|group-1|GroupProxy3D|0|0";
        const groupProxy = makeProxyRequest({
          datasetId: "ds-1",
          entityId: "group-1",
          imageId: "image-group-1",
          kind: "GroupProxy3D",
        });

        // Group active; its group proxy takes a slot and stays in-flight.
        cache.onPlanRebuildStart();
        cache.submit({
          ...makePlan([], [makeActiveEntry("group-1", "image-group-1")]),
          proxyRequests: [groupProxy],
        });
        expect(source.fetchProxyCount).toBe(1);
        expect(cache.telemetry().inFlightProxyCount).toBe(1);
        expect(source.pendingProxyFetches.has(GROUP_KEY)).toBe(true);

        // Zoom-in: the tiles become the active entities; the group id drops
        // out of the active set, but the group proxy is still requested.
        cache.onPlanRebuildStart();
        cache.submit({
          ...makePlan([], [makeActiveEntry("tile-1", "image-tile-1")]),
          proxyRequests: [groupProxy],
        });

        // Departure boundary for the group id. The group proxy's wantedness
        // tracks plan membership (still requested), not one tile's departure,
        // so it must survive the boundary — in-flight, never refetched.
        cache.onPlanRebuildStart();
        cache.submit({
          ...makePlan([], [makeActiveEntry("tile-1", "image-tile-1")]),
          proxyRequests: [groupProxy],
        });
        await flush();

        expect(cache.telemetry().inFlightProxyCount).toBe(1);
        expect(source.fetchProxyCount).toBe(1);
        expect(source.pendingProxyFetches.has(GROUP_KEY)).toBe(true);
      });
    });
  });

  // =========================================================================
  // Subtle behaviours: race orderings, telemetry shape, eviction-burst log.
  // =========================================================================

  describe("subtle behaviours", () => {
    beforeEach(() => {
      vi.mocked(debugLog).mockClear();
    });

    it("cancelled-during-decode: stale chunk can cache demoted but is not deliverable", async () => {
      // Race: fetch resolves before cancelDataset; the queued decode
      // microtask runs after. Cache-insert is unconditional, so the
      // chunk can still land and be observed by the delivery surface.
      const { cache, source } = createTestCache();
      const req = makeRequest({ x: 0, y: 0, z: 0 });
      cache.submit(makePlan([req]));
      expect(source.fetchCount).toBe(1);

      // Resolve first: the source's promise settles; fetchAndDecode's
      // continuation is queued for the next microtask but has not run.
      source.resolve("entity-1/image-1/0/0/0/0/0/0");

      // Cancel between resolve and the queued continuation. abort()
      // fires but is a no-op against the already-resolved promise; the
      // inFlight map entry is deleted.
      cache.cancelDataset("entity-1", ["entity-1"]);

      await flush();

      expect(cache.getCachedChunk("entity-1", req.chunkKey)).not.toBeNull();
      const deliveries = consumeDeliverables(cache);
      expect(deliveries).toHaveLength(0);
      expect(cache.getCachedChunkTier("entity-1", req.chunkKey)).toBe("demoted-detail");
    });

    it("pendingOldestAgeMs: telemetry reports the age of the oldest pending enqueue", async () => {
      vi.useFakeTimers();
      try {
        const { cache, source } = createTestCache({ maxConcurrentFetches: 1 });
        const r1 = makeRequest({ x: 0 });
        const r2 = makeRequest({ x: 1 });
        cache.submit(makePlan([r1, r2]));
        expect(source.fetchCount).toBe(1);

        const t0 = cache.telemetry().pendingOldestAgeMs;
        expect(t0).toBeGreaterThanOrEqual(0);

        vi.advanceTimersByTime(250);
        const t1 = cache.telemetry().pendingOldestAgeMs;
        expect(t1).toBeGreaterThanOrEqual(t0);
        // Conservative bound: at least the time we advanced.
        expect(t1).toBeGreaterThanOrEqual(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("telemetry reports desired versus resident coarse/detail chunks", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      const detail = makeRequest({ lane: "detail", tier: "detail", chunkKey: "0/0/0/0/0/0" });
      const coarse = makeRequest({
        lane: "coarse",
        tier: "coarse",
        level: 2,
        chunkKey: "2/0/0/0/0/0",
      });

      cache.submit(makePlan([detail, coarse]));
      await flush();

      const demand = cache.telemetry().tierDemand;
      expect(demand.desired).toEqual({ detailChunks: 1, coarseChunks: 1 });
      expect(demand.resident).toMatchObject({
        detailChunks: 1,
        coarseChunks: 1,
        detailBytes: 64,
        coarseBytes: 64,
      });
      expect(demand.detailCoverageRatio).toBe(1);
      expect(demand.sparseDetail).toBe(false);
    });

    it("interleaves detail and coarse fetch starts when both tiers have demand", () => {
      const { cache, source } = createTestCache({ maxConcurrentFetches: 2 });
      cache.submit(makePlan([
        makeRequest({ x: 0, lane: "detail", tier: "detail", chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ x: 1, lane: "detail", tier: "detail", chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ x: 0, lane: "coarse", tier: "coarse", level: 2, chunkKey: "2/0/0/0/0/0" }),
        makeRequest({ x: 1, lane: "coarse", tier: "coarse", level: 2, chunkKey: "2/0/0/0/0/1" }),
      ]));

      expect(Array.from(source.pendingFetches.keys()).sort()).toEqual([
        "entity-1/image-1/0/0/0/0/0/0",
        "entity-1/image-1/2/0/0/0/0/0",
      ]);
      const queues = cache.telemetry().tierQueues;
      expect(queues.detail.inFlight).toBe(1);
      expect(queues.coarse.inFlight).toBe(1);
      expect(queues.detail.pending).toBe(1);
      expect(queues.coarse.pending).toBe(1);
    });

    it("logs sparse detail after sustained low coverage", () => {
      vi.mocked(debugLog).mockClear();
      const { cache } = createTestCache({ maxConcurrentFetches: 0 });
      cache.submit(makePlan([
        makeRequest({ x: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" }),
        makeRequest({ x: 3, chunkKey: "0/0/0/0/0/3" }),
      ]));

      expect(cache.telemetry().tierDemand.sparseDetail).toBe(true);
      cache.telemetry();
      cache.telemetry();

      expect(debugLog).toHaveBeenCalledWith(
        "cache",
        "cache.sparse_detail",
        expect.objectContaining({
          desiredDetailChunks: 4,
          residentDetailChunks: 0,
          pendingChunks: 4,
          notice: expect.stringContaining("lower the detail LOD explicitly"),
        }),
      );
    });

    it("backpressure log fires at most once per second under sustained queue depth", () => {
      vi.useFakeTimers();
      try {
        // BurstLogger gate is `now - lastAt >= 1000`; lastAt starts at 0.
        vi.advanceTimersByTime(2000);

        const { cache } = createTestCache({
          maxConcurrentFetches: 1,
          maxBytesInFlight: 1,
        });
        const requests = [0, 1, 2, 3, 4].map((x) => makeRequest({ x }));

        cache.submit(makePlan(requests));
        const firstCallCount = vi.mocked(debugLog).mock.calls.filter(
          (c) => c[1] === "cache.backpressure",
        ).length;
        expect(firstCallCount).toBe(1);

        // Within 1 second, the rate limit suppresses additional emits.
        vi.advanceTimersByTime(500);
        cache.submit(makePlan(requests));
        const stillOne = vi.mocked(debugLog).mock.calls.filter(
          (c) => c[1] === "cache.backpressure",
        ).length;
        expect(stillOne).toBe(1);

        // After the 1-second window elapses, a new emit fires.
        vi.advanceTimersByTime(600);
        cache.submit(makePlan(requests));
        const afterWindow = vi.mocked(debugLog).mock.calls.filter(
          (c) => c[1] === "cache.backpressure",
        ).length;
        expect(afterWindow).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("eviction-burst log fires when ≥16 entries evict in one pass", async () => {
      const { cache, source } = createTestCache({
        mainBudgetBytes: 16,
        overviewBudgetBytes: 0,
        maxConcurrentFetches: 100,
        maxBytesInFlight: 1024,
      });
      // Each fetch returns 1 byte; cache is empty until we fill it.
      source.autoResolveBytes = 1;

      const fillers = Array.from({ length: 16 }, (_, i) =>
        makeRequest({ x: i, lane: "prefetch" }),
      );
      cache.submit(makePlan(fillers));
      await flush();

      // Mark current deliverables sent. Cache now holds 16 × 1B in main.
      consumeDeliverables(cache);
      vi.mocked(debugLog).mockClear();

      // Insert one bigger entry that requires evicting all 16.
      source.autoResolveBytes = 16;
      cache.submit(
        makePlan([makeRequest({ x: 100, lane: "detail" })]),
      );
      await flush();

      const evictionLogs = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.eviction_burst",
      );
      expect(evictionLogs.length).toBeGreaterThanOrEqual(1);
      expect(evictionLogs[0][2]).toMatchObject({ removed: expect.any(Number) });
      const removedArg = (evictionLogs[0][2] as { removed: number }).removed;
      expect(removedArg).toBeGreaterThanOrEqual(16);
    });

    it("imageWireFormats cleared on dataset removal", async () => {
      // The leak fix lives on ProxiedContentSource, not the cache.
      const sentMessages: string[] = [];
      const source = new ProxiedContentSource(
        (json) => sentMessages.push(json),
      );
      source.registerImage("image-leak", { Raw: { data_type: "uint16" } });

      // Sanity check: registered image dispatches a request.
      const ctrlBefore = new AbortController();
      const before = source.fetch(
        { datasetId: "ds-leak", imageId: "image-leak", chunkKey: "0/0/0/0/0/0" },
        ctrlBefore.signal,
      );
      expect(sentMessages.length).toBe(1);
      ctrlBefore.abort();
      await expect(before).rejects.toMatchObject({ name: "AbortError" });

      // Drop the dataset's image registrations.
      source.unregisterDataset(["image-leak"]);

      const ctrlAfter = new AbortController();
      await expect(
        source.fetch(
          { datasetId: "ds-leak", imageId: "image-leak", chunkKey: "0/0/0/0/0/0" },
          ctrlAfter.signal,
        ),
      ).rejects.toThrow(/No wire format registered for image image-leak/);
    });

    it("telemetry shape regression — locks the CacheTelemetry surface", async () => {
      // Pinned shape after `submit + flush + delivery consumption`; values that depend
      // on wall-clock or running averages use expect.any(Number).
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.submit(makePlan([makeRequest()]));
      await flush();
      consumeDeliverables(cache);

      const tel = cache.telemetry();
      expect(tel).toEqual({
        mainBytes: expect.any(Number),
        mainBudget: expect.any(Number),
        overviewBytes: expect.any(Number),
        overviewBudget: expect.any(Number),
        proxyBytes: expect.any(Number),
        proxyBudget: expect.any(Number),
        maxConcurrentFetches: expect.any(Number),
        maxBytesInFlight: expect.any(Number),
        inFlightCount: expect.any(Number),
        inFlightBytes: expect.any(Number),
        inFlightProxyCount: expect.any(Number),
        inFlightProxyBytes: expect.any(Number),
        pendingCount: expect.any(Number),
        pendingProxyCount: expect.any(Number),
        pendingOldestAgeMs: expect.any(Number),
        readyCount: expect.any(Number),
        hitRate: expect.any(Number),
        evictionsPerSec: expect.any(Number),
        evictionsByTier: {
          activeDetail: expect.any(Number),
          demotedDetail: expect.any(Number),
          prefetch: expect.any(Number),
          overview: expect.any(Number),
          proxy: expect.any(Number),
        },
        interactionMode: expect.stringMatching(/^(panning|scrubbing|idle)$/),
        evictionTierOrder: expect.any(Array),
        failedChunks: {
          transient: expect.any(Number),
          permanent: expect.any(Number),
        },
        lastError: null,
        decodesPerSec: expect.any(Number),
        decodeWorkersTotal: expect.any(Number),
        avgDecodeMs: expect.any(Number),
        decodeP50Ms: expect.any(Number),
        decodeP95Ms: expect.any(Number),
        tierResidency: {
          activeDetail: { count: expect.any(Number), bytes: expect.any(Number) },
          demotedDetail: { count: expect.any(Number), bytes: expect.any(Number) },
          prefetch: { count: expect.any(Number), bytes: expect.any(Number) },
          overview: { count: expect.any(Number), bytes: expect.any(Number) },
          proxy: { count: expect.any(Number), bytes: expect.any(Number) },
        },
        tierDemand: {
          desired: {
            detailChunks: expect.any(Number),
            coarseChunks: expect.any(Number),
          },
          resident: {
            detailChunks: expect.any(Number),
            coarseChunks: expect.any(Number),
            detailBytes: expect.any(Number),
            coarseBytes: expect.any(Number),
          },
          detailCoverageRatio: expect.any(Number),
          sparseDetail: expect.any(Boolean),
        },
        tierQueues: {
          detail: {
            pending: expect.any(Number),
            inFlight: expect.any(Number),
            inFlightBytes: expect.any(Number),
          },
          coarse: {
            pending: expect.any(Number),
            inFlight: expect.any(Number),
            inFlightBytes: expect.any(Number),
          },
        },
        tierBudgets: {
          detailBytes: expect.any(Number),
          coarseBytes: expect.any(Number),
        },
      });

      // Load-bearing values from the known-input sequence.
      expect(tel.hitRate).toBe(0);
      expect(tel.tierResidency.activeDetail.count).toBe(1);
      expect(tel.tierResidency.activeDetail.bytes).toBe(64);
      expect(tel.tierDemand.desired.detailChunks).toBe(1);
      expect(tel.tierDemand.resident.detailChunks).toBe(1);
      expect(tel.mainBytes).toBe(64);
      expect(tel.tierBudgets.detailBytes).toBeGreaterThanOrEqual(tel.mainBudget);
    });
  });
});

import { TRANSIENT_RETRY_DELAY_MS } from "./cpuCache.ts";

// ---------------------------------------------------------------------------
// Pending dump: admission window vs backlog (ADR 0044)
// ---------------------------------------------------------------------------

describe("CpuCache.getPendingDump", () => {
  it("reports no age for backlog entries rather than a misleading zero", () => {
    const { cache } = createTestCache();
    cache.onPlanRebuildStart();

    // Far more requests than the admission window (max(64, 24*4) = 96) so
    // the queue certainly has a backlog behind it.
    const reqs = Array.from({ length: 500 }, (_, i) =>
      makeRequest({
        entityId: `entity-${i}`,
        imageId: `image-${i}`,
        chunkKey: `0/0/0/0/0/${i}`,
        priority: i,
      }),
    );
    cache.submit(makePlan(reqs, reqs.map(r => makeActiveEntry(r.entityId, r.imageId))));

    const dump = cache.getPendingDump();
    const admitted = dump.filter(d => d.admitted);
    const backlog = dump.filter(d => !d.admitted);

    // Both partitions are non-empty, and they partition the queue.
    expect(admitted.length).toBeGreaterThan(0);
    expect(backlog.length).toBeGreaterThan(0);
    expect(admitted.length + backlog.length).toBe(dump.length);

    // Admitted entries carry a real age; backlog entries carry none. The
    // `null` is the point: reporting 0 would paint a deeply oversubscribed
    // queue as a healthy one.
    for (const entry of admitted) expect(entry.ageMs).not.toBeNull();
    for (const entry of backlog) expect(entry.ageMs).toBeNull();
  });
});
