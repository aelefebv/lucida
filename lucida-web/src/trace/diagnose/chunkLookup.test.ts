/**
 * The chunk lookup: "why is this chunk not resident", answered in text from
 * the rows the run recorded. Every case asserts on the lookup as a section
 * of the diagnostic document, against rows whose timings the fixtures fix.
 */

import { describe, expect, it } from "vitest";

import { healthyLocalOpen, makeRow, makeRun, saturatedReopen } from "./fixtures.ts";
import { lookupChunk, MAX_CHUNK_ROWS, parseChunkSelector, worstRowSelector } from "./chunkLookup.ts";
import { diagnoseRun } from "./diagnose.ts";
import { rollupPhases } from "./phaseRollup.ts";

const MS = 1_000;

describe("the chunk selector", () => {
  it("reads a bare chunk key, and an entity ahead of one", () => {
    expect(parseChunkSelector("1/0/0/0/119/0")).toEqual({ entityId: null, chunkKey: "1/0/0/0/119/0" });
    expect(parseChunkSelector("member-7/1/0/0/0/119/0")).toEqual({
      entityId: "member-7",
      chunkKey: "1/0/0/0/119/0",
    });
    // An entity id may itself contain the separator; the key is always the last six.
    expect(parseChunkSelector("group/a/2/0/1/0/3/4")).toEqual({
      entityId: "group/a",
      chunkKey: "2/0/1/0/3/4",
    });
  });

  it("rejects anything that does not end in six coordinates", () => {
    expect(parseChunkSelector("1/0/0")).toBeNull();
    expect(parseChunkSelector("a/b/c/d/e/f")).toBeNull();
    expect(parseChunkSelector("")).toBeNull();
    expect(parseChunkSelector("1/0/0/0/-1/0")).toBeNull();
  });
});

describe("looking up one chunk", () => {
  it("returns the phase history, the queue rank and the age of a known row", () => {
    const lookup = lookupChunk(healthyLocalOpen(), "member-7/1/0/0/0/119/0", "named by the caller");

    expect(lookup.chunkKey).toBe("1/0/0/0/119/0");
    expect(lookup.entityId).toBe("member-7");
    expect(lookup.rowCount).toBe(1);
    expect(lookup.entityCount).toBe(1);
    expect(lookup.rows).toHaveLength(1);

    const row = lookup.rows[0];
    expect(row.id).toBe(1);
    expect(row.entityId).toBe("member-7");
    expect(row.lane).toBe("detail");
    expect(row.residencyTier).toBe("detail");
    expect(row.outcome).toBe("complete");
    expect(row.state).toBe("complete");
    // Row 119 starts at 40 ms + 119 × 0.2 ms and walks every phase.
    expect(row.firstSeenMs).toBe(63.8);
    expect(row.phases.map((phase) => phase.phase)).toEqual([
      "plan",
      "queue",
      "wire",
      "decode",
      "upload",
      "present",
    ]);
    expect(row.phases[2]).toEqual({ phase: "wire", startMs: 66.2, endMs: 306.2, durationMs: 240 });
    expect(row.ageMs).toBe(246.5);
    // Admitted at 64.2 ms. Rows 110 to 118 were admitted earlier and had not
    // dispatched yet; nothing admitted later went first.
    expect(row.queue).toEqual({ aheadAtAdmission: 9, overtaken: 0, waitedMs: 2, dispatched: true });
    expect(lookup.events).toEqual([]);
    expect(lookup.statement).toContain("1 row");
  });

  it("reads a row the table holds in the queue as waiting, with its rank now", () => {
    // The recorder never makes this row: one is born at dispatch with its queue
    // phase stamped, so a chunk still queued at close has no row. The table can
    // hold the shape and the fixture does, so the reading has to be right for it.
    const lookup = lookupChunk(saturatedReopen(), "1/0/0/0/300/0", "named by the caller");
    const row = lookup.rows[0];

    expect(row.outcome).toBe("in-flight");
    expect(row.state).toBe("queue");
    // Planned at 50 ms + 300 × 27 ms, and still there when the run timed out.
    expect(row.firstSeenMs).toBe(8_150);
    expect(row.ageMs).toBe(3_850);
    // Rows 130 to 259 had been admitted and not dispatched when this one was
    // admitted, and rows 260 to 299 were waiting in front of it too.
    expect(row.queue).toEqual({
      aheadAtAdmission: 170,
      overtaken: 0,
      waitedMs: 3_849.7,
      dispatched: false,
    });
  });

  it("counts the rows admitted later that went first", () => {
    const rows = [
      // Admitted first, dispatched last.
      makeRow({ startUs: 10 * MS, durations: { plan: 100, queue: 50 * MS, wire: 5 * MS } }, 0),
      // Admitted 1 ms later, dispatched 40 ms before the first.
      makeRow({ startUs: 11 * MS, durations: { plan: 100, queue: 9 * MS, wire: 5 * MS } }, 1),
      makeRow({ startUs: 12 * MS, durations: { plan: 100, queue: 9 * MS, wire: 5 * MS } }, 2),
    ];
    const run = makeRun({ header: { durationUs: 100 * MS }, rows });

    const first = lookupChunk(run, "1/0/0/0/0/0", "named by the caller").rows[0];
    expect(first.queue).toEqual({ aheadAtAdmission: 0, overtaken: 2, waitedMs: 50, dispatched: true });
    const second = lookupChunk(run, "1/0/0/0/1/0", "named by the caller").rows[0];
    expect(second.queue).toEqual({ aheadAtAdmission: 1, overtaken: 0, waitedMs: 9, dispatched: true });
  });

  it("says when the chunk is not in the run rather than inventing a row", () => {
    const lookup = lookupChunk(healthyLocalOpen(), "1/0/0/0/999/0", "named by the caller");

    expect(lookup.rows).toEqual([]);
    expect(lookup.rowCount).toBe(0);
    expect(lookup.statement).toContain("not in this run");
    // A row is born at dispatch, so "no row" names the two things it can mean.
    expect(lookup.statement).toContain("never dispatched");
  });

  it("says when the selector is not a chunk at all", () => {
    const lookup = lookupChunk(healthyLocalOpen(), "wire", "named by the caller");
    expect(lookup.chunkKey).toBeNull();
    expect(lookup.rows).toEqual([]);
    expect(lookup.statement).toContain("not a chunk selector");
  });

  it("carries the point events about the chunk, with or without a row", () => {
    const chunk = {
      datasetId: "ds",
      entityId: "member-0",
      imageId: "image-1",
      residencyTier: "detail" as const,
      level: 1,
      t: 0,
      c: 0,
      z: 0,
      y: 0,
      x: 0,
      chunkKey: "1/0/0/0/0/0",
    };
    const run = makeRun({
      header: { durationUs: 5_000 * MS },
      events: [
        { atUs: 3_200 * MS, kind: "eviction", reason: "evicted", chunk, levelChange: null },
        { atUs: 3_300 * MS, kind: "retry", reason: "transient", chunk, levelChange: null },
        {
          atUs: 3_400 * MS,
          kind: "eviction",
          reason: "evicted",
          chunk: { ...chunk, entityId: "member-5" },
          levelChange: null,
        },
      ],
    });

    const bare = lookupChunk(run, "1/0/0/0/0/0", "named by the caller");
    expect(bare.rowCount).toBe(0);
    expect(bare.eventCount).toBe(3);
    expect(bare.events.map((event) => [event.kind, event.atMs, event.entityId])).toEqual([
      ["eviction", 3_200, "member-0"],
      ["retry", 3_300, "member-0"],
      ["eviction", 3_400, "member-5"],
    ]);
    expect(bare.statement).toContain("not in this run");

    const narrowed = lookupChunk(run, "member-5/1/0/0/0/0/0", "named by the caller");
    expect(narrowed.eventCount).toBe(1);
  });

  it("caps a key shared across a collection and says how to narrow it", () => {
    // The same chunk key exists once per tile; a bare key matches every tile.
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ...makeRow({ startUs: 10 * MS + i * MS, durations: { plan: 100, queue: MS, wire: 20 * MS } }, i),
      entityId: `tile-${i}`,
      y: 0,
      chunkKey: "1/0/0/0/0/0",
    }));
    const run = makeRun({ header: { durationUs: 500 * MS }, rows });

    const bare = lookupChunk(run, "1/0/0/0/0/0", "named by the caller");
    expect(bare.rowCount).toBe(40);
    expect(bare.entityCount).toBe(40);
    expect(bare.rows).toHaveLength(MAX_CHUNK_ROWS);
    // Oldest first.
    expect(bare.rows.map((row) => row.entityId)).toEqual(
      Array.from({ length: MAX_CHUNK_ROWS }, (_, i) => `tile-${i}`),
    );
    expect(bare.statement).toContain("name the entity");

    const one = lookupChunk(run, "tile-33/1/0/0/0/0/0", "named by the caller");
    expect(one.rowCount).toBe(1);
    expect(one.rows[0].entityId).toBe("tile-33");
  });

  it("lists a refetched chunk as one history, oldest first", () => {
    const rows = [
      makeRow({ startUs: 100 * MS, durations: { plan: 100, queue: MS, wire: 20 * MS } }, 0),
      makeRow({ startUs: 900 * MS, durations: { plan: 100, queue: MS, wire: 30 * MS } }, 7),
    ].map((row) => ({ ...row, y: 4, chunkKey: "1/0/0/0/4/0", entityId: "member-1" }));
    const run = makeRun({ header: { durationUs: 1_000 * MS }, rows: [rows[1], rows[0]] });

    const lookup = lookupChunk(run, "member-1/1/0/0/0/4/0", "named by the caller");
    expect(lookup.rowCount).toBe(2);
    expect(lookup.rows.map((row) => row.firstSeenMs)).toEqual([100, 900]);
    expect(lookup.rows.map((row) => row.id)).toEqual([1, 2]);
    expect(lookup.statement).toContain("2 rows");
  });
});

describe("the worst row", () => {
  it("is the row that spent longest in the lead finding's phase, named with its entity", () => {
    const run = healthyLocalOpen();
    const document = diagnoseRun(run);
    const choice = worstRowSelector(run, rollupPhases(run), document.findings);

    // The healthy open has no finding; the largest browser phase is the wire,
    // and row 119 is the one that spent 240 ms on it.
    expect(choice).toEqual({
      selector: "member-7/1/0/0/0/119/0",
      chosen: "the row that spent longest in browser.wire",
    });
  });

  it("is null when the run recorded no chunk row", () => {
    const run = makeRun({ header: { durationUs: 100 * MS } });
    expect(worstRowSelector(run, rollupPhases(run), [])).toBeNull();
  });
});
