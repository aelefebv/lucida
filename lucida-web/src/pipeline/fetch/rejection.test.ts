import { describe, it, expect } from "vitest";

import { RejectionTracker } from "./rejection.ts";

// ---------------------------------------------------------------------------
// Tests — synthetic input only; the cache integration tests in
// cpuCache.test.ts cover the wire-up to the chunk scheduler.
// ---------------------------------------------------------------------------

describe("RejectionTracker", () => {
  it("mark() returns true on first add and false on duplicate", () => {
    const tracker = new RejectionTracker();

    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-A")).toBe(false);
    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-A")).toBe(false);
  });

  it("has() reflects what was marked", () => {
    const tracker = new RejectionTracker();

    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-A")).toBe(false);
    tracker.mark("ds-1", "entity-1", "detail", "chunk-A");
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-B")).toBe(false);
  });

  it("clear() empties the tracker", () => {
    const tracker = new RejectionTracker();

    tracker.mark("ds-1", "entity-1", "detail", "chunk-A");
    tracker.mark("ds-1", "entity-1", "detail", "chunk-B");
    tracker.mark("ds-1", "entity-2", "detail", "chunk-C");
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
    expect(tracker.has("ds-1", "entity-2", "detail", "chunk-C")).toBe(true);

    tracker.clear();

    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-A")).toBe(false);
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-B")).toBe(false);
    expect(tracker.has("ds-1", "entity-2", "detail", "chunk-C")).toBe(false);
  });

  it("clear() lets a previously-rejected key be re-marked as new", () => {
    const tracker = new RejectionTracker();

    tracker.mark("ds-1", "entity-1", "detail", "chunk-A");
    tracker.clear();

    // After clear, the same key is "new" again — important so the
    // caller fans the cancel-in-flight call back out on a fresh
    // rejection after a cold-state rebuild.
    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
  });

  it("multiple entities don't interfere with each other", () => {
    const tracker = new RejectionTracker();

    tracker.mark("ds-1", "entity-1", "detail", "chunk-A");
    tracker.mark("ds-1", "entity-2", "detail", "chunk-A");

    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
    expect(tracker.has("ds-1", "entity-2", "detail", "chunk-A")).toBe(true);

    // Same chunkKey under a different entity is independent — second
    // mark is "new" relative to that entity even though the chunkKey
    // string was already seen elsewhere.
    expect(tracker.mark("ds-1", "entity-3", "detail", "chunk-A")).toBe(true);
  });

  it("multiple chunkKeys under one entity are tracked independently", () => {
    const tracker = new RejectionTracker();

    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-B")).toBe(true);
    expect(tracker.mark("ds-1", "entity-1", "detail", "chunk-C")).toBe(true);

    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-A")).toBe(true);
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-B")).toBe(true);
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-C")).toBe(true);
    expect(tracker.has("ds-1", "entity-1", "detail", "chunk-D")).toBe(false);
  });

  it("keeps detail and coarse rejection state independent", () => {
    const tracker = new RejectionTracker();
    tracker.mark("ds-1", "image-1", "detail", "same-key");

    expect(tracker.has("ds-1", "image-1", "detail", "same-key")).toBe(true);
    expect(tracker.has("ds-1", "image-1", "coarse", "same-key")).toBe(false);
    expect(tracker.mark("ds-1", "image-1", "coarse", "same-key")).toBe(true);
  });

  it("clearImage preserves sibling images and datasets", () => {
    const tracker = new RejectionTracker();
    tracker.mark("ds-a", "shared", "detail", "chunk-A");
    tracker.mark("ds-a", "sibling", "detail", "chunk-A");
    tracker.mark("ds-b", "shared", "detail", "chunk-A");

    tracker.clearImage("ds-a", "shared");

    expect(tracker.has("ds-a", "shared", "detail", "chunk-A")).toBe(false);
    expect(tracker.has("ds-a", "sibling", "detail", "chunk-A")).toBe(true);
    expect(tracker.has("ds-b", "shared", "detail", "chunk-A")).toBe(true);
  });

  it("has() on a never-marked entity returns false (no implicit Set creation)", () => {
    const tracker = new RejectionTracker();

    // has() must not create empty Sets as a side effect — otherwise
    // long-lived caches would accumulate stale entries for every
    // entity ever queried.
    expect(tracker.has("ds-1", "never-marked", "detail", "any-key")).toBe(false);
    expect(tracker.has("ds-1", "still-never-marked", "detail", "another-key")).toBe(false);
  });
});
