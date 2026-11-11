// @vitest-environment happy-dom
/**
 * The trace seam, tested the way its callers use it: drive the
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
import { setScriptControls } from "./steps.ts";
import { installTraceSeam, reportsMobile, resolveGpuIdentity } from "./seam.ts";
import { traceRecorder } from "./recorder.ts";
import { createSettleState, evaluateSettle } from "../pipeline/settle.ts";
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

  handleBinary(): void {}

  deliver(chunkKey: string, byteLength = 8): void {
    const resolve = this.waiting.get(chunkKey);
    if (!resolve) throw new Error(`no fetch in flight for ${chunkKey}`);
    this.waiting.delete(chunkKey);
    resolve(new ArrayBuffer(byteLength));
  }

}

/**
 * Stand-in for the browser Worker so the real {@link DecodePool}, and the
 * correlation id it carries, is what the lifecycle runs through. Replies
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
    mode: "slice",
    priority: 0,
    chunkKey: "0/0/0/0/0/0",
    ...overrides,
  };
}

function makePlan(requests: ChunkRequest[]): RequestPlan {
  return {
    requests,
    activeSet: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
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
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => createSettleState(),
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
   * The bundle is the same export with more around it: one function
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

  it("records the device memory the trace driver told the page", async () => {
    installTraceSeam();
    setBundleServices(null);
    // As the driver's pre-load script installs its override.
    const own = Object.getOwnPropertyDescriptor(Navigator.prototype, "deviceMemory");
    Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 2, configurable: true });
    try {
      traceRecorder.openRun(OPEN_CAUSE);
      const bundle = await window.lucidaTrace!.exportBundle();
      expect(bundle.header.deviceMemoryGib).toBe(2);
    } finally {
      if (own) Object.defineProperty(Navigator.prototype, "deviceMemory", own);
      else delete (Navigator.prototype as { deviceMemory?: unknown }).deviceMemory;
    }
  });

  it("records the page it ran on, the window, and whether the browser said it was a phone's", async () => {
    installTraceSeam();
    setBundleServices(null);
    traceRecorder.openRun(OPEN_CAUSE);
    const bundle = await window.lucidaTrace!.exportBundle();
    expect(bundle.header.fullUi).toBe(true);
    expect(bundle.header.pageSize).toEqual({ cssWidth: window.innerWidth, cssHeight: window.innerHeight });
    expect(bundle.header.mobile).toBe(false);

    const phone = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
    expect(reportsMobile({ userAgent: phone } as Navigator)).toBe(true);
    // The hints win where the browser sends them, since the string can be frozen.
    expect(reportsMobile({ userAgent: phone, userAgentData: { mobile: false } } as unknown as Navigator)).toBe(false);
    expect(reportsMobile({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", userAgentData: { mobile: true } } as unknown as Navigator)).toBe(true);
    expect(reportsMobile(undefined)).toBe(false);
  });

  it("carries the frame and the health the viewer registered, and the projection only when asked", async () => {
    installTraceSeam();
    setBundleServices({
      requestHealth: () => Promise.resolve({ datasets: [], sourceThrottle: null, linkThrottle: null }),
      captureFrame: () =>
        Promise.resolve({ frame: { png: new Uint8Array([1, 2, 3]).buffer, width: 4, height: 2 }, reason: null }),
      canvasRect: () => null,
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
   * surface gets a privately shaped copy of the trace.
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
   * monitor's cards are two readings of one object rather than two opinions.
   * The CLI holding no diagnostic logic is what this protects.
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
    // The wall is the real clock. Hold it past the window's end and past the
    // snap to the wall, so the window is the one asked for on any host.
    while (traceRecorder.openIntervalMs! < 1) {
      // Spin: a timer only promises a lower bound in whole milliseconds.
    }

    const windowed = window.lucidaTrace!.diagnose(undefined, {
      window: { startMs: 0, endMs: 0.5 },
    });
    expect(windowed.window).toMatchObject({ startMs: 0, endMs: 0.5 });
    expect(windowed.coverage.wallMs).toBe(0.5);
    expect(window.lucidaTrace!.diagnoseText(windowed.runId, { window: { startMs: 0, endMs: 0.5 } })).toContain(
      "window    0..0.5 ms",
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

  it("compares two supplied trace documents without touching the recording", async () => {
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
    const comparison = seam.compareTraces(
      { trace: document, runId, label: "baseline.json", planning: { prefetchDepth: 0 } },
      { trace: document, runId },
    );
    const text = seam.compareTracesText({ trace: document, runId }, { trace: document, runId });
    expect(traceRecorder.isRunOpen).toBe(true);

    expect(comparison.left.runId).toBe(runId);
    expect(comparison.right.runId).toBe(runId);
    expect(comparison.comparable).toBe(true);
    expect(comparison.header.find((field) => field.field === "planning.prefetchDepth")).toMatchObject({
      left: 0,
      same: false,
      breaksComparability: false,
    });
    expect(comparison.wall.deltaMs).toBe(0);
    expect(text).toContain(`lucida trace diff ${runId} ${runId}`);
    expect(text).toContain("PHASES");
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
   * The driver's scripted steps. Pan, zoom, and
   * orbit arrive as synthesized pointer events and need nothing here. Scrub
   * and select go through the handlers the viewer registers, because the
   * capture surface hides the controls they would otherwise land on, and
   * the view is read the same way before and after every step.
   */
  it("reads the view and takes each step through the registered controls", async () => {
    const seam = installTraceSeam();
    const calls: unknown[] = [];
    const view = { v: 1, camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [8, 6] } };
    setScriptControls({
      view: () => view as never,
      comparison: () => null,
      scrub: (axis, count) => {
        calls.push(["scrub", axis, count]);
        return { applied: true, reason: null };
      },
      plane: (plane) => {
        calls.push(["plane", plane]);
        return { applied: true, reason: null };
      },
      select: (target, visible) => {
        calls.push(["select", target, visible]);
        return { applied: true, reason: null };
      },
      contrast: (channel, min, max) => {
        calls.push(["contrast", channel, min, max]);
        return { applied: true, reason: null };
      },
      addDataset: (url, timeoutMs) => {
        calls.push(["add", url, timeoutMs]);
        return Promise.resolve({ applied: true, reason: null });
      },
      removeDataset: (url) => {
        calls.push(["remove", url]);
        return Promise.resolve({ applied: true, reason: null });
      },
      swipe: (at, withUrl) => {
        calls.push(["swipe", at, withUrl]);
        return Promise.resolve({ applied: true, reason: null });
      },
      blink: (withUrl) => {
        calls.push(["blink", withUrl]);
        return Promise.resolve({ applied: true, reason: null });
      },
      views: (layout, show) => {
        calls.push(["views", layout, show]);
        return Promise.resolve({ applied: true, reason: null });
      },
    });
    try {
      expect(seam.view()).toBe(view);
      expect(seam.viewSignature()).toEqual({
        camera: { mode: "slice", center: [0, 0], zoom: 1 },
        view: null,
        visibility: {},
        contrast: {},
        comparison: null,
      });
      // The viewers' own constants, so the driver's pixels are the page's.
      expect(seam.inputScale.orbitRadiansPerPixel).toBe(0.005);
      expect(seam.inputScale.sliceZoomInPerNotch).toBe(1.1);
      expect(seam.scrub("t", 3)).toEqual({ applied: true, reason: null });
      expect(seam.plane("xz")).toEqual({ applied: true, reason: null });
      expect(seam.plane("zz" as never)).toEqual({ applied: false, reason: "a slice plane is xy, xz or yz, not zz" });
      expect(seam.select({ channel: 1 }, false)).toEqual({ applied: true, reason: null });
      expect(seam.select({ layer: "ds-2" })).toEqual({ applied: true, reason: null });
      expect(seam.select({ label: 0 }, false)).toEqual({ applied: true, reason: null });
      expect(seam.contrast(0, 10, 200)).toEqual({ applied: true, reason: null });
      await expect(seam.addDataset("/data/b.zarr", 5000)).resolves.toEqual({ applied: true, reason: null });
      await expect(seam.addDataset("/data/c.zarr")).resolves.toEqual({ applied: true, reason: null });
      await expect(seam.removeDataset("/data/b.zarr")).resolves.toEqual({ applied: true, reason: null });
      await expect(seam.swipe(0.25)).resolves.toEqual({ applied: true, reason: null });
      await expect(seam.blink("/data/b.zarr")).resolves.toEqual({ applied: true, reason: null });
      expect(calls).toEqual([
        ["scrub", "t", 3],
        ["plane", "xz"],
        ["select", { channel: 1 }, false],
        ["select", { layer: "ds-2" }, true],
        ["select", { label: 0 }, false],
        ["contrast", 0, 10, 200],
        ["add", "/data/b.zarr", 5000],
        ["add", "/data/c.zarr", 60_000],
        ["remove", "/data/b.zarr"],
        ["swipe", 0.25, null],
        ["blink", "/data/b.zarr"],
      ]);
    } finally {
      setScriptControls(null);
    }
  });

  it("answers a step with nothing registered, and a malformed one, by saying so rather than throwing", async () => {
    const seam = installTraceSeam();
    setScriptControls(null);
    expect(seam.view()).toBeNull();
    expect(seam.viewSignature()).toBeNull();
    expect(seam.scrub("z", 1)).toEqual({
      applied: false,
      reason: "no viewer has registered its controls on this page",
    });
    expect(seam.select({ channel: 0 })).toEqual({
      applied: false,
      reason: "no viewer has registered its controls on this page",
    });

    setScriptControls({
      view: () => null,
      comparison: () => null,
      scrub: () => ({ applied: true, reason: null }),
      plane: () => ({ applied: true, reason: null }),
      select: () => ({ applied: true, reason: null }),
      contrast: () => ({ applied: true, reason: null }),
      addDataset: () => Promise.resolve({ applied: true, reason: null }),
      removeDataset: () => Promise.resolve({ applied: true, reason: null }),
      swipe: () => Promise.resolve({ applied: true, reason: null }),
      blink: () => Promise.resolve({ applied: true, reason: null }),
      views: () => Promise.resolve({ applied: true, reason: null }),
    });
    try {
      // The arguments arrive over the DevTools protocol, so the seam checks
      // them before any handler sees them.
      expect(seam.contrast(0, 5, 5)).toEqual({
        applied: false,
        reason: "a contrast window is two finite numbers, the minimum below the maximum, not 5,5",
      });
      expect(seam.contrast(1.5, 0, 5).applied).toBe(false);
      await expect(seam.swipe(1.5)).resolves.toEqual({
        applied: false,
        reason: "a divider is a fraction of the view's width from 0 to 1, not 1.5",
      });
      await expect(seam.removeDataset("")).resolves.toEqual({
        applied: false,
        reason: "a dataset is named by its source URL",
      });
      expect(seam.scrub("q" as never, 1)).toEqual({ applied: false, reason: "no selector is called q" });
      expect(seam.select({} as never)).toEqual({
        applied: false,
        reason: "a select names a channel index, a layer id or a label index",
      });
      expect(seam.select({ label: 0.5 })).toEqual({
        applied: false,
        reason: "a label is a whole number from 0, not 0.5",
      });
      expect(seam.select({ channel: -1 })).toEqual({
        applied: false,
        reason: "a channel is a whole number from 0, not -1",
      });
    } finally {
      setScriptControls(null);
    }
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
   * The live view's read. Everything else through this seam concludes
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

  it("produces a provisional reading as JSON and as text without closing the run", async () => {
    const seam = installTraceSeam();
    expect(seam.provisional()).toBeNull();
    expect(seam.provisionalText()).toBeNull();

    traceRecorder.openRun(OPEN_CAUSE);
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());
    cache.submit(makePlan([makeRequest()]));
    await flush();
    traceRecorder.noteReading(0, 1, 2_000, 8);
    traceRecorder.noteQuiescence(
      evaluateSettle(Object.assign(createSettleState(), { inFlight: 1 }), performance.now()),
    );

    const reading = seam.provisional()!;
    expect(reading.provisional).toBe(true);
    expect(reading.runId).toBe(seam.progress()!.runId);
    expect(reading.occupancy.inFlight).toBe(1);
    expect(reading.rows.made).toBe(1);
    expect(reading.rows.walked).toBe(0);
    expect(reading.quiescence.reason).toBe("chunks_in_flight");
    expect(reading.statement.startsWith("provisional")).toBe(true);
    expect("verdict" in reading).toBe(false);
    // An agent over CDP and the watch stream both get the JSON of this
    // object, so the round trip must lose nothing.
    expect(JSON.parse(JSON.stringify(reading))).toEqual(reading);

    const text = seam.provisionalText()!;
    expect(text.split("\n")[0]).toContain(`lucida trace ${reading.runId} — PROVISIONAL:`);
    expect(text).toContain("not a verdict");

    expect(seam.runState.open).toBe(true);
    expect(seam.provisional({ windowMs: 1_000 })!.window.requestedMs).toBe(1_000);

    seam.closeRun();
    expect(seam.provisional()).toBeNull();
    expect("provisional" in seam.diagnose(reading.runId)).toBe(false);
  });

  it("offers the open run's live timeline as JSON and as text without closing the run", async () => {
    const seam = installTraceSeam();
    expect(seam.liveTimeline()).toBeNull();
    expect(seam.liveTimelineText()).toBeNull();

    traceRecorder.openRun(OPEN_CAUSE);
    const source = new ControlledSource();
    const cache = new CpuCache(source, makeDecode());
    cache.submit(makePlan([makeRequest()]));
    await flush();
    traceRecorder.noteReading(0, 1, 2_000, 8);

    const live = seam.liveTimeline()!;
    expect(live.provisional).toBe(true);
    expect(live.runId).toBe(seam.progress()!.runId);
    expect(live.timeline.rowsWalked).toBe(false);
    expect(live.timeline.charts.find((chart) => chart.id === "in-flight")?.recorded).toBe(true);
    expect(live.timeline.charts.find((chart) => chart.id === "occupancy.browser")?.recorded).toBe(false);
    // An agent over CDP gets the JSON of this object, so the round trip must lose nothing.
    expect(JSON.parse(JSON.stringify(live))).toEqual(live);

    const text = seam.liveTimelineText()!;
    expect(text.split("\n")[0]).toContain(`lucida trace ${live.runId} — PROVISIONAL TIMELINE:`);
    expect(text).toContain("not a verdict");
    expect(seam.liveTimeline({ windowMs: 1_000 })!.window.requestedMs).toBe(1_000);

    // Reading it changed nothing, and the closed run's timeline is the same
    // closed set with the rows walked.
    expect(seam.runState.open).toBe(true);
    seam.closeRun();
    expect(seam.liveTimeline()).toBeNull();
    const closed = seam.diagnose(live.runId).timeline;
    expect(closed.rowsWalked).toBe(true);
    expect(closed.charts.map((chart) => chart.id)).toEqual(live.timeline.charts.map((chart) => chart.id));
    expect(seam.diagnoseText(live.runId, { depth: "timeline" })).toContain("TIMELINE");
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

    const inputs = cache.settleInputs(createSettleState());
    expect(inputs.inFlight + inputs.speculativeInFlight).toBe(1);
    expect(inputs.pending + inputs.speculativePending).toBe(1);
    expect(inputs.speculativeInFlight + inputs.speculativePending).toBe(1);
    expect(inputs.pendingUnclassified).toBe(false);
    // Demand is the view's own: prefetch is neither desired nor resident, so
    // an evicted prefetch chunk never leaves the view waiting.
    expect(inputs.desiredDetailChunks).toBe(1);
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

  it("asks again when the first answer after launch is null", async () => {
    const answers: Array<FakeAdapter | null> = [null, null, { info: hardwareInfo(), features: new Set() }];
    let calls = 0;
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter: () => Promise.resolve(answers[Math.min(calls++, answers.length - 1)]) },
    });
    const identity = await resolveGpuIdentity({ attempts: 5, retryMs: 0 });
    expect(identity?.vendor).toBe("v");
    expect(calls).toBe(3);
  });

  it("takes null as final once the attempts are spent", async () => {
    withAdapter(null);
    expect(await resolveGpuIdentity({ attempts: 2, retryMs: 0 })).toBeNull();
  });
});
