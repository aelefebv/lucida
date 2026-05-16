import { describe, it, expect } from "vitest";

import { RejectionTracker } from "./rejection.ts";

// ---------------------------------------------------------------------------
// Tests — synthetic input only; the cache integration tests in
// cpuCache.test.ts cover the wire-up to the chunk scheduler.
// ---------------------------------------------------------------------------

describe("RejectionTracker", () => {
  it("mark() returns true on first add and false on duplicate", () => {
    const tracker = new RejectionTracker();

    expect(tracker.mark("entity-1", "chunk-A")).toBe(true);
    expect(tracker.mark("entity-1", "chunk-A")).toBe(false);
    expect(tracker.mark("entity-1", "chunk-A")).toBe(false);
  });

  it("has() reflects what was marked", () => {
    const tracker = new RejectionTracker();

    expect(tracker.has("entity-1", "chunk-A")).toBe(false);
    tracker.mark("entity-1", "chunk-A");
    expect(tracker.has("entity-1", "chunk-A")).toBe(true);
    expect(tracker.has("entity-1", "chunk-B")).toBe(false);
  });

  it("clear() empties the tracker", () => {
    const tracker = new RejectionTracker();

    tracker.mark("entity-1", "chunk-A");
    tracker.mark("entity-1", "chunk-B");
    tracker.mark("entity-2", "chunk-C");
    expect(tracker.has("entity-1", "chunk-A")).toBe(true);
    expect(tracker.has("entity-2", "chunk-C")).toBe(true);

    tracker.clear();

    expect(tracker.has("entity-1", "chunk-A")).toBe(false);
    expect(tracker.has("entity-1", "chunk-B")).toBe(false);
    expect(tracker.has("entity-2", "chunk-C")).toBe(false);
  });

  it("clear() lets a previously-rejected key be re-marked as new", () => {
    const tracker = new RejectionTracker();

    tracker.mark("entity-1", "chunk-A");
    tracker.clear();

    // After clear, the same key is "new" again — important so the
    // caller fans the cancel-in-flight call back out on a fresh
    // rejection after a cold-state rebuild.
    expect(tracker.mark("entity-1", "chunk-A")).toBe(true);
  });

  it("multiple entities don't interfere with each other", () => {
    const tracker = new RejectionTracker();

    tracker.mark("entity-1", "chunk-A");
    tracker.mark("entity-2", "chunk-A");

    expect(tracker.has("entity-1", "chunk-A")).toBe(true);
    expect(tracker.has("entity-2", "chunk-A")).toBe(true);

    // Same chunkKey under a different entity is independent — second
    // mark is "new" relative to that entity even though the chunkKey
    // string was already seen elsewhere.
    expect(tracker.mark("entity-3", "chunk-A")).toBe(true);
  });

  it("multiple chunkKeys under one entity are tracked independently", () => {
    const tracker = new RejectionTracker();

    expect(tracker.mark("entity-1", "chunk-A")).toBe(true);
    expect(tracker.mark("entity-1", "chunk-B")).toBe(true);
    expect(tracker.mark("entity-1", "chunk-C")).toBe(true);

    expect(tracker.has("entity-1", "chunk-A")).toBe(true);
    expect(tracker.has("entity-1", "chunk-B")).toBe(true);
    expect(tracker.has("entity-1", "chunk-C")).toBe(true);
    expect(tracker.has("entity-1", "chunk-D")).toBe(false);
  });

  it("has() on a never-marked entity returns false (no implicit Set creation)", () => {
    const tracker = new RejectionTracker();

    // has() must not create empty Sets as a side effect — otherwise
    // long-lived caches would accumulate stale entries for every
    // entity ever queried.
    expect(tracker.has("never-marked", "any-key")).toBe(false);
    expect(tracker.has("still-never-marked", "another-key")).toBe(false);
  });
});
