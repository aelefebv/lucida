// @vitest-environment happy-dom
/**
 * The trace seam, tested the way ADR 0051 says it will be used: drive the
 * pipeline, call the function on the page, assert on the returned document.
 *
 * Nothing here reaches into the recorder's buffers. Phase names, run
 * boundaries and end reasons are external behaviour; the shape of a buffer
 * and the order of writes are not.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { CpuCache } from "../pipeline/fetch/cpuCache.ts";
import type { ContentSource, FetchRequest, FetchResult } from "../pipeline/fetch/contentSource.ts";
import { DecodePool } from "../pipeline/fetch/decodePool.ts";
import type { ChunkRequest, RequestPlan } from "../pipeline/planning/index.ts";
import { emptyPlanStats } from "../pipeline/planning/index.ts";
import { installTraceSeam } from "./seam.ts";
import { traceRecorder } from "./recorder.ts";
import { createQuiescenceState } from "./quiescence.ts";
import { TRACE_SCHEMA_VERSION } from "./types.ts";

const OPEN_CAUSE = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" } as const;

/** Resolves a fetch only when the test says so, so `wire` has a real duration. */
class ControlledSource implements ContentSource {
  private waiting = new Map<string, (bytes: ArrayBuffer) => void>();

  fetch(request: FetchRequest): Promise<FetchResult> {
    return new Promise<FetchResult>(resolve => {
      this.waiting.set(request.chunkKey, bytes =>
        resolve({ bytes, wireFormat: { Raw: { dtype: "uint8" } } as never, dataType: "uint8" }),
      );
    });
  }

  fetchProxy(): Promise<never> {
    return new Promise<never>(() => {});
  }

  handleBinary(): void {}

  deliver(chunkKey: string, byteLength = 8): void {
    const resolve = this.waiting.get(chunkKey);
    if (!resolve) throw new Error(`no fetch in flight for ${chunkKey}`);
    this.waiting.delete(chunkKey);
    resolve(new ArrayBuffer(byteLength));
  }

}

/**
 * Stand-in for the browser Worker so the real {@link DecodePool} — and the
 * correlation id it now carries — is what the lifecycle runs through. Replies
 * land on a later task, so the `decode` round trip has a real duration.
 */
class EchoWorker {
  onmessage: ((e: { data: { id: number; data?: ArrayBuffer; error?: string } }) => void) | null = null;

  postMessage(msg: { id: number; bytes: ArrayBuffer }): void {
    setTimeout(() => this.onmessage?.({ data: { id: msg.id, data: msg.bytes } }), 0);
  }

  terminate(): void {}
}

function makeDecode(): DecodePool {
  return {
    size: 1,
    decode: (bytes: ArrayBuffer) => Promise.resolve(bytes),
  } as unknown as DecodePool;
}

function makeRequest(overrides: Partial<ChunkRequest> = {}): ChunkRequest {
  return {
    datasetId: "ds",
    entityId: "member-1",
    imageId: "image-1",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    lane: "detail",
    tier: "detail",
    priority: 0,
    chunkKey: "0/0/0/0/0/0",
    ...overrides,
  };
}

function makePlan(requests: ChunkRequest[]): RequestPlan {
  return {
    requests,
    activeSet: [],
    proxyRequests: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    stats: emptyPlanStats(),
    nextState: { previousActiveSet: [] },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
/** Long enough for the fetch continuation, the decode round trip, and the cache insert. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

/**
 * Stands in for the render loop, which is what registers the real one. A run
 * cannot open without an environment — its conditions are what make it a
 * comparable artifact.
 */
function registerEnvironment(): void {
  traceRecorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => createQuiescenceState(),
  });
}

describe("the trace seam", () => {
  beforeEach(() => {
    // The recorder is a page-lifetime singleton; each case gets a clean one.
    traceRecorder.reset();
    registerEnvironment();
  });

  it("is installed on the page and declares its schema version", () => {
    const seam = installTraceSeam();
    expect(window.lucidaTrace).toBe(seam);
    expect(seam.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
  });

  it("returns a whole chunk lifecycle, not just its time on the wire", async () => {
    vi.stubGlobal("Worker", EchoWorker);
    try {
      installTraceSeam();
      const source = new ControlledSource();
      const cache = new CpuCache(source, new DecodePool(1));

      traceRecorder.openRun(OPEN_CAUSE);
      // The tick coordinator opens the plan phase; `submit` closes it.
      traceRecorder.markPlanStart();
      cache.submit(makePlan([makeRequest()]));
      await flush();
      source.deliver("0/0/0/0/0/0");
      await settle();

      // The upload path: hand the decoded chunk to the renderer, then two
      // frame dispatches — the first makes it resident, the second proves it
      // was drawn.
      for (const delivery of cache.getDeliverable()) cache.markSent(delivery);
      traceRecorder.noteFrameDispatched();
      traceRecorder.noteFrameDispatched();

      const doc = window.lucidaTrace!.exportTrace();
      expect(doc.instrumentedPhases)
        .toEqual(["plan", "queue", "wire", "decode", "upload", "present"]);
      expect(doc.runs).toHaveLength(1);

      const [row] = doc.runs[0].rows;
      expect(row.chunkKey).toBe("0/0/0/0/0/0");
      expect(row.entityId).toBe("member-1");
      expect(row.residencyTier).toBe("detail");
      expect(row.lane).toBe("detail");
      expect(row.outcome).toBe("complete");

      // Every phase measured, and the boundaries meet: each phase starts
      // where the one before it ended.
      expect(Object.keys(row.phases).sort())
        .toEqual(["decode", "plan", "present", "queue", "upload", "wire"]);
      const ordered = [
        row.phases.plan!, row.phases.queue!, row.phases.wire!,
        row.phases.decode!, row.phases.upload!, row.phases.present!,
      ];
      for (const phase of ordered) {
        expect(phase.endUs).toBeGreaterThanOrEqual(phase.startUs);
        expect(phase.durationUs).toBe(phase.endUs - phase.startUs);
      }
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i].startUs).toBe(ordered[i - 1].endUs);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("counts the stages below the clock floor rather than timing them", async () => {
    vi.stubGlobal("Worker", EchoWorker);
    try {
      installTraceSeam();
      const source = new ControlledSource();
      const cache = new CpuCache(source, new DecodePool(1));

      traceRecorder.openRun(OPEN_CAUSE);
      // Two lanes wanting the same chunk: one fetch, one coalesce attach.
      cache.submit(makePlan([
        makeRequest({ lane: "coarse", tier: "coarse" }),
        makeRequest({ lane: "minimap", tier: "coarse" }),
      ]));
      await flush();
      source.deliver("0/0/0/0/0/0");
      await settle();

      traceRecorder.beginTick("ds-1");
      traceRecorder.commitTick();
      const { counted } = window.lucidaTrace!.exportTrace().runs[0].ticks[0];
      expect(counted["coalesce-attach"]).toBe(1);
      expect(counted["worker-dispatch"]).toBe(1);
      expect(counted["cache-admission"]).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("joins a decode to its chunk through the pool, which knows no chunk keys", async () => {
    vi.stubGlobal("Worker", EchoWorker);
    try {
      installTraceSeam();
      const source = new ControlledSource();
      const cache = new CpuCache(source, new DecodePool(1));

      traceRecorder.openRun(OPEN_CAUSE);
      cache.submit(makePlan([
        makeRequest({ x: 1, chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ x: 2, chunkKey: "0/0/0/0/0/2" }),
      ]));
      await settle();
      // Delivered out of plan order, so a decode landing on the wrong row
      // would be visible rather than coincidentally right.
      source.deliver("0/0/0/0/0/2");
      await settle();

      const rows = window.lucidaTrace!.exportTrace().runs[0].rows;
      const decoded = rows.filter(r => r.phases.decode !== undefined);
      expect(decoded.map(r => r.chunkKey)).toEqual(["0/0/0/0/0/2"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes the two residency tiers behind one chunk key", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([
      makeRequest({ lane: "detail", tier: "detail" }),
      makeRequest({ lane: "coarse", tier: "coarse" }),
    ]));
    await flush();

    const doc = window.lucidaTrace!.exportTrace();
    const tiers = doc.runs[0].rows.map(r => r.residencyTier).sort();
    expect(tiers).toEqual(["coarse", "detail"]);
    expect(new Set(doc.runs[0].rows.map(r => r.chunkKey)).size).toBe(1);
  });

  it("leaves an unfinished fetch in flight rather than drawing it as complete", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const [row] = window.lucidaTrace!.exportTrace().runs[0].rows;
    expect(row.outcome).toBe("in-flight");
    expect(row.phases.wire).toBeUndefined();
  });

  it("closes the run in progress on export, so end reason is always present", async () => {
    installTraceSeam();
    traceRecorder.openRun(OPEN_CAUSE);

    const doc = window.lucidaTrace!.exportTrace();
    expect(doc.runs[0].header.endReason).toBe("explicit");
    expect(traceRecorder.isRunOpen).toBe(false);
  });

  it("stops a run without exporting it", () => {
    const seam = installTraceSeam();
    traceRecorder.openRun(OPEN_CAUSE);
    seam.closeRun();
    expect(traceRecorder.isRunOpen).toBe(false);
    expect(seam.exportTrace().runs[0].header.endReason).toBe("explicit");
  });

  it("records rows seen with no run open without pretending they were kept", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    cache.submit(makePlan([makeRequest()]));
    await flush();

    const doc = window.lucidaTrace!.exportTrace();
    expect(doc.runs).toHaveLength(0);
    expect(doc.rowsOutsideRun).toBeGreaterThan(0);
  });
});

describe("the cache's half of the quiescence predicate", () => {
  it("counts the view's outstanding work and holds speculative work apart", async () => {
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode(), { maxConcurrentFetches: 1 });

    cache.submit(makePlan([
      makeRequest({ lane: "detail", chunkKey: "0/0/0/0/0/0" }),
      makeRequest({ lane: "prefetch", t: 1, chunkKey: "0/1/0/0/0/0" }),
    ]));
    await flush();

    const inputs = cache.quiescenceInputs(createQuiescenceState());
    expect(inputs.inFlight + inputs.speculativeInFlight).toBe(1);
    expect(inputs.pending + inputs.speculativePending).toBe(1);
    expect(inputs.speculativeInFlight + inputs.speculativePending).toBe(1);
    expect(inputs.pendingUnclassified).toBe(false);
    // Demand stays on the cache's own prefetch-inclusive basis, so resident
    // and desired are counted the same way; the exclusion is in the queues.
    expect(inputs.desiredDetailChunks).toBe(2);
  });
});
