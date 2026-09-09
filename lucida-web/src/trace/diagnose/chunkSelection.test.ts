/**
 * The chunk set a brushed window publishes, asserted over fixture runs: the
 * rows the window can see, narrowed to a phase when one is named, and the
 * statements of what the set cannot show. No browser, no dock, no overlay.
 */

import { describe, expect, it } from "vitest";

import { chunkIdentity } from "./chunkStates.ts";
import { selectChunks } from "./chunkSelection.ts";
import {
  coldRemoteOpen,
  lateStallOpen,
  makeRow,
  makeRun,
  makeServerRow,
  saturatedReopen,
} from "./fixtures.ts";
import { firstBoundaryUs } from "./rowState.ts";

const MS = 1_000;

describe("a window without a phase", () => {
  it("selects the chunks whose rows were active inside the window and no other", () => {
    // Sixty fast rows in the first second, forty stalled ones from 1.1 s on.
    const run = lateStallOpen();

    const early = selectChunks(run, { startMs: 0, endMs: 1_000 });
    const late = selectChunks(run, { startMs: 1_100, endMs: 2_000 });

    expect(early.chunks).toBe(60);
    expect(late.chunks).toBe(40);
    expect(early.phase).toBeNull();
    for (const row of run.rows.slice(0, 60)) {
      expect(early.identities.has(chunkIdentity(row.datasetId, row.entityId, row.chunkKey))).toBe(true);
      expect(late.identities.has(chunkIdentity(row.datasetId, row.entityId, row.chunkKey))).toBe(false);
    }
    // The window is stated as the derivation read it, on the run's clock.
    expect(early.window).toMatchObject({ startMs: 0, endMs: 1_000, spanMs: 1_000, ofWallMs: 2_000, whole: false });
    expect(early.statement).toContain("60 chunks");
    expect(early.statement).toContain("0..1000 ms");
  });

  it("counts a row that crosses the window's edge, because the part inside is inside", () => {
    const run = lateStallOpen();
    // Row 0 runs from 40 ms to about 64 ms. A window that opens at 50 ms sees its tail.
    const first = run.rows[0];
    const startMs = (firstBoundaryUs(first)! + 10 * MS) / 1_000;

    const selection = selectChunks(run, { startMs, endMs: startMs + 1 });

    expect(selection.identities.has(chunkIdentity(first.datasetId, first.entityId, first.chunkKey))).toBe(true);
  });

  it("charges a row still in flight to the run's close, so a late window still sees it", () => {
    // The undispatched rows of the saturated re-open finish `plan` and sit in
    // the queue until the run times out.
    const run = saturatedReopen();
    const stuck = run.rows[399];
    expect(stuck.outcome).toBe("in-flight");

    const tail = selectChunks(run, { startMs: 11_900, endMs: 12_000 });

    expect(tail.identities.has(chunkIdentity(stuck.datasetId, stuck.entityId, stuck.chunkKey))).toBe(true);
  });

  it("reads the whole run as the set of every positioned chunk, exactly as no window would", () => {
    const run = lateStallOpen();
    const whole = selectChunks(run, { startMs: 0, endMs: 2_000 });
    const positioned = new Set(
      run.rows
        .filter((row) => firstBoundaryUs(row) !== null)
        .map((row) => chunkIdentity(row.datasetId, row.entityId, row.chunkKey)),
    );

    expect(whole.window.whole).toBe(true);
    expect(whole.chunks).toBe(positioned.size);
    expect([...whole.identities].sort()).toEqual([...positioned].sort());
  });

  it("leaves out a row with no boundary and says so, rather than placing it nowhere", () => {
    const rows = [
      makeRow({ startUs: 10 * MS, durations: { plan: 200, queue: 5 * MS } }, 0),
      // Reached no boundary: the recorder never makes one, the table can hold one.
      { ...makeRow({ startUs: 20 * MS, durations: {} }, 1), phases: {}, outcome: "in-flight" as const },
    ];
    const run = makeRun({ header: { durationUs: 100 * MS }, rows });

    const selection = selectChunks(run, { startMs: 0, endMs: 100 });

    expect(selection.chunks).toBe(1);
    expect(selection.cannotShow.some((line) => line.includes("no boundary"))).toBe(true);
  });

  it("refuses an empty window with the derivation's own words", () => {
    expect(() => selectChunks(lateStallOpen(), { startMs: 500, endMs: 500 })).toThrow(/empty/);
  });
});

describe("narrowed to a browser phase", () => {
  it("keeps only the chunks whose rows were in that phase during the window", () => {
    // The stalled rows' decode starts 20.4 ms after each row starts, at
    // 1,100 ms + 10 ms per row, and lasts 400 ms. A window ending at 1,200 ms
    // reaches the first eight rows' decodes and none of the fast rows'.
    const run = lateStallOpen();

    const decoding = selectChunks(run, { startMs: 1_100, endMs: 1_200 }, "browser.decode");
    const any = selectChunks(run, { startMs: 1_100, endMs: 1_200 });

    expect(decoding.phase).toBe("browser.decode");
    expect(decoding.chunks).toBe(8);
    expect(any.chunks).toBeGreaterThan(decoding.chunks);
    for (const identity of decoding.identities) expect(any.identities.has(identity)).toBe(true);
    expect(decoding.statement).toContain("browser.decode");
  });

  it("counts a row still sitting in the phase at the run's close, from its last boundary on", () => {
    // In the saturated re-open, rows 260 to 399 finished `plan` and never
    // dispatched: they are in the queue until the run times out. The
    // dispatched rows whose 4.6 s queue reaches into the last second are the
    // twenty-four that started after 6.4 s.
    const run = saturatedReopen();

    const queued = selectChunks(run, { startMs: 11_000, endMs: 12_000 }, "browser.queue");

    expect(queued.chunks).toBe(140 + 24);
    expect(queued.statement).toMatch(/140 .*still in it/);
  });

  it("selects nothing for a phase no row entered and says why", () => {
    const run = saturatedReopen();

    const presented = selectChunks(run, { startMs: 0, endMs: 12_000 }, "browser.present");

    expect(presented.chunks).toBe(0);
    expect(presented.statement).toContain("no chunk");
  });
});

describe("narrowed to a server phase", () => {
  it("joins the server rows in that phase to the browser rows that carry their label", () => {
    // Two browser rows on the wire, one server row per label, both placed
    // inside their brackets. Only the second row's bracket reaches the window.
    const rows = [
      makeRow({ startUs: 10 * MS, durations: { plan: 200, queue: 800, wire: 100 * MS }, rid: 7 }, 0),
      makeRow({ startUs: 300 * MS, durations: { plan: 200, queue: 800, wire: 100 * MS }, rid: 8 }, 1),
    ];
    const serverRows = [
      makeServerRow({
        rid: 7,
        phases: { "permit-wait": 40 * MS, "backend-read": 30 * MS },
        placement: { startUs: 20 * MS, endUs: 100 * MS, gapUs: 30 * MS, overshootUs: 0 },
      }),
      makeServerRow({
        rid: 8,
        phases: { "permit-wait": 40 * MS, "backend-read": 30 * MS },
        placement: { startUs: 310 * MS, endUs: 390 * MS, gapUs: 30 * MS, overshootUs: 0 },
      }),
    ];
    const run = makeRun({ header: { durationUs: 1_000 * MS }, rows, serverRows });

    const waiting = selectChunks(run, { startMs: 300, endMs: 500 }, "server.permit-wait");

    expect(waiting.chunks).toBe(1);
    expect(waiting.identities.has(chunkIdentity(rows[1].datasetId, rows[1].entityId, rows[1].chunkKey))).toBe(true);
  });

  it("cannot place a server row the merge did not nest, and says so", () => {
    // The cold remote open's server rows carry durations and no placement.
    const run = coldRemoteOpen();

    const reading = selectChunks(run, { startMs: 3_700, endMs: 4_120 }, "server.backend-read");

    expect(reading.chunks).toBe(0);
    expect(reading.cannotShow.some((line) => line.includes("no position"))).toBe(true);
  });
});

describe("phases that name no chunk", () => {
  it("selects nothing for a metadata read phase and says a metadata read is not a chunk", () => {
    const run = coldRemoteOpen();

    const reads = selectChunks(run, { startMs: 0, endMs: 4_120 }, "metadata.backend-read");

    expect(reads.chunks).toBe(0);
    expect(reads.cannotShow.some((line) => line.includes("not a chunk"))).toBe(true);
  });

  it("selects nothing for a phase the run does not have and names it", () => {
    const reading = selectChunks(lateStallOpen(), { startMs: 0, endMs: 2_000 }, "render.frame");

    expect(reading.chunks).toBe(0);
    expect(reading.cannotShow.some((line) => line.includes("render.frame"))).toBe(true);
  });
});

describe("what the set cannot show", () => {
  it("always says that a chunk with no row is not in the set", () => {
    const selection = selectChunks(lateStallOpen(), { startMs: 0, endMs: 500 });

    expect(selection.cannotShow.length).toBeGreaterThan(0);
    expect(selection.cannotShow.some((line) => line.includes("no row"))).toBe(true);
  });
});
