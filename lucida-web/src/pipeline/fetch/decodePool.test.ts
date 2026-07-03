import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DecodePool } from "./decodePool.ts";
import type { WireFormat } from "../../manifestTypes.ts";

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
});
