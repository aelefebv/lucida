/**
 * The monitor's reading of a diagnostic document.
 *
 * Every assertion here is about the *document* becoming a page: which callout
 * leads, what a track is placed over, what a drill-down carries. The thresholds
 * and the attribution are the derivation's tests, not these — the parity rule
 * is that this module selects from the document and never computes a number of
 * its own, so a test that recomputed one would be testing the wrong module.
 */

import { describe, expect, it } from "vitest";
import { diagnoseRun } from "../trace/diagnose/diagnose.ts";
import {
  coldRemoteOpen,
  healthyLocalOpen,
  interactionRun,
  makeRow,
  makeRun,
  saturatedReopen,
} from "../trace/diagnose/fixtures.ts";
import { buildMonitorView, formatMs } from "./monitorModel.ts";

const MS = 1_000;

describe("the verdict leads", () => {
  it("puts the verdict first and the findings under it", () => {
    const view = buildMonitorView(diagnoseRun(saturatedReopen()));

    expect(view.callouts[0].tone).toBe("verdict");
    expect(view.callouts[0].headline).toContain("saturated");
    expect(view.callouts.length).toBeGreaterThan(1);
  });

  it("carries the confidence word and what it cannot see on the verdict itself", () => {
    const view = buildMonitorView(diagnoseRun(saturatedReopen()));

    expect(view.callouts[0].confidence).toBe("resource-limited");
    // Never empty on any of the seven words. A confidence with no statement of
    // its blind spot is a confidence a reader over-trusts.
    expect(view.callouts[0].detail.length).toBeGreaterThan(0);
  });

  it("says so plainly when nothing crossed a threshold", () => {
    const view = buildMonitorView(diagnoseRun(healthyLocalOpen()));

    expect(view.callouts[0].tone).toBe("verdict");
    expect(view.callouts[0].headline).toContain("no stall");
  });

  it("gives a finding the numbers behind its one bit", () => {
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));
    const finding = view.callouts.find((callout) => callout.tone !== "verdict");

    expect(finding).toBeDefined();
    const labels = finding!.numbers.map((number) => number.label);
    expect(labels).toContain("p50");
    expect(labels).toContain("p95");
    expect(labels).toContain("rows");
  });
});

/** A run whose plan pass blows its absolute ceiling, so a finding names a phase directly. */
function planCeilingRun() {
  return makeRun({
    header: { durationUs: 2_000 * MS },
    rows: Array.from({ length: 10 }, (_, i) =>
      makeRow({ startUs: i * 60 * MS, durations: { plan: 120 * MS, wire: 10 * MS } }, i),
    ),
  });
}

describe("drill-down", () => {
  it("carries a phase scope and the worst row, not a time coordinate", () => {
    const view = buildMonitorView(diagnoseRun(planCeilingRun()));
    const finding = view.callouts.find((callout) => callout.subject === "browser.plan")!;

    expect(finding.drill).not.toBeNull();
    expect(finding.drill!.phaseId).toBe("browser.plan");
    // The callout's question, carried through verbatim: one step, and the same
    // question on both sides of it.
    expect(finding.drill!.question).toBe(finding.headline);
    // A chunk key, not a moment.
    expect(finding.drill!.worst!.label).toMatch(/^\d+\/\d/);
  });

  it("lets the verdict itself be the one step, under its own question", () => {
    // The verdict is the sentence a reader arrives at. A step from it that
    // landed nowhere would make the headline the one callout you cannot follow.
    const document = diagnoseRun(planCeilingRun());
    const view = buildMonitorView(document);
    const verdict = view.callouts[0];

    expect(verdict.tone).toBe("verdict");
    expect(verdict.drill!.phaseId).toBe("browser.plan");
    expect(verdict.drill!.question).toBe(document.verdict.text);
  });

  it("carries the phase's numbers, so the panel does not format a rollup itself", () => {
    const view = buildMonitorView(diagnoseRun(planCeilingRun()));
    const drill = view.callouts[0].drill!;

    expect(drill.numbers.map((number) => number.label)).toEqual([
      "rows",
      "p50",
      "p95",
      "max",
      "total",
    ]);
    expect(drill.placement).toContain("to");
  });

  it("offers no drill on a verdict with no finding under it", () => {
    const view = buildMonitorView(diagnoseRun(healthyLocalOpen()));

    expect(view.callouts[0].drill).toBeNull();
  });

  it("opens the cold open's read family from the segment that named it", () => {
    // The critical path calls the segment `open.metadata-read` and builds it out
    // of exactly the metadata rows, so the one step lands on that family's
    // table row rather than on nothing.
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));
    const finding = view.callouts.find((callout) => callout.subject === "open.metadata-read")!;

    expect(finding.drill!.phaseId).toBe("metadata.backend-read");
    expect(finding.drill!.worst!.label).toContain("open-1");
  });

  it("offers no drill-down for a subject no phase table can scope to", () => {
    // A limiter is a subject and not a phase; there is no per-phase table row
    // to open, and a button that opens nothing is worse than no button.
    const view = buildMonitorView(diagnoseRun(saturatedReopen()));
    const limiterCallout = view.callouts.find((callout) => callout.tone === "saturated");

    expect(limiterCallout).toBeDefined();
    expect(limiterCallout!.drill).toBeNull();
  });

  it("offers no drill-down for a phase that has no per-item rows", () => {
    // `render.frame` is per-tick readings. It can be shown to overlap the run
    // and there is no row behind it to open.
    const view = buildMonitorView(diagnoseRun(interactionRun()));
    const aggregate = view.callouts.find((callout) => callout.subject === "render.frame")!;

    expect(aggregate.drill).toBeNull();
    expect(aggregate.numbers.some((number) => number.label === "per-item rows")).toBe(true);
  });

  it("resolves a drill-down to the phase's whole rollup row", () => {
    const document = diagnoseRun(coldRemoteOpen());
    const view = buildMonitorView(document);
    const drill = view.callouts.find((callout) => callout.drill != null)!.drill!;

    expect(view.phases.find((phase) => phase.id === drill.phaseId)).toBeDefined();
  });
});

describe("tracks", () => {
  it("gives dataset-open metadata reads a track of their own, ahead of the chunk tracks", () => {
    // The cold open's first 3.7 s are metadata reads and no chunk track can draw
    // them: the first chunk does not exist yet. Silence over the bottleneck is
    // the defect this track exists to prevent.
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));

    expect(view.trackGroups[0].side).toBe("metadata");
    const reads = view.trackGroups[0].tracks.find((track) => track.phaseId === "metadata.backend-read");
    expect(reads).toBeDefined();
    expect(reads!.placed).toBe(true);
    expect(reads!.leftPct).toBeLessThan(1);
    expect(reads!.widthPct).toBeGreaterThan(80);
  });

  it("places a track over the run's own wall clock", () => {
    const run = makeRun({
      header: { durationUs: 1_000 * MS },
      rows: [makeRow({ startUs: 250 * MS, durations: { wire: 500 * MS } }, 0)],
    });
    const view = buildMonitorView(diagnoseRun(run));
    const wire = view.trackGroups.flatMap((group) => group.tracks).find((track) => track.phaseId === "browser.wire")!;

    expect(wire.leftPct).toBeCloseTo(25, 1);
    expect(wire.widthPct).toBeCloseTo(50, 1);
  });

  it("draws no bar for a phase nothing could place, and says how many rows that was", () => {
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));
    const serverGroup = view.trackGroups.find((group) => group.side === "server")!;
    const permitWait = serverGroup.tracks.find((track) => track.phaseId === "server.permit-wait")!;

    expect(permitWait.placed).toBe(false);
    expect(permitWait.widthPct).toBe(0);
    expect(permitWait.note).toContain("60");
    expect(permitWait.note).toContain("no position");
  });

  it("orders the tracks within a group by when they started", () => {
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));
    const browser = view.trackGroups.find((group) => group.side === "browser")!;
    const starts = browser.tracks.filter((track) => track.placed).map((track) => track.leftPct);

    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("has a track for a run with no dataset open at all", () => {
    const view = buildMonitorView(diagnoseRun(interactionRun()));

    expect(view.trackGroups.some((group) => group.side === "metadata")).toBe(false);
    expect(view.trackGroups.flatMap((group) => group.tracks).length).toBeGreaterThan(0);
  });
});

describe("truncation and coverage lead", () => {
  it("leads with the truncation record when the run stopped recording", () => {
    const run = saturatedReopen();
    run.header.truncation = {
      reason: "per-run-cap",
      atUs: 6_000 * MS,
      capBytes: 8_388_608,
      rowsRecorded: 18_000,
      rowsUnrecorded: 45_412,
      ticksUnrecorded: 0,
      eventsUnrecorded: 0,
      serverRowsUnrecorded: 0,
    };
    const view = buildMonitorView(diagnoseRun(run));

    expect(view.banners[0].kind).toBe("truncation");
    expect(view.banners[0].headline).toContain("18,000");
    expect(view.banners[0].headline).toContain("63,412");
  });

  it("leads with coverage on a clean run too, so 'no stall' is qualified", () => {
    const view = buildMonitorView(diagnoseRun(healthyLocalOpen()));

    expect(view.banners[0].kind).toBe("coverage");
    expect(view.banners.some((banner) => banner.kind === "not-health")).toBe(true);
  });

  it("puts every banner ahead of the phase table", () => {
    // Ordering is the whole point of the field: a coverage block a reader
    // reaches after the numbers is a footnote wearing a banner's clothes.
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));

    expect(view.banners.length).toBeGreaterThan(0);
    for (const banner of view.banners) expect(banner.headline.length).toBeGreaterThan(0);
  });

  it("names a gap that could hide the bottleneck", () => {
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));
    const gaps = view.banners.filter((banner) => banner.kind === "gap");

    expect(gaps.length).toBe(diagnoseRun(coldRemoteOpen()).coverage.gapCount);
  });
});

describe("durations read as durations", () => {
  it("keeps milliseconds under a second and switches to seconds above it", () => {
    expect(formatMs(0)).toBe("0 ms");
    expect(formatMs(912)).toBe("912 ms");
    expect(formatMs(9_140)).toBe("9.1 s");
    expect(formatMs(17_400)).toBe("17.4 s");
  });
});

describe("observation only", () => {
  it("exposes no action beyond saving and drilling in", () => {
    const view = buildMonitorView(diagnoseRun(coldRemoteOpen()));

    // The view model is data. Nothing here is a callback into the pipeline, and
    // the page cannot grow one without adding a field to this type.
    for (const value of Object.values(view)) expect(typeof value).not.toBe("function");
  });
});
