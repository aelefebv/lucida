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

    worker.emit({ type: "intensityRange", datasetId: "ds", min: 0, max: 1 });
    const close = vi.fn();
    worker.emit({ type: "thumbnailResult", id: 99, bitmap: { close } });

    expect(onIntensityRange).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
