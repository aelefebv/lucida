import { describe, expect, it } from "vitest";

import { LruGenerationCache, RequestScheduler } from "../src/request-scheduler";

function delayedValue(
  value: string,
  delayMs: number,
): (signal: AbortSignal) => Promise<string> {
  return (signal) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
}

describe("request scheduler", () => {
  it("cancels stale in-flight requests after generation invalidation", async () => {
    const scheduler = new RequestScheduler(1);

    const stale = scheduler
      .schedule({
        key: "tile:0:0",
        generationSeq: 1,
        priority: 1,
        execute: delayedValue("stale", 40),
      })
      .catch((error: unknown) => (error as Error).message);

    scheduler.invalidateOlderGenerations(2);

    const fresh = scheduler.schedule({
      key: "tile:0:0",
      generationSeq: 2,
      priority: 10,
      execute: delayedValue("fresh", 1),
    });

    await expect(stale).resolves.toMatch(/aborted|invalidated/);
    await expect(fresh).resolves.toBe("fresh");
  });

  it("supports explicit cancellation by key", async () => {
    const scheduler = new RequestScheduler(1);
    const pending = scheduler
      .schedule({
        key: "tile:1:1",
        generationSeq: 4,
        priority: 1,
        execute: delayedValue("value", 30),
      })
      .catch((error: unknown) => (error as Error).message);

    scheduler.cancel("tile:1:1");

    await expect(pending).resolves.toMatch(/cancelled|aborted/);
  });

  it("prioritizes visible-center ahead of ring requests with deterministic tie ordering", async () => {
    const scheduler = new RequestScheduler(1);
    const order: string[] = [];

    const blocker = scheduler.schedule({
      key: "blocker",
      generationSeq: 1,
      priorityClass: "coarse_fallback",
      execute: delayedValue("blocker", 25),
    }).then((value) => {
      order.push(value);
      return value;
    });

    const ringA = scheduler.schedule({
      key: "ring-a",
      generationSeq: 1,
      priorityClass: "visible_ring",
      execute: delayedValue("ring-a", 1),
    }).then((value) => {
      order.push(value);
      return value;
    });

    const center = scheduler.schedule({
      key: "center",
      generationSeq: 1,
      priorityClass: "visible_center",
      execute: delayedValue("center", 1),
    }).then((value) => {
      order.push(value);
      return value;
    });

    const ringB = scheduler.schedule({
      key: "ring-b",
      generationSeq: 1,
      priorityClass: "visible_ring",
      execute: delayedValue("ring-b", 1),
    }).then((value) => {
      order.push(value);
      return value;
    });

    await expect(Promise.all([blocker, ringA, center, ringB])).resolves.toEqual([
      "blocker",
      "ring-a",
      "center",
      "ring-b",
    ]);
    expect(order).toEqual(["blocker", "center", "ring-a", "ring-b"]);
  });

  it("drops lowest-priority queued work when queue pressure exceeds limits", async () => {
    const scheduler = new RequestScheduler(1, 2);

    const blocker = scheduler.schedule({
      key: "blocker",
      generationSeq: 1,
      priority: 100,
      execute: delayedValue("blocker", 30),
    });

    const high = scheduler.schedule({
      key: "high",
      generationSeq: 1,
      priority: 90,
      execute: delayedValue("high", 1),
    });
    const medium = scheduler.schedule({
      key: "medium",
      generationSeq: 1,
      priority: 80,
      execute: delayedValue("medium", 1),
    });
    const low = scheduler
      .schedule({
        key: "low",
        generationSeq: 1,
        priority: 10,
        execute: delayedValue("low", 1),
      })
      .catch((error: unknown) => (error as Error).message);

    await expect(blocker).resolves.toBe("blocker");
    await expect(high).resolves.toBe("high");
    await expect(medium).resolves.toBe("medium");
    await expect(low).resolves.toMatch(/queue pressure/);
  });
});

describe("lru generation cache", () => {
  it("evicts oldest entries when max size is exceeded", () => {
    const cache = new LruGenerationCache<string>(2);
    cache.set("a", "A", 1);
    cache.set("b", "B", 1);
    cache.set("c", "C", 1);

    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.value).toBe("B");
    expect(cache.get("c")?.value).toBe("C");
  });

  it("invalidates older generations", () => {
    const cache = new LruGenerationCache<string>(4);
    cache.set("g1", "old", 1);
    cache.set("g2", "new", 2);
    cache.invalidateOlderGenerations(2);

    expect(cache.get("g1")).toBeUndefined();
    expect(cache.get("g2")?.value).toBe("new");
  });
});
