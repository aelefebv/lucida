/**
 * The provisional reading (#1057), over synthetic samples.
 *
 * The cases are about what an open run is allowed to say: the label on every
 * rendering, the window it states, the rows it did not see, and the three
 * rules a window of readings can judge. Nothing here asserts a verdict,
 * because the reading has none to give.
 */

import { describe, expect, it } from "vitest";

import type { LiveProgress } from "../liveProgress.ts";
import { PHASES } from "../types.ts";
import { makeReading, makeReadingSeries as series } from "./fixtures.ts";
import {
  DEFAULT_PROVISIONAL_WINDOW_MS,
  deriveProvisional,
  renderProvisional,
  resolveLiveWindow,
  type LiveSample,
} from "./provisional.ts";
import { RULESET } from "./ruleset.ts";

const MS = 1_000;

function progress(overrides: Partial<LiveProgress> = {}): LiveProgress {
  return {
    runId: "run-9-3",
    cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" },
    elapsedMs: 12_300,
    planned: 1_203,
    visible: 1_100,
    inFlight: 39,
    retired: 64,
    unrecorded: 0,
    occupancy: PHASES.map((phase) => ({
      phase,
      rows: phase === "wire" ? 24 : phase === "decode" ? 3 : phase === "present" ? 12 : 0,
    })),
    unstamped: 0,
    quiescent: false,
    quiescenceReason: "chunks_pending",
    ...overrides,
  };
}

function sample(overrides: Partial<LiveSample> = {}): LiveSample {
  return {
    progress: progress(),
    atUs: 12_300 * MS,
    readings: [],
    readingsDropped: 0,
    ...overrides,
  };
}

/** A window pinned at a cap of 24 with a queue shrinking from 20,000 to 19,800 over five seconds. */
function saturatedSample(): LiveSample {
  const readings = series(7_000 * MS, 12_300 * MS, 100 * MS, (i, atUs) => ({
    inFlight: 24,
    queueDepth: 20_000 - Math.round(((atUs - 7_300 * MS) / (5_000 * MS)) * 200),
    frameTimeUs: 2_000 + (i % 3) * 500,
  }));
  return sample({ readings });
}

describe("the label", () => {
  it("is on the document, the statement and the text, and there is no verdict to mistake for one", () => {
    const reading = deriveProvisional(saturatedSample());

    expect(reading.provisional).toBe(true);
    expect(reading.statement.startsWith("provisional")).toBe(true);
    expect("verdict" in reading).toBe(false);

    const text = renderProvisional(reading);
    expect(text.split("\n")[0]).toContain("PROVISIONAL");
    expect(text).toContain("not a verdict");
    expect(text).toContain("(provisional)");
  });

  it("labels a quiet window too, so a moving number is never read as a conclusion", () => {
    // In-flight wanders below its peak, so nothing is pinned and nothing fires.
    const readings = series(7_000 * MS, 12_300 * MS, 250 * MS, (i) => ({
      inFlight: 1 + (i % 3),
      queueDepth: 2,
    }));
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.topFinding).toBeNull();
    expect(reading.statement).toMatch(/^provisional — nothing crossed a threshold over the last 5000 ms/);
    expect(renderProvisional(reading)).toContain("FINDINGS  none — no threshold crossed in the window (provisional).");
  });
});

describe("the window", () => {
  it("ends now and reaches back the requested length by default", () => {
    const reading = deriveProvisional(saturatedSample());

    expect(reading.window).toEqual({
      startMs: 7_300,
      endMs: 12_300,
      spanMs: 5_000,
      requestedMs: DEFAULT_PROVISIONAL_WINDOW_MS,
      wholeRun: false,
    });
    expect(reading.elapsedMs).toBe(12_300);
  });

  it("is the run so far while the run is younger than the window, and says so", () => {
    const readings = series(0, 800 * MS, 100 * MS, () => ({ inFlight: 8, queueDepth: 40 }));
    const reading = deriveProvisional(sample({ atUs: 800 * MS, readings }));

    expect(reading.window.wholeRun).toBe(true);
    expect(reading.window.startMs).toBe(0);
    expect(reading.window.spanMs).toBe(800);
    expect(reading.statement).toContain("over the 800 ms of the run so far");
    expect(renderProvisional(reading)).toContain("window    the run so far: 0..800 ms of the run");
  });

  it("takes a caller's window and refuses one with no length", () => {
    const reading = deriveProvisional(saturatedSample(), { windowMs: 2_000 });
    expect(reading.window.startMs).toBe(10_300);
    expect(reading.window.requestedMs).toBe(2_000);

    expect(() => resolveLiveWindow(12_300 * MS, 0)).toThrow(/positive number of milliseconds/);
    expect(() => resolveLiveWindow(12_300 * MS, Number.NaN)).toThrow(/positive number of milliseconds/);
  });
});

describe("what was read of the window", () => {
  it("counts the readings inside it and knows the one carried from before it", () => {
    const reading = deriveProvisional(saturatedSample());

    // 7,300 ms sits on a reading; the one at 7,200 is the reading in force
    // when the window opened, and it is carried rather than counted.
    expect(reading.readings.n).toBe(51);
    expect(reading.readings.carried).toBe(true);
    expect(reading.readings.startUnread).toBe(false);
    expect(reading.readings.latestAgeMs).toBe(0);
    expect(reading.readings.statement).toBe("51 reading(s) in the window");
  });

  it("says when the page has not ticked at all, and measures nothing", () => {
    const reading = deriveProvisional(sample());

    expect(reading.readings.n).toBe(0);
    expect(reading.limiter).toBeNull();
    expect(reading.render).toBeNull();
    expect(reading.findings).toEqual([]);
    expect(reading.statement).toBe(
      "provisional — no reading yet: the page has not ticked since the run opened, so nothing below is measured; the page says chunks_pending",
    );
  });

  it("tells a page waiting on its work from a quiescent one when no tick lands in the window", () => {
    // The last tick was at 4 s; the window opens at 7.3 s. A stalled fetch
    // dirties nothing, so nothing ticks, and the reading in force is old.
    const readings = [makeReading(4_000 * MS, { inFlight: 24, queueDepth: 19_800 })];
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.readings.n).toBe(0);
    expect(reading.readings.carried).toBe(true);
    expect(reading.readings.latestAgeMs).toBe(8_300);
    expect(reading.statement).toContain("no tick landed in the window");
    expect(reading.statement).toContain("8300 ms old, with 19,800 pending and 24 in flight");
    expect(reading.statement).toContain("a page waiting on the work it has out, not a quiescent one");
    expect(reading.limiter).toBeNull();
  });

  it("states the stretch of the window the ring no longer holds", () => {
    // The ring wrapped: the first retained reading is at 9,000 ms, and the
    // window opened at 7,300 ms with nothing carried.
    const readings = series(9_000 * MS, 12_300 * MS, 100 * MS, () => ({ inFlight: 24, queueDepth: 500 }));
    const reading = deriveProvisional(sample({ readings, readingsDropped: 3_000 }));

    expect(reading.readings.carried).toBe(false);
    expect(reading.readings.startUnread).toBe(true);
    expect(reading.readings.unreadMs).toBe(1_700);
    expect(reading.readings.dropped).toBe(3_000);
    expect(reading.readings.statement).toContain("the window's first 1700 ms are unread");
  });

  it("does not call a window that opened before the first tick unread", () => {
    const readings = series(2_000 * MS, 4_000 * MS, 500 * MS, () => ({ inFlight: 4 }));
    const reading = deriveProvisional(sample({ atUs: 4_000 * MS, readings }));

    expect(reading.readings.carried).toBe(false);
    expect(reading.readings.startUnread).toBe(false);
    expect(reading.readings.unreadMs).toBe(0);
  });
});

describe("the rows it did not see", () => {
  it("names every row the run has made, and walked none of them", () => {
    const reading = deriveProvisional(saturatedSample());

    expect(reading.rows).toEqual({
      made: 1_203,
      complete: 1_100,
      retired: 64,
      inFlight: 39,
      unrecorded: 0,
      walked: 0,
      statement:
        "walked none of the 1,203 rows this run has made (1,100 complete, 64 retired, 39 in flight); " +
        "per-row durations, the critical path and the worst row wait for the verdict",
    });
    expect(renderProvisional(reading)).toContain("rows      walked none of the 1,203 rows");
  });

  it("adds the rows the cap refused, which exist in no table", () => {
    const reading = deriveProvisional(sample({ progress: progress({ unrecorded: 45_412 }) }));
    expect(reading.rows.unrecorded).toBe(45_412);
    expect(reading.rows.statement).toContain("and 45,412 more were refused by the per-run cap");
  });

  it("carries the occupancy this instant, as the live view's bar does", () => {
    const reading = deriveProvisional(saturatedSample());

    expect(reading.occupancy.inFlight).toBe(39);
    expect(reading.occupancy.phases.find((slot) => slot.phase === "wire")?.rows).toBe(24);
    expect(renderProvisional(reading)).toContain(
      "in flight 39 row(s) this instant: wire 24 · decode 3 · present 12",
    );
  });
});

describe("the limiter, from the readings alone", () => {
  it("reads the cap, the pinned share and the net drain over the window", () => {
    const reading = deriveProvisional(saturatedSample());

    expect(reading.limiter).toEqual({
      id: "scheduler.admission",
      cap: 24,
      capSource: "observed-max",
      unit: "chunk requests in flight",
      pinnedPct: 100,
      pending: 19_800,
      pendingAtStart: 20_004,
      netDrainPerS: 40.8,
      backlogEtaS: 485,
      windowMs: 5_000,
      samples: 51,
    });
  });

  it("fires the backlog rule with the shipped threshold when the backlog will not drain in time", () => {
    const reading = deriveProvisional(saturatedSample());
    const lead = reading.topFinding!;

    expect(lead.severity).toBe("saturated");
    expect(lead.rule).toBe(RULESET.backlog.id);
    expect(lead.subject).toBe("scheduler.admission");
    expect(lead.threshold).toEqual({
      kind: "backlog",
      value: RULESET.backlog.maxEtaS,
      why: RULESET.backlog.why,
    });
    expect(lead.basis).toContain("net change");
    expect(reading.statement).toBe(
      "provisional — over the last 5000 ms, scheduler.admission held 19,800 requests behind a cap of 24 " +
        "and at the net 40.8/s the backlog needs about 485 s; the page says chunks_pending",
    );
  });

  it("says a backlog that is not shrinking is not shrinking, rather than giving it a time", () => {
    const readings = series(7_000 * MS, 12_300 * MS, 100 * MS, () => ({ inFlight: 24, queueDepth: 20_000 }));
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.limiter?.netDrainPerS).toBe(0);
    expect(reading.limiter?.backlogEtaS).toBeNull();
    expect(reading.topFinding?.severity).toBe("saturated");
    expect(reading.statement).toContain("the backlog is not shrinking");
    expect(renderProvisional(reading)).toContain("ETA not shrinking");
  });

  it("does not call one full set of in-flight slots a queue", () => {
    const readings = series(7_000 * MS, 12_300 * MS, 100 * MS, () => ({ inFlight: 24, queueDepth: 24 }));
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.findings.find((finding) => finding.rule === RULESET.backlog.id)).toBeUndefined();
  });

  it("notes a limiter pinned at its cap when the backlog is draining, and ranks it below a stall", () => {
    const readings = series(7_000 * MS, 12_300 * MS, 100 * MS, (i) => ({
      inFlight: 24,
      queueDepth: Math.max(20, 1_000 - i * 20),
    }));
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.topFinding?.severity).toBe("note");
    expect(reading.topFinding?.rule).toBe(RULESET.occupancy.id);
    expect(reading.statement).toContain("nothing crossed a threshold");
    expect(reading.statement).toContain("scheduler.admission sat at its cap of 24 for 100% of it");
  });

  it("has no limiter to report when nothing was in flight", () => {
    const readings = series(7_000 * MS, 12_300 * MS, 100 * MS, () => ({ inFlight: 0, queueDepth: 0 }));
    expect(deriveProvisional(sample({ readings })).limiter).toBeNull();
  });
});

describe("render time over the window", () => {
  it("summarises the main thread over the window's readings and charges it per interval", () => {
    // A frame time equal to the tick interval: the main thread fills the window.
    const readings = series(7_000 * MS, 12_300 * MS, 20 * MS, () => ({ inFlight: 2, frameTimeUs: 20 * MS }));
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.render?.mainThread?.p95Ms).toBe(20);
    expect(reading.render?.sharePct).toBe(100);
    expect(reading.render?.busyMs).toBe(5_000);
    expect(reading.render?.gpuPass).toBeNull();

    const lead = reading.topFinding!;
    expect(lead.severity).toBe("stall");
    expect(lead.subject).toBe("render.frame");
    expect(lead.rule).toBe(RULESET.share.id);
    expect(lead.observed).toEqual({
      ms: 5_000,
      sharePct: 100,
      shareOf: "window",
      rows: 0,
      tier: "per-tick readings",
    });
    expect(reading.statement).toBe(
      "provisional — over the last 5000 ms, render.frame held 5000 ms (100% of the window); the page says chunks_pending",
    );
  });

  it("carries the GPU pass time only when a reading in the window had one", () => {
    const readings = series(7_000 * MS, 12_300 * MS, 100 * MS, (i) => ({
      inFlight: 2,
      ...(i % 2 === 0 ? { gpuPassUs: 3_000 + i * 10 } : {}),
    }));
    const reading = deriveProvisional(sample({ readings }));

    // Readings at even indices from 7.0 s carry one; 25 of them land inside
    // the window that opens at 7.3 s.
    expect(reading.render?.gpuPass?.samples).toBe(25);
    expect(renderProvisional(reading)).toMatch(/GPU pass p50 [\d.]+ ms/);
  });

  it("holds the share rule to its floor, so a fast window is not a stall", () => {
    // 100% of a 200 ms run so far, but only 200 ms of it: under the floor,
    // the way a healthy 368 ms local open must not read as a stall.
    const readings = series(0, 200 * MS, 20 * MS, () => ({ inFlight: 2, frameTimeUs: 20 * MS }));
    const reading = deriveProvisional(sample({ atUs: 200 * MS, readings }));

    expect(reading.render?.sharePct).toBe(100);
    expect(reading.render?.busyMs).toBeLessThan(RULESET.share.floorMs);
    expect(reading.findings.find((finding) => finding.severity === "stall")).toBeUndefined();
  });

  it("ranks findings as the verdict does: stalls and saturation before notes, then by share", () => {
    const readings = series(7_000 * MS, 12_300 * MS, 20 * MS, () => ({
      inFlight: 24,
      queueDepth: 20_000,
      frameTimeUs: 20 * MS,
    }));
    const reading = deriveProvisional(sample({ readings }));

    expect(reading.findings.map((finding) => finding.severity)).toEqual(["stall", "saturated"]);
  });
});

describe("the text twin", () => {
  it("prints the window, the page, the rows, the limiter, the render time and the next steps in a dozen lines", () => {
    const text = renderProvisional(deriveProvisional(saturatedSample()));
    const lines = text.split("\n");

    expect(lines.length).toBeLessThanOrEqual(16);
    expect(lines[0]).toBe(
      "lucida trace run-9-3 — PROVISIONAL: provisional — over the last 5000 ms, scheduler.admission held 19,800 requests " +
        "behind a cap of 24 and at the net 40.8/s the backlog needs about 485 s; the page says chunks_pending",
    );
    expect(text).toContain("window    the last 5000 ms: 7300..12300 ms of the run · 51 reading(s) in the window");
    expect(text).toContain("page      chunks_pending · last reading 0 ms ago");
    expect(text).toContain(
      "limiter   scheduler.admission cap 24 (observed-max) · pinned 100% · pending 19,800 (from 20,004) · net drain 40.8/s · ETA ~485 s",
    );
    expect(text).toContain("FINDINGS (1), provisional");
    expect(text).toContain("  1  SATURATED scheduler.admission   19,800 pending · cap 24 · pinned 100% · net drain 40.8/s · ETA ~485 s   [queue.backlog] (provisional)");
    expect(text).toContain("       basis: ");
    expect(text).toContain("lucida trace show run-9-3");
    expect(text).toContain("window.lucidaTrace.closeRun()");
  });

  it("names the next steps in the document as well as the text", () => {
    const reading = deriveProvisional(saturatedSample());
    expect(reading.next.map((step) => step.command)).toEqual([
      "lucida trace show run-9-3",
      "window.lucidaTrace.closeRun()",
    ]);
  });
});
