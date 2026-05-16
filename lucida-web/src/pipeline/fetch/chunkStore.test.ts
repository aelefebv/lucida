/**
 * Unit tests for {@link ChunkStore}.
 *
 * Synthetic `CacheEntry` literals only — no cache instance, no fetch
 * mock. `cpuCache.test.ts` integration tests cover the store's
 * interaction with the rest of the cache; these tests pin the store's
 * own contract in isolation.
 *
 * Both store flavours (main = TieredPolicy, overview = LRUPolicy) are
 * exercised through the same {@link ChunkStore} class — the policy and
 * eviction-tier-label are injected via constructor options.
 */

import { describe, it, expect, vi } from "vitest";

import { ChunkStore } from "./chunkStore.ts";
import { LRUPolicy, TieredPolicy } from "./eviction.ts";
import type { CacheEntry, EvictionTier } from "./types.ts";
import type { EvictionRecordTier } from "./telemetry.ts";
import type { SceneEpochs } from "../epochs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_EPOCHS: SceneEpochs = {
  content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0,
};

let nextInsertedAt = 0;

function makeEntry(overrides: Partial<CacheEntry> & {
  sizeBytes: number;
  entityId?: string;
  chunkKey?: string;
  tier?: EvictionTier;
}): CacheEntry {
  const insertedAt = overrides.insertedAt ?? nextInsertedAt++;
  const base: CacheEntry = {
    data: new ArrayBuffer(0),
    sizeBytes: 0,
    lane: "detail",
    tier: "active-detail",
    entityId: "e-1",
    imageId: "img-1",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: `key-${insertedAt}`,
    insertedAt,
    epochs: ZERO_EPOCHS,
    dataType: "u8",
    priority: 0,
    lastSeenTick: 0,
  };
  return { ...base, ...overrides };
}

/**
 * Build a main-flavoured store backed by {@link TieredPolicy}, with an
 * `entry.tier`-driven eviction label so victim accounting is faithful
 * to the real cache wiring.
 */
function makeMainStore(opts?: {
  budgetBytes?: number;
  onEvictionBurst?: (info: {
    removed: number;
    bytesFreed: number;
    bytesNeeded: number;
  }) => void;
}) {
  const evictionLog: EvictionRecordTier[] = [];
  const store = new ChunkStore({
    policy: new TieredPolicy(() => "idle"),
    budgetBytes: opts?.budgetBytes ?? Infinity,
    evictionTier: (entry) => entry.tier,
    recordEviction: (tier) => { evictionLog.push(tier); },
    onEvictionBurst: opts?.onEvictionBurst,
  });
  return { store, evictionLog };
}

/**
 * Build an overview-flavoured store backed by {@link LRUPolicy}, with
 * a hardcoded "overview" eviction label.
 */
function makeOverviewStore(opts?: { budgetBytes?: number }) {
  const evictionLog: EvictionRecordTier[] = [];
  const store = new ChunkStore({
    policy: new LRUPolicy<CacheEntry>(),
    budgetBytes: opts?.budgetBytes ?? Infinity,
    evictionTier: () => "overview",
    recordEviction: (tier) => { evictionLog.push(tier); },
  });
  return { store, evictionLog };
}

// ---------------------------------------------------------------------------
// Basic API
// ---------------------------------------------------------------------------

describe("ChunkStore basics", () => {
  it("insert + get round-trip returns the live entry", () => {
    const { store } = makeMainStore();
    const entry = makeEntry({ sizeBytes: 100, chunkKey: "k-1" });
    store.insert(entry);
    expect(store.get("e-1", "k-1")).toBe(entry);
    expect(store.bytes).toBe(100);
  });

  it("get returns undefined for missing entries", () => {
    const { store } = makeMainStore();
    expect(store.get("e-x", "k-x")).toBeUndefined();
  });

  it("remove drops the entry and decrements bytes", () => {
    const { store, evictionLog } = makeMainStore();
    const entry = makeEntry({ sizeBytes: 100, chunkKey: "k-1", tier: "prefetch" });
    store.insert(entry);
    expect(store.remove("e-1", "k-1")).toBe(true);
    expect(store.get("e-1", "k-1")).toBeUndefined();
    expect(store.bytes).toBe(0);
    // remove() emits an eviction record using the configured label fn.
    expect(evictionLog).toEqual(["prefetch"]);
  });

  it("remove returns false for missing entries", () => {
    const { store } = makeMainStore();
    expect(store.remove("e-x", "k-x")).toBe(false);
  });

  it("removeEntry drops the entry by reference and decrements bytes", () => {
    const { store, evictionLog } = makeMainStore();
    const entry = makeEntry({ sizeBytes: 50, tier: "active-detail" });
    store.insert(entry);
    store.removeEntry(entry);
    expect(store.bytes).toBe(0);
    expect(evictionLog).toEqual(["active-detail"]);
  });

  it("hasEntity reflects insert / remove", () => {
    const { store } = makeMainStore();
    expect(store.hasEntity("e-1")).toBe(false);
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "k-1" }));
    expect(store.hasEntity("e-1")).toBe(true);
    store.remove("e-1", "k-1");
    expect(store.hasEntity("e-1")).toBe(false);
  });

  it("multiple entries per entity are kept and iterable", () => {
    const { store } = makeMainStore();
    const a = makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "a" });
    const b = makeEntry({ sizeBytes: 20, entityId: "e-1", chunkKey: "b" });
    store.insert(a);
    store.insert(b);
    expect(store.bytes).toBe(30);
    const keys = Array.from(store.chunkKeysForEntity("e-1"));
    expect(new Set(keys)).toEqual(new Set(["a", "b"]));
    const entries = Array.from(store.entriesForEntity("e-1"));
    expect(entries).toHaveLength(2);
  });

  it("allEntries iterates every cached entry across entities", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-2", chunkKey: "b" }));
    const all = Array.from(store.allEntries()).map(e => e.chunkKey);
    expect(new Set(all)).toEqual(new Set(["a", "b"]));
  });
});

// ---------------------------------------------------------------------------
// cancelDataset
// ---------------------------------------------------------------------------

describe("ChunkStore.cancelDataset", () => {
  it("removes every entry for the given entityIds and zeros their bytes", () => {
    const { store, evictionLog } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 100, entityId: "e-1", chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 100, entityId: "e-1", chunkKey: "b" }));
    store.insert(makeEntry({ sizeBytes: 50, entityId: "e-2", chunkKey: "c" }));
    expect(store.bytes).toBe(250);

    store.cancelDataset(["e-1"]);

    expect(store.bytes).toBe(50);
    expect(store.hasEntity("e-1")).toBe(false);
    expect(store.hasEntity("e-2")).toBe(true);
    // cancelDataset is a dataset removal, not a policy decision — no
    // eviction records.
    expect(evictionLog).toEqual([]);
  });

  it("is a no-op for unknown entityIds", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "a" }));
    store.cancelDataset(["unknown"]);
    expect(store.bytes).toBe(10);
    expect(store.hasEntity("e-1")).toBe(true);
  });

  it("handles multiple entityIds in one call", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 20, entityId: "e-2", chunkKey: "b" }));
    store.insert(makeEntry({ sizeBytes: 30, entityId: "e-3", chunkKey: "c" }));
    store.cancelDataset(["e-1", "e-3"]);
    expect(store.bytes).toBe(20);
    expect(store.hasEntity("e-2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("ChunkStore.reset", () => {
  it("clears all entries and zeros bytes", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 100, entityId: "e-1", chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 100, entityId: "e-2", chunkKey: "b" }));
    expect(store.bytes).toBe(200);

    store.reset();

    expect(store.bytes).toBe(0);
    expect(store.hasEntity("e-1")).toBe(false);
    expect(store.hasEntity("e-2")).toBe(false);
    expect(Array.from(store.allEntries())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

describe("ChunkStore eviction via policy", () => {
  it("over-budget insert triggers policy and removes victims", () => {
    const { store, evictionLog } = makeOverviewStore({ budgetBytes: 200 });
    // Pre-fill to 200 bytes.
    store.insert(makeEntry({ sizeBytes: 100, chunkKey: "a", insertedAt: 0 }));
    store.insert(makeEntry({ sizeBytes: 100, chunkKey: "b", insertedAt: 1 }));
    expect(store.bytes).toBe(200);

    // Insert one that pushes us over; LRU should evict the oldest.
    store.insert(makeEntry({ sizeBytes: 50, chunkKey: "c", insertedAt: 2 }));

    expect(store.bytes).toBeLessThanOrEqual(200);
    expect(store.get("e-1", "a")).toBeUndefined();
    expect(store.get("e-1", "b")).toBeDefined();
    expect(store.get("e-1", "c")).toBeDefined();
    // Eviction label was the configured one.
    expect(evictionLog).toEqual(["overview"]);
  });

  it("under-budget insert is a no-op for the policy", () => {
    const { store, evictionLog } = makeOverviewStore({ budgetBytes: 200 });
    store.insert(makeEntry({ sizeBytes: 50, chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 50, chunkKey: "b" }));
    expect(store.bytes).toBe(100);
    expect(evictionLog).toEqual([]);
  });

  it("main store uses entry.tier for the eviction record label", () => {
    // Tight budget so a single insert evicts.
    const { store, evictionLog } = makeMainStore({ budgetBytes: 100 });
    store.insert(makeEntry({
      sizeBytes: 100, chunkKey: "prefetch", tier: "prefetch", insertedAt: 0,
    }));
    // Force eviction — the prefetch entry should drop first under the
    // TieredPolicy idle order (prefetch first).
    store.insert(makeEntry({
      sizeBytes: 50, chunkKey: "active", tier: "active-detail", insertedAt: 1,
    }));
    expect(store.get("e-1", "prefetch")).toBeUndefined();
    expect(evictionLog).toEqual(["prefetch"]);
  });

  it("onEvictionBurst fires when >= 16 victims removed in one pass", () => {
    const onEvictionBurst = vi.fn();
    const { store } = makeMainStore({
      budgetBytes: 16,
      onEvictionBurst,
    });
    // Pre-fill with 16 × 1B prefetch entries (idle tier-order evicts
    // prefetch first, so they're chosen as victims). Increasing
    // insertedAt to break LRU ties deterministically.
    for (let i = 0; i < 16; i++) {
      store.insert(makeEntry({
        sizeBytes: 1, chunkKey: `p-${i}`, tier: "prefetch", insertedAt: i,
      }));
    }
    expect(store.bytes).toBe(16);
    expect(onEvictionBurst).not.toHaveBeenCalled();

    // One big insert forces evicting all 16.
    store.insert(makeEntry({
      sizeBytes: 16, chunkKey: "big", tier: "active-detail", insertedAt: 100,
    }));
    expect(onEvictionBurst).toHaveBeenCalledTimes(1);
    expect(onEvictionBurst).toHaveBeenCalledWith(
      expect.objectContaining({ removed: expect.any(Number) }),
    );
    const call = onEvictionBurst.mock.calls[0][0];
    expect(call.removed).toBeGreaterThanOrEqual(16);
  });

  it("onEvictionBurst is not fired when fewer than threshold victims", () => {
    const onEvictionBurst = vi.fn();
    const { store } = makeMainStore({
      budgetBytes: 100,
      onEvictionBurst,
    });
    store.insert(makeEntry({
      sizeBytes: 100, chunkKey: "a", tier: "prefetch", insertedAt: 0,
    }));
    // Insert one that evicts exactly one victim.
    store.insert(makeEntry({
      sizeBytes: 100, chunkKey: "b", tier: "prefetch", insertedAt: 1,
    }));
    expect(onEvictionBurst).not.toHaveBeenCalled();
  });

  it("overview store leaves onEvictionBurst unset — no fire path", () => {
    // Construct without onEvictionBurst; even a huge eviction is silent.
    const { store } = makeOverviewStore({ budgetBytes: 16 });
    for (let i = 0; i < 16; i++) {
      store.insert(makeEntry({
        sizeBytes: 1, chunkKey: `o-${i}`, insertedAt: i,
      }));
    }
    // No callback to verify — the absence of an error here is the
    // contract. Sanity check: bytes drop to within budget after the
    // big insert.
    store.insert(makeEntry({
      sizeBytes: 16, chunkKey: "big", insertedAt: 100,
    }));
    expect(store.bytes).toBeLessThanOrEqual(16);
  });
});

// ---------------------------------------------------------------------------
// Telemetry shapes
// ---------------------------------------------------------------------------

describe("ChunkStore residency reporting", () => {
  it("tierResidency bins entries by entry.tier", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 10, chunkKey: "a", tier: "active-detail" }));
    store.insert(makeEntry({ sizeBytes: 20, chunkKey: "b", tier: "active-detail" }));
    store.insert(makeEntry({ sizeBytes: 30, chunkKey: "c", tier: "demoted-detail" }));
    store.insert(makeEntry({ sizeBytes: 40, chunkKey: "d", tier: "prefetch" }));

    const tiers = store.tierResidency();
    expect(tiers.activeDetail).toEqual({ count: 2, bytes: 30 });
    expect(tiers.demotedDetail).toEqual({ count: 1, bytes: 30 });
    expect(tiers.prefetch).toEqual({ count: 1, bytes: 40 });
  });

  it("totalResidency sums every entry", () => {
    const { store } = makeOverviewStore();
    store.insert(makeEntry({ sizeBytes: 50, chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 50, chunkKey: "b" }));
    expect(store.totalResidency()).toEqual({ count: 2, bytes: 100 });
  });

  it("dump returns one entry per cached chunk with the expected shape", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({
      sizeBytes: 64, entityId: "e-1", chunkKey: "k-1",
      level: 2, tier: "active-detail", insertedAt: 5,
    }));
    const dump = store.dump();
    expect(dump).toHaveLength(1);
    expect(dump[0]).toEqual({
      entityId: "e-1",
      level: 2,
      tier: "active-detail",
      bytes: 64,
      chunkKey: "k-1",
      insertedAt: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Demotion
// ---------------------------------------------------------------------------

describe("ChunkStore.demoteEntity", () => {
  it("moves every active-detail entry for an entity to demoted-detail", () => {
    const { store } = makeMainStore();
    const a = makeEntry({
      sizeBytes: 10, entityId: "e-1", chunkKey: "a", tier: "active-detail",
    });
    const b = makeEntry({
      sizeBytes: 10, entityId: "e-1", chunkKey: "b", tier: "active-detail",
    });
    const c = makeEntry({
      sizeBytes: 10, entityId: "e-1", chunkKey: "c", tier: "prefetch",
    });
    store.insert(a);
    store.insert(b);
    store.insert(c);

    store.demoteEntity("e-1");

    expect(store.get("e-1", "a")?.tier).toBe("demoted-detail");
    expect(store.get("e-1", "b")?.tier).toBe("demoted-detail");
    // Prefetch entries don't change tier on demotion.
    expect(store.get("e-1", "c")?.tier).toBe("prefetch");
  });

  it("is a no-op for unknown entities", () => {
    const { store } = makeMainStore();
    // Should not throw.
    expect(() => store.demoteEntity("unknown")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Snapshot integration helper
// ---------------------------------------------------------------------------

describe("ChunkStore.entityChunkKeys", () => {
  it("yields [entityId, chunkKeys] pairs for snapshot composition", () => {
    const { store } = makeMainStore();
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "a" }));
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-1", chunkKey: "b" }));
    store.insert(makeEntry({ sizeBytes: 10, entityId: "e-2", chunkKey: "c" }));

    const collected = new Map<string, Set<string>>();
    for (const [entityId, keys] of store.entityChunkKeys()) {
      collected.set(entityId, new Set(keys));
    }
    expect(collected.get("e-1")).toEqual(new Set(["a", "b"]));
    expect(collected.get("e-2")).toEqual(new Set(["c"]));
  });
});
