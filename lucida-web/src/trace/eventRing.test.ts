import { describe, expect, it } from "vitest";

import { EventRing } from "./eventRing.ts";
import { PointEvent, POINT_EVENT_REASONS } from "./types.ts";

const CHUNK = {
  datasetId: "ds",
  entityId: "ent",
  imageId: "img",
  level: 2,
  t: 1,
  c: 0,
  z: 5,
  y: 3,
  x: 4,
};

describe("EventRing", () => {
  it("records time, kind, reason and chunk identity in one shape", () => {
    const ring = new EventRing(4);
    ring.append(900, PointEvent.Failure, "permanent", CHUNK, 0);

    expect(ring.serialise()).toEqual([
      {
        atUs: 900,
        kind: "failure",
        reason: "permanent",
        chunk: { ...CHUNK, residencyTier: "detail", chunkKey: "2/1/0/5/3/4" },
      },
    ]);
  });

  it("carries an event with no chunk behind it", () => {
    const ring = new EventRing(4);
    ring.append(10, PointEvent.Eviction, "evicted", null, 0);

    expect(ring.serialise()[0].chunk).toBeNull();
  });

  it("defaults an absent dataset id to empty rather than guessing one", () => {
    const ring = new EventRing(4);
    const { datasetId: _omitted, ...noDataset } = CHUNK;
    ring.append(10, PointEvent.Rejection, "atlas-policy", noDataset, 1);

    const chunk = ring.serialise()[0].chunk;
    expect(chunk?.datasetId).toBe("");
    expect(chunk?.residencyTier).toBe("coarse");
  });

  it("drops oldest and reports how many it dropped", () => {
    const ring = new EventRing(2);
    for (let i = 0; i < 5; i++) ring.append(i, PointEvent.Retry, "transient", null, 0);

    expect(ring.dropped).toBe(3);
    expect(ring.serialise().map(e => e.atUs)).toEqual([3, 4]);
  });

  it("round-trips every reason code in the borrowed taxonomies", () => {
    const ring = new EventRing(POINT_EVENT_REASONS.length);
    for (const reason of POINT_EVENT_REASONS) {
      ring.append(0, PointEvent.Failure, reason, null, 0);
    }

    expect(ring.serialise().map(e => e.reason)).toEqual([...POINT_EVENT_REASONS]);
  });
});
