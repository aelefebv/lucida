import { describe, it, expect } from "vitest";
import type { MissingProxy } from "../../../renderer/workerProtocol.ts";
import { DeliveryTracker } from "./tracker.ts";

// ---------------------------------------------------------------------------
// Chunk side
// ---------------------------------------------------------------------------

describe("DeliveryTracker — chunk side", () => {
  it("markChunkSent + wasChunkSent round-trip per (member, key)", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-0", "field-0", "k1");
    expect(t.wasChunkSent("img-0", "k1")).toBe(true);
    expect(t.wasChunkSent("img-0", "k2")).toBe(false);
    expect(t.wasChunkSent("img-other", "k1")).toBe(false);
  });

  it("markChunkSent also populates the wid → entityId reverse lookup", () => {
    const t = new DeliveryTracker();
    expect(t.entityIdFor("img-0:ch1")).toBeNull();
    t.markChunkSent("img-0:ch1", "field-7", "k1");
    expect(t.entityIdFor("img-0:ch1")).toBe("field-7");
  });

  it("recordMember populates wid → entityId without marking any chunk sent", () => {
    const t = new DeliveryTracker();
    t.recordMember("img-0:ch1", "field-9");
    expect(t.entityIdFor("img-0:ch1")).toBe("field-9");
    expect(t.wasChunkSent("img-0:ch1", "k1")).toBe(false);
  });

  it("markChunkEvicted: evicted keys are removed from the sent set", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-0", "field-0", "k1");
    t.markChunkSent("img-0", "field-0", "k2");
    t.markChunkSent("img-0", "field-0", "k3");

    t.markChunkEvicted("img-0", ["k1", "k3"], []);

    expect(t.wasChunkSent("img-0", "k1")).toBe(false);
    expect(t.wasChunkSent("img-0", "k2")).toBe(true);
    expect(t.wasChunkSent("img-0", "k3")).toBe(false);
  });

  it("markChunkEvicted: skipped keys are added to the rejected set and also removed from sent", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-0", "field-0", "k1");

    t.markChunkEvicted("img-0", [], ["k1", "k2"]);

    expect(t.wasChunkRejected("img-0", "k1")).toBe(true);
    expect(t.wasChunkRejected("img-0", "k2")).toBe(true);
    // skipped removes from sent.
    expect(t.wasChunkSent("img-0", "k1")).toBe(false);
  });

  it("markChunkEvicted: evicted keys are removed from the rejected set (acceptance proves deliverable)", () => {
    const t = new DeliveryTracker();
    // Seed rejected via a prior skipped report.
    t.markChunkEvicted("img-0", [], ["k1", "k2"]);
    expect(t.wasChunkRejected("img-0", "k1")).toBe(true);

    // Now the worker reports it as evicted — acceptance proves deliverable.
    t.markChunkEvicted("img-0", ["k1"], []);

    expect(t.wasChunkRejected("img-0", "k1")).toBe(false);
    expect(t.wasChunkRejected("img-0", "k2")).toBe(true);
  });

  it("markChunkEvicted: mixed evicted + skipped batch handled in one call", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-0", "field-0", "k1");
    t.markChunkSent("img-0", "field-0", "k2");
    t.markChunkSent("img-0", "field-0", "k3");

    t.markChunkEvicted("img-0", ["k1"], ["k2", "k3"]);

    // All three dropped from sent.
    expect(t.wasChunkSent("img-0", "k1")).toBe(false);
    expect(t.wasChunkSent("img-0", "k2")).toBe(false);
    expect(t.wasChunkSent("img-0", "k3")).toBe(false);
    // Only skipped added to rejected; evicted stays out.
    expect(t.wasChunkRejected("img-0", "k1")).toBe(false);
    expect(t.wasChunkRejected("img-0", "k2")).toBe(true);
    expect(t.wasChunkRejected("img-0", "k3")).toBe(true);
  });

  it("markChunkEvicted returns rejectedNew for skipped keys with a known entityId", () => {
    const t = new DeliveryTracker();
    // Pre-populate wid → entityId via markChunkSent.
    t.markChunkSent("img-0:ch1", "field-7", "seed");

    const { rejectedNew } = t.markChunkEvicted(
      "img-0:ch1", [], ["kA", "kB"],
    );

    expect(rejectedNew).toEqual([
      { entityId: "field-7", chunkKey: "kA" },
      { entityId: "field-7", chunkKey: "kB" },
    ]);
  });

  it("markChunkEvicted returns empty rejectedNew when entityId is unknown", () => {
    const t = new DeliveryTracker();
    // No prior markChunkSent / recordMember → entityIdFor is null.

    const { rejectedNew } = t.markChunkEvicted(
      "img-ghost", [], ["k1"],
    );

    expect(rejectedNew).toEqual([]);
    // But the rejected set still receives the key so the resend pass
    // short-circuits future re-attempts.
    expect(t.wasChunkRejected("img-ghost", "k1")).toBe(true);
  });

  it("entityIdFor returns null for unknown members", () => {
    const t = new DeliveryTracker();
    expect(t.entityIdFor("img-ghost")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proxy side
// ---------------------------------------------------------------------------

describe("DeliveryTracker — proxy side", () => {
  it("markProxyDelivered + wasProxyDelivered round-trip per key", () => {
    const t = new DeliveryTracker();
    const key = "ds1|field-0|FieldProxy3D|0|0";

    expect(t.wasProxyDelivered(key)).toBe(false);
    t.markProxyDelivered(key);
    expect(t.wasProxyDelivered(key)).toBe(true);
  });

  it("clearProxyDelivered drops the entry built from a MissingProxy report", () => {
    const t = new DeliveryTracker();
    const key = "ds1|field-0|FieldProxy3D|0|0";
    t.markProxyDelivered(key);

    const missing: MissingProxy = {
      kind: "proxy",
      datasetId: "ds1",
      entityId: "field-0",
      proxyKind: "FieldProxy3D",
      t: 0,
      c: 0,
    };
    t.clearProxyDelivered(missing);

    expect(t.wasProxyDelivered(key)).toBe(false);
  });

  it("clearProxyDelivered is a no-op when the composite key isn't tracked", () => {
    const t = new DeliveryTracker();
    const missing: MissingProxy = {
      kind: "proxy",
      datasetId: "ds-other",
      entityId: "field-0",
      proxyKind: "FieldProxy3D",
      t: 0,
      c: 0,
    };
    expect(() => t.clearProxyDelivered(missing)).not.toThrow();
    expect(t.getProxyDeliveredKeys().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("DeliveryTracker — lifecycle", () => {
  it("onColdStateRebuild clears chunk sent / rejected / wid → entity for all members", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-a", "field-a", "k1");
    t.markChunkEvicted("img-b", [], ["k2"]);
    t.recordMember("img-c:ch1", "field-c");

    t.onColdStateRebuild();

    expect(t.wasChunkSent("img-a", "k1")).toBe(false);
    expect(t.wasChunkRejected("img-b", "k2")).toBe(false);
    expect(t.entityIdFor("img-c:ch1")).toBeNull();
  });

  it("onColdStateRebuild does NOT clear proxy-delivered tracking (worker proxy pools persist)", () => {
    const t = new DeliveryTracker();
    const key = "ds1|field-0|FieldProxy3D|0|0";
    t.markProxyDelivered(key);

    t.onColdStateRebuild();

    expect(t.wasProxyDelivered(key)).toBe(true);
  });

  it("clearMember drops chunk-side state for one workerMemberId only", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-a", "field-a", "k1");
    t.markChunkSent("img-b", "field-b", "k2");

    t.clearMember("img-a");

    expect(t.wasChunkSent("img-a", "k1")).toBe(false);
    expect(t.wasChunkSent("img-b", "k2")).toBe(true);
    expect(t.entityIdFor("img-a")).toBeNull();
    expect(t.entityIdFor("img-b")).toBe("field-b");
  });

  it("clearDataset drops proxy-delivered entries whose composite key starts with `${datasetId}|`", () => {
    const t = new DeliveryTracker();
    t.markProxyDelivered("ds1|field-0|FieldProxy3D|0|0");
    t.markProxyDelivered("ds1|field-1|WellProxy3D|0|0");
    t.markProxyDelivered("ds2|field-2|FieldProxy3D|0|0");

    t.clearDataset("ds1");

    expect(t.wasProxyDelivered("ds1|field-0|FieldProxy3D|0|0")).toBe(false);
    expect(t.wasProxyDelivered("ds1|field-1|WellProxy3D|0|0")).toBe(false);
    expect(t.wasProxyDelivered("ds2|field-2|FieldProxy3D|0|0")).toBe(true);
  });

  it("clearDataset is a no-op when no key matches the prefix (id-shape mismatch)", () => {
    const t = new DeliveryTracker();
    t.markProxyDelivered("ds1|field-0|FieldProxy3D|0|0");

    // workerMemberId shape — won't match any composite key.
    t.clearDataset("img-0:ch1");

    expect(t.wasProxyDelivered("ds1|field-0|FieldProxy3D|0|0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Iteration helpers
// ---------------------------------------------------------------------------

describe("DeliveryTracker — iteration", () => {
  it("trackedKeys iterates every workerMemberId that has at least one sent chunk", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-a", "field-a", "k1");
    t.markChunkSent("img-b", "field-b", "k2");
    t.markChunkSent("img-a", "field-a", "k3");

    expect(new Set(t.trackedKeys())).toEqual(new Set(["img-a", "img-b"]));
  });

  it("trackedKeys is empty after onColdStateRebuild", () => {
    const t = new DeliveryTracker();
    t.markChunkSent("img-a", "field-a", "k1");
    t.onColdStateRebuild();
    expect([...t.trackedKeys()]).toEqual([]);
  });
});
