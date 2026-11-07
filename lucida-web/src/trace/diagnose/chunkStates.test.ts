/**
 * The per-chunk states: where each chunk's newest row stands and how many
 * times the interval fetched it. The overlay's phase color and churn tint
 * read this shape, so the cases assert it over fixture runs whose rows are
 * known, and hold its churn count to the steady-state refetch rule.
 */

import { describe, expect, it } from "vitest";

import { chunkIdentity, deriveChunkStates } from "./chunkStates.ts";
import {
  healthyLocalOpen,
  interactionRun,
  makeRow,
  makeRun,
  refetchLoopSteadyState,
  saturatedReopen,
} from "./fixtures.ts";
import { deriveSteadyState } from "./steadyState.ts";

const MS = 1_000;

describe("the chunk identity", () => {
  it("is the dataset, the entity and the chunk key together, as the refetch rule counts them", () => {
    expect(chunkIdentity("ds", "member-1", "1/0/0/0/4/0")).toBe("ds/member-1/1/0/0/0/4/0");
  });
});

describe("deriving chunk states from a run", () => {
  it("reads a complete open as one complete, once-fetched reading per chunk", () => {
    const states = deriveChunkStates(healthyLocalOpen());

    expect(states.windowMs).toBe(330);
    expect(states.rowCount).toBe(120);
    expect(states.byIdentity.size).toBe(120);
    const reading = states.byIdentity.get(chunkIdentity("ds", "member-7", "1/0/0/0/119/0"));
    expect(reading).toEqual({ state: "complete", rows: 1, fetches: 1, ageMs: 246.5 });
    expect(states.refetchedChunks).toBe(0);
    expect(states.refetches).toBe(0);
  });

  it("places a row still in the queue in the queue, with no fetch to its name", () => {
    const states = deriveChunkStates(saturatedReopen());

    const queued = states.byIdentity.get(chunkIdentity("ds", "member-4", "1/0/0/0/300/0"));
    expect(queued).toEqual({ state: "queue", rows: 1, fetches: 0, ageMs: 3_850 });
    const complete = states.byIdentity.get(chunkIdentity("ds", "member-0", "1/0/0/0/0/0"));
    expect(complete?.state).toBe("complete");
    expect(complete?.fetches).toBe(1);
  });

  it("puts an in-flight row in the phase after the last one it finished", () => {
    const states = deriveChunkStates(interactionRun());
    // Every row finished `upload` and is still open, so it sits in `present`.
    for (const reading of states.byIdentity.values()) {
      expect(reading.state).toBe("present");
      expect(reading.fetches).toBe(1);
    }
  });

  it("counts churn the way the refetch rule counts it, over the interval's span", () => {
    const run = healthyLocalOpen();
    const interval = refetchLoopSteadyState(run);
    const states = deriveChunkStates(interval);
    const refetch = deriveSteadyState(run, interval, "").reading.refetch!;

    expect(states.windowMs).toBe(refetch.windowMs);
    expect(states.refetchedChunks).toBe(refetch.chunks);
    expect(states.refetches).toBe(refetch.refetches);
    expect(states.byIdentity.size).toBe(12);
    for (const reading of states.byIdentity.values()) {
      expect(reading).toMatchObject({ state: "complete", rows: 3, fetches: 3 });
    }
  });

  it("reads the newest row's state and age when several rows carry one identity", () => {
    const rows = [
      makeRow(
        { startUs: 10 * MS, durations: { plan: 100, queue: MS, wire: 5 * MS, decode: MS, upload: MS, present: MS } },
        0,
      ),
      // Fetched again 50 ms later; the wire is still open.
      makeRow({ startUs: 60 * MS, durations: { plan: 100, queue: MS }, outcome: "in-flight" }, 0),
      // Another chunk, retired before its wire closed.
      makeRow({ startUs: 20 * MS, durations: { plan: 100, queue: MS }, outcome: "retired" }, 1),
    ];
    const states = deriveChunkStates(makeRun({ header: { durationUs: 100 * MS }, rows }));

    expect(states.byIdentity.get(chunkIdentity("ds", "member-0", "1/0/0/0/0/0"))).toEqual({
      state: "wire",
      rows: 2,
      fetches: 1,
      ageMs: 40,
    });
    expect(states.byIdentity.get(chunkIdentity("ds", "member-1", "1/0/0/0/1/0"))).toEqual({
      state: "retired",
      rows: 1,
      fetches: 0,
      ageMs: 1.1,
    });
    expect(states.refetchedChunks).toBe(0);
  });
});
