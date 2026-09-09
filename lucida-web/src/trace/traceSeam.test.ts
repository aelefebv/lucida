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
import { configStore } from "../pipeline/planning/configStore.ts";
import { setBundleServices } from "./bundle.ts";
import { installTraceSeam, resolveGpuIdentity } from "./seam.ts";
import { traceRecorder } from "./recorder.ts";
import { createQuiescenceState } from "./quiescence.ts";
import { TRACE_SCHEMA_VERSION } from "./types.ts";
import { initialPlanningState } from "../pipeline/planning/index.ts";

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
    nextState: initialPlanningState(),
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

  /**
   * The bundle is the same export with more around it (#1055): one function
   * behind the seam, so the monitor's save and the driver's file agree.
   */
  it("offers the run as a bundle, closing it the same way and naming what the page could not add", async () => {
    installTraceSeam();
    setBundleServices(null);
    traceRecorder.openRun(OPEN_CAUSE);

    const bundle = await window.lucidaTrace!.exportBundle();
    expect(traceRecorder.isRunOpen).toBe(false);
    expect(bundle.format).toBe("lucida-trace-bundle");
    expect(bundle.header.runId).toBe(bundle.trace.runs[0].header.runId);
    expect(bundle.header.endReason).toBe("explicit");
    expect(bundle.header.viewUrl).toBe(`${window.location.origin}/w/ws-1`);
    expect(bundle.header.devicePixelRatio).toBe(2);
    expect(bundle.header.planning).toEqual(configStore.get());
    // No viewer registered its services on this page, so the frame and the
    // health are absent and say so, rather than the export failing.
    expect(bundle.frame).toBeNull();
    expect(bundle.health).toBeNull();
    expect(bundle.absent.map(entry => entry.section)).toEqual(["frame", "health"]);
    expect(bundle.perfetto).toBeNull();
  });

  it("carries the frame and the health the viewer registered, and the projection only when asked", async () => {
    installTraceSeam();
    setBundleServices({
      requestDatasetHealth: () => Promise.resolve([]),
      captureFrame: () => Promise.resolve({ png: new Uint8Array([1, 2, 3]).buffer, width: 4, height: 2 }),
    });
    try {
      traceRecorder.openRun(OPEN_CAUSE);
      const bundle = await window.lucidaTrace!.exportBundle({ perfetto: true });
      // The frame is labelled with the page's ratio when it was taken, not
      // the run's. The two agree on a page that stayed on one screen, and
      // the frame says what it is when they do not.
      expect(bundle.frame).toEqual({
        png: "AQID",
        width: 4,
        height: 2,
        devicePixelRatio: window.devicePixelRatio,
        capturedBy: "page",
      });
      expect(bundle.health?.datasets).toEqual([]);
      expect(bundle.absent).toEqual([]);
      expect(JSON.parse(bundle.perfetto!).displayTimeUnit).toBe("ms");
    } finally {
      setBundleServices(null);
    }
  });

  /**
   * The borrowed path goes through the same seam as the native one, so no
   * surface gets a privately shaped copy of the trace (#934).
   */
  it("offers the same run projected for Perfetto, closing it the same way", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const file = JSON.parse(window.lucidaTrace!.exportChromeTrace());
    expect(traceRecorder.isRunOpen).toBe(false);
    expect(file.displayTimeUnit).toBe("ms");
    expect(file.otherData.runs[0].endReason).toBe("explicit");
    const tracks = file.traceEvents
      .filter((e: { ph: string; name: string }) => e.ph === "M" && e.name === "thread_name")
      .map((e: { args: { name: string } }) => e.args.name);
    expect(tracks).toEqual(expect.arrayContaining(["plan", "queue", "wire", "serve"]));
  });

  /**
   * The derivation lives behind the seam, so the agent's text and the
   * monitor's cards are two readings of one object rather than two opinions
   * (#933). The CLI holding no diagnostic logic is what this protects.
   */
  it("reads the run as a diagnostic, and renders that same object as text", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const diagnostic = window.lucidaTrace!.diagnose();
    expect(traceRecorder.isRunOpen).toBe(false);
    expect(diagnostic.verdict.text).not.toBe("");
    expect(diagnostic.attribution.degraded).not.toBe("");
    expect(diagnostic.ruleset.version).toBeGreaterThan(0);

    traceRecorder.openRun(OPEN_CAUSE);
    const text = window.lucidaTrace!.diagnoseText();
    expect(text.split("\n").length).toBeLessThanOrEqual(30);
    expect(text).toContain("NOT A HEALTH SIGNAL");
    expect(text).toContain("coverage  ");
  });

  /**
   * The driver reads the deeper depth off the same renderer rather than
   * growing one of its own: `lucida trace show --phases` prints what the page
   * rendered, so the CLI stays free of thresholds it would otherwise restate.
   */
  it("renders the deeper depth through the same renderer", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const phases = window.lucidaTrace!.diagnoseText(undefined, { depth: "phases" });
    expect(phases).toContain("CRITICAL PATH");
    expect(phases).toContain("RULESET v");
  });

  /**
   * A window is the same derivation over an interval of the run, reached
   * through the same seam, so a brushed interval in the monitor and the
   * CLI's window flag cannot disagree about it.
   */
  it("scopes the diagnostic to a window through the same derivation", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    // The run's wall is whatever the test took, so a window past it is clamped
    // to it. Either way the reading is scoped, and the text names the window.
    const windowed = window.lucidaTrace!.diagnose(undefined, {
      window: { startMs: 0, endMs: 0.5 },
    });
    expect(windowed.window).toMatchObject({ startMs: 0 });
    expect(windowed.window!.endMs).toBeLessThanOrEqual(0.5);
    expect(windowed.coverage.wallMs).toBeLessThanOrEqual(0.5);
    expect(window.lucidaTrace!.diagnoseText(windowed.runId, { window: { startMs: 0, endMs: 0.5 } })).toContain(
      `window    0..${windowed.window!.endMs} ms`,
    );
  });

  /**
   * A run file read back after its browser is gone carries the whole-run
   * reading and no other, so the CLI hands the document back to a page and
   * asks for the window there. The recorder is not involved: reading a
   * document someone else recorded closes nothing here.
   */
  it("diagnoses a supplied trace document without touching the recording", async () => {
    const seam = installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();
    seam.closeRun("timeout");
    const document = seam.exportTrace();
    const runId = seam.runState.lastConcludedRunId!;

    traceRecorder.openRun(OPEN_CAUSE);
    const diagnostic = seam.diagnoseTrace(document, { runId, window: { startMs: 0, endMs: 1 } });
    const text = seam.diagnoseTraceText(document, { runId, depth: "phases" });
    expect(traceRecorder.isRunOpen).toBe(true);

    expect(diagnostic.runId).toBe(runId);
    // Clamped to the run's own wall when the run took under a millisecond.
    const wallMs = document.runs.find((run) => run.header.runId === runId)!.header.durationUs / 1_000;
    expect(diagnostic.window).toMatchObject({ startMs: 0 });
    expect([1, wallMs]).toContain(diagnostic.window!.endMs);
    expect(text).toContain(`lucida trace ${runId}`);
    expect(text).toContain("CRITICAL PATH");
  });

  /**
   * "The shape behind X" is a depth of the page's renderer too, so the CLI
   * that prints it never becomes a second renderer with its own opinions.
   */
  it("renders one phase through the same renderer", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const wire = window.lucidaTrace!.diagnoseText(undefined, {
      depth: "phase",
      phase: "browser.wire",
    });
    expect(wire).toContain("PHASE     browser.wire");
    expect(wire).not.toContain("browser.decode  ");

    const absent = window.lucidaTrace!.diagnoseText(undefined, {
      depth: "phase",
      phase: "nonsense",
    });
    expect(absent).toContain("not in this run");
  });

  /**
   * One chunk and what is where are readings of the document too, so an
   * agent driving its own browser asks for them through the seam, and the
   * chunk it names is the one the document is about.
   */
  it("looks up a chunk and summarises space through the same derivation", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    traceRecorder.openRun(OPEN_CAUSE);
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const document = window.lucidaTrace!.diagnose();
    expect(document.chunk.selector).not.toBeNull();
    expect(document.spatial.rowCount).toBeGreaterThan(0);

    traceRecorder.openRun(OPEN_CAUSE);
    const named = window.lucidaTrace!.diagnose(undefined, { chunk: "9/9/9/9/9/9" });
    expect(named.chunk.chosen).toBe("named by the caller");
    expect(named.chunk.statement).toContain("not in this run");

    traceRecorder.openRun(OPEN_CAUSE);
    const text = window.lucidaTrace!.diagnoseText(undefined, { depth: "chunk", chunk: "9/9/9/9/9/9" });
    expect(text).toContain("CHUNK     9/9/9/9/9/9");
    expect(text).toContain("not in this run");

    traceRecorder.openRun(OPEN_CAUSE);
    const spatial = window.lucidaTrace!.diagnoseText(undefined, { depth: "spatial" });
    expect(spatial).toContain("SPATIAL");
    expect(spatial).toContain("chunk indices");
  });

  /**
   * Before a run opens, nothing is dirty and nothing is wanted — so the
   * predicate is trivially true. A driver has to be able to tell that apart
   * from a run that finished, without exporting (which would close it). And
   * a run somebody closed is not a run that concluded: a page torn down and
   * rebuilt hands back a sub-millisecond `explicit` run, and a driver that
   * took it would measure the teardown.
   */
  it("says which run concluded on its own, without exporting", () => {
    const seam = installTraceSeam();
    expect(seam.runState).toEqual({ open: false, concluded: 0, lastConcludedRunId: null });

    traceRecorder.openRun(OPEN_CAUSE);
    expect(seam.runState.open).toBe(true);
    expect(seam.runState.concluded).toBe(0);

    seam.closeRun();
    expect(seam.runState.concluded).toBe(0);

    traceRecorder.openRun(OPEN_CAUSE);
    seam.closeRun("timeout");
    expect(seam.runState.concluded).toBe(1);
    const concluded = seam.runState.lastConcludedRunId;
    expect(concluded).not.toBeNull();

    // Reading it concluded nothing: both runs are still there to export.
    const runs = seam.exportTrace().runs;
    expect(runs).toHaveLength(2);
    expect(runs.map(run => run.header.runId)).toContain(concluded);
  });

  /**
   * The live view's read (#937). Everything else through this seam concludes
   * the interval it is asked about, which is the one thing a surface watching
   * an open run must not do.
   */
  it("reports a run's progress without closing it, and nothing at all between runs", async () => {
    const seam = installTraceSeam();
    expect(seam.progress()).toBeNull();

    traceRecorder.openRun(OPEN_CAUSE);
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());
    cache.submit(makePlan([makeRequest()]));
    await flush();

    const progress = seam.progress()!;
    expect(progress.runId).toBeTruthy();
    expect(progress.planned).toBeGreaterThan(0);
    expect(progress.planned).toBe(progress.visible + progress.inFlight + progress.retired);
    // Reading it changed nothing: the run is still open and still the one
    // being watched.
    expect(seam.runState.open).toBe(true);
    expect(seam.progress()!.runId).toBe(progress.runId);

    seam.closeRun();
    expect(seam.progress()).toBeNull();
    expect(seam.diagnose(progress.runId).runId).toBe(progress.runId);
  });

  it("stops a run without exporting it", () => {
    const seam = installTraceSeam();
    traceRecorder.openRun(OPEN_CAUSE);
    seam.closeRun();
    expect(traceRecorder.isRunOpen).toBe(false);
    expect(seam.exportTrace().runs[0].header.endReason).toBe("explicit");
  });

  /**
   * A driver that gives up on a run that never settled has to say so in the
   * run rather than in its own prose: `explicit` would claim somebody asked
   * for the document, and the end reason is the field a later reader trusts.
   */
  it("lets a driver close a run that never settled as a timeout", () => {
    const seam = installTraceSeam();
    traceRecorder.openRun(OPEN_CAUSE);
    seam.closeRun("timeout");
    expect(seam.exportTrace().runs[0].header.endReason).toBe("timeout");
  });

  it("keeps rows seen with no run open as unlabelled steady state", async () => {
    installTraceSeam();
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());

    cache.submit(makePlan([makeRequest()]));
    await flush();

    const doc = window.lucidaTrace!.exportTrace();
    expect(doc.runs).toHaveLength(0);
    expect(doc.rowsOutsideRun).toBe(0);
    expect(doc.steadyState[0].rows.length).toBeGreaterThan(0);
    expect(doc.steadyState[0].header.cause).toBeNull();
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

describe("the adapter identity the header carries", () => {
  interface FakeAdapter {
    info: Record<string, unknown>;
    features: Set<string>;
    isFallbackAdapter?: boolean;
  }

  function withAdapter(adapter: FakeAdapter | null | (() => never)): void {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: () =>
          typeof adapter === "function" ? adapter() : Promise.resolve(adapter),
      },
    });
  }

  function hardwareInfo(): Record<string, unknown> {
    return { vendor: "v", architecture: "a", device: "d", description: "desc", isFallbackAdapter: false };
  }

  it("is null where there is no WebGPU at all", async () => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
    expect(await resolveGpuIdentity()).toBeNull();
  });

  it("names the adapter and whether it offers timestamp queries", async () => {
    withAdapter({ info: hardwareInfo(), features: new Set(["timestamp-query"]) });
    expect(await resolveGpuIdentity()).toEqual({
      vendor: "v",
      architecture: "a",
      device: "d",
      description: "desc",
      fallback: false,
      timestampQueries: true,
    });
  });

  it("records a software fallback from the adapter info", async () => {
    withAdapter({ info: { ...hardwareInfo(), isFallbackAdapter: true }, features: new Set() });
    const identity = await resolveGpuIdentity();
    expect(identity?.fallback).toBe(true);
    expect(identity?.timestampQueries).toBe(false);
  });

  it("falls back to the adapter's own flag where the info lacks one", async () => {
    const info = hardwareInfo();
    delete info.isFallbackAdapter;
    withAdapter({ info, features: new Set(), isFallbackAdapter: true });
    expect((await resolveGpuIdentity())?.fallback).toBe(true);
  });

  it("records an adapter that says nothing about fallback as saying nothing", async () => {
    const info = hardwareInfo();
    delete info.isFallbackAdapter;
    withAdapter({ info, features: new Set() });
    expect((await resolveGpuIdentity())?.fallback).toBeNull();
  });

  it("is null when the adapter request fails", async () => {
    withAdapter(() => {
      throw new Error("no adapter");
    });
    expect(await resolveGpuIdentity()).toBeNull();
  });
});
