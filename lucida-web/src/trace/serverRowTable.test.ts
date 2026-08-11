import { describe, expect, it } from "vitest";

import { ServerRowTable, type ServerTimingBatch } from "./serverRowTable.ts";

function batch(overrides: Partial<ServerTimingBatch> = {}): ServerTimingBatch {
  return {
    dropped: 0,
    rid: [1, 2],
    family: ["chunk", "asset"],
    dispatch_offset_us: [10, 20],
    duration_us: [1_000, 2_000],
    outcome: ["delivered", "not_ready"],
    ...overrides,
  };
}

describe("ServerRowTable", () => {
  it("copies a batch's columns in and stamps the arriving connection", () => {
    const table = new ServerRowTable(1);
    table.ingest(batch(), 3);

    expect(table.length).toBe(2);
    expect(table.serialise()).toEqual([
      {
        rid: 1,
        connectionGeneration: 3,
        family: "chunk",
        outcome: "delivered",
        dispatchOffsetUs: 10,
        durationUs: 1_000,
      },
      {
        rid: 2,
        connectionGeneration: 3,
        family: "asset",
        outcome: "not-ready",
        dispatchOffsetUs: 20,
        durationUs: 2_000,
      },
    ]);
  });

  it("translates the wire vocabulary and refuses to read a strange word as success", () => {
    const table = new ServerRowTable();
    table.ingest(
      batch({
        rid: [1],
        family: ["chunk"],
        dispatch_offset_us: [1],
        duration_us: [1],
        outcome: ["sideways" as never],
      }),
      1,
    );
    // Drift between the two sides is what the goldens prevent; if one gets
    // through, it must not be able to hide a request that never landed.
    expect(table.serialise()[0].outcome).toBe("failed");
  });

  it("accumulates what the server declared it dropped", () => {
    const table = new ServerRowTable();
    table.ingest(batch({ dropped: 4 }), 1);
    table.ingest(batch({ dropped: 7 }), 1);
    // Two sources of loss, both reported: a coverage block that counted only
    // the browser's would overstate coverage for the other side.
    expect(table.droppedCount).toBe(11);
  });

  it("keeps rows whole when a malformed batch's columns disagree", () => {
    const table = new ServerRowTable();
    table.ingest(batch({ duration_us: [1_000] }), 1);
    // Better one row short than a row assembled from another row's numbers.
    expect(table.length).toBe(1);
    expect(table.serialise()[0].durationUs).toBe(1_000);
  });

  it("grows by doubling rather than reallocating per row", () => {
    const table = new ServerRowTable(2);
    for (let i = 0; i < 5; i++) table.ingest(batch(), 1);
    expect(table.length).toBe(10);
    expect(table.serialise()).toHaveLength(10);
    expect(table.byteLength).toBe(16 * ServerRowTable.BYTES_PER_ROW);
  });
});
