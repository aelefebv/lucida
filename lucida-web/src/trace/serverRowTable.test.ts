import { describe, expect, it } from "vitest";

import { serverRowTotalUs, ServerRowTable, type ServerTimingBatch } from "./serverRowTable.ts";
import { PHASE_UNSET } from "./types.ts";

/**
 * Two rows: a source chunk that led its own read, and a generated chunk
 * that never touched the store — so the second row's store phases are
 * unset rather than zero.
 */
function batch(overrides: Partial<ServerTimingBatch> = {}): ServerTimingBatch {
  return {
    dropped: 0,
    rid: [1, 2],
    family: ["chunk", "asset"],
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
      },
      {
        rid: 2,
        connectionGeneration: 3,
        family: "asset",
        outcome: "not-ready",
        // Unentered phases are absent, not zero: a stage that never ran and
        // one that ran instantly are different facts.
        phases: { arrival: 20, "binding-lookup": 6, dispatch: 8, "cache-lookup": 2, handoff: 9 },
      },
    ]);
  });

  it("sums only the phases a row entered", () => {
    const table = new ServerRowTable();
    table.ingest(batch(), 1);
    const [chunk, asset] = table.serialise();
    expect(serverRowTotalUs(chunk.phases)).toBe(10 + 5 + 7 + 1 + 900 + 60 + 20 + 4 + 3);
    expect(serverRowTotalUs(asset.phases)).toBe(20 + 6 + 8 + 2 + 9);
  });

  it("keeps a follower's wait apart from a backend read", () => {
    const table = new ServerRowTable();
    table.ingest(
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
      }),
      1,
    );
    const [follower] = table.serialise();
    // The diagnosis is "waited on a read already in flight", not "the
    // backend was slow" — a different fix.
    expect(follower.phases["coalesced-wait"]).toBe(400_000);
    expect(follower.phases["backend-read"]).toBeUndefined();
    expect(follower.phases["permit-wait"]).toBeUndefined();
  });

  it("translates the wire vocabulary and refuses to read a strange word as success", () => {
    const table = new ServerRowTable();
    table.ingest(
      batch({
        rid: [1],
        family: ["chunk"],
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
    table.ingest(batch({ dropped: 4 }), 1);
    table.ingest(batch({ dropped: 7 }), 1);
    // Two sources of loss, both reported: a coverage block that counted only
    // the browser's would overstate coverage for the other side.
    expect(table.droppedCount).toBe(11);
  });

  it("keeps rows whole when a malformed batch's columns disagree", () => {
    const table = new ServerRowTable();
    table.ingest(batch({ handoff_us: [1_000] }), 1);
    // Better one row short than a row assembled from another row's numbers.
    expect(table.length).toBe(1);
    expect(table.serialise()[0].phases.handoff).toBe(1_000);
  });

  it("grows by doubling rather than reallocating per row", () => {
    const table = new ServerRowTable(2);
    for (let i = 0; i < 5; i++) table.ingest(batch(), 1);
    expect(table.length).toBe(10);
    expect(table.serialise()).toHaveLength(10);
    expect(table.byteLength).toBe(16 * ServerRowTable.BYTES_PER_ROW);
  });
});
