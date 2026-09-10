import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RenderClient } from "./renderClient.ts";

/**
 * Stand-in for the browser Worker so RenderClient's lifecycle logic is
 * testable without a module-worker runtime. Worker replies are driven
 * manually via `emit`; `terminate` only records the call.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Array<{ type: string } & Record<string, unknown>> = [];
  terminated = false;
  private listeners = new Set<(e: { data: unknown }) => void>();

  constructor(_url: unknown, _opts?: unknown) {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: { type: string }, _transfer?: unknown[]): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, cb: (e: { data: unknown }) => void): void {
    if (type === "message") this.listeners.add(cb);
  }

  removeEventListener(_type: string, cb: (e: { data: unknown }) => void): void {
    this.listeners.delete(cb);
  }

  emit(data: unknown): void {
    for (const cb of [...this.listeners]) cb({ data });
  }
}

/** The constructor only needs `transferControlToOffscreen`. */
function makeCanvas(): HTMLCanvasElement {
  return {
    transferControlToOffscreen: () => ({}),
  } as unknown as HTMLCanvasElement;
}

function makeReadyClient(): { client: RenderClient; worker: FakeWorker } {
  const client = new RenderClient(makeCanvas());
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  worker.emit({ type: "ready" });
  return { client, worker };
}

const noLayers: never[] = [];
const invViewProj = new Float32Array(16);
const eye = new Float32Array(3);

describe("RenderClient destroy", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
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

  it("hands over the worker's GPU pass time once, and null when none arrived", () => {
    const { client, worker } = makeReadyClient();
    expect(client.takeGpuPassUs()).toBeNull();

    worker.emit({ type: "gpuPassTime", gpuPassUs: 1_800 });
    worker.emit({ type: "gpuPassTime", gpuPassUs: 2_100 });
    expect(client.takeGpuPassUs()).toBe(2_100);
    expect(client.takeGpuPassUs()).toBeNull();
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

  it("captureFrame resolves with the worker's PNG and device size, or its failure as the reason, matched by id", async () => {
    const { client, worker } = makeReadyClient();
    const first = client.captureFrame();
    const second = client.captureFrame();
    const posted = worker.posted.filter(m => m.type === "captureFrame");
    expect(posted.map(m => m.id)).toEqual([0, 1]);

    const png = new Uint8Array([1, 2, 3]).buffer;
    worker.emit({ type: "frameCaptured", id: 1, png, width: 2880, height: 1800, failure: null });
    worker.emit({
      type: "frameCaptured",
      id: 0,
      png: null,
      width: 2880,
      height: 1800,
      failure: { name: "InvalidStateError", message: "the canvas has no current texture" },
    });

    await expect(second).resolves.toEqual({ frame: { png, width: 2880, height: 1800 }, reason: null });
    await expect(first).resolves.toEqual({
      frame: null,
      reason: "the render worker could not read its canvas: InvalidStateError: the canvas has no current texture",
    });
  });

  it("destroy settles an in-flight frame capture with a reason", async () => {
    const { client } = makeReadyClient();
    const pending = client.captureFrame();
    client.destroy();
    await expect(pending).resolves.toEqual({
      frame: null,
      reason: "the render client was destroyed before the worker answered",
    });
  });

  it("captureFrame after destroy resolves with a reason immediately and posts nothing", async () => {
    const { client, worker } = makeReadyClient();
    client.destroy();
    const postedBefore = worker.posted.length;

    await expect(client.captureFrame()).resolves.toEqual({
      frame: null,
      reason: "the render client was destroyed, so there was no canvas to read",
    });
    expect(worker.posted.length).toBe(postedBefore);
  });

  /**
   * The worker drops every message until its init completes and answers
   * none after its init fails, so a capture posted then would hang the
   * bundle export on the one host the driver's fallback frame exists for:
   * one where the worker never came up (#1098).
   */
  it("captureFrame on a worker that failed to start resolves with the failure as the reason and posts nothing", async () => {
    const client = new RenderClient(makeCanvas());
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    worker.emit({ type: "error", message: "Failed to get WebGPU adapter" });
    const postedBefore = worker.posted.length;

    await expect(client.captureFrame()).resolves.toEqual({
      frame: null,
      reason: "the render worker did not start: Failed to get WebGPU adapter",
    });
    expect(worker.posted.length).toBe(postedBefore);
  });

  it("captureFrame before the worker is ready waits for it, then posts and is answered by id", async () => {
    const client = new RenderClient(makeCanvas());
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    const pending = client.captureFrame();
    expect(worker.posted.filter(m => m.type === "captureFrame")).toHaveLength(0);

    worker.emit({ type: "ready" });
    await client.ready();
    expect(worker.posted.filter(m => m.type === "captureFrame").map(m => m.id)).toEqual([0]);

    const png = new Uint8Array([9]).buffer;
    worker.emit({ type: "frameCaptured", id: 0, png, width: 4, height: 2, failure: null });
    await expect(pending).resolves.toEqual({ frame: { png, width: 4, height: 2 }, reason: null });
  });

  it("destroy settles a capture still waiting for the worker to start", async () => {
    const client = new RenderClient(makeCanvas());
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    const pending = client.captureFrame();
    client.destroy();

    await expect(pending).resolves.toEqual({
      frame: null,
      reason: "the render client was destroyed before the worker answered",
    });
    expect(worker.posted.filter(m => m.type === "captureFrame")).toHaveLength(0);
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

    worker.emit({ type: "intensityRange", datasetId: "ds", min: 0, max: 1 });
    const close = vi.fn();
    worker.emit({ type: "thumbnailResult", id: 99, bitmap: { close } });

    expect(onIntensityRange).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
