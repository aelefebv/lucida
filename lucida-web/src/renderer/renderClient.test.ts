import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FrameStarvationError, RenderClient } from "./renderClient.ts";
import { FRAME_STARVATION_TIMEOUT_MS } from "./frameStarvationWatchdog.ts";
import type { SliceLayerParams } from "./workerProtocol.ts";

/**
 * Stand-in for the browser Worker so RenderClient's lifecycle logic is
 * testable without a module-worker runtime. Worker replies are driven
 * manually via `emit`; `terminate` only records the call.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructionError: Error | null = null;
  posted: Array<{ type: string } & Record<string, unknown>> = [];
  terminated = false;
  private listeners = new Set<(e: { data: unknown }) => void>();
  private errorListeners = new Set<(e: { message: string; preventDefault(): void }) => void>();
  private messageErrorListeners = new Set<() => void>();

  constructor(_url: unknown, _opts?: unknown) {
    const constructionError = FakeWorker.constructionError;
    FakeWorker.constructionError = null;
    if (constructionError) throw constructionError;
    FakeWorker.instances.push(this);
  }

  postMessage(msg: { type: string }, _transfer?: unknown[]): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, cb: unknown): void {
    if (type === "message") {
      this.listeners.add(cb as (e: { data: unknown }) => void);
    } else if (type === "error") {
      this.errorListeners.add(cb as (e: { message: string; preventDefault(): void }) => void);
    } else if (type === "messageerror") {
      this.messageErrorListeners.add(cb as () => void);
    }
  }

  removeEventListener(type: string, cb: unknown): void {
    if (type === "message") {
      this.listeners.delete(cb as (e: { data: unknown }) => void);
    } else if (type === "error") {
      this.errorListeners.delete(cb as (e: { message: string; preventDefault(): void }) => void);
    } else if (type === "messageerror") {
      this.messageErrorListeners.delete(cb as () => void);
    }
  }

  emit(data: unknown): void {
    for (const cb of [...this.listeners]) cb({ data });
  }

  emitError(message = "worker crashed"): void {
    for (const cb of [...this.errorListeners]) cb({ message, preventDefault() {} });
  }

  emitMessageError(): void {
    for (const cb of [...this.messageErrorListeners]) cb();
  }
}

/** The constructor only needs `transferControlToOffscreen`. */
function makeCanvas(): HTMLCanvasElement {
  return {
    transferControlToOffscreen: () => ({}),
  } as unknown as HTMLCanvasElement;
}

function makeReadyClient(maxTextureDimension2D?: number): { client: RenderClient; worker: FakeWorker } {
  const client = new RenderClient(makeCanvas());
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  worker.emit({
    type: "ready",
    ...(maxTextureDimension2D === undefined ? {} : { maxTextureDimension2D }),
  });
  return { client, worker };
}

const noLayers: never[] = [];
const oneLayer = [{} as never];
const invViewProj = new Float32Array(16);
const eye = new Float32Array(3);

describe("RenderClient destroy", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.constructionError = null;
    vi.stubGlobal("Worker", FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ready() resolves on the worker's ready message", async () => {
    const { client } = makeReadyClient();
    await expect(client.ready()).resolves.toBeUndefined();
  });

  it("rolls back its lifecycle observer when worker construction throws", () => {
    const removeListener = vi.fn();
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: removeListener,
    });
    FakeWorker.constructionError = new Error("worker blocked by policy");

    expect(() => new RenderClient(makeCanvas())).toThrow("worker blocked by policy");
    expect(FakeWorker.instances).toHaveLength(0);
    expect(removeListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("publishes worker-confirmed frame completion and supports unsubscribe", () => {
    const { client, worker } = makeReadyClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribeFramePresented(listener);

    worker.emit({ type: "framePresented", frameId: 41 });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      frameId: 41,
      receivedAt: expect.any(Number),
    });

    unsubscribe();
    worker.emit({ type: "framePresented", frameId: 42 });
    expect(listener).toHaveBeenCalledOnce();
    client.destroy();
  });

  it("correlates every main render submission with a monotonic frame id", () => {
    const { client, worker } = makeReadyClient();
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    client.sliceRenderMultiPass(noLayers, 1, 0, 0, 100, 100, epochs);
    client.volumeRenderMultiPass(noLayers, invViewProj, eye, 100, 100, 100, 100, epochs);

    const renders = worker.posted.filter((message) => message.type.endsWith("RenderMultiPass"));
    expect(renders.map((message) => message.frameId)).toEqual([1, 2]);
    client.destroy();
  });

  it("suppresses malformed and device-oversized surfaces for both modes, then recovers", () => {
    const { client, worker } = makeReadyClient(1024);
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    expect(client.resize(0, 720, "slice")).toBe(false);
    expect(client.sliceRenderMultiPass(noLayers, 1, 0, 0, Number.NaN, 720, epochs)).toBe(false);
    expect(client.resize(640, 0, "volume")).toBe(false);
    expect(client.volumeRenderMultiPass(
      noLayers,
      invViewProj,
      eye,
      640,
      480,
      640,
      0,
      epochs,
    )).toBe(false);
    expect(client.volumeRenderMultiPass(
      noLayers,
      invViewProj,
      eye,
      1025,
      480,
      1025,
      480,
      epochs,
    )).toBe(false);
    expect(worker.posted.filter((message) =>
      message.type === "resize" || message.type.endsWith("RenderMultiPass"),
    )).toEqual([]);

    expect(client.resize(511.6, 255.6, "slice")).toBe(true);
    expect(client.sliceRenderMultiPass(noLayers, 1, 0, 0, 512, 256, epochs)).toBe(true);
    expect(client.resize(640, 480, "volume")).toBe(true);
    expect(client.volumeRenderMultiPass(
      noLayers,
      invViewProj,
      eye,
      640,
      480,
      4096,
      2048,
      epochs,
    )).toBe(true);

    expect(worker.posted.filter((message) => message.type === "resize")).toEqual([
      expect.objectContaining({ type: "resize", width: 512, height: 256 }),
      expect.objectContaining({ type: "resize", width: 640, height: 480 }),
    ]);
    expect(client.getRuntimeSnapshot().surface).toMatchObject({
      maxDimension: 1024,
      attempts: 9,
      forwarded: 4,
      suppressed: 5,
      byMode: {
        slice: { attempts: 4, forwarded: 2, suppressed: 2 },
        volume: { attempts: 5, forwarded: 2, suppressed: 3 },
      },
      lastSuppressed: {
        source: "volume-render",
        mode: "volume",
        rejection: "exceeds-device-limit",
      },
      lastForwarded: {
        source: "volume-render",
        mode: "volume",
      },
    });
    client.destroy();
  });

  it("cancels an armed but unsubmitted obligation when surface admission rejects", () => {
    const { client } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;

    client.expectNextMainFrame();
    expect(client.resize(0, 0, "slice")).toBe(false);
    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS * 2);

    expect(failure).not.toHaveBeenCalled();
    client.destroy();
  });

  it("proves worker quiescence by counters and resumes interaction after idle", () => {
    const { client, worker } = makeReadyClient();
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    client.sliceRenderMultiPass(noLayers, 1, 0, 0, 320, 200, epochs);
    expect(client.getRuntimeSnapshot().frames).toMatchObject({
      posted: 1,
      presented: 0,
      pending: 1,
    });
    worker.emit({ type: "framePresented", frameId: 1 });
    const idleStart = client.getRuntimeSnapshot();
    expect(idleStart.frames).toMatchObject({ posted: 1, presented: 1, pending: 0 });

    vi.advanceTimersByTime(2_000);
    const idleEnd = client.getRuntimeSnapshot();
    expect(idleEnd.frames).toEqual(idleStart.frames);
    expect(idleEnd.worker.messages).toBe(idleStart.worker.messages);

    client.volumeRenderMultiPass(
      noLayers,
      invViewProj,
      eye,
      320,
      200,
      320,
      200,
      { ...epochs, view: 2 },
    );
    expect(client.getRuntimeSnapshot().frames).toMatchObject({
      posted: 2,
      presented: 1,
      pending: 1,
    });
    worker.emit({ type: "framePresented", frameId: 2 });
    expect(client.getRuntimeSnapshot()).toMatchObject({
      frames: {
        posted: 2,
        presented: 2,
        pending: 0,
        lastPostedFrameId: 2,
        lastPresentedFrameId: 2,
      },
      worker: { messages: 3, lastMessageType: "framePresented" },
    });
    client.destroy();
  });

  it("publishes cached aggregate geometry once and then sends key-only frames", () => {
    const { client, worker } = makeReadyClient();
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };
    const canonical = new ArrayBuffer(64);
    const layers: SliceLayerParams[] = [{
      datasetId: "img-0",
      entityIndex: 0,
      blendMode: "alpha",
      dataW: 2048,
      dataH: 1024,
      aggregate: {
        poolMemberId: "img-0",
        count: 2,
        quads: canonical,
        cacheKey: "aggregate-1",
        cacheOwnerKey: "ds-0|single",
        ownerDatasetId: "ds-0",
      },
    }];

    client.sliceRenderMultiPass(layers, 1, 0, 0, 100, 100, epochs);
    client.sliceRenderMultiPass(layers, 1, 10, 20, 100, 100, {
      ...epochs,
      view: 2,
    });

    const renders = worker.posted.filter(
      (message) => message.type === "sliceRenderMultiPass",
    ) as unknown as Array<{ layers: SliceLayerParams[] }>;
    expect(renders).toHaveLength(2);
    expect(renders[0].layers[0].aggregate?.quads.byteLength).toBe(64);
    expect(renders[0].layers[0].aggregate?.quads).not.toBe(canonical);
    expect(renders[1].layers[0].aggregate?.quads.byteLength).toBe(0);
    // Publishing never detaches the canonical main-thread cache.
    expect(canonical.byteLength).toBe(64);

    client.removeLayerResources("ds-0");
    client.sliceRenderMultiPass(layers, 1, 0, 0, 100, 100, epochs);
    const republished = worker.posted.at(-1) as unknown as { layers: SliceLayerParams[] };
    expect(republished.layers[0].aggregate?.quads.byteLength).toBe(64);
    client.destroy();
  });

  it("forgets a superseded aggregate key when the same owner slot is replaced", () => {
    const { client, worker } = makeReadyClient();
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };
    const layer = (cacheKey: string): SliceLayerParams => ({
      datasetId: "img-0",
      entityIndex: 0,
      blendMode: "alpha",
      dataW: 2048,
      dataH: 1024,
      aggregate: {
        poolMemberId: "img-0",
        count: 2,
        quads: new ArrayBuffer(64),
        cacheKey,
        cacheOwnerKey: "ds-0|single",
        ownerDatasetId: "ds-0",
      },
    });

    client.sliceRenderMultiPass([layer("aggregate-1")], 1, 0, 0, 100, 100, epochs);
    client.sliceRenderMultiPass([layer("aggregate-2")], 1, 0, 0, 100, 100, epochs);
    // The worker evicted key 1 when key 2 took its owner slot. Returning to
    // key 1 must therefore republish bytes rather than send a stale key-only
    // reference.
    client.sliceRenderMultiPass([layer("aggregate-1")], 1, 0, 0, 100, 100, epochs);

    const renders = worker.posted.filter(
      (message) => message.type === "sliceRenderMultiPass",
    ) as unknown as Array<{ layers: SliceLayerParams[] }>;
    expect(renders.map((render) =>
      render.layers[0].aggregate?.quads.byteLength,
    )).toEqual([64, 64, 64]);
    client.destroy();
  });

  it("bounds all main-thread aggregate owner indexes while one slot churns 1000 keys", () => {
    const { client } = makeReadyClient();
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };
    for (let i = 0; i < 1000; i++) {
      const layer: SliceLayerParams = {
        datasetId: "img-0",
        entityIndex: 0,
        blendMode: "alpha",
        dataW: 2,
        dataH: 1,
        aggregate: {
          poolMemberId: "img-0",
          count: 2,
          quads: new ArrayBuffer(64),
          cacheKey: `aggregate-${i}`,
          cacheOwnerKey: "ds-0|single",
          ownerDatasetId: "ds-0",
        },
      };
      client.sliceRenderMultiPass([layer], 1, 0, 0, 100, 100, epochs);
    }

    const indexes = client as unknown as {
      publishedAggregateKeys: Set<string>;
      aggregateOwnerByKey: Map<string, string>;
      aggregateKeyByOwner: Map<string, string>;
    };
    expect(indexes.publishedAggregateKeys).toEqual(new Set(["aggregate-999"]));
    expect(indexes.aggregateOwnerByKey).toEqual(new Map([["aggregate-999", "ds-0"]]));
    expect(indexes.aggregateKeyByOwner).toEqual(new Map([["ds-0|single", "aggregate-999"]]));
    client.destroy();
  });

  it("forgets a worker cache miss and republishes canonical geometry on retry", () => {
    const { client, worker } = makeReadyClient();
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };
    const missed = vi.fn();
    client.onAggregateCacheMiss = missed;
    const layer: SliceLayerParams = {
      datasetId: "img-0",
      entityIndex: 0,
      blendMode: "alpha",
      dataW: 2,
      dataH: 1,
      aggregate: {
        poolMemberId: "img-0",
        count: 2,
        quads: new ArrayBuffer(64),
        cacheKey: "aggregate-1",
        cacheOwnerKey: "ds-0|single",
        ownerDatasetId: "ds-0",
      },
    };

    client.sliceRenderMultiPass([layer], 1, 0, 0, 100, 100, epochs);
    worker.emit({
      type: "aggregateCacheMiss",
      frameId: 1,
      cacheKey: "aggregate-1",
      cacheOwnerKey: "ds-0|single",
      ownerDatasetId: "ds-0",
    });
    client.sliceRenderMultiPass([layer], 1, 0, 0, 100, 100, epochs);

    const renders = worker.posted.filter(
      (message) => message.type === "sliceRenderMultiPass",
    ) as unknown as Array<{ layers: SliceLayerParams[] }>;
    expect(missed).toHaveBeenCalledOnce();
    expect(renders.map((render) => render.layers[0].aggregate?.quads.byteLength))
      .toEqual([64, 64]);
    client.destroy();
  });

  it("turns a submitted-but-never-presented main frame into one terminal failure", () => {
    const { client, worker } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    client.sliceRenderMultiPass(oneLayer, 1, 0, 0, 100, 100, epochs);
    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS);

    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][0]).toBeInstanceOf(FrameStarvationError);
    expect(failure.mock.calls[0][0]).toMatchObject({
      code: "frame_starvation",
      message: expect.stringContaining("stopped presenting frames"),
    });
    expect(worker.terminated).toBe(true);

    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS);
    expect(failure).toHaveBeenCalledOnce();
    client.destroy();
  });

  it("detects dirty work that starves before a main frame is submitted", () => {
    const { client, worker } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;

    expect(client.expectNextMainFrame()).toBe(1);
    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS);

    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      code: "frame_starvation",
      message: expect.stringContaining("stopped presenting frames"),
    }));
    expect(worker.terminated).toBe(true);
    client.destroy();
  });

  it("keeps the pre-submission deadline when the expected frame is posted", () => {
    const { client } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    client.expectNextMainFrame();
    vi.advanceTimersByTime(6_000);
    client.sliceRenderMultiPass(oneLayer, 1, 0, 0, 100, 100, epochs);
    vi.advanceTimersByTime(4_000);

    expect(failure).toHaveBeenCalledOnce();
    client.destroy();
  });

  it("retires the starvation deadline only on worker-confirmed presentation", () => {
    const { client, worker } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    client.volumeRenderMultiPass(oneLayer, invViewProj, eye, 100, 100, 100, 100, epochs);
    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS - 1);
    worker.emit({ type: "framePresented", frameId: 1 });
    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS * 2);

    expect(failure).not.toHaveBeenCalled();
    client.destroy();
  });

  it("does not arm starvation detection for an intentionally empty clear frame", () => {
    const { client } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;
    const epochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

    client.sliceRenderMultiPass(noLayers, 1, 0, 0, 100, 100, epochs);
    vi.advanceTimersByTime(FRAME_STARVATION_TIMEOUT_MS * 2);

    expect(failure).not.toHaveBeenCalled();
    client.destroy();
  });

  it("destroy before init settles ready() with a rejection", async () => {
    const client = new RenderClient(makeCanvas());
    const ready = client.ready();
    client.destroy();
    await expect(ready).rejects.toThrow("RenderClient destroyed");
  });

  it("destroy without ever awaiting ready() produces no unhandled rejection", async () => {
    // Deliberately no ready() call and no catch anywhere in this test:
    // vitest fails the file on unhandled-rejection events, so surviving
    // this path IS the assertion.
    const client = new RenderClient(makeCanvas());
    client.destroy();

    // Give a would-be unhandled rejection a real event-loop turn so it is
    // reported inside this test rather than after the suite.
    vi.useRealTimers();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("destroy settles in-flight thumbnail requests with null", async () => {
    const { client } = makeReadyClient();
    const pending = client.thumbnailRender(noLayers, invViewProj, eye, 64);
    client.destroy();
    await expect(pending).resolves.toBeNull();
  });

  it("thumbnailRender after destroy resolves null immediately and posts nothing", async () => {
    const { client, worker } = makeReadyClient();
    client.destroy();
    const postedBefore = worker.posted.length;

    await expect(
      client.thumbnailRender(noLayers, invViewProj, eye, 64),
    ).resolves.toBeNull();
    expect(worker.posted.length).toBe(postedBefore);
  });

  it("posts destroy to the worker and only hard-terminates as a delayed fallback", () => {
    const { client, worker } = makeReadyClient();
    client.destroy();

    // The worker-side destroy handler must get a chance to run its GPU
    // cleanup (it exits via self.close()); an immediate terminate() would
    // discard the queued message.
    expect(worker.posted.some(m => m.type === "destroy")).toBe(true);
    expect(worker.terminated).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(worker.terminated).toBe(true);
  });

  it("is idempotent — a second destroy posts nothing more", () => {
    const { client, worker } = makeReadyClient();
    client.destroy();
    client.destroy();
    expect(worker.posted.filter(m => m.type === "destroy")).toHaveLength(1);
  });

  it("worker messages flushed after destroy reach no callback but still release bitmaps", () => {
    const { client, worker } = makeReadyClient();
    const onIntensityRange = vi.fn();
    client.onIntensityRange = onIntensityRange;
    client.destroy();

    worker.emit({ type: "intensityRange", datasetId: "ds", channel: 0, min: 0, max: 1 });
    const close = vi.fn();
    worker.emit({ type: "thumbnailResult", id: 99, bitmap: { close } });

    expect(onIntensityRange).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("settles startup on a module-worker error and exposes one terminal failure", async () => {
    const client = new RenderClient(makeCanvas());
    const worker = FakeWorker.instances[0];
    const failure = vi.fn();
    client.onFailure = failure;
    const ready = client.ready();

    worker.emitError("failed to load module");
    worker.emitMessageError(); // duplicate terminal event is ignored

    await expect(ready).rejects.toThrow("failed to load module");
    expect(failure).toHaveBeenCalledTimes(1);
    expect(worker.terminated).toBe(true);
    client.destroy();
  });

  it("rejects every in-flight thumbnail exactly once on a steady-state crash", async () => {
    const { client, worker } = makeReadyClient();
    const a = client.thumbnailRender(noLayers, invViewProj, eye, 64);
    const b = client.thumbnailRender(noLayers, invViewProj, eye, 64);

    worker.emit({ type: "error", message: "WebGPU device lost" });
    worker.emitError("duplicate runtime event");

    await expect(a).rejects.toThrow("WebGPU device lost");
    await expect(b).rejects.toThrow("WebGPU device lost");
    expect(worker.terminated).toBe(true);
    await expect(client.thumbnailRender(noLayers, invViewProj, eye, 64))
      .rejects.toThrow("WebGPU device lost");
    client.destroy();
  });

  it("preserves a stable GPU failure code across the worker boundary", () => {
    const { client, worker } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;

    worker.emit({
      type: "error",
      message: "WebGPU ran out of memory",
      code: "gpu-out-of-memory",
    });

    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      name: "RenderWorkerError",
      code: "gpu-out-of-memory",
    }));
    client.destroy();
  });

  it("turns a synchronous postMessage failure into the same terminal state", () => {
    const { client, worker } = makeReadyClient();
    const failure = vi.fn();
    client.onFailure = failure;
    vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
      throw new Error("structured clone failed");
    });

    client.resize(100, 100);

    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      message: "structured clone failed",
    }));
    expect(worker.terminated).toBe(true);
    client.destroy();
  });
});
