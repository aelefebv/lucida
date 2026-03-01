import { describe, expect, it } from "vitest";

import { ProgressiveFrameStore } from "../src/renderer-2d";
import { RequestScheduler } from "../src/request-scheduler";

describe("generation consistency", () => {
  it("never returns mixed-generation frame payloads", () => {
    const store = new ProgressiveFrameStore();
    const gen1Tile = new Uint8ClampedArray([10, 10, 10, 255]);
    const gen2Preview = new Uint8ClampedArray([200, 200, 200, 255]);

    store.setPreview(1, gen1Tile);
    store.setTiles(1, gen1Tile);
    store.setPreview(2, gen2Preview);
    store.pruneOlderThan(2);

    const resolved = store.resolveFrame(2);
    expect(Array.from(resolved ?? [])).toEqual(Array.from(gen2Preview));
    expect(store.resolveFrame(1)).toBeNull();
  });

  it("cancels stale generation fetches before they can resolve", async () => {
    const scheduler = new RequestScheduler(1);
    let staleResolved = false;

    const stale = scheduler.schedule({
      key: "tile:latest",
      generationSeq: 7,
      priority: 1,
      execute: (signal) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            staleResolved = true;
            resolve("gen7");
          }, 50);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    });
    scheduler.invalidateOlderGenerations(8);
    const fresh = scheduler.schedule({
      key: "tile:latest",
      generationSeq: 8,
      priority: 10,
      execute: async () => "gen8",
    });

    await expect(stale).rejects.toThrow();
    await expect(fresh).resolves.toBe("gen8");
    expect(staleResolved).toBe(false);
  });
});
