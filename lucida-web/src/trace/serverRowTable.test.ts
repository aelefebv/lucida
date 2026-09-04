import { describe, expect, it } from "vitest";

import { serverRowTotalUs, ServerRowTable, type ServerTimingBatch } from "./serverRowTable.ts";
import { LABEL_NONE, PHASE_UNSET } from "./types.ts";

/**
 * Two rows: a source chunk that led its own read, and a generated chunk
 * that never touched the store — so the second row's store phases are
 * unset rather than zero.
 */
function batch(overrides: Partial<ServerTimingBatch> = {}): ServerTimingBatch {
  return {
    dropped: 0,
    rid: [1, 2],
    request_id: [null, null],
    family: ["chunk", "asset"],
    metadata_phase: [null, null],
    dispatch_offset_us: [0, 0],
    duration_us: [0, 0],
    outcome: ["delivered", "not_ready"],
    arrival_us: [10, 20],
    binding_lookup_us: [5, 6],
    dispatch_us: [7, 8],
    cache_lookup_us: [1, 2],
    permit_wait_us: [900, PHASE_UNSET],
    backend_read_us: [60, PHASE_UNSET],
    coalesced_wait_us: [PHASE_UNSET, PHASE_UNSET],
    decompress_us: [20, PHASE_UNSET],
    slice_encode_us: [4, PHASE_UNSET],
    handoff_us: [3, 9],
    backend_bytes: [4_096, null],
    coalesced_onto: [LABEL_NONE, LABEL_NONE],
    ...overrides,
  };
}

/**
 * Whether a row is joinable is the recorder's question — it holds the labels
 * and the opens. These tests are about the copy, so they take every row.
 */
const ingest = (table: ServerRowTable, rows: ServerTimingBatch, generation: number) =>
  table.ingest(rows, generation, () => true);

describe("ServerRowTable", () => {
  it("copies a batch's columns in and stamps the arriving connection", () => {
    const table = new ServerRowTable(1);
    ingest(table, batch(), 3);

    expect(table.length).toBe(2);
    expect(table.serialise()).toEqual([
      {
        rid: 1,
        connectionGeneration: 3,
        family: "chunk",
        outcome: "delivered",
        coalescedOnto: null,
        phases: {
          arrival: 10,
          "binding-lookup": 5,
          dispatch: 7,
          "cache-lookup": 1,
          "permit-wait": 900,
          "backend-read": 60,
          decompress: 20,
          "slice-encode": 4,
          handoff: 3,
        },
        // The bytes the round trip returned travel with it.
        backendBytes: 4_096,
        dispatchOffsetUs: 0,
        durationUs: 0,
        requestId: null,
        metadataPhase: null,
      },
      {
        rid: 2,
        connectionGeneration: 3,
        family: "asset",
        outcome: "not-ready",
        coalescedOnto: null,
        // Unentered phases are absent, not zero: a stage that never ran and
        // one that ran instantly are different facts.
        phases: { arrival: 20, "binding-lookup": 6, dispatch: 8, "cache-lookup": 2, handoff: 9 },
        // No round trip, so no byte count either, rather than a zero that
        // would read as an empty object.
        backendBytes: null,
        dispatchOffsetUs: 0,
        durationUs: 0,
        requestId: null,
        metadataPhase: null,
      },
    ]);
  });

  it("sums only the phases a row entered", () => {
    const table = new ServerRowTable();
    ingest(table, batch(), 1);
    const [chunk, asset] = table.serialise();
    expect(serverRowTotalUs(chunk.phases)).toBe(10 + 5 + 7 + 1 + 900 + 60 + 20 + 4 + 3);
    expect(serverRowTotalUs(asset.phases)).toBe(20 + 6 + 8 + 2 + 9);
  });

  it("keeps a follower's wait apart from a backend read", () => {
    const table = new ServerRowTable();
    ingest(table, 
      batch({
        rid: [9],
        family: ["chunk"],
        outcome: ["delivered"],
        arrival_us: [1],
        binding_lookup_us: [1],
        dispatch_us: [1],
        cache_lookup_us: [1],
        permit_wait_us: [PHASE_UNSET],
        backend_read_us: [PHASE_UNSET],
        coalesced_wait_us: [400_000],
        decompress_us: [10],
        slice_encode_us: [1],
        handoff_us: [1],
        backend_bytes: [null],
        coalesced_onto: [4_321],
      }),
      1,
    );
    const [follower] = table.serialise();
    // The diagnosis is "waited on a read already in flight", not "the
    // backend was slow" — a different fix.
    expect(follower.phases["coalesced-wait"]).toBe(400_000);
    expect(follower.phases["backend-read"]).toBeUndefined();
    expect(follower.phases["permit-wait"]).toBeUndefined();
    // The bytes belong to the leader's row: summing the column must count
    // each byte the backend moved exactly once.
    expect(follower.backendBytes).toBeNull();
    // And it names the read it waited on, so the wait joins to the row that
    // owns the round trip.
    expect(follower.coalescedOnto).toBe(4_321);
  });

  it("translates the wire vocabulary and refuses to read a strange word as success", () => {
    const table = new ServerRowTable();
    ingest(table, 
      batch({
        rid: [1],
        request_id: [null],
        family: ["chunk"],
        metadata_phase: [null],
        dispatch_offset_us: [0],
        duration_us: [0],
        outcome: ["sideways" as never],
        arrival_us: [1],
        binding_lookup_us: [1],
        dispatch_us: [1],
        cache_lookup_us: [1],
        permit_wait_us: [1],
        backend_read_us: [1],
        coalesced_wait_us: [PHASE_UNSET],
        decompress_us: [1],
        slice_encode_us: [1],
        handoff_us: [1],
      }),
      1,
    );
    // Drift between the two sides is what the goldens prevent; if one gets
    // through, it must not be able to hide a request that never landed.
    expect(table.serialise()[0].outcome).toBe("failed");
  });

  it("accumulates what the server declared it dropped", () => {
    const table = new ServerRowTable();
    ingest(table, batch({ dropped: 4 }), 1);
    ingest(table, batch({ dropped: 7 }), 1);
    // Two sources of loss, both reported: a coverage block that counted only
    // the browser's would overstate coverage for the other side.
    expect(table.droppedCount).toBe(11);
  });

  it("stores only the rows the caller accepts, and reports how many it refused", () => {
    const table = new ServerRowTable();
    const refused = table.ingest(batch(), 1, rid => rid === 2);

    expect(refused).toBe(1);
    expect(table.length).toBe(1);
    expect(table.serialise()[0].rid).toBe(2);
    // A refusal costs no capacity and is not a server-declared drop: the two
    // losses have different causes and different lines in the coverage block.
    expect(table.droppedCount).toBe(0);
  });

  it("keeps rows whole when a malformed batch's columns disagree", () => {
    const table = new ServerRowTable();
    ingest(table, batch({ handoff_us: [1_000] }), 1);
    // Better one row short than a row assembled from another row's numbers.
    expect(table.length).toBe(1);
    expect(table.serialise()[0].phases.handoff).toBe(1_000);

    const short = new ServerRowTable();
    ingest(short, batch({ backend_bytes: [7] }), 1);
    expect(short.length).toBe(1);
    expect(short.serialise()[0].backendBytes).toBe(7);
  });

  it("keys a metadata read on its open and translates the phase vocabulary", () => {
    const table = new ServerRowTable();
    ingest(table, 
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
      ingest(table, 
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
    ingest(table, batch({ rid: [9], request_id: [null], family: ["chunk"], metadata_phase: [null],
      dispatch_offset_us: [1], duration_us: [1], outcome: ["delivered"] }), 1);
    expect(table.serialise().at(-1)?.requestId).toBeNull();
  });

  it("leaves an unreadable phase unset rather than guessing at one", () => {
    const table = new ServerRowTable();
    ingest(table, 
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
    for (let i = 0; i < 5; i++) ingest(table, batch(), 1);
    expect(table.length).toBe(10);
    expect(table.serialise()).toHaveLength(10);
    expect(table.byteLength).toBe(16 * ServerRowTable.BYTES_PER_ROW);
  });
});
