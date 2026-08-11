import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DecodePool } from "./decodePool.ts";
import type { WireFormat } from "../../manifestTypes.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { Boundary } from "../../trace/types.ts";
import { createQuiescenceState } from "../../trace/quiescence.ts";

const OPEN_CAUSE = { epoch: "content", dirtyKind: "interactive", source: "test" } as const;

const CHUNK = {
  datasetId: "ds",
  entityId: "member-1",
  imageId: "image-1",
  lane: "detail",
  level: 0,
  t: 0,
  c: 0,
  z: 0,
  y: 0,
  x: 0,
};

const ENVIRONMENT = {
  captureWarmth: () => ({
    detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
  }),
  captureConditions: () => ({
    datasetIds: ["ds"],
    composedView: { url: "/w/ws-1", mode: "slice" as const },
    devicePixelRatio: 2,
    viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
  }),
  captureOutstanding: () => createQuiescenceState(),
};

/**
 * Stand-in for the browser Worker so the pool's dispatch/teardown logic is
 * testable without a real module worker. Replies are driven manually via
 * `reply`; `terminate` only records the call (like the real API, it never
 * settles outstanding messages by itself).
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: { id: number; data?: ArrayBuffer; error?: string } }) => void) | null = null;
  posted: { id: number; bytes: ArrayBuffer }[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: { id: number; bytes: ArrayBuffer }): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(id: number, data: ArrayBuffer): void {
    this.onmessage?.({ data: { id, data } });
  }
}

const wireFormat: WireFormat = { Raw: { data_type: "uint16" } };

describe("DecodePool", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("terminate() terminates every worker and empties the pool", () => {
    const pool = new DecodePool(3);
    expect(FakeWorker.instances).toHaveLength(3);

    pool.terminate();

    expect(FakeWorker.instances.every(w => w.terminated)).toBe(true);
    expect(pool.size).toBe(0);
  });

  it("terminate() rejects outstanding decode promises so awaiting callers settle", async () => {
    const pool = new DecodePool(1);
    const pending = pool.decode(new ArrayBuffer(8), wireFormat);
    expect(pool.activeCount()).toBe(1);

    pool.terminate();

    await expect(pending).rejects.toThrow("DecodePool terminated");
    expect(pool.activeCount()).toBe(0);
  });

  it("terminate() is idempotent", () => {
    const pool = new DecodePool(2);
    pool.terminate();
    expect(() => pool.terminate()).not.toThrow();
    expect(pool.size).toBe(0);
  });

  it("decode() after terminate() rejects instead of crashing on an empty pool", async () => {
    const pool = new DecodePool(1);
    pool.terminate();

    await expect(pool.decode(new ArrayBuffer(4), wireFormat)).rejects.toThrow(
      "DecodePool terminated",
    );
  });

  it("still resolves decodes normally before termination", async () => {
    const pool = new DecodePool(1);
    const promise = pool.decode(new ArrayBuffer(8), wireFormat);

    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);
    const decoded = new ArrayBuffer(16);
    worker.reply(worker.posted[0].id, decoded);

    await expect(promise).resolves.toBe(decoded);
    expect(pool.activeCount()).toBe(0);
  });

  it("brackets each decode's round trip against the row that asked for it", async () => {
    traceRecorder.reset();
    traceRecorder.setEnvironment(ENVIRONMENT);
    traceRecorder.openRun(OPEN_CAUSE);

    // Two chunks in flight on one worker. The pool's own ids are slot
    // numbers; only the correlation id says which chunk a reply belongs to.
    const first = traceRecorder.beginChunkRow({ ...CHUNK, x: 1 }, 0);
    const second = traceRecorder.beginChunkRow({ ...CHUNK, x: 2 }, 0);
    traceRecorder.stamp(first, Boundary.DecodeStart);
    traceRecorder.stamp(second, Boundary.DecodeStart);

    const pool = new DecodePool(1);
    const firstDecode = pool.decode(new ArrayBuffer(8), wireFormat, first);
    pool.decode(new ArrayBuffer(8), wireFormat, second);

    const worker = FakeWorker.instances[0];
    // Reply to the SECOND decode only, so a reply landing on the wrong row
    // would be visible rather than coincidentally right.
    worker.reply(worker.posted[1].id, new ArrayBuffer(16));
    traceRecorder.closeRun("explicit");

    const rows = traceRecorder.exportDocument().runs[0].rows;
    expect(rows.filter(r => r.phases.decode !== undefined).map(r => r.x)).toEqual([2]);
    // Dispatch is below the clock floor: counted, not timed.
    expect(traceRecorder.exportDocument().runs[0].counted.workerDispatch).toBe(2);

    pool.terminate();
    await expect(firstDecode).rejects.toThrow("DecodePool terminated");
    traceRecorder.reset();
  });
});
