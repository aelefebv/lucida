/** Tests {@link WorkerFeedback} directly against `DeliveryTracker`. */

import { describe, it, expect, vi } from "vitest";
import type { CpuCache } from "../../fetch/index.ts";
import type {
  MissingChunk,
  MissingProxy,
} from "../../../renderer/workerProtocol.ts";
import { DeliveryTracker } from "./tracker.ts";
import { WorkerFeedback } from "./feedback.ts";

/**
 * Minimal CpuCache fake — only `markRejected` is called by the
 * handler. Returning the spy lets each test assert call args directly.
 */
function makeFakeCpuCache(): {
  cache: CpuCache;
  markRejected: ReturnType<typeof vi.fn>;
} {
  const markRejected = vi.fn();
  const cache = { markRejected } as unknown as CpuCache;
  return { cache, markRejected };
}

// ---------------------------------------------------------------------------
// handleChunksEvicted
// ---------------------------------------------------------------------------

describe("WorkerFeedback.handleChunksEvicted", () => {
  it("evicted only — no markRejected calls (acceptance proves deliverable)", () => {
    const tracker = new DeliveryTracker();
    // Seed sent so the eviction has something to drop.
    tracker.markChunkSent("img-0", "field-0", "k1");
    tracker.markChunkSent("img-0", "field-0", "k2");

    const { cache, markRejected } = makeFakeCpuCache();
    const fb = new WorkerFeedback(tracker);

    fb.handleChunksEvicted("img-0", ["k1", "k2"], [], cache);

    expect(markRejected).not.toHaveBeenCalled();
    // Sent set drained — re-eligible for upload.
    expect(tracker.wasChunkSent("img-0", "k1")).toBe(false);
    expect(tracker.wasChunkSent("img-0", "k2")).toBe(false);
  });

  it("skipped with known entityId — markRejected called per skipped chunk", () => {
    const tracker = new DeliveryTracker();
    // markChunkSent seeds the wid → entityId reverse lookup.
    tracker.markChunkSent("img-0:ch1", "field-7", "seed");

    const { cache, markRejected } = makeFakeCpuCache();
    const fb = new WorkerFeedback(tracker);

    fb.handleChunksEvicted("img-0:ch1", [], ["kA", "kB"], cache);

    expect(markRejected).toHaveBeenCalledTimes(2);
    expect(markRejected).toHaveBeenNthCalledWith(1, "field-7", "kA");
    expect(markRejected).toHaveBeenNthCalledWith(2, "field-7", "kB");
    // Tracker also records both as rejected so future resends short-circuit.
    expect(tracker.wasChunkRejected("img-0:ch1", "kA")).toBe(true);
    expect(tracker.wasChunkRejected("img-0:ch1", "kB")).toBe(true);
  });

  it("skipped with unknown entityId — no markRejected calls, but tracker still records rejection", () => {
    const tracker = new DeliveryTracker();
    // No markChunkSent / recordMember → entityIdFor is null.
    const { cache, markRejected } = makeFakeCpuCache();
    const fb = new WorkerFeedback(tracker);

    fb.handleChunksEvicted("img-ghost", [], ["k1"], cache);

    expect(markRejected).not.toHaveBeenCalled();
    expect(tracker.wasChunkRejected("img-ghost", "k1")).toBe(true);
  });

  it("mixed evicted + skipped — both effects in one call", () => {
    const tracker = new DeliveryTracker();
    tracker.markChunkSent("img-0", "field-0", "k1");
    tracker.markChunkSent("img-0", "field-0", "k2");
    tracker.markChunkSent("img-0", "field-0", "k3");

    const { cache, markRejected } = makeFakeCpuCache();
    const fb = new WorkerFeedback(tracker);

    fb.handleChunksEvicted("img-0", ["k1"], ["k2", "k3"], cache);

    // Evicted: re-eligible (not rejected, no markRejected).
    expect(tracker.wasChunkSent("img-0", "k1")).toBe(false);
    expect(tracker.wasChunkRejected("img-0", "k1")).toBe(false);
    // Skipped: rejected on tracker + cpuCache notified.
    expect(tracker.wasChunkSent("img-0", "k2")).toBe(false);
    expect(tracker.wasChunkSent("img-0", "k3")).toBe(false);
    expect(tracker.wasChunkRejected("img-0", "k2")).toBe(true);
    expect(tracker.wasChunkRejected("img-0", "k3")).toBe(true);
    expect(markRejected).toHaveBeenCalledTimes(2);
    expect(markRejected).toHaveBeenNthCalledWith(1, "field-0", "k2");
    expect(markRejected).toHaveBeenNthCalledWith(2, "field-0", "k3");
  });
});

// ---------------------------------------------------------------------------
// handleWantedSetDelta
// ---------------------------------------------------------------------------

describe("WorkerFeedback.handleWantedSetDelta", () => {
  it("proxy entry clears proxy-delivered tracking", () => {
    const tracker = new DeliveryTracker();
    const key = "ds1|field-0|FieldProxy3D|0|0";
    tracker.markProxyDelivered(key);
    expect(tracker.wasProxyDelivered(key)).toBe(true);

    const fb = new WorkerFeedback(tracker);
    const missing: MissingProxy = {
      kind: "proxy",
      datasetId: "ds1",
      entityId: "field-0",
      proxyKind: "FieldProxy3D",
      t: 0,
      c: 0,
    };

    fb.handleWantedSetDelta([missing]);

    expect(tracker.wasProxyDelivered(key)).toBe(false);
  });

  it("chunk entry is ignored (no tracker call, no throw)", () => {
    const tracker = new DeliveryTracker();
    // Seed a proxy so we can prove it wasn't touched.
    const proxyKey = "ds1|field-0|FieldProxy3D|0|0";
    tracker.markProxyDelivered(proxyKey);
    // Spy on clearProxyDelivered to assert it isn't called for chunks.
    const spy = vi.spyOn(tracker, "clearProxyDelivered");

    const fb = new WorkerFeedback(tracker);
    const missingChunk: MissingChunk = {
      kind: "chunk",
      entityId: "field-0",
      chunkKey: "k1",
    };

    fb.handleWantedSetDelta([missingChunk]);

    expect(spy).not.toHaveBeenCalled();
    expect(tracker.wasProxyDelivered(proxyKey)).toBe(true);
  });
});
