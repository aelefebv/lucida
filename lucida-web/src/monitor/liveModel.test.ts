/**
 * The live view model (#937).
 *
 * The cases here are about what a run in progress is allowed to say: four
 * counters that partition the work, a bar over the rows still going, and no
 * judgement anywhere.
 */

import { describe, expect, it } from "vitest";
import { buildLiveView, buildProvisionalView, PROVISIONAL_CAVEAT } from "./liveModel.ts";
import { formatCause } from "./monitorModel.ts";
import { makeReadingSeries } from "../trace/diagnose/fixtures.ts";
import { deriveProvisional } from "../trace/diagnose/provisional.ts";
import type { LiveProgress } from "../trace/liveProgress.ts";
import { PHASES, type TraceReading } from "../trace/types.ts";

function progress(overrides: Partial<LiveProgress> = {}): LiveProgress {
  return {
    runId: "run-1",
    cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" },
    elapsedMs: 3_400,
    planned: 1_000,
    visible: 600,
    inFlight: 300,
    retired: 100,
    unrecorded: 0,
    occupancy: PHASES.map((phase) => ({ phase, rows: 0 })),
    unstamped: 0,
    quiescent: false,
    quiescenceReason: "chunks_in_flight",
    ...overrides,
  };
}

describe("the counters", () => {
  it("carries the four the ticket names, in the order work moves through them", () => {
    const view = buildLiveView(progress());

    expect(view.counters.map((counter) => counter.label)).toEqual([
      "planned",
      "visible",
      "in flight",
      "retired",
    ]);
    expect(view.counters.map((counter) => counter.value)).toEqual(["1,000", "600", "300", "100"]);
  });

  it("counts over the whole run rather than a trailing window", () => {
    // The prototype's auto-following window scrolled the interesting part of
    // an open out of view before anyone looked. These are cumulative from run
    // start, so nothing moves out of reach while you read it.
    const early = buildLiveView(progress({ visible: 10, elapsedMs: 500 }));
    const later = buildLiveView(progress({ visible: 600, elapsedMs: 8_000 }));

    expect(early.counters[1].value).toBe("10");
    expect(later.counters[1].value).toBe("600");
    expect(later.elapsed).toBe("8.0 s");
  });

  it("says what the caps left out, next to the counts they are missing from", () => {
    const view = buildLiveView(progress({ unrecorded: 45_412 }));
    expect(view.unrecorded).toContain("45,412");
    expect(buildLiveView(progress()).unrecorded).toBeNull();
  });
});

describe("the phase bar", () => {
  it("shares the rows in flight out over the phases they are sitting in", () => {
    const occupancy = PHASES.map((phase) => ({
      phase,
      rows: phase === "wire" ? 150 : phase === "decode" ? 50 : 0,
    }));
    const view = buildLiveView(progress({ inFlight: 200, occupancy }));

    expect(view.bar.map((segment) => segment.id)).toEqual(["wire", "decode"]);
    expect(view.bar.map((segment) => segment.pct)).toEqual([75, 25]);
  });

  it("gives rows that have stamped nothing a segment of their own, ahead of plan", () => {
    // A planned row has not entered `plan`, and folding it in would invent
    // time in a phase it never reached.
    const occupancy = PHASES.map((phase) => ({ phase, rows: phase === "wire" ? 1 : 0 }));
    const view = buildLiveView(progress({ inFlight: 3, unstamped: 2, occupancy }));

    expect(view.bar[0].id).toBe("planned");
    expect(view.bar[0].rows).toBe(2);
  });

  it("draws no bar at all when nothing is in flight", () => {
    expect(buildLiveView(progress({ inFlight: 0 })).bar).toEqual([]);
  });
});

describe("what it withholds", () => {
  it("reports the page's own predicate rather than deciding whether the run is healthy", () => {
    expect(buildLiveView(progress()).quiescence).toBe("chunks_in_flight");
    expect(buildLiveView(progress({ quiescent: true })).quiescence).toContain("quiescent");
  });

  it("spells the cause the way the closed-run report spells it", () => {
    // Two spellings of one cause would read as two different runs across the
    // handover from watching to reading.
    expect(buildLiveView(progress()).cause).toBe(
      formatCause({ epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" }),
    );
  });
});

describe("the provisional reading, as the live view shows it (#1057)", () => {
  const readings = (fromUs: number, toUs: number, make: (i: number) => Partial<TraceReading>) =>
    makeReadingSeries(fromUs, toUs, 100_000, make);

  it("carries the label, the statement, the window and the rows it did not see", () => {
    const reading = deriveProvisional({
      progress: progress({ elapsedMs: 12_300 }),
      atUs: 12_300_000,
      readings: readings(7_000_000, 12_300_000, () => ({ inFlight: 24, queueDepth: 20_000 })),
      readingsDropped: 0,
    });

    const view = buildProvisionalView(reading);

    expect(view.label).toBe("provisional");
    expect(view.statement).toBe(reading.statement);
    expect(view.window).toBe("the last 5.0 s (7.3 s to 12.3 s of the run)");
    expect(view.readings).toBe("51 reading(s) in the window");
    expect(view.quiescence).toBe("chunks_in_flight");
    expect(view.rows).toContain("walked none of the 1,000 rows");
    expect(view.caveat).toBe(PROVISIONAL_CAVEAT);
    expect(view.caveat).toContain("Not a verdict");
  });

  it("selects the top finding and spells its observation as the text does", () => {
    const reading = deriveProvisional({
      progress: progress(),
      atUs: 12_300_000,
      readings: readings(7_000_000, 12_300_000, () => ({ inFlight: 24, queueDepth: 20_000 })),
      readingsDropped: 0,
    });

    const view = buildProvisionalView(reading);

    expect(view.finding).toEqual({
      severity: "saturated",
      subject: "scheduler.admission",
      detail: "20,000 pending · cap 24 · pinned 100% · net drain 0/s",
      rule: "queue.backlog",
      basis: reading.topFinding!.basis,
    });
  });

  it("says the run so far when the window reaches back to run start, and has no finding to show on a quiet one", () => {
    const reading = deriveProvisional({
      progress: progress({ elapsedMs: 800 }),
      atUs: 800_000,
      readings: readings(0, 800_000, (i) => ({ inFlight: 1 + (i % 3), queueDepth: 0 })),
      readingsDropped: 0,
    });

    const view = buildProvisionalView(reading);

    expect(view.window).toBe("the run so far (800 ms)");
    expect(view.finding).toBeNull();
  });

  it("reports the page's own predicate rather than deciding whether the run is healthy", () => {
    const reading = deriveProvisional({
      progress: progress({ quiescent: true, quiescenceReason: "quiescent" }),
      atUs: 3_000_000,
      readings: [],
      readingsDropped: 0,
    });
    expect(buildProvisionalView(reading).quiescence).toContain("quiescent");
  });
});
