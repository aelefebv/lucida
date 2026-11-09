import { describe, expect, it } from "vitest";

import { diagnoseRun } from "./diagnose.ts";
import { interactionRunFor, makeRow, makeRun } from "./fixtures.ts";

const MS = 1_000;

function presented(startUs: number, rid: number, bytes: number) {
  return makeRow(
    {
      startUs,
      durations: { plan: 1 * MS, queue: 1 * MS, wire: 10 * MS, decode: 1 * MS, upload: 1 * MS, present: 6 * MS },
      rid,
      bytes,
    },
    rid,
  );
}

describe("the load reading", () => {
  it("dates the first frame by the earliest chunk on screen, not the first row born", () => {
    // Ends its present at 120 ms.
    const first = presented(100 * MS, 0, 4_096);
    // Born later, drawn sooner: its wire was quicker, so it is on screen at 112 ms.
    const quicker = makeRow(
      {
        startUs: 104 * MS,
        durations: { plan: 1 * MS, queue: 1 * MS, wire: 1 * MS, decode: 1 * MS, upload: 1 * MS, present: 3 * MS },
        rid: 1,
        bytes: 4_096,
      },
      1,
    );
    const run = makeRun({ header: { durationUs: 2_000 * MS }, rows: [first, quicker] });

    expect(diagnoseRun(run).load.firstFrameMs).toBe(112);
  });

  it("takes the hold off the close on a document that does not date its wanted set", () => {
    const run = makeRun({
      header: { durationUs: 2_340 * MS, quiescenceHoldMs: 500, endReason: "quiescent" },
      rows: [presented(0, 0, 1)],
    });

    expect(diagnoseRun(run).load.settleMs).toBe(1_840);
  });

  it("dates settle by when the view had its wanted set, and prefetch by its last decode", () => {
    const prefetched = makeRow(
      {
        startUs: 300 * MS,
        durations: { plan: 1 * MS, queue: 1 * MS, wire: 400 * MS, decode: 8 * MS, upload: 2_000 * MS },
        lane: "prefetch",
      },
      1,
    );
    const run = makeRun({
      header: { durationUs: 1_300 * MS, quiescenceHoldMs: 500, endReason: "quiescent", wantedSetMetAtUs: 320 * MS },
      rows: [presented(0, 0, 1), prefetched],
    });

    const load = diagnoseRun(run).load;
    expect(load.settleMs).toBe(320);
    expect(load.prefetchMs).toBe(710);
  });

  it("settles once the frame drawing the last wanted chunk lands, which a prefetched one's does not move", () => {
    const drawnLate = presented(304 * MS, 1, 1);
    const prefetchShown = makeRow(
      {
        startUs: 300 * MS,
        durations: { plan: 1 * MS, queue: 1 * MS, wire: 10 * MS, decode: 1 * MS, upload: 300 * MS, present: 6 * MS },
        lane: "prefetch",
      },
      2,
    );
    const run = makeRun({
      header: { durationUs: 1_300 * MS, quiescenceHoldMs: 500, endReason: "quiescent", wantedSetMetAtUs: 320 * MS },
      rows: [presented(0, 0, 1), drawnLate, prefetchShown],
    });

    expect(diagnoseRun(run).load.settleMs).toBe(324);
  });

  it("has no prefetch time on a run that prefetched nothing", () => {
    expect(diagnoseRun(makeRun({ rows: [presented(0, 0, 1)] })).load.prefetchMs).toBeNull();
  });

  it("counts the wanted chunks not resident at the close, both tiers together", () => {
    const run = makeRun({
      header: {
        outstandingAtSettle: {
          ...makeRun().header.outstandingAtSettle,
          desiredDetailChunks: 1_024,
          residentDetailChunks: 512,
          desiredCoarseChunks: 4,
          residentCoarseChunks: 3,
        },
      },
    });

    expect(diagnoseRun(run).load.coverageLossChunks).toBe(513);
  });

  it("has no settle time on a run that did not settle", () => {
    for (const endReason of ["timeout", "stalled", "explicit"] as const) {
      const run = makeRun({ header: { durationUs: 9_000 * MS, endReason } });
      expect(diagnoseRun(run).load.settleMs).toBeNull();
    }
  });

  it("has no first frame when nothing the run fetched reached the screen", () => {
    expect(diagnoseRun(interactionRunFor("pan")).load.firstFrameMs).toBeNull();
  });

  it("counts a coalesced request's bytes and chunk once", () => {
    const leader = presented(0, 7, 8_192);
    const follower = { ...presented(2 * MS, 7, 8_192), chunkKey: "1/0/0/0/0/0" };
    const other = presented(4 * MS, 8, 1_024);
    const run = makeRun({ header: { durationUs: 1_000 * MS }, rows: [leader, follower, other] });

    const { received } = diagnoseRun(run).load;
    expect(received.bytes).toBe(9_216);
    expect(received.requests).toBe(2);
  });
});
