/**
 * The recorder's per-chunk reads of the interval in progress (#1062): what
 * the overlay's phase color and churn tint paint, and what its hover
 * inspector shows. Every case holds the live read to the derivation over the
 * same rows once exported, because the two are meant to be one reading.
 */

import { describe, expect, it } from "vitest";

import { lookupChunk } from "./diagnose/chunkLookup.ts";
import { chunkIdentity, deriveChunkStates } from "./diagnose/chunkStates.ts";
import { TraceRecorder } from "./recorder.ts";
import { Boundary, RowOutcome, type ChunkRowSource } from "./types.ts";

function makeRecorder() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 3_600_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
      speculativePending: 0,
      speculativeInFlight: 0,
      desiredDetailChunks: 0,
      residentDetailChunks: 0,
      desiredCoarseChunks: 0,
      residentCoarseChunks: 0,
      detailBytes: 0,
      detailBudgetBytes: 0,
      coarseBytes: 0,
      coarseBudgetBytes: 0,
    }),
  });
  return { recorder, advance: (ms: number) => { clock += ms; } };
}

function source(x: number, entityId = "m"): ChunkRowSource {
  return { datasetId: "ds", entityId, imageId: "i", lane: "detail", level: 1, t: 0, c: 0, z: 0, y: 2, x };
}

/** The chunk `source()` names, as the overlay's cell names it. */
function chunk(x: number, entityId = "m") {
  return { datasetId: "ds", entityId, level: 1, t: 0, c: 0, z: 0, y: 2, x };
}

const OPEN = { epoch: "content" as const, dirtyKind: "interactive" as const, source: "dataset_open_request" };

describe("reading one chunk of the interval in progress", () => {
  it("answers null before any interval is open, and reports no window", () => {
    const recorder = new TraceRecorder({ now: () => 0, epochNow: () => 0 });
    expect(recorder.openIntervalMs).toBeNull();
    expect(recorder.readChunk(chunk(0))).toBeNull();
    expect(recorder.lookupChunkLive(chunk(0))).toBeNull();
  });

  it("follows a chunk through its phases without closing the run", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN);
    advance(10);
    const handle = recorder.beginChunkRow(source(0), 0);

    expect(recorder.readChunk(chunk(0))).toEqual({
      state: "wire",
      rows: 1,
      fetches: 0,
      ageMs: 0,
    });

    advance(30);
    recorder.noteBytesReceived(handle, 4_096);
    expect(recorder.readChunk(chunk(0))).toMatchObject({ state: "decode", fetches: 1, ageMs: 30 });

    advance(5);
    recorder.stamp(handle, Boundary.UploadStart);
    recorder.noteHandedToRenderer(handle);
    recorder.noteFrameDispatched();
    expect(recorder.readChunk(chunk(0))?.state).toBe("present");
    recorder.noteFrameDispatched();
    expect(recorder.readChunk(chunk(0))).toMatchObject({ state: "complete", rows: 1, fetches: 1 });

    // A chunk nobody dispatched has no row.
    expect(recorder.readChunk(chunk(9))).toBeNull();
    expect(recorder.isRunOpen).toBe(true);
    expect(recorder.openIntervalMs).toBe(45);
  });

  it("counts a chunk fetched again, and agrees with the derivation over the exported rows", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN);
    const identities: Array<[number, string]> = [];
    for (let pass = 0; pass < 3; pass++) {
      for (let x = 0; x < 4; x++) {
        advance(7);
        const handle = recorder.beginChunkRow(source(x, `m-${x % 2}`), 0);
        identities.push([x, `m-${x % 2}`]);
        if (pass === 2 && x === 3) continue; // the last fetch is still on the wire
        advance(3);
        recorder.noteBytesReceived(handle, 1_024);
        if (x === 1) recorder.finishRow(handle, RowOutcome.Retired);
        else recorder.finishRow(handle, RowOutcome.Complete);
      }
    }

    const live = new Map<string, ReturnType<TraceRecorder["readChunk"]>>();
    for (const [x, entityId] of identities) {
      live.set(chunkIdentity("ds", entityId, `1/0/0/0/2/${x}`), recorder.readChunk(chunk(x, entityId)));
    }
    expect(live.get(chunkIdentity("ds", "m-0", "1/0/0/0/2/0"))).toMatchObject({ state: "complete", rows: 3, fetches: 3 });
    expect(live.get(chunkIdentity("ds", "m-1", "1/0/0/0/2/3"))).toMatchObject({ state: "wire", rows: 3, fetches: 2 });

    const run = recorder.exportDocument().runs[0];
    const derived = deriveChunkStates(run);
    expect(derived.refetchedChunks).toBe(4);
    expect(derived.refetches).toBe(7);
    for (const [identity, reading] of live) {
      expect(reading, identity).toEqual(derived.byIdentity.get(identity));
    }
  });

  it("looks a chunk up live with the rank and age the document's lookup gives it", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN);
    const handles: number[] = [];
    for (let x = 0; x < 6; x++) {
      advance(2);
      handles.push(recorder.beginChunkRow(source(x), 0, 1_000 + x));
    }
    advance(20);
    recorder.noteBytesReceived(handles[2], 512);
    advance(1);
    recorder.beginChunkRow(source(2), 0);

    const live = recorder.lookupChunkLive(chunk(2))!;
    expect(live.chosen).toBe("under the pointer");
    expect(live.selector).toBe("m/1/0/0/0/2/2");
    expect(live.rowCount).toBe(2);
    expect(live.rows.map((row) => row.state)).toEqual(["decode", "wire"]);
    // Row 1 was admitted a millisecond earlier and had not dispatched; row 0
    // dispatched at the very instant row 2 was admitted, so it is not ahead.
    expect(live.rows[0].queue).toMatchObject({ aheadAtAdmission: 1, overtaken: 0, dispatched: true });

    const fromDocument = lookupChunk(recorder.exportDocument().runs[0], "m/1/0/0/0/2/2", "under the pointer");
    expect(live).toEqual(fromDocument);
  });

  it("says a chunk is not in the interval when no row carries it", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN);
    const lookup = recorder.lookupChunkLive(chunk(7))!;
    expect(lookup.rowCount).toBe(0);
    expect(lookup.statement).toContain("no lifecycle row carries it");
  });

  it("reads the steady-state interval once the run closes, which starts with no rows", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN);
    recorder.beginChunkRow(source(0), 0);
    advance(100);
    recorder.closeRun("explicit");

    expect(recorder.isRunOpen).toBe(false);
    expect(recorder.openIntervalMs).toBe(0);
    expect(recorder.readChunk(chunk(0))).toBeNull();
    recorder.beginChunkRow(source(0), 0);
    expect(recorder.readChunk(chunk(0))).toMatchObject({ rows: 1, fetches: 0 });
  });
});
