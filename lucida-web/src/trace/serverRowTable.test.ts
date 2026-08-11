import { describe, expect, it } from "vitest";

import { ServerRowTable, type ServerTimingBatch } from "./serverRowTable.ts";

function batch(overrides: Partial<ServerTimingBatch> = {}): ServerTimingBatch {
  return {
    dropped: 0,
    rid: [1, 2],
    request_id: [null, null],
    family: ["chunk", "asset"],
    metadata_phase: [null, null],
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
        requestId: null,
        metadataPhase: null,
      },
      {
        rid: 2,
        connectionGeneration: 3,
        family: "asset",
        outcome: "not-ready",
        dispatchOffsetUs: 20,
        durationUs: 2_000,
        requestId: null,
        metadataPhase: null,
      },
    ]);
  });

  it("translates the wire vocabulary and refuses to read a strange word as success", () => {
    const table = new ServerRowTable();
    table.ingest(
      batch({
        rid: [1],
        request_id: [null],
        family: ["chunk"],
        metadata_phase: [null],
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

  it("keys a metadata read on its open and translates the phase vocabulary", () => {
    const table = new ServerRowTable();
    table.ingest(
      batch({
        rid: [0, 0],
        request_id: ["web-open-4c1a", "web-open-4c1a"],
        family: ["metadata_read", "metadata_read"],
        metadata_phase: ["backend_read", "coalesced_wait"],
        dispatch_offset_us: [1_204, 1_990],
        duration_us: [63_441, 400],
        outcome: ["delivered", "delivered"],
      }),
      1,
    );

    const rows = table.serialise();
    expect(rows.map(row => [row.family, row.requestId, row.metadataPhase])).toEqual([
      ["metadata-read", "web-open-4c1a", "backend-read"],
      ["metadata-read", "web-open-4c1a", "coalesced-wait"],
    ]);
  });

  it("interns the open id, so one open's hundreds of reads hold one string", () => {
    const table = new ServerRowTable();
    for (let i = 0; i < 4; i++) {
      table.ingest(
        batch({
          rid: [0],
          request_id: ["web-open-4c1a"],
          family: ["metadata_read"],
          metadata_phase: ["cache_hit"],
          dispatch_offset_us: [i],
          duration_us: [1],
          outcome: ["delivered"],
        }),
        1,
      );
    }
    const ids = new Set(table.serialise().map(row => row.requestId));
    expect(ids).toEqual(new Set(["web-open-4c1a"]));
    // The first pool entry is index 0, and a row that is not keyed on an
    // open must still read as unkeyed rather than borrowing it.
    table.ingest(batch({ rid: [9], request_id: [null], family: ["chunk"], metadata_phase: [null],
      dispatch_offset_us: [1], duration_us: [1], outcome: ["delivered"] }), 1);
    expect(table.serialise().at(-1)?.requestId).toBeNull();
  });

  it("leaves an unreadable phase unset rather than guessing at one", () => {
    const table = new ServerRowTable();
    table.ingest(
      batch({
        rid: [0],
        request_id: ["web-open-4c1a"],
        family: ["metadata_read"],
        metadata_phase: ["sideways" as never],
        dispatch_offset_us: [1],
        duration_us: [1],
        outcome: ["delivered"],
      }),
      1,
    );
    // A wrong guess would report a coalesced wait as a backend round trip,
    // which is a different diagnosis with a different fix.
    expect(table.serialise()[0].metadataPhase).toBeNull();
  });

  it("grows by doubling rather than reallocating per row", () => {
    const table = new ServerRowTable(2);
    for (let i = 0; i < 5; i++) table.ingest(batch(), 1);
    expect(table.length).toBe(10);
    expect(table.serialise()).toHaveLength(10);
    expect(table.byteLength).toBe(16 * ServerRowTable.BYTES_PER_ROW);
  });
});
