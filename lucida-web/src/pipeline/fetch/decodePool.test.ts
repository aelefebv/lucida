import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DecodePool } from "./decodePool.ts";
import type { WireFormat } from "../../manifestTypes.ts";
import { makeChunkContract } from "../../test/fixtures.ts";

/**
 * Stand-in for the browser Worker so the pool's dispatch/teardown logic is
 * testable without a real module worker. Replies are driven manually via
 * `reply`; `terminate` only records the call (like the real API, it never
 * settles outstanding messages by itself).
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructionErrors: Array<Error | null> = [];
  onmessage: ((e: { data: { id: number; data?: ArrayBuffer; error?: string } }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: { id: number; bytes: ArrayBuffer }[] = [];
  terminated = false;

  constructor() {
    const constructionError = FakeWorker.constructionErrors.shift();
    if (constructionError) throw constructionError;
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

  crash(message = "boom"): void {
    this.onerror?.({ message, preventDefault() {} });
  }

  corruptMessage(): void {
    this.onmessageerror?.();
  }
}

const wireFormat: WireFormat = { Raw: { data_type: "uint16" } };
const contract = makeChunkContract();

describe("DecodePool", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.constructionErrors = [];
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
    const pending = pool.decode(new ArrayBuffer(8), wireFormat, contract);
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

    await expect(pool.decode(new ArrayBuffer(4), wireFormat, contract)).rejects.toThrow(
      "DecodePool terminated",
    );
  });

  it("still resolves decodes normally before termination", async () => {
    const pool = new DecodePool(1);
    const promise = pool.decode(new ArrayBuffer(8), wireFormat, contract);

    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);
    const decoded = new ArrayBuffer(16);
    worker.reply(worker.posted[0].id, decoded);

    await expect(promise).resolves.toBe(decoded);
    expect(pool.activeCount()).toBe(0);
  });

  it("rejects every pending decode exactly once and replaces a crashed worker", async () => {
    const pool = new DecodePool(1);
    const failure = vi.fn();
    pool.onFailure = failure;
    const a = pool.decode(new ArrayBuffer(8), wireFormat, contract);
    const b = pool.decode(new ArrayBuffer(8), wireFormat, contract);
    const first = FakeWorker.instances[0];

    first.crash("codec crashed");
    first.corruptMessage(); // duplicate terminal signal from the retired worker

    await expect(a).rejects.toThrow("codec crashed");
    await expect(b).rejects.toThrow("codec crashed");
    expect(first.terminated).toBe(true);
    expect(pool.activeCount()).toBe(0);
    expect(pool.size).toBe(1);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenLastCalledWith(expect.any(Error), false);

    const recovered = pool.decode(new ArrayBuffer(8), wireFormat, contract);
    const replacement = FakeWorker.instances[1];
    replacement.reply(replacement.posted[0].id, new ArrayBuffer(16));
    await expect(recovered).resolves.toHaveProperty("byteLength", 16);
  });

  it("enters a retryable terminal state after replacement startup also fails", async () => {
    const pool = new DecodePool(1);
    const failure = vi.fn();
    pool.onFailure = failure;
    FakeWorker.instances[0].crash("first startup failure");
    FakeWorker.instances[1].crash("replacement startup failure");

    expect(pool.size).toBe(0);
    expect(failure).toHaveBeenNthCalledWith(1, expect.any(Error), false);
    expect(failure).toHaveBeenNthCalledWith(2, expect.any(Error), true);
    await expect(pool.decode(new ArrayBuffer(8), wireFormat, contract)).rejects.toThrow(
      "DecodePool unavailable: replacement startup failure",
    );

    expect(pool.retry()).toBe(true);
    expect(pool.size).toBe(1);
    const pending = pool.decode(new ArrayBuffer(8), wireFormat, contract);
    const retried = FakeWorker.instances[2];
    retried.reply(retried.posted[0].id, new ArrayBuffer(4));
    await expect(pending).resolves.toHaveProperty("byteLength", 4);
  });

  it("retains and replays a synchronous initial construction failure", async () => {
    FakeWorker.constructionErrors = [null, new Error("module workers blocked")];
    const pool = new DecodePool(2);
    const failure = vi.fn();

    expect(pool.size).toBe(0);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(() => {
      pool.onFailure = failure;
    }).not.toThrow();
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "module workers blocked" }),
      true,
    );
    await expect(pool.decode(new ArrayBuffer(8), wireFormat, contract)).rejects.toThrow(
      "DecodePool unavailable: module workers blocked",
    );

    expect(pool.retry()).toBe(true);
    expect(pool.size).toBe(2);
  });

  it("retires a dead slot when synchronous replacement construction fails", async () => {
    const pool = new DecodePool(1);
    const failure = vi.fn();
    pool.onFailure = failure;
    FakeWorker.constructionErrors = [new Error("replacement constructor blocked")];

    FakeWorker.instances[0].crash("decoder crashed");

    expect(pool.size).toBe(0);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Decode worker replacement could not start: replacement constructor blocked",
      }),
      true,
    );
    await expect(pool.decode(new ArrayBuffer(8), wireFormat, contract)).rejects.toThrow(
      "DecodePool unavailable: Decode worker replacement could not start",
    );
  });

  it("keeps retry available when synchronous retry construction also fails", () => {
    FakeWorker.constructionErrors = [new Error("initial blocked")];
    const pool = new DecodePool(1);
    const failure = vi.fn();
    pool.onFailure = failure;
    FakeWorker.constructionErrors = [new Error("retry still blocked")];

    expect(pool.retry()).toBe(false);
    expect(pool.size).toBe(0);
    expect(failure).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "retry still blocked" }),
      true,
    );

    expect(pool.retry()).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("settles a request when postMessage throws without poisoning the worker", async () => {
    const pool = new DecodePool(1);
    const worker = FakeWorker.instances[0];
    vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
      throw new Error("detached input");
    });
    await expect(pool.decode(new ArrayBuffer(8), wireFormat, contract)).rejects.toThrow("detached input");
    expect(pool.activeCount()).toBe(0);
    expect(pool.size).toBe(1);
  });
});
