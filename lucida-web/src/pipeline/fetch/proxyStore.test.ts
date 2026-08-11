import { describe, it, expect, vi } from "vitest";

import {
  ProxyStore,
  proxyInnerKey,
  type ProxyCacheEntry,
  type ProxyEvictable,
} from "./proxyStore.ts";
import { LRUPolicy } from "./eviction.ts";
import type { SceneEpochs } from "../epochs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_EPOCHS: SceneEpochs = {
  content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0,
};

let nextInsertedAt = 0;

function makeProxyEntry(overrides: Partial<ProxyCacheEntry> & {
  bytes: number;
  datasetId?: string;
  entityId?: string;
}): ProxyCacheEntry {
  const base: ProxyCacheEntry = {
    header: {
      algorithmVersion: 1,
      sourceContentHash: new Uint8Array(32),
      dims: [4, 4, 4],
      dtype: "u16",
    },
    data: new ArrayBuffer(0),
    bytes: 0,
    datasetId: "ds-1",
    entityId: "e-1",
    imageId: "img-1",
    proxyKind: "TileProxy3D",
    t: 0,
    c: 0,
    insertedAt: nextInsertedAt++,
    epochs: ZERO_EPOCHS,
    priority: 0,
    lastSeenTick: 0,
  };
  return { ...base, ...overrides };
}

function makeStore(opts?: { budgetBytes?: number }) {
  const evictions: number[] = [];
  const store = new ProxyStore({
    policy: new LRUPolicy<ProxyEvictable>(),
    budgetBytes: opts?.budgetBytes ?? Infinity,
    recordEviction: () => { evictions.push(performance.now()); },
  });
  return { store, evictions };
}

// ---------------------------------------------------------------------------
// proxyInnerKey
// ---------------------------------------------------------------------------

describe("proxyInnerKey", () => {
  it("composes a stable string from (entityId, kind, t, c)", () => {
    expect(proxyInnerKey({
      entityId: "e-1", kind: "TileProxy3D", t: 0, c: 0,
    })).toBe("e-1|TileProxy3D|0|0");
  });

  it("distinguishes GroupProxy3D vs TileProxy3D", () => {
    const a = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 0, c: 0 });
    const b = proxyInnerKey({ entityId: "e-1", kind: "GroupProxy3D", t: 0, c: 0 });
    expect(a).not.toBe(b);
  });

  it("distinguishes channels and timepoints", () => {
    const a = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 0, c: 0 });
    const b = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 1, c: 0 });
    const c = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 0, c: 1 });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Basic API
// ---------------------------------------------------------------------------

describe("ProxyStore basics", () => {
  it("insert + get round-trip returns the live entry", () => {
    const { store } = makeStore();
    const entry = makeProxyEntry({ bytes: 256 });
    const key = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 0, c: 0 });
    store.insert("ds-1", key, entry);
    expect(store.get("ds-1", key)).toBe(entry);
    expect(store.bytes).toBe(256);
  });

  it("get returns undefined for missing entries", () => {
    const { store } = makeStore();
    expect(store.get("ds-x", "missing")).toBeUndefined();
  });

  it("has reflects insert / remove", () => {
    const { store } = makeStore();
    const key = "e-1|TileProxy3D|0|0";
    expect(store.has("ds-1", key)).toBe(false);
    store.insert("ds-1", key, makeProxyEntry({ bytes: 100 }));
    expect(store.has("ds-1", key)).toBe(true);
    store.remove("ds-1", key);
    expect(store.has("ds-1", key)).toBe(false);
  });

  it("remove returns false for missing entries", () => {
    const { store } = makeStore();
    expect(store.remove("ds-x", "missing")).toBe(false);
  });

  it("remove decrements bytes", () => {
    const { store } = makeStore();
    const key = "e-1|TileProxy3D|0|0";
    store.insert("ds-1", key, makeProxyEntry({ bytes: 256 }));
    expect(store.bytes).toBe(256);
    expect(store.remove("ds-1", key)).toBe(true);
    expect(store.bytes).toBe(0);
  });

  it("partitions entries by datasetId in the outer map", () => {
    const { store } = makeStore();
    const key = "e-1|TileProxy3D|0|0";
    store.insert("ds-A", key, makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.insert("ds-B", key, makeProxyEntry({ bytes: 200, datasetId: "ds-B" }));
    expect(store.get("ds-A", key)?.datasetId).toBe("ds-A");
    expect(store.get("ds-B", key)?.datasetId).toBe("ds-B");
    expect(store.bytes).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// cancelDataset
// ---------------------------------------------------------------------------

describe("ProxyStore.cancelDataset", () => {
  it("drops every entry under a dataset and zeros their bytes", () => {
    const { store, evictions } = makeStore();
    const k0 = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 0, c: 0 });
    const k1 = proxyInnerKey({ entityId: "e-1", kind: "TileProxy3D", t: 1, c: 0 });
    store.insert("ds-A", k0, makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.insert("ds-A", k1, makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.insert("ds-B", k0, makeProxyEntry({ bytes: 50, datasetId: "ds-B" }));
    expect(store.bytes).toBe(250);

    store.cancelDataset("ds-A");

    expect(store.bytes).toBe(50);
    expect(store.has("ds-A", k0)).toBe(false);
    expect(store.has("ds-A", k1)).toBe(false);
    expect(store.has("ds-B", k0)).toBe(true);
    // Dataset removal does not emit eviction records.
    expect(evictions).toEqual([]);
  });

  it("is a no-op for unknown datasets", () => {
    const { store } = makeStore();
    store.insert("ds-A", "k", makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.cancelDataset("unknown");
    expect(store.bytes).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("ProxyStore.reset", () => {
  it("clears all entries across datasets and zeros bytes", () => {
    const { store } = makeStore();
    store.insert("ds-A", "k0", makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.insert("ds-B", "k0", makeProxyEntry({ bytes: 100, datasetId: "ds-B" }));
    expect(store.bytes).toBe(200);

    store.reset();

    expect(store.bytes).toBe(0);
    expect(store.has("ds-A", "k0")).toBe(false);
    expect(store.has("ds-B", "k0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

describe("ProxyStore eviction via policy", () => {
  it("over-budget insert evicts oldest first across datasets", () => {
    const { store, evictions } = makeStore({ budgetBytes: 200 });
    store.insert(
      "ds-A", "k0",
      makeProxyEntry({ bytes: 100, datasetId: "ds-A", insertedAt: 0 }),
    );
    store.insert(
      "ds-B", "k1",
      makeProxyEntry({ bytes: 100, datasetId: "ds-B", insertedAt: 1 }),
    );
    expect(store.bytes).toBe(200);

    // 300 > 200 → evict the oldest (ds-A/k0).
    store.insert(
      "ds-A", "k2",
      makeProxyEntry({ bytes: 100, datasetId: "ds-A", insertedAt: 2 }),
    );

    expect(store.bytes).toBeLessThanOrEqual(200);
    expect(store.has("ds-A", "k0")).toBe(false);
    expect(store.has("ds-B", "k1")).toBe(true);
    expect(store.has("ds-A", "k2")).toBe(true);
    expect(evictions).toHaveLength(1);
  });

  it("dataset whose subtree shrinks to empty is removed from outer map", () => {
    const { store } = makeStore({ budgetBytes: 100 });
    store.insert(
      "ds-only", "k0",
      makeProxyEntry({ bytes: 100, datasetId: "ds-only", insertedAt: 0 }),
    );
    // Force the lone entry to evict.
    store.insert(
      "ds-keep", "k1",
      makeProxyEntry({ bytes: 100, datasetId: "ds-keep", insertedAt: 1 }),
    );
    // Inner map for "ds-only" should have been garbage-collected.
    expect(store.has("ds-only", "k0")).toBe(false);
  });

  it("under-budget insert is a no-op for the policy", () => {
    const { store, evictions } = makeStore({ budgetBytes: 1000 });
    store.insert("ds-A", "k", makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    expect(evictions).toEqual([]);
  });

  it("recordEviction is invoked once per evicted entry", () => {
    const recordEviction = vi.fn();
    const store = new ProxyStore({
      policy: new LRUPolicy<ProxyEvictable>(),
      budgetBytes: 100,
      recordEviction,
    });
    // Fill to exactly the budget with three small entries.
    for (let i = 0; i < 3; i++) {
      store.insert(`ds-${i}`, "k", makeProxyEntry({
        bytes: 33, datasetId: `ds-${i}`, insertedAt: i,
      }));
    }
    // The next 100-byte insert sweeps all three.
    store.insert("ds-big", "k", makeProxyEntry({
      bytes: 100, datasetId: "ds-big", insertedAt: 99,
    }));
    expect(recordEviction).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe("ProxyStore residency reporting", () => {
  it("totalResidency aggregates count and bytes across datasets", () => {
    const { store } = makeStore();
    store.insert("ds-A", "k0", makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.insert("ds-A", "k1", makeProxyEntry({ bytes: 100, datasetId: "ds-A" }));
    store.insert("ds-B", "k0", makeProxyEntry({ bytes: 50, datasetId: "ds-B" }));
    expect(store.totalResidency()).toEqual({ count: 3, bytes: 250 });
  });

});
