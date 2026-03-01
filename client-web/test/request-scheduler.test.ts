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
