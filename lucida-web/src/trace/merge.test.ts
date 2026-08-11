import { describe, expect, it } from "vitest";

import { placeServerRows } from "./merge.ts";
import type { StoredServerRow } from "./serverRowTable.ts";
import type { TraceRow } from "./types.ts";

function browserRow(overrides: Partial<TraceRow> & { rid: number }): TraceRow {
  return {
    rid: overrides.rid,
    connectionGeneration: overrides.connectionGeneration ?? 1,
    datasetId: "ds-1",
    entityId: "e-1",
    imageId: "img-1",
    lane: overrides.lane ?? "detail",
    residencyTier: "detail",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: "0/0/0/0/0/0",
    outcome: "complete",
    phases: overrides.phases ?? { wire: { startUs: 1_000, endUs: 11_000, durationUs: 10_000 } },
  };
}

function serverRow(overrides: Partial<StoredServerRow> & { rid: number }): StoredServerRow {
  return {
    rid: overrides.rid,
    connectionGeneration: overrides.connectionGeneration ?? 1,
    family: overrides.family ?? "chunk",
    outcome: overrides.outcome ?? "delivered",
    coalescedOnto: overrides.coalescedOnto ?? null,
    // 6,000 µs of server time, spread over the phases a source chunk
    // passes through.
    phases: overrides.phases ?? {
      arrival: 100,
      "binding-lookup": 100,
      dispatch: 200,
      "cache-lookup": 100,
      "permit-wait": 3_000,
      "backend-read": 2_000,
      decompress: 400,
      "slice-encode": 50,
      handoff: 50,
    },
    dispatchOffsetUs: overrides.dispatchOffsetUs ?? 0,
    durationUs: overrides.durationUs ?? 0,
    requestId: overrides.requestId ?? null,
    metadataPhase: overrides.metadataPhase ?? null,
  };
}

describe("placeServerRows", () => {
  it("nests the server's span inside the browser's bracket and names the remainder", () => {
    const [placed] = placeServerRows([browserRow({ rid: 7 })], [serverRow({ rid: 7 })], []);

    const placement = placed.placement!;
    // Bracket is 10,000 µs; the server accounts for 6,000 of it.
    expect(placement.gapUs).toBe(4_000);
    expect(placement.startUs).toBe(3_000);
    expect(placement.endUs).toBe(9_000);
    expect(placement.startUs).toBeGreaterThanOrEqual(1_000);
    expect(placement.endUs).toBeLessThanOrEqual(11_000);
    expect(placement.overshootUs).toBe(0);
    expect(placed.unplacedReason).toBeNull();
  });

  it("never lets the server's clock push a span outside the bracket", () => {
    // The server claims 20 ms inside a 10 ms bracket. Two clocks disagreeing
    // is not a longer server, and the browser's is the one we trust.
    const [placed] = placeServerRows(
      [browserRow({ rid: 7 })],
      [serverRow({ rid: 7, phases: { "permit-wait": 20_000 } })],
      [],
    );

    const placement = placed.placement!;
    expect(placement.startUs).toBe(1_000);
    expect(placement.endUs).toBe(11_000);
    expect(placement.gapUs).toBe(0);
    // The size of the disagreement, not just its existence: 3 µs and 3 s
    // are not the same news.
    expect(placement.overshootUs).toBe(10_000);
  });

  it("joins on the generation as well as the label", () => {
    const rows = placeServerRows(
      [
        browserRow({ rid: 0, connectionGeneration: 1 }),
        browserRow({
          rid: 0,
          connectionGeneration: 2,
          phases: { wire: { startUs: 50_000, endUs: 90_000, durationUs: 40_000 } },
        }),
      ],
      [
        serverRow({ rid: 0, connectionGeneration: 1 }),
        serverRow({ rid: 0, connectionGeneration: 2 }),
      ],
      [],
    );

    // Two requests that share `rid: 0` across a reconnect must not collapse
    // into each other's brackets.
    expect(rows[0].placement!.startUs).toBeGreaterThanOrEqual(1_000);
    expect(rows[0].placement!.endUs).toBeLessThanOrEqual(11_000);
    expect(rows[1].placement!.startUs).toBeGreaterThanOrEqual(50_000);
  });

  it("spans the union of the bracket when several rows coalesced onto one label", () => {
    const rows = placeServerRows(
      [
        browserRow({ rid: 4, phases: { wire: { startUs: 2_000, endUs: 9_000, durationUs: 7_000 } } }),
        browserRow({ rid: 4, phases: { wire: { startUs: 1_000, endUs: 11_000, durationUs: 10_000 } } }),
      ],
      [serverRow({ rid: 4 })],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].placement!.gapUs).toBe(4_000);
  });

  it("does not read a not-ready answer as a server stall", () => {
    // The server answered with a status, so no bytes are coming and the
    // browser's bracket never closes. Placing the row inside a bracket that
    // has no end would charge the server for a wait it is not having.
    const [placed] = placeServerRows(
      [browserRow({ rid: 7, phases: {}, outcome: "in-flight" })],
      [serverRow({ rid: 7, outcome: "not-ready", phases: { arrival: 300 } })],
      [],
    );

    expect(placed.placement).toBeNull();
    expect(placed.unplacedReason).toBe("answered-without-delivery");
    // The server's own numbers survive: it did do 300 µs of honest work.
    expect(placed.phases.arrival).toBe(300);
  });

  it("never joins an unlabelled row, whose rid 0 is not a label", () => {
    // Generation 0 means no wire request went out. A connection's genuine
    // first request is also rid 0, so treating the two alike would place a
    // server row inside a bracket that belongs to nothing.
    const [placed] = placeServerRows(
      [browserRow({ rid: 0, connectionGeneration: 0 })],
      [serverRow({ rid: 0, connectionGeneration: 1 })],
      [],
    );
    expect(placed.unplacedReason).toBe("no-browser-row");
  });

  it("lays an open's metadata reads out across the open's own bracket", () => {
    const open = { requestId: "web-open-4c1a", startUs: 1_000, endUs: 5_000_000 };
    const [first, second] = placeServerRows(
      [],
      [
        serverRow({
          rid: 0,
          family: "metadata-read",
          requestId: "web-open-4c1a",
          metadataPhase: "backend-read",
          dispatchOffsetUs: 200_000,
          durationUs: 63_000,
        }),
        serverRow({
          rid: 0,
          family: "metadata-read",
          requestId: "web-open-4c1a",
          metadataPhase: "cache-hit",
          dispatchOffsetUs: 900_000,
          durationUs: 2,
        }),
      ],
      [open],
    );

    // Each read sits where inside the open it happened. Centring them, as a
    // labelled row is centred in its bracket, would stack every read of a
    // cold open at one instant and say nothing about where the time went.
    expect(first.placement).toEqual({
      startUs: 201_000,
      endUs: 264_000,
      gapUs: 0,
      overshootUs: 0,
    });
    expect(second.placement?.startUs).toBe(901_000);
  });

  it("places a still-running open's reads, and clamps one that outruns the bracket", () => {
    const [running] = placeServerRows(
      [],
      [
        serverRow({
          rid: 0,
          family: "metadata-read",
          requestId: "web-open-4c1a",
          dispatchOffsetUs: 10,
          durationUs: 90,
        }),
      ],
      [{ requestId: "web-open-4c1a", startUs: 1_000, endUs: null }],
    );
    // A run that closed over an open still going is exactly the run someone
    // is reading, so its reads are placed rather than withheld.
    expect(running.placement).toEqual({ startUs: 1_010, endUs: 1_100, gapUs: 0, overshootUs: 0 });

    const [overrun] = placeServerRows(
      [],
      [
        serverRow({
          rid: 0,
          family: "metadata-read",
          requestId: "web-open-4c1a",
          dispatchOffsetUs: 10,
          durationUs: 90,
        }),
      ],
      [{ requestId: "web-open-4c1a", startUs: 1_000, endUs: 1_050 }],
    );
    // The bracket is the one measured on a single clock, so it wins and the
    // disagreement is reported at its actual size.
    expect(overrun.placement?.endUs).toBe(1_050);
    expect(overrun.placement?.overshootUs).toBe(50);
  });

  it("says an open it never saw sent, rather than blaming a missing browser row", () => {
    const [placed] = placeServerRows(
      [],
      [serverRow({ rid: 0, family: "metadata-read", requestId: "web-open-older" })],
      [{ requestId: "web-open-4c1a", startUs: 1_000, endUs: 2_000 }],
    );
    expect(placed.placement).toBeNull();
    expect(placed.unplacedReason).toBe("no-open-bracket");
  });

  it("distinguishes an open bracket from a label the browser never recorded", () => {
    const [openBracket] = placeServerRows(
      [browserRow({ rid: 7, phases: {}, outcome: "in-flight" })],
      [serverRow({ rid: 7 })],
      [],
    );
    expect(openBracket.unplacedReason).toBe("bracket-open");

    const [unknown] = placeServerRows([], [serverRow({ rid: 7 })], []);
    expect(unknown.unplacedReason).toBe("no-browser-row");
  });
});
