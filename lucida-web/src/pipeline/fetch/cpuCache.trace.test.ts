/**
 * What the cache contributes to the trace's second and third tiers: the point
 * events for the rare things, the counted-not-timed phases, and the per-level
 * residency the per-tick aggregate reads.
 *
 * Driven through the real `CpuCache` against the real recorder, because the
 * value of these events is that they appear when the pipeline does the thing
 * — a mock that emits them proves nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CpuCache, type CpuCacheConfig } from "./cpuCache.ts";
import { FetchError } from "./retry.ts";
import type { ContentSource, FetchRequest, FetchResult } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { ChunkRequest, RequestPlan, ActiveSetEntry } from "../planning/index.ts";
import { emptyPlanStats } from "../planning/index.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { CountedPhaseIndex, type TracePointEvent } from "../../trace/types.ts";

const CAUSE = { epoch: "content", dirtyKind: "interactive", source: "test" } as const;

function makeRequest(overrides?: Partial<ChunkRequest>): ChunkRequest {
  const level = overrides?.level ?? 0;
  const y = overrides?.y ?? 0;
  const x = overrides?.x ?? 0;
  return {
    datasetId: "ds-1",
    entityId: "entity-1",
    imageId: "image-1",
    level,
    t: 0,
    c: 0,
    z: 0,
    y,
    x,
    lane: "detail",
    priority: 0,
    chunkKey: `${level}/0/0/0/${y}/${x}`,
    ...overrides,
  };
}

function makePlan(requests: ChunkRequest[]): RequestPlan {
  const activeSet: ActiveSetEntry[] = [{
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
    activeSet,
    proxyRequests: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    stats: emptyPlanStats(),
    nextState: { previousActiveSet: activeSet },
  };
}

/** Fetches resolve immediately with `bytes` of zeroes; failures are queued by key. */
function createSource(bytes: number) {
  const failures = new Map<string, Error>();
  const source: ContentSource = {
    fetch: async (req: FetchRequest): Promise<FetchResult> => {
      const failure = failures.get(req.chunkKey);
      if (failure) throw failure;
      return {
        bytes: new ArrayBuffer(bytes),
        wireFormat: { Raw: { data_type: "uint8" } },
        dataType: "uint8",
      } satisfies FetchResult;
    },
    fetchProxy: async () => { throw new Error("unused"); },
  } as unknown as ContentSource;
  return { source, failures };
}

function createDecode(): DecodePool {
  return {
    decode: async (bytes: ArrayBuffer) => bytes,
    size: 1,
  } as unknown as DecodePool;
}

function createCache(bytes: number, config?: Partial<CpuCacheConfig>) {
  const { source, failures } = createSource(bytes);
  const cache = new CpuCache(source, createDecode(), config);
  return { cache, failures };
}

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

function eventsOfKind(events: TracePointEvent[], kind: string): TracePointEvent[] {
  return events.filter(e => e.kind === kind);
}

function openRun(): void {
  traceRecorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds-1"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
      speculativePending: 0,
      speculativeInFlight: 0,
      desiredDetailChunks: 0,
      residentDetailChunks: 0,
      desiredCoarseChunks: 0,
      residentCoarseChunks: 0,
    }),
  });
  traceRecorder.openRun(CAUSE);
}

/** The run's events, with the run closed as a side effect. */
function exportedEvents(): TracePointEvent[] {
  const doc = traceRecorder.exportDocument();
  return doc.runs.flatMap(run => run.events);
}

describe("cache point events", () => {
  beforeEach(() => {
    traceRecorder.reset();
    traceRecorder.setEnvironment(null);
    vi.useRealTimers();
  });

  it("records a failure naming the chunk, with the source's own reason code", async () => {
    openRun();
    const { cache, failures } = createCache(64);
    failures.set("0/0/0/0/0/0", new FetchError("gone", { kind: "permanent" }));

    cache.submit(makePlan([makeRequest()]));
    await flush();

    const failures0 = eventsOfKind(exportedEvents(), "failure");
    expect(failures0).toHaveLength(1);
    expect(failures0[0].reason).toBe("permanent");
    expect(failures0[0].chunk?.chunkKey).toBe("0/0/0/0/0/0");
    expect(failures0[0].chunk?.entityId).toBe("entity-1");
  });

  it("records a retry, under the reason the retry policy read", async () => {
    openRun();
    const { cache, failures } = createCache(64);
    failures.set("0/0/0/0/0/0", new FetchError("blip", { kind: "transient" }));

    cache.submit(makePlan([makeRequest()]));
    await flush();

    // The second attempt is still waiting out the retry delay; what this
    // asserts is that the retry itself left a mark, which is the whole
    // diagnostic value of a path nobody has caught executing.
    const retries = eventsOfKind(exportedEvents(), "retry");
    expect(retries.map(e => e.reason)).toEqual(["transient"]);
    expect(retries[0].chunk?.chunkKey).toBe("0/0/0/0/0/0");
  });

  it("records an eviction per chunk the budget pushed out", async () => {
    openRun();
    // Two 64-byte chunks against a 100-byte budget. The coarse budget goes
    // to zero too: an unused tier lends its bytes to the tier under demand,
    // so leaving it at its default would keep the detail store from ever
    // reaching its cap.
    const { cache } = createCache(64, { mainBudgetBytes: 100, overviewBudgetBytes: 0 });

    cache.submit(makePlan([makeRequest({ x: 0 })]));
    await flush();
    // A second tick that no longer wants the first chunk: it demotes out of
    // active detail, so admitting the second chunk evicts it.
    cache.submit(makePlan([makeRequest({ x: 1 })]));
    await flush();

    const evictions = eventsOfKind(exportedEvents(), "eviction");
    expect(evictions.length).toBeGreaterThanOrEqual(1);
    expect(evictions[0].reason).toBe("evicted");
    expect(evictions[0].chunk?.chunkKey).toBe("0/0/0/0/0/0");
  });

  it("records a rejection under the renderer's own reason code", () => {
    openRun();
    const { cache } = createCache(64);

    cache.markRejected("entity-1", "0/0/0/0/1/2");

    const rejections = eventsOfKind(exportedEvents(), "rejection");
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe("atlas-policy");
    expect(rejections[0].chunk?.chunkKey).toBe("0/0/0/0/1/2");
  });

  it("records nothing while no run is open", async () => {
    const { cache, failures } = createCache(64);
    failures.set("0/0/0/0/0/0", new FetchError("gone", { kind: "permanent" }));

    cache.submit(makePlan([makeRequest()]));
    await flush();

    expect(exportedEvents()).toEqual([]);
  });
});

describe("counted-not-timed phases", () => {
  beforeEach(() => {
    traceRecorder.reset();
    traceRecorder.setEnvironment(null);
  });

  it("counts a cache admission when decoded bytes become resident", async () => {
    openRun();
    const { cache } = createCache(64);

    cache.submit(makePlan([makeRequest()]));
    await flush();
    traceRecorder.beginTick("ds-1");
    traceRecorder.commitTick();

    const [run] = traceRecorder.exportDocument().runs;
    expect(run.ticks[0].counted["cache-admission"]).toBe(1);
  });

  it("counts a coalesce attach when a second demand meets a fetch in flight", async () => {
    openRun();
    const { cache } = createCache(64);

    // Same chunk twice across two plans, while the first fetch is still out.
    const source = { fetch: () => new Promise<FetchResult>(() => {}) };
    const held = new CpuCache(source as unknown as ContentSource, createDecode());
    held.submit(makePlan([makeRequest()]));
    held.submit(makePlan([makeRequest()]));

    traceRecorder.beginTick("ds-1");
    traceRecorder.commitTick();
    const [run] = traceRecorder.exportDocument().runs;
    expect(run.ticks[0].counted["coalesce-attach"]).toBe(1);
    void cache;
  });

  it("indexes the counted phases the way the recorder names them", () => {
    expect(CountedPhaseIndex.CacheAdmission).toBe(0);
    expect(CountedPhaseIndex.WorkerDispatch).toBe(1);
    expect(CountedPhaseIndex.CoalesceAttach).toBe(2);
  });
});

describe("per-level residency", () => {
  beforeEach(() => {
    traceRecorder.reset();
    traceRecorder.setEnvironment(null);
  });

  it("counts resident chunks by level without walking the store", async () => {
    const { cache } = createCache(64);

    cache.submit(makePlan([
      makeRequest({ level: 0, x: 0 }),
      makeRequest({ level: 0, x: 1 }),
      makeRequest({ level: 2, x: 0 }),
    ]));
    await flush();

    const { cached } = cache.levelResidency();
    expect(cached[0]).toBe(2);
    expect(cached[1] ?? 0).toBe(0);
    expect(cached[2]).toBe(1);
  });

  it("counts dispatched fetches by level while they are out", () => {
    const source = { fetch: () => new Promise<FetchResult>(() => {}) };
    const cache = new CpuCache(source as unknown as ContentSource, createDecode());

    cache.submit(makePlan([makeRequest({ level: 3 })]));

    expect(cache.levelResidency().inFlight[3]).toBe(1);
  });
});
