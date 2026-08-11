import { describe, it, expect } from "vitest";

import { RowTable } from "./rowTable.ts";
import { Boundary, PHASES, RowOutcome, UNSET_STAMP, BOUNDARY_COUNT } from "./types.ts";

function source(overrides: Partial<Parameters<RowTable["append"]>[0]> = {}) {
  return {
    datasetId: "ds",
    entityId: "member-1",
    imageId: "image-1",
    lane: "detail" as const,
    level: 2,
    t: 3,
    c: 1,
    z: 4,
    y: 5,
    x: 6,
    ...overrides,
  };
}

describe("RowTable", () => {
  it("preallocates and grows only by doubling", () => {
    const table = new RowTable(2);
    expect(table.capacityRows).toBe(2);

    table.append(source(), 0);
    table.append(source(), 0);
    expect(table.capacityRows).toBe(2);

    table.append(source(), 0);
    expect(table.capacityRows).toBe(4);
    expect(table.length).toBe(3);

    table.append(source(), 0);
    table.append(source(), 0);
    expect(table.capacityRows).toBe(8);
  });

  it("pins the row width, because the memory caps are derived from it", () => {
    // 3 interned identity ids + 6 chunk coordinates + 7 boundary slots + the
    // two-part wire label, all uint32, plus a residency-tier byte, a lane
    // byte and an outcome byte. #927 derives its resident and per-run caps
    // from this figure, so a change here is a change to how much of a run
    // fits — the label costs 8 B a row, and buys the join to the server's
    // table.
    expect(RowTable.BYTES_PER_ROW).toBe(75);
  });

  it("carries lane as a column, not as a phase", () => {
    const table = new RowTable(2);
    table.append(source({ lane: "prefetch" }), 0);
    table.append(source({ lane: "minimap" }), 1);

    const rows = table.serialise();
    expect(rows.map(r => r.lane)).toEqual(["prefetch", "minimap"]);
    expect(rows.every(r => Object.keys(r.phases).length === 0)).toBe(true);
  });

  it("reports a fixed width per row", () => {
    const table = new RowTable(4);
    const empty = table.byteLength;
    table.append(source(), 0);
    table.append(source(), 0);
    // Capacity is what is allocated; four rows' worth either way.
    expect(table.byteLength).toBe(empty);
    expect(RowTable.BYTES_PER_ROW * 4).toBe(empty);
  });

  it("starts every boundary slot unset and every row in flight", () => {
    const table = new RowTable(1);
    const row = table.append(source(), 0);
    for (let b = 0; b < BOUNDARY_COUNT; b++) {
      expect(table.stampAt(row, b)).toBe(UNSET_STAMP);
    }
    expect(table.outcomeAt(row)).toBe(RowOutcome.InFlight);
  });

  it("keeps rows independent across a growth step", () => {
    const table = new RowTable(1);
    const first = table.append(source({ entityId: "a" }), 0);
    table.stamp(first, Boundary.WireStart, 100);
    const second = table.append(source({ entityId: "b" }), 1);
    table.stamp(second, Boundary.WireStart, 200);

    expect(table.stampAt(first, Boundary.WireStart)).toBe(100);
    expect(table.stampAt(second, Boundary.WireStart)).toBe(200);
    expect(table.serialise()[0].entityId).toBe("a");
    expect(table.serialise()[1].entityId).toBe("b");
  });

  it("distinguishes the two residency tiers sharing one chunk key", () => {
    const table = new RowTable(2);
    table.append(source(), 0);
    table.append(source(), 1);

    const rows = table.serialise();
    expect(rows.map(r => r.residencyTier)).toEqual(["detail", "coarse"]);
    expect(rows[0].chunkKey).toBe(rows[1].chunkKey);
  });

  it("rebuilds the canonical chunk key from its columns", () => {
    const table = new RowTable(1);
    table.append(source({ level: 2, t: 3, c: 1, z: 4, y: 5, x: 6 }), 0);
    expect(table.serialise()[0].chunkKey).toBe("2/3/1/4/5/6");
  });

  it("serialises a stamped boundary pair as one phase timing", () => {
    const table = new RowTable(1);
    const row = table.append(source(), 0);
    table.stamp(row, Boundary.WireStart, 1_000);
    table.stamp(row, Boundary.DecodeStart, 4_500);
    table.setOutcome(row, RowOutcome.Complete);

    const [serialised] = table.serialise();
    expect(serialised.outcome).toBe("complete");
    expect(serialised.phases.wire).toEqual({ startUs: 1_000, endUs: 4_500, durationUs: 3_500 });
    expect(serialised.phases.plan).toBeUndefined();
    expect(serialised.phases.decode).toBeUndefined();
  });

  it("omits a phase whose closing boundary was never reached", () => {
    const table = new RowTable(1);
    const row = table.append(source(), 0);
    table.stamp(row, Boundary.WireStart, 1_000);

    const [serialised] = table.serialise();
    expect(serialised.phases.wire).toBeUndefined();
    expect(serialised.outcome).toBe("in-flight");
  });

  it("interns repeated identity strings instead of storing them per row", () => {
    const table = new RowTable(4);
    for (let i = 0; i < 4; i++) table.append(source(), 0);
    expect(table.internedStringCount).toBe(3);
  });
});

describe("the live tally (#937)", () => {
  it("counts outcomes and parks each unfinished row in the phase it is sitting in", () => {
    const table = new RowTable(4);
    const occupancy = new Uint32Array(PHASES.length);

    const waiting = table.append(source(), 0);
    table.stamp(waiting, Boundary.QueueStart, 10);
    const onTheWire = table.append(source(), 0);
    table.stamp(onTheWire, Boundary.QueueStart, 10);
    table.stamp(onTheWire, Boundary.WireStart, 20);
    const drawn = table.append(source(), 0);
    table.stamp(drawn, Boundary.PresentEnd, 90);
    table.setOutcome(drawn, RowOutcome.Complete);
    const abandoned = table.append(source(), 0);
    table.setOutcome(abandoned, RowOutcome.Retired);

    const tally = table.liveTally(occupancy);

    expect(tally).toEqual({ complete: 1, retired: 1, inFlight: 2, unstamped: 0 });
    // A row's phase is the one after its last boundary: queue starts where
    // plan ended.
    expect(occupancy[PHASES.indexOf("queue")]).toBe(1);
    expect(occupancy[PHASES.indexOf("wire")]).toBe(1);
    expect(occupancy[PHASES.indexOf("present")]).toBe(0);
  });

  it("separates a row that has stamped nothing from one sitting in `plan`", () => {
    // A row exists from the moment the planner asks for it, before admission
    // stamps anything. Counting it as `plan` would invent time in a phase it
    // has not entered.
    const table = new RowTable(2);
    const occupancy = new Uint32Array(PHASES.length);
    table.append(source(), 0);
    const planned = table.append(source(), 0);
    table.stamp(planned, Boundary.PlanStart, 5);

    const tally = table.liveTally(occupancy);

    expect(tally.unstamped).toBe(1);
    expect(tally.inFlight).toBe(2);
    expect(occupancy[PHASES.indexOf("plan")]).toBe(1);
  });

  it("zeroes the caller's vector, so a poll reads this instant and not a sum of polls", () => {
    const table = new RowTable(2);
    const occupancy = new Uint32Array(PHASES.length);
    const row = table.append(source(), 0);
    table.stamp(row, Boundary.WireStart, 1);

    table.liveTally(occupancy);
    table.liveTally(occupancy);

    expect(occupancy[PHASES.indexOf("wire")]).toBe(1);
  });
});
