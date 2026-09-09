/**
 * The spatial summary: "what is where", as counts and bounding boxes per
 * state and level. The text twin of the overlay, asserted against fixture
 * rows whose coordinates are known.
 */

import { describe, expect, it } from "vitest";

import { healthyLocalOpen, makeRow, makeRun, saturatedReopen } from "./fixtures.ts";
import { summariseSpace } from "./spatialSummary.ts";

const MS = 1_000;

describe("the spatial summary", () => {
  it("groups a healthy open into one complete group at its level, with its box", () => {
    const summary = summariseSpace(healthyLocalOpen());

    expect(summary.rowCount).toBe(120);
    expect(summary.groupCount).toBe(1);
    expect(summary.levelCount).toBe(1);
    const [group] = summary.groups;
    expect(group.id).toBe(1);
    expect(group.state).toBe("complete");
    expect(group.level).toBe(1);
    expect(group.residencyTier).toBe("detail");
    expect(group.datasetId).toBe("ds");
    expect(group.n).toBe(120);
    expect(group.entityCount).toBe(8);
    // Rows 0 to 119 sit along y at x 0, one t, c and z.
    expect(group.box).toEqual({ min: [0, 0, 0, 0, 0], max: [0, 0, 0, 119, 0] });
    // Row 119 is the one that waited on the wire.
    expect(group.oldestMs).toBe(246.5);
  });

  it("puts the rows still in flight ahead of the rows that finished", () => {
    const summary = summariseSpace(saturatedReopen());

    expect(summary.rowCount).toBe(400);
    expect(summary.groups.map((group) => [group.state, group.n])).toEqual([
      ["queue", 140],
      ["complete", 260],
    ]);
    const [queued, complete] = summary.groups;
    expect(queued.box).toEqual({ min: [0, 0, 0, 260, 0], max: [0, 0, 0, 399, 0] });
    expect(complete.box).toEqual({ min: [0, 0, 0, 0, 0], max: [0, 0, 0, 259, 0] });
    // Row 260 was planned at 50 ms + 260 × 27 ms and is still waiting at 12 s.
    expect(queued.oldestMs).toBe(4_930);
  });

  it("separates levels, tiers and datasets, and orders by state then level", () => {
    const rows = [
      // Two complete rows at level 0 on one dataset.
      ...[0, 1].map((i) =>
        makeRow({ startUs: 10 * MS, durations: { plan: 100, queue: MS, wire: 5 * MS, decode: MS, upload: MS, present: MS } }, i),
      ).map((row, i) => ({ ...row, level: 0, x: 3 + i, y: 7, chunkKey: `0/0/0/0/7/${3 + i}` })),
      // One row on the wire at level 2.
      { ...makeRow({ startUs: 20 * MS, durations: { plan: 100, queue: MS }, outcome: "in-flight" }, 2), level: 2, z: 5, y: 1, x: 1, chunkKey: "2/0/0/5/1/1" },
      // One coarse-tier row at level 2, complete, on another dataset.
      {
        ...makeRow({ startUs: 30 * MS, durations: { plan: 100, queue: MS, wire: 5 * MS, decode: MS, upload: MS, present: MS } }, 3),
        datasetId: "other",
        residencyTier: "coarse" as const,
        level: 2,
        y: 0,
        x: 0,
        chunkKey: "2/0/0/0/0/0",
      },
      // One retired row at level 0.
      { ...makeRow({ startUs: 40 * MS, durations: { plan: 100, queue: MS, wire: 2 * MS }, outcome: "retired" }, 4), level: 0, y: 9, x: 9, chunkKey: "0/0/0/0/9/9" },
    ];
    const summary = summariseSpace(makeRun({ header: { durationUs: 100 * MS, datasetIds: ["ds", "other"] }, rows }));

    expect(summary.rowCount).toBe(5);
    expect(summary.levelCount).toBe(2);
    expect(
      summary.groups.map((group) => [group.state, group.datasetId, group.residencyTier, group.level, group.n]),
    ).toEqual([
      ["wire", "ds", "detail", 2, 1],
      ["complete", "ds", "detail", 0, 2],
      ["complete", "other", "coarse", 2, 1],
      ["retired", "ds", "detail", 0, 1],
    ]);
    expect(summary.groups[1].box).toEqual({ min: [0, 0, 0, 7, 3], max: [0, 0, 0, 7, 4] });
    expect(summary.groups[0].box).toEqual({ min: [0, 0, 5, 1, 1], max: [0, 0, 5, 1, 1] });
    expect(summary.groups[0].oldestMs).toBe(80);
  });

  it("states its coordinate system and what it cannot show, and is empty on a run with no rows", () => {
    const summary = summariseSpace(makeRun({ header: { durationUs: 100 * MS } }));

    expect(summary.rowCount).toBe(0);
    expect(summary.groups).toEqual([]);
    expect(summary.groupCount).toBe(0);
    expect(summary.coordinates).toContain("chunk indices");
    expect(summary.cannotShow.length).toBeGreaterThan(0);
    for (const line of summary.cannotShow) expect(line).not.toBe("");
  });
});
