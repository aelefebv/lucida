import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});
import { debugLog } from "../../debug/logging.ts";

import { CpuCache, type CpuCacheConfig, type ReadyDelivery } from "./cpuCache.ts";
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
        kind: "FieldProxy3D",
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

    it("resolves skipped chunk feedback from imageId back to entityId", async () => {
      const { cache, source } = createTestCache();
      source.autoResolveBytes = 64;
      cache.onPlanRebuildStart();

      const detail = makeRequest({
        entityId: "field-entity",
        imageId: "field-image",
        chunkKey: "0/0/0/0/0/0",
        lane: "detail",
      });
      cache.submit(makePlan([detail], [makeActiveEntry("field-entity", "field-image")]));
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

      cache.markProxyMissing("ds-1|entity-1|FieldProxy3D|0|0");
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
      expect(d.proxyKind).toBe("FieldProxy3D");
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
      consumeDeliverables(cache);
      expect(source.fetchProxyCount).toBe(before);
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
