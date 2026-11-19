import { describe, expect, it } from "vitest";

import { ChunkStore } from "./chunkStore.ts";
import { TieredPolicy, type EvictionPolicy } from "./eviction.ts";
import type { InteractionMode } from "./interactionMode.ts";
import type { CacheEntry, EvictionTier } from "./types.ts";

const TIERS: EvictionTier[] = ["active-detail", "demoted-detail", "prefetch"];
const MODES: InteractionMode[] = ["idle", "panning", "scrubbing"];

function makeEntry(fields: Partial<CacheEntry> & { insertedAt: number }): CacheEntry {
  return {
    data: new ArrayBuffer(0),
    sizeBytes: 100,
    lane: "detail",
    residencyTier: "detail",
    tier: "active-detail",
    entityId: "e-0",
    imageId: "img-0",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: `k-${fields.insertedAt}`,
    epochs: { content: 0, layout: 0, view: 0, selection: 0, request: 0 },
    dataType: "u16",
    priority: 0,
    lastSeenTick: 0,
    ...fields,
  };
}

/** A policy that counts how often the store asks it for a fresh order. */
function counting(policy: EvictionPolicy): { policy: EvictionPolicy; sorts: () => number } {
  let sorts = 0;
  return {
    policy: {
      comparator: () => {
        sorts++;
        return policy.comparator();
      },
      stamp: () => policy.stamp(),
      selectVictims: (entries, bytes) => policy.selectVictims(entries, bytes),
    },
    sorts: () => sorts,
  };
}

describe("a full store's eviction order", () => {
  it("takes what sorting every entry for each insert would take, over a run of changes", () => {
    let tick = 1;
    let mode: InteractionMode = "idle";
    const targets = new Map<string, number>();
    const policy = new TieredPolicy(() => mode, (entityId) => targets.get(entityId), () => tick);
    const protects = (resident: CacheEntry, incoming: CacheEntry) =>
      resident.lastSeenTick === tick && resident.priority < incoming.priority;
    const evicted: CacheEntry[] = [];
    const store = new ChunkStore({
      policy,
      budgetBytes: 40 * 100,
      evictionTier: (entry) => entry.tier,
      recordEviction: (_tier, entry) => evicted.push(entry),
      protects,
    });
    // A fixed pseudo-random sequence, so a failure replays.
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n;
    };
    let insertedAt = 0;
    const live = () => [...store.allEntries()];

    for (let step = 0; step < 3000; step++) {
      switch (next(10)) {
        case 0: {
          // A plan refreshes some entries in place, as `submit` does.
          for (const entry of live()) {
            if (next(3) !== 0) continue;
            entry.lastSeenTick = tick;
            entry.priority = next(50);
            entry.tier = TIERS[next(3)];
          }
          store.invalidateOrder();
          break;
        }
        case 1:
          tick++;
          break;
        case 2:
          mode = MODES[next(3)];
          break;
        case 3:
          targets.set(`e-${next(3)}`, next(3));
          store.invalidateOrder();
          break;
        case 4: {
          const entries = live();
          if (entries.length > 0) store.remove(entries[next(entries.length)].entityId, entries[next(entries.length)].chunkKey);
          break;
        }
        case 5:
          store.demoteEntity(`e-${next(3)}`);
          break;
        default: {
          const entityId = `e-${next(3)}`;
          const entry = makeEntry({
            insertedAt: insertedAt++,
            entityId,
            // Some arrivals replace the entry their chunk already has.
            chunkKey: `k-${next(80)}`,
            sizeBytes: 100 * (1 + next(2)),
            level: next(3),
            tier: TIERS[next(3)],
            priority: next(50),
            lastSeenTick: tick - next(2),
          });
          const replaced = store.get(entityId, entry.chunkKey);
          const needed = store.bytes + entry.sizeBytes - (replaced?.sizeBytes ?? 0) - store.budgetBytes;
          const candidates = live().filter((resident) => resident !== replaced && !protects(resident, entry));
          const available = candidates.reduce((sum, resident) => sum + resident.sizeBytes, 0);
          const expected = needed <= 0 ? [] : available < needed ? null : policy.selectVictims(candidates, needed);

          evicted.length = 0;
          const inserted = store.insert(entry);
          expect(inserted).toBe(expected !== null);
          expect(evicted.map((e) => e.chunkKey + "@" + e.entityId)).toEqual(
            (expected ?? []).map((e) => e.chunkKey + "@" + e.entityId),
          );
        }
      }
    }
  });

  it("sorts once for a run of inserts into a full store, not once per insert", () => {
    const { policy, sorts } = counting(new TieredPolicy(() => "idle", () => undefined, () => 1));
    const store = new ChunkStore({
      policy,
      budgetBytes: 1000 * 100,
      evictionTier: (entry) => entry.tier,
      recordEviction: () => {},
    });
    for (let i = 0; i < 1000; i++) store.insert(makeEntry({ insertedAt: i, priority: i % 7 }));
    expect(sorts()).toBe(0);

    for (let i = 1000; i < 1050; i++) store.insert(makeEntry({ insertedAt: i, priority: i % 7 }));

    expect(sorts()).toBe(1);
    expect([...store.allEntries()]).toHaveLength(1000);
    // A plan changing the entries in place orders them again.
    store.invalidateOrder();
    store.insert(makeEntry({ insertedAt: 2000 }));
    expect(sorts()).toBe(2);
  });
});

describe("finding an entry by image chunk", () => {
  function makeStore(budgetBytes = Infinity) {
    return new ChunkStore({
      policy: new TieredPolicy(() => "idle", () => undefined, () => 1),
      budgetBytes,
      evictionTier: (entry) => entry.tier,
      recordEviction: () => {},
    });
  }

  it("finds an entry by image, channel and chunk key, under any entity", () => {
    const store = makeStore();
    const entry = makeEntry({ insertedAt: 0, entityId: "tile-3", imageId: "img-1", c: 2, chunkKey: "0/0/2/0/0/1" });
    store.insert(entry);

    expect(store.findByImageChunk("img-1", 2, "0/0/2/0/0/1")).toBe(entry);
    expect(store.findByImageChunk("img-1", 1, "0/0/2/0/0/1")).toBeUndefined();
    expect(store.findByImageChunk("img-2", 2, "0/0/2/0/0/1")).toBeUndefined();
  });

  it("forgets an entry that is removed, evicted, replaced or cancelled", () => {
    const store = makeStore(200);
    const a = makeEntry({ insertedAt: 0, chunkKey: "a" });
    const b = makeEntry({ insertedAt: 1, chunkKey: "b" });
    store.insert(a);
    store.insert(b);
    store.remove(a.entityId, "a");
    expect(store.findByImageChunk(a.imageId, a.c, "a")).toBeUndefined();

    // Over budget: the oldest goes.
    store.insert(makeEntry({ insertedAt: 2, chunkKey: "c" }));
    store.insert(makeEntry({ insertedAt: 3, chunkKey: "d" }));
    expect(store.findByImageChunk(b.imageId, b.c, "b")).toBeUndefined();

    const whole = makeEntry({ insertedAt: 4, chunkKey: "c" });
    store.insert(whole);
    expect(store.findByImageChunk(whole.imageId, whole.c, "c")).toBe(whole);

    store.cancelDataset([whole.entityId]);
    expect(store.findByImageChunk(whole.imageId, whole.c, "c")).toBeUndefined();
  });

  it("still finds an image chunk another entity holds when one lets it go", () => {
    const store = makeStore();
    const first = makeEntry({ insertedAt: 0, entityId: "tile-0", chunkKey: "k" });
    const second = makeEntry({ insertedAt: 1, entityId: "tile-1", chunkKey: "k" });
    store.insert(first);
    store.insert(second);

    store.remove("tile-0", "k");

    expect(store.findByImageChunk(second.imageId, second.c, "k")).toBe(second);
    store.reset();
    expect(store.findByImageChunk(second.imageId, second.c, "k")).toBeUndefined();
  });
});
