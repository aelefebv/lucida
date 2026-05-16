/**
 * Unit tests for the {@link LRUPolicy} and {@link TieredPolicy}
 * extracted in Slice 5 (`#599`).
 *
 * Synthetic `CacheEntry` literals only — no cache instance, no fetch
 * mock. The existing `cpuCache.test.ts:eviction tiers` describe block
 * remains as integration coverage for the cache-level wiring; these
 * tests pin the per-policy behavior so future stores (Slice 6) can
 * swap policies without losing the active-detail tiebreaker contract.
 */

import { describe, it, expect } from "vitest";

import {
  LRUPolicy,
  TieredPolicy,
  getTierOrder,
  type EvictableEntry,
} from "./eviction.ts";
import type { CacheEntry, EvictionTier } from "./types.ts";
import type { InteractionMode } from "./interactionMode.ts";
import type { SceneEpochs } from "../epochs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_EPOCHS: SceneEpochs = {
  content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0,
};

function makeEntry(overrides: Partial<CacheEntry> & {
  insertedAt: number;
  sizeBytes: number;
  tier: EvictionTier;
}): CacheEntry {
  return {
    data: new ArrayBuffer(0),
    lane: "detail",
    entityId: "e-1",
    imageId: "img-1",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: `key-${overrides.insertedAt}`,
    epochs: ZERO_EPOCHS,
    dataType: "u8",
    priority: 0,
    lastSeenTick: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LRUPolicy
// ---------------------------------------------------------------------------

describe("LRUPolicy", () => {
  it("returns empty when bytesNeeded is zero or negative", () => {
    const policy = new LRUPolicy();
    const entries = [
      makeEntry({ insertedAt: 0, sizeBytes: 100, tier: "active-detail" }),
      makeEntry({ insertedAt: 1, sizeBytes: 100, tier: "active-detail" }),
    ];
    expect(policy.selectVictims(entries, 0)).toEqual([]);
    expect(policy.selectVictims(entries, -10)).toEqual([]);
  });

  it("returns empty when entries is empty", () => {
    const policy = new LRUPolicy();
    expect(policy.selectVictims([], 100)).toEqual([]);
  });

  it("picks oldest insertedAt first", () => {
    const policy = new LRUPolicy();
    const e0 = makeEntry({ insertedAt: 0, sizeBytes: 50, tier: "active-detail", chunkKey: "a" });
    const e1 = makeEntry({ insertedAt: 1, sizeBytes: 50, tier: "active-detail", chunkKey: "b" });
    const e2 = makeEntry({ insertedAt: 2, sizeBytes: 50, tier: "active-detail", chunkKey: "c" });
    // Pass in shuffled order to confirm the policy sorts.
    const victims = policy.selectVictims([e2, e0, e1], 75);
    expect(victims.map(v => v.chunkKey)).toEqual(["a", "b"]);
  });

  it("stops as soon as freed >= bytesNeeded", () => {
    const policy = new LRUPolicy();
    const entries = [
      makeEntry({ insertedAt: 0, sizeBytes: 100, tier: "active-detail", chunkKey: "a" }),
      makeEntry({ insertedAt: 1, sizeBytes: 100, tier: "active-detail", chunkKey: "b" }),
      makeEntry({ insertedAt: 2, sizeBytes: 100, tier: "active-detail", chunkKey: "c" }),
    ];
    expect(policy.selectVictims(entries, 100).map(v => v.chunkKey)).toEqual(["a"]);
    expect(policy.selectVictims(entries, 101).map(v => v.chunkKey)).toEqual(["a", "b"]);
    expect(policy.selectVictims(entries, 250).map(v => v.chunkKey)).toEqual(["a", "b", "c"]);
  });

  it("works with the generic EvictableEntry shape (proxy adapter)", () => {
    interface ProxyShim extends EvictableEntry {
      key: string;
    }
    const policy = new LRUPolicy<ProxyShim>();
    const entries: ProxyShim[] = [
      { insertedAt: 2, sizeBytes: 50, key: "c" },
      { insertedAt: 0, sizeBytes: 50, key: "a" },
      { insertedAt: 1, sizeBytes: 50, key: "b" },
    ];
    const victims = policy.selectVictims(entries, 75);
    expect(victims.map(v => v.key)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const policy = new LRUPolicy();
    const entries = [
      makeEntry({ insertedAt: 2, sizeBytes: 50, tier: "active-detail", chunkKey: "c" }),
      makeEntry({ insertedAt: 0, sizeBytes: 50, tier: "active-detail", chunkKey: "a" }),
    ];
    const order = entries.map(e => e.chunkKey);
    policy.selectVictims(entries, 100);
    expect(entries.map(e => e.chunkKey)).toEqual(order);
  });
});

// ---------------------------------------------------------------------------
// getTierOrder
// ---------------------------------------------------------------------------

describe("getTierOrder", () => {
  it("panning walks prefetch → demoted → active", () => {
    expect(getTierOrder("panning")).toEqual([
      "prefetch", "demoted-detail", "active-detail",
    ]);
  });

  it("scrubbing protects prefetch (walks demoted → active → prefetch)", () => {
    expect(getTierOrder("scrubbing")).toEqual([
      "demoted-detail", "active-detail", "prefetch",
    ]);
  });

  it("idle matches panning (default order)", () => {
    expect(getTierOrder("idle")).toEqual([
      "prefetch", "demoted-detail", "active-detail",
    ]);
  });
});

// ---------------------------------------------------------------------------
// TieredPolicy
// ---------------------------------------------------------------------------

describe("TieredPolicy", () => {
  function makePolicy(mode: InteractionMode): TieredPolicy {
    return new TieredPolicy(() => mode);
  }

  it("returns empty when bytesNeeded is zero", () => {
    const policy = makePolicy("idle");
    expect(policy.selectVictims([
      makeEntry({ insertedAt: 0, sizeBytes: 100, tier: "prefetch" }),
    ], 0)).toEqual([]);
  });

  it("walks tiers in the panning order (prefetch first)", () => {
    const policy = makePolicy("panning");
    const prefetch = makeEntry({
      insertedAt: 5, sizeBytes: 50, tier: "prefetch", chunkKey: "p",
    });
    const demoted = makeEntry({
      insertedAt: 0, sizeBytes: 50, tier: "demoted-detail", chunkKey: "d",
    });
    const active = makeEntry({
      insertedAt: 1, sizeBytes: 50, tier: "active-detail", chunkKey: "a",
    });
    // Need 50 bytes — should evict prefetch (highest-priority tier), not
    // the demoted entry even though it's older by insertedAt.
    const victims = policy.selectVictims([prefetch, demoted, active], 50);
    expect(victims.map(v => v.chunkKey)).toEqual(["p"]);
  });

  it("walks tiers in the scrubbing order (demoted first, prefetch last)", () => {
    const policy = makePolicy("scrubbing");
    const prefetch = makeEntry({
      insertedAt: 0, sizeBytes: 50, tier: "prefetch", chunkKey: "p",
    });
    const demoted = makeEntry({
      insertedAt: 5, sizeBytes: 50, tier: "demoted-detail", chunkKey: "d",
    });
    // Need 50 bytes — demoted goes first in scrubbing order even though
    // the prefetch entry has the older insertedAt.
    const victims = policy.selectVictims([prefetch, demoted], 50);
    expect(victims.map(v => v.chunkKey)).toEqual(["d"]);
  });

  it("idle order matches panning order", () => {
    const policy = makePolicy("idle");
    const prefetch = makeEntry({
      insertedAt: 5, sizeBytes: 50, tier: "prefetch", chunkKey: "p",
    });
    const demoted = makeEntry({
      insertedAt: 0, sizeBytes: 50, tier: "demoted-detail", chunkKey: "d",
    });
    const victims = policy.selectVictims([prefetch, demoted], 50);
    expect(victims.map(v => v.chunkKey)).toEqual(["p"]);
  });

  it("falls through to the next tier when the current one is exhausted", () => {
    const policy = makePolicy("panning");
    const prefetch = makeEntry({
      insertedAt: 0, sizeBytes: 50, tier: "prefetch", chunkKey: "p",
    });
    const demoted = makeEntry({
      insertedAt: 1, sizeBytes: 50, tier: "demoted-detail", chunkKey: "d",
    });
    const active = makeEntry({
      insertedAt: 2, sizeBytes: 50, tier: "active-detail", chunkKey: "a",
    });
    // Need 120 bytes — should evict prefetch + demoted + active in order.
    const victims = policy.selectVictims([prefetch, demoted, active], 120);
    expect(victims.map(v => v.chunkKey)).toEqual(["p", "d", "a"]);
  });

  it("stops as soon as freed >= bytesNeeded", () => {
    const policy = makePolicy("panning");
    const entries = [
      makeEntry({ insertedAt: 0, sizeBytes: 50, tier: "prefetch", chunkKey: "p1" }),
      makeEntry({ insertedAt: 1, sizeBytes: 50, tier: "prefetch", chunkKey: "p2" }),
      makeEntry({ insertedAt: 2, sizeBytes: 50, tier: "demoted-detail", chunkKey: "d" }),
    ];
    expect(policy.selectVictims(entries, 1).map(v => v.chunkKey)).toEqual(["p1"]);
    expect(policy.selectVictims(entries, 60).map(v => v.chunkKey)).toEqual(["p1", "p2"]);
  });

  it("non-active tiers use pure insertion-order LRU", () => {
    const policy = makePolicy("panning");
    // Two prefetch entries; the older insertedAt goes first.
    const newer = makeEntry({
      insertedAt: 10, sizeBytes: 50, tier: "prefetch", chunkKey: "newer",
    });
    const older = makeEntry({
      insertedAt: 1, sizeBytes: 50, tier: "prefetch", chunkKey: "older",
    });
    const victims = policy.selectVictims([newer, older], 50);
    expect(victims.map(v => v.chunkKey)).toEqual(["older"]);
  });

  describe("active-detail tiebreaker (lastSeenTick ↑, priority ↓, insertedAt ↑)", () => {
    // Scrubbing puts active-detail second; with no prefetch entries to
    // exhaust first this isolates the active-tier sort logic. Use
    // scrubbing so the tier reaches active-detail without skipping it.
    function activeOnly(mode: InteractionMode = "scrubbing") {
      return makePolicy(mode);
    }

    it("oldest lastSeenTick goes first (key #1)", () => {
      const policy = activeOnly();
      const recent = makeEntry({
        insertedAt: 0, sizeBytes: 50, tier: "active-detail",
        chunkKey: "recent", lastSeenTick: 10, priority: 0,
      });
      const stale = makeEntry({
        insertedAt: 5, sizeBytes: 50, tier: "active-detail",
        chunkKey: "stale", lastSeenTick: 1, priority: 0,
      });
      const victims = policy.selectVictims([recent, stale], 50);
      expect(victims.map(v => v.chunkKey)).toEqual(["stale"]);
    });

    it("on lastSeenTick tie, highest priority NUMBER goes first (key #2)", () => {
      // priority descending = farthest-from-focal (highest number) first.
      const policy = activeOnly();
      const focal = makeEntry({
        insertedAt: 0, sizeBytes: 50, tier: "active-detail",
        chunkKey: "focal", lastSeenTick: 5, priority: 0,
      });
      const distant = makeEntry({
        insertedAt: 5, sizeBytes: 50, tier: "active-detail",
        chunkKey: "distant", lastSeenTick: 5, priority: 100,
      });
      const victims = policy.selectVictims([focal, distant], 50);
      expect(victims.map(v => v.chunkKey)).toEqual(["distant"]);
    });

    it("on (lastSeenTick, priority) tie, oldest insertedAt goes first (key #3)", () => {
      const policy = activeOnly();
      const newer = makeEntry({
        insertedAt: 99, sizeBytes: 50, tier: "active-detail",
        chunkKey: "newer", lastSeenTick: 5, priority: 7,
      });
      const older = makeEntry({
        insertedAt: 1, sizeBytes: 50, tier: "active-detail",
        chunkKey: "older", lastSeenTick: 5, priority: 7,
      });
      const victims = policy.selectVictims([newer, older], 50);
      expect(victims.map(v => v.chunkKey)).toEqual(["older"]);
    });

    it("full ordering: stale + distant + focal + freshly-planned", () => {
      const policy = activeOnly();
      // Four active-detail entries crafted to exercise all three keys.
      const focalFresh = makeEntry({
        insertedAt: 0, sizeBytes: 10, tier: "active-detail",
        chunkKey: "focalFresh", lastSeenTick: 10, priority: 0,
      });
      const distantFresh = makeEntry({
        insertedAt: 1, sizeBytes: 10, tier: "active-detail",
        chunkKey: "distantFresh", lastSeenTick: 10, priority: 50,
      });
      const focalStale = makeEntry({
        insertedAt: 2, sizeBytes: 10, tier: "active-detail",
        chunkKey: "focalStale", lastSeenTick: 1, priority: 0,
      });
      const focalStaleOld = makeEntry({
        insertedAt: 0, sizeBytes: 10, tier: "active-detail",
        chunkKey: "focalStaleOld", lastSeenTick: 1, priority: 0,
      });
      // Need all 40 bytes; expected eviction order:
      //   focalStaleOld (lastSeenTick 1, prio 0, insertedAt 0)
      //   focalStale    (lastSeenTick 1, prio 0, insertedAt 2)
      //   distantFresh  (lastSeenTick 10, prio 50)
      //   focalFresh    (lastSeenTick 10, prio 0)
      const victims = policy.selectVictims(
        [focalFresh, distantFresh, focalStale, focalStaleOld],
        40,
      );
      expect(victims.map(v => v.chunkKey)).toEqual([
        "focalStaleOld",
        "focalStale",
        "distantFresh",
        "focalFresh",
      ]);
    });
  });

  it("reads the live interaction mode each call (modeProvider thunk)", () => {
    // Pre-Slice-5 the cache called this.interactionDetector.current()
    // on each eviction; the policy must do the same so a mode change
    // between two eviction passes is observed.
    let mode: InteractionMode = "panning";
    const policy = new TieredPolicy(() => mode);
    const prefetch = makeEntry({
      insertedAt: 0, sizeBytes: 50, tier: "prefetch", chunkKey: "p",
    });
    const demoted = makeEntry({
      insertedAt: 5, sizeBytes: 50, tier: "demoted-detail", chunkKey: "d",
    });
    // Panning → prefetch first.
    expect(
      policy.selectVictims([prefetch, demoted], 50).map(v => v.chunkKey),
    ).toEqual(["p"]);
    // Flip mode; same input → demoted first under scrubbing order.
    mode = "scrubbing";
    expect(
      policy.selectVictims([prefetch, demoted], 50).map(v => v.chunkKey),
    ).toEqual(["d"]);
  });
});
