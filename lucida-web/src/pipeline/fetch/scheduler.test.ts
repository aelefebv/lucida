import { describe, it, expect, vi, beforeEach } from "vitest";

import { Scheduler, type InFlightEntry } from "./scheduler.ts";
import { BurstLogger } from "./telemetry.ts";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});
import { debugLog } from "../../debug/logging.ts";

// Clear the debugLog spy before every test. The backpressure-log specs below
// assert exact `cache.backpressure` call counts; without this, a
// backpressure emit from an earlier test inflates the count under
// `--sequence.shuffle` (expected 1, got 3) — lucida-ig7.
beforeEach(() => {
  vi.mocked(debugLog).mockClear();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TestRequest {
  datasetId: string;
  entityId: string;
  chunkKey: string;
}

function req(overrides: Partial<TestRequest> & { chunkKey: string }): TestRequest {
  return {
    datasetId: "ds-1",
    entityId: "e-1",
    ...overrides,
  };
}

const keyOf = (r: TestRequest) => `${r.entityId}/${r.chunkKey}`;

interface StartCall {
  req: TestRequest;
  controller: AbortController;
  estimatedBytes: number;
  key: string;
}

function makeScheduler(opts?: {
  maxConcurrentFetches?: number;
  maxBytesInFlight?: number;
  burstLogger?: BurstLogger;
  siblingInFlight?: () => { count: number; bytes: number };
}) {
  const startCalls: StartCall[] = [];
  const startFn = (
    r: TestRequest,
    controller: AbortController,
    estimatedBytes: number,
    key: string,
  ) => {
    startCalls.push({ req: r, controller, estimatedBytes, key });
  };
  const scheduler = new Scheduler<TestRequest>(
    {
      maxConcurrentFetches: opts?.maxConcurrentFetches ?? 4,
      maxBytesInFlight: opts?.maxBytesInFlight ?? 1_000_000,
      burstLogger: opts?.burstLogger,
      siblingInFlight: opts?.siblingInFlight,
    },
    keyOf,
    startFn,
  );
  return { scheduler, startCalls };
}

// ---------------------------------------------------------------------------
// enqueue + drain
// ---------------------------------------------------------------------------

describe("Scheduler.enqueue + drain", () => {
  it("drain calls startFn for each pending request up to maxConcurrentFetches", () => {
    const { scheduler, startCalls } = makeScheduler({ maxConcurrentFetches: 2 });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
      req({ chunkKey: "c" }),
    ]);
    scheduler.drain(() => 0);
    expect(startCalls).toHaveLength(2);
    expect(scheduler.inFlightSize).toBe(2);
    expect(scheduler.pendingSize).toBe(1);
    // The retained pending entry is the third one.
    expect(scheduler.pendingSnapshot()[0].chunkKey).toBe("c");
  });

  it("drain consumes all pending when under both caps", () => {
    const { scheduler, startCalls } = makeScheduler({ maxConcurrentFetches: 4 });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
    ]);
    scheduler.drain(() => 0);
    expect(startCalls).toHaveLength(2);
    expect(scheduler.pendingSize).toBe(0);
  });

  it("drain charges estimated bytes per started request", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 4 });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
    ]);
    scheduler.drain(() => 100);
    expect(scheduler.inFlightBytes).toBe(200);
  });

  it("drain stops when bytes cap reached", () => {
    const { scheduler, startCalls } = makeScheduler({
      maxConcurrentFetches: 10,
      maxBytesInFlight: 150,
    });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
      req({ chunkKey: "c" }),
    ]);
    scheduler.drain(() => 100);
    // First start charges 100; bytes is now 100 (< 150) so a second
    // start fires and charges another 100; bytes is now 200 (>= 150)
    // so the third stays pending.
    expect(startCalls).toHaveLength(2);
    expect(scheduler.inFlightBytes).toBe(200);
    expect(scheduler.pendingSize).toBe(1);
  });

  it("startFn receives the same key the scheduler tracks internally", () => {
    const { scheduler, startCalls } = makeScheduler();
    const r = req({ chunkKey: "k-1" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 0);
    expect(startCalls[0].key).toBe(keyOf(r));
    expect(scheduler.hasInFlight(keyOf(r))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preserveEnqueueTime
// ---------------------------------------------------------------------------

describe("Scheduler.enqueue preserves original timestamps", () => {
  it("re-enqueueing the same key keeps the original enqueue time", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 0 });
    scheduler.enqueue([req({ chunkKey: "a" })], 1000);
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "a" })))).toBe(1000);

    // Re-submitting at a later time keeps the older timestamp.
    scheduler.enqueue([req({ chunkKey: "a" })], 2000);
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "a" })))).toBe(1000);
  });

  it("dropped keys do not leak into the enqueue-time map", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 0 });
    scheduler.enqueue([req({ chunkKey: "a" }), req({ chunkKey: "b" })], 1000);
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "a" })))).toBe(1000);
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "b" })))).toBe(1000);

    // Drop "a" by re-enqueueing only "b".
    scheduler.enqueue([req({ chunkKey: "b" })], 2000);
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "a" })))).toBeUndefined();
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "b" })))).toBe(1000);
  });

  it("oldestPendingAgeMs returns 0 when queue is empty", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.oldestPendingAgeMs(5000)).toBe(0);
  });

  it("oldestPendingAgeMs returns now - oldest enqueue", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 0 });
    scheduler.enqueue([req({ chunkKey: "a" })], 1000);
    scheduler.enqueue(
      [req({ chunkKey: "a" }), req({ chunkKey: "b" })],
      3000,
    );
    // "a" carries the original 1000; "b" gets the second-call timestamp 3000.
    // Oldest is 1000; age at now=4000 is 3000.
    expect(scheduler.oldestPendingAgeMs(4000)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// correctInFlightBytes
// ---------------------------------------------------------------------------

describe("Scheduler.correctInFlightBytes", () => {
  it("adjusts the bytes counter from estimate to actual", () => {
    const { scheduler } = makeScheduler();
    const r = req({ chunkKey: "k" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);
    expect(scheduler.inFlightBytes).toBe(100);

    scheduler.correctInFlightBytes(keyOf(r), 250);
    expect(scheduler.inFlightBytes).toBe(250);
  });

  it("can correct downward when actual < estimate", () => {
    const { scheduler } = makeScheduler();
    const r = req({ chunkKey: "k" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 1000);
    expect(scheduler.inFlightBytes).toBe(1000);

    scheduler.correctInFlightBytes(keyOf(r), 100);
    expect(scheduler.inFlightBytes).toBe(100);
  });

  it("is a no-op for keys not in flight (cancelled mid-fetch)", () => {
    const { scheduler } = makeScheduler();
    expect(() => scheduler.correctInFlightBytes("missing", 100)).not.toThrow();
    expect(scheduler.inFlightBytes).toBe(0);
  });

  it("subsequent markInFlightDone deducts the corrected (not the estimate) amount", () => {
    const { scheduler } = makeScheduler();
    const r = req({ chunkKey: "k" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);
    scheduler.correctInFlightBytes(keyOf(r), 250);
    scheduler.markInFlightDone(keyOf(r));
    expect(scheduler.inFlightBytes).toBe(0);
    expect(scheduler.inFlightSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// markInFlightDone
// ---------------------------------------------------------------------------

describe("Scheduler.markInFlightDone", () => {
  it("removes the entry and decrements bytes", () => {
    const { scheduler } = makeScheduler();
    const r = req({ chunkKey: "k" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);
    expect(scheduler.inFlightSize).toBe(1);
    expect(scheduler.inFlightBytes).toBe(100);

    scheduler.markInFlightDone(keyOf(r));
    expect(scheduler.inFlightSize).toBe(0);
    expect(scheduler.inFlightBytes).toBe(0);
  });

  it("is idempotent — safe to call after cancellation", () => {
    const { scheduler } = makeScheduler();
    expect(() => scheduler.markInFlightDone("missing")).not.toThrow();
    expect(scheduler.inFlightBytes).toBe(0);
  });

  it("releasing a slot re-opens capacity for the next drain", () => {
    const { scheduler, startCalls } = makeScheduler({ maxConcurrentFetches: 1 });
    const r1 = req({ chunkKey: "a" });
    const r2 = req({ chunkKey: "b" });
    scheduler.enqueue([r1, r2]);
    scheduler.drain(() => 0);
    expect(startCalls).toHaveLength(1);
    expect(scheduler.pendingSize).toBe(1);

    scheduler.markInFlightDone(keyOf(r1));
    scheduler.drain(() => 0);
    expect(startCalls).toHaveLength(2);
    expect(scheduler.pendingSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// markInFlightDoneIfCurrent
// ---------------------------------------------------------------------------

describe("Scheduler.markInFlightDoneIfCurrent", () => {
  it("releases and returns true when the caller's controller still holds the key", () => {
    const { scheduler, startCalls } = makeScheduler();
    const r = req({ chunkKey: "k" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);
    expect(scheduler.inFlightSize).toBe(1);
    expect(scheduler.inFlightBytes).toBe(100);

    const controller = startCalls[0].controller;
    expect(scheduler.markInFlightDoneIfCurrent(keyOf(r), controller)).toBe(true);
    expect(scheduler.inFlightSize).toBe(0);
    expect(scheduler.inFlightBytes).toBe(0);
  });

  it("preserves the slot and returns false when a superseding controller holds the key", () => {
    const { scheduler, startCalls } = makeScheduler();
    const r = req({ chunkKey: "k" });

    // First controller starts the key, then the key is cancelled and
    // re-enqueued so a fresh controller supersedes it under the same key.
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);
    const superseded = startCalls[0].controller;

    scheduler.cancelOne(keyOf(r));
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);
    const successor = startCalls[1].controller;
    expect(successor).not.toBe(superseded);
    expect(scheduler.inFlightSize).toBe(1);

    // The superseded controller frees nothing: the successor's slot and its
    // bytes stay intact.
    expect(scheduler.markInFlightDoneIfCurrent(keyOf(r), superseded)).toBe(false);
    expect(scheduler.inFlightSize).toBe(1);
    expect(scheduler.inFlightBytes).toBe(100);

    // The successor's own controller releases it.
    expect(scheduler.markInFlightDoneIfCurrent(keyOf(r), successor)).toBe(true);
    expect(scheduler.inFlightSize).toBe(0);
    expect(scheduler.inFlightBytes).toBe(0);
  });

  it("returns false for a key that is not in flight", () => {
    const { scheduler } = makeScheduler();
    const controller = new AbortController();
    expect(scheduler.markInFlightDoneIfCurrent("missing", controller)).toBe(false);
    expect(scheduler.inFlightBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cancelOne
// ---------------------------------------------------------------------------

describe("Scheduler.cancelOne", () => {
  it("aborts the controller, releases the slot, and drops bytes", () => {
    const { scheduler, startCalls } = makeScheduler();
    const r = req({ chunkKey: "k" });
    scheduler.enqueue([r]);
    scheduler.drain(() => 100);

    const controller = startCalls[0].controller;
    const aborted = vi.fn();
    controller.signal.addEventListener("abort", aborted);

    scheduler.cancelOne(keyOf(r));
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(scheduler.inFlightSize).toBe(0);
    expect(scheduler.inFlightBytes).toBe(0);
  });

  it("is a no-op for unknown keys", () => {
    const { scheduler } = makeScheduler();
    expect(() => scheduler.cancelOne("missing")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cancelDataset
// ---------------------------------------------------------------------------

describe("Scheduler.cancelDataset", () => {
  it("aborts in-flight entries matching the predicate, leaves others", () => {
    const { scheduler, startCalls } = makeScheduler({ maxConcurrentFetches: 4 });
    scheduler.enqueue([
      req({ chunkKey: "a", entityId: "e-1" }),
      req({ chunkKey: "b", entityId: "e-2" }),
      req({ chunkKey: "c", entityId: "e-1" }),
    ]);
    scheduler.drain(() => 50);
    expect(scheduler.inFlightSize).toBe(3);

    const aborted = startCalls.map((c) => {
      const fn = vi.fn();
      c.controller.signal.addEventListener("abort", fn);
      return { req: c.req, fn };
    });

    scheduler.cancelDataset((e) => e.request.entityId === "e-1");

    expect(scheduler.inFlightSize).toBe(1);
    expect(scheduler.inFlightBytes).toBe(50); // only e-2 / "b" remains
    // e-1's two entries aborted; e-2 not.
    const e1Aborts = aborted.filter((a) => a.req.entityId === "e-1");
    const e2Aborts = aborted.filter((a) => a.req.entityId === "e-2");
    e1Aborts.forEach((a) => expect(a.fn).toHaveBeenCalledTimes(1));
    e2Aborts.forEach((a) => expect(a.fn).not.toHaveBeenCalled());
  });

  it("drops pending entries matching the predicate too", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 0 });
    scheduler.enqueue([
      req({ chunkKey: "a", entityId: "e-1" }),
      req({ chunkKey: "b", entityId: "e-2" }),
    ]);
    expect(scheduler.pendingSize).toBe(2);

    scheduler.cancelDataset((e) => e.request.entityId === "e-1");
    expect(scheduler.pendingSize).toBe(1);
    expect(scheduler.pendingSnapshot()[0].entityId).toBe("e-2");
  });

  it("clears enqueue-time entries for both pending and in-flight cancellations", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 1 });
    scheduler.enqueue(
      [
        req({ chunkKey: "a", entityId: "e-1" }),
        req({ chunkKey: "b", entityId: "e-1" }),
      ],
      1000,
    );
    scheduler.drain(() => 0);
    // "a" is in-flight (enqueueTime cleared); "b" is pending (kept).
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "b", entityId: "e-1" })))).toBe(1000);

    scheduler.cancelDataset((e) => e.request.entityId === "e-1");

    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "a", entityId: "e-1" })))).toBeUndefined();
    expect(scheduler.enqueueTimeFor(keyOf(req({ chunkKey: "b", entityId: "e-1" })))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cancelWhere
// ---------------------------------------------------------------------------

describe("Scheduler.cancelWhere", () => {
  it("returns keys removed from in-flight and pending queues", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 1 });
    scheduler.enqueue([
      req({ chunkKey: "a", entityId: "e-1" }),
      req({ chunkKey: "b", entityId: "e-1" }),
      req({ chunkKey: "c", entityId: "e-2" }),
    ]);
    scheduler.drain(() => 10);

    const cancelled = scheduler.cancelWhere((entry) => entry.request.entityId === "e-1");

    expect(cancelled.sort()).toEqual([
      keyOf(req({ chunkKey: "a", entityId: "e-1" })),
      keyOf(req({ chunkKey: "b", entityId: "e-1" })),
    ].sort());
    expect(scheduler.inFlightSize).toBe(0);
    expect(scheduler.inFlightBytes).toBe(0);
    expect(scheduler.pendingSnapshot().map((r) => r.chunkKey)).toEqual(["c"]);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("Scheduler.reset", () => {
  it("aborts all in-flight + drops pending + zeros bytes", () => {
    const { scheduler, startCalls } = makeScheduler({ maxConcurrentFetches: 2 });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
      req({ chunkKey: "c" }),
    ]);
    scheduler.drain(() => 100);
    expect(scheduler.inFlightSize).toBe(2);
    expect(scheduler.pendingSize).toBe(1);
    expect(scheduler.inFlightBytes).toBe(200);

    const aborts = startCalls.map((c) => {
      const fn = vi.fn();
      c.controller.signal.addEventListener("abort", fn);
      return fn;
    });

    scheduler.reset();

    expect(scheduler.inFlightSize).toBe(0);
    expect(scheduler.pendingSize).toBe(0);
    expect(scheduler.inFlightBytes).toBe(0);
    aborts.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
  });
});

// ---------------------------------------------------------------------------
// Backpressure log
// ---------------------------------------------------------------------------

describe("Scheduler backpressure log", () => {
  it("fires when pending > 0 and a cap is hit", () => {
    vi.useFakeTimers();
    try {
      // performance.now() must be ≥ windowMs (1000) so the BurstLogger
      // emits on the first call; advance time before constructing.
      vi.advanceTimersByTime(2000);

      const burstLogger = new BurstLogger("cache", "cache.backpressure");
      const { scheduler } = makeScheduler({
        maxConcurrentFetches: 1,
        burstLogger,
      });
      scheduler.enqueue([
        req({ chunkKey: "a" }),
        req({ chunkKey: "b" }),
      ]);
      scheduler.drain(() => 0);
      // 1 in-flight, 1 pending → cap hit + pending remains → emit.
      const calls = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.backpressure",
      );
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire when there are no pending entries left after drain", () => {
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2000);
      vi.mocked(debugLog).mockClear();
      const burstLogger = new BurstLogger("cache", "cache.backpressure");
      const { scheduler } = makeScheduler({
        maxConcurrentFetches: 4,
        burstLogger,
      });
      scheduler.enqueue([req({ chunkKey: "a" })]);
      scheduler.drain(() => 0);
      const calls = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.backpressure",
      );
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate-limits to once per window (BurstLogger semantics)", () => {
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2000);
      vi.mocked(debugLog).mockClear();
      const burstLogger = new BurstLogger("cache", "cache.backpressure");
      const { scheduler } = makeScheduler({
        maxConcurrentFetches: 1,
        burstLogger,
      });

      scheduler.enqueue([
        req({ chunkKey: "a" }),
        req({ chunkKey: "b" }),
        req({ chunkKey: "c" }),
      ]);
      scheduler.drain(() => 0);
      const first = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.backpressure",
      ).length;
      expect(first).toBe(1);

      // Within 1 second, the rate limit suppresses additional emits.
      vi.advanceTimersByTime(500);
      scheduler.enqueue([
        req({ chunkKey: "a" }),
        req({ chunkKey: "b" }),
        req({ chunkKey: "c" }),
      ]);
      scheduler.drain(() => 0);
      const stillOne = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.backpressure",
      ).length;
      expect(stillOne).toBe(1);

      // After the 1-second window elapses, another emit fires.
      vi.advanceTimersByTime(600);
      scheduler.enqueue([
        req({ chunkKey: "a" }),
        req({ chunkKey: "b" }),
        req({ chunkKey: "c" }),
      ]);
      scheduler.drain(() => 0);
      const afterWindow = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.backpressure",
      ).length;
      expect(afterWindow).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is silent when no burstLogger is configured", () => {
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2000);
      vi.mocked(debugLog).mockClear();
      // No burstLogger — backpressure path is silent even when triggered.
      const { scheduler } = makeScheduler({
        maxConcurrentFetches: 1,
      });
      scheduler.enqueue([
        req({ chunkKey: "a" }),
        req({ chunkKey: "b" }),
      ]);
      scheduler.drain(() => 0);
      const calls = vi.mocked(debugLog).mock.calls.filter(
        (c) => c[1] === "cache.backpressure",
      );
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// siblingInFlight (proxy <-> chunk shared caps)
// ---------------------------------------------------------------------------

describe("Scheduler.siblingInFlight", () => {
  it("counts sibling in-flight against the concurrency cap", () => {
    const sibling = { count: 2, bytes: 0 };
    const { scheduler, startCalls } = makeScheduler({
      maxConcurrentFetches: 3,
      siblingInFlight: () => sibling,
    });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
    ]);
    scheduler.drain(() => 0);
    // 2 sibling + cap 3 = room for 1; second one stays pending.
    expect(startCalls).toHaveLength(1);
    expect(scheduler.pendingSize).toBe(1);
  });

  it("counts sibling bytes against the bytes cap", () => {
    const sibling = { count: 0, bytes: 100 };
    const { scheduler, startCalls } = makeScheduler({
      maxConcurrentFetches: 10,
      maxBytesInFlight: 200,
      siblingInFlight: () => sibling,
    });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
      req({ chunkKey: "c" }),
    ]);
    scheduler.drain(() => 80);
    // sibling already at 100; cap 200 → room for one 80B start (180 < 200),
    // a second 80B start (260 > 200) is blocked.
    expect(startCalls).toHaveLength(2);
    expect(scheduler.pendingSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

describe("Scheduler.dump", () => {
  it("returns shallow copies of pending + in-flight", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 1 });
    const r1 = req({ chunkKey: "a" });
    const r2 = req({ chunkKey: "b" });
    scheduler.enqueue([r1, r2]);
    scheduler.drain(() => 0);

    const d = scheduler.dump();
    expect(d.inFlight).toHaveLength(1);
    expect(d.inFlight[0].key).toBe(keyOf(r1));
    expect(d.inFlight[0].request.chunkKey).toBe("a");
    expect(d.pending).toHaveLength(1);
    expect(d.pending[0].key).toBe(keyOf(r2));
    expect(d.pending[0].request.chunkKey).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// inFlightEntries iteration (used by snapshot())
// ---------------------------------------------------------------------------

describe("Scheduler.inFlightEntries", () => {
  it("yields [key, entry] pairs for every in-flight request", () => {
    const { scheduler } = makeScheduler({ maxConcurrentFetches: 2 });
    scheduler.enqueue([
      req({ chunkKey: "a" }),
      req({ chunkKey: "b" }),
    ]);
    scheduler.drain(() => 0);

    const collected = new Map<string, InFlightEntry<TestRequest>>();
    for (const [key, entry] of scheduler.inFlightEntries()) {
      collected.set(key, entry);
    }
    expect(collected.size).toBe(2);
    expect(collected.get(keyOf(req({ chunkKey: "a" })))?.request.chunkKey).toBe("a");
    expect(collected.get(keyOf(req({ chunkKey: "b" })))?.request.chunkKey).toBe("b");
  });
});
