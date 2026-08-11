import { describe, it, expect } from "vitest";

import { computeCoverage, MIN_REPORTED_GAP_US, STRUCTURAL_LIMITS } from "./coverage.ts";
import type { CoverageGapKind, Phase, TraceRow, TraceTick, TruncationRecord } from "./types.ts";

const MS = 1_000;

function row(phases: Partial<Record<Phase, [number, number]>>): TraceRow {
  const built: TraceRow["phases"] = {};
  for (const [phase, span] of Object.entries(phases)) {
    const [startUs, endUs] = span as [number, number];
    built[phase as Phase] = { startUs, endUs, durationUs: endUs - startUs };
  }
  return {
    rid: 1,
    connectionGeneration: 1,
    datasetId: "ds",
    entityId: "member-1",
    imageId: "image-1",
    lane: "detail",
    residencyTier: "detail",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: "0/0/0/0/0/0",
    outcome: "complete",
    phases: built,
  };
}

function tick(counted: Partial<TraceTick["counted"]>): TraceTick {
  return {
    atUs: 0,
    datasetId: "ds",
    counters: {} as TraceTick["counters"],
    counted: { "cache-admission": 0, "worker-dispatch": 0, "coalesce-attach": 0, ...counted },
    levels: [],
    levelsDropped: 0,
  };
}

function coverageOf(overrides: Partial<Parameters<typeof computeCoverage>[0]> = {}) {
  return computeCoverage({
    wallClockUs: 1_000 * MS,
    rows: [],
    ticks: [],
    truncation: null,
    ticksDropped: 0,
    eventsDropped: 0,
    serverRowsDropped: 0,
    ...overrides,
  });
}

function kinds(gaps: { kind: CoverageGapKind }[]): CoverageGapKind[] {
  return gaps.map(gap => gap.kind);
}

describe("accounted wall clock", () => {
  it("counts overlapping phase spans once", () => {
    const coverage = coverageOf({
      wallClockUs: 100 * MS,
      rows: [row({ wire: [0, 60 * MS] }), row({ wire: [30 * MS, 90 * MS] })],
    });

    expect(coverage.accountedUs).toBe(90 * MS);
    expect(coverage.unaccountedUs).toBe(10 * MS);
  });

  it("keeps the unaccounted remainder exact even when no gap is worth listing", () => {
    const sliver = MIN_REPORTED_GAP_US - 1;
    const coverage = coverageOf({
      wallClockUs: 100 * MS,
      rows: [row({ wire: [0, 50 * MS] }), row({ wire: [50 * MS + sliver, 100 * MS] })],
    });

    expect(coverage.unaccountedUs).toBe(sliver);
    expect(coverage.gaps).toHaveLength(0);
  });

  it("clamps a span that runs past the run's own duration", () => {
    const coverage = coverageOf({ wallClockUs: 10 * MS, rows: [row({ wire: [0, 40 * MS] })] });

    expect(coverage.accountedUs).toBe(10 * MS);
    expect(coverage.unaccountedUs).toBe(0);
  });

  it("reports a run that timed nothing as wholly unaccounted, and says so in those words", () => {
    const coverage = coverageOf({ wallClockUs: 300 * MS });

    expect(coverage.accountedUs).toBe(0);
    expect(coverage.unaccountedUs).toBe(300 * MS);
    // Not `unrecorded-prefix`, which would read as boot: nothing was measured
    // at any point, which is different news.
    expect(kinds(coverage.gaps)).toEqual(["nothing-recorded"]);
  });
});

describe("interval gaps", () => {
  it("names the prefix, the interior and the suffix separately", () => {
    const coverage = coverageOf({
      wallClockUs: 1_000 * MS,
      rows: [row({ wire: [300 * MS, 400 * MS] }), row({ wire: [700 * MS, 800 * MS] })],
    });

    expect(kinds(coverage.gaps)).toEqual([
      "unrecorded-prefix",
      "unaccounted-interior",
      "unrecorded-suffix",
    ]);
    expect(coverage.gaps[0]).toMatchObject({ startUs: 0, endUs: 300 * MS, durationUs: 300 * MS });
    expect(coverage.gaps[2]).toMatchObject({ startUs: 800 * MS, endUs: 1_000 * MS });
  });

  it("flags a gap long enough to hold the bottleneck", () => {
    const coverage = coverageOf({
      wallClockUs: 1_000 * MS,
      rows: [row({ wire: [870 * MS, 1_000 * MS] })],
    });

    expect(coverage.gaps[0].couldHideBottleneck).toBe(true);
  });

  it("does not flag a gap too short to be anybody's bottleneck", () => {
    const coverage = coverageOf({
      wallClockUs: 1_000 * MS,
      rows: [row({ wire: [0, 900 * MS] }), row({ wire: [901 * MS, 1_000 * MS] })],
    });

    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0].couldHideBottleneck).toBe(false);
  });

  it("does not flag a long gap that is a small share of a long run", () => {
    const coverage = coverageOf({
      wallClockUs: 60_000 * MS,
      rows: [row({ wire: [0, 59_700 * MS] })],
    });

    expect(coverage.gaps[0].durationUs).toBe(300 * MS);
    expect(coverage.gaps[0].couldHideBottleneck).toBe(false);
  });
});

describe("truncation", () => {
  const truncation: TruncationRecord = {
    reason: "per-run-cap",
    atUs: 400 * MS,
    capBytes: 2 * 1024 * 1024,
    rowsRecorded: 18_000,
    rowsUnrecorded: 45_412,
    ticksUnrecorded: 3,
    eventsUnrecorded: 0,
    serverRowsUnrecorded: 12,
  };

  it("replaces the tail with one truncated gap that always could hide the bottleneck", () => {
    const coverage = coverageOf({
      wallClockUs: 1_000 * MS,
      rows: [row({ wire: [0, 400 * MS] })],
      truncation,
    });

    expect(kinds(coverage.gaps)).toEqual(["truncated"]);
    expect(coverage.gaps[0]).toMatchObject({
      startUs: 400 * MS,
      endUs: 1_000 * MS,
      durationUs: 600 * MS,
      // Every tier the tail swallowed, not just the rows.
      records: 45_412 + 3 + 0 + 12,
      couldHideBottleneck: true,
    });
  });

  it("still names the gaps before the truncation offset", () => {
    const coverage = coverageOf({
      wallClockUs: 1_000 * MS,
      rows: [row({ wire: [300 * MS, 400 * MS] })],
      truncation,
    });

    expect(kinds(coverage.gaps)).toEqual(["unrecorded-prefix", "truncated"]);
  });
});

describe("stream losses", () => {
  it("names each dropped stream and does not let it hide elapsed time", () => {
    const coverage = coverageOf({
      wallClockUs: 100 * MS,
      rows: [row({ wire: [0, 100 * MS] })],
      ticksDropped: 7,
      eventsDropped: 2,
      serverRowsDropped: 5,
    });

    expect(kinds(coverage.gaps)).toEqual(["ticks-dropped", "events-dropped", "server-rows-dropped"]);
    for (const gap of coverage.gaps) {
      expect(gap.durationUs).toBe(0);
      expect(gap.startUs).toBeNull();
      expect(gap.couldHideBottleneck).toBe(false);
    }
    expect(coverage.gaps.map(gap => gap.records)).toEqual([7, 2, 5]);
  });
});

describe("what a clean run still cannot tell you", () => {
  it("carries a coverage block with no gaps on a fully accounted run", () => {
    const coverage = coverageOf({ wallClockUs: 100 * MS, rows: [row({ wire: [0, 100 * MS] })] });

    expect(coverage.gaps).toEqual([]);
    expect(coverage.unaccountedUs).toBe(0);
    expect(coverage.limits).toEqual(STRUCTURAL_LIMITS);
  });

  it("sums the counted-not-timed phases across the run's tick samples", () => {
    const coverage = coverageOf({
      ticks: [tick({ "cache-admission": 4 }), tick({ "cache-admission": 6, "worker-dispatch": 1 })],
    });

    expect(coverage.countedPhases).toEqual({
      "cache-admission": 10,
      "worker-dispatch": 1,
      "coalesce-attach": 0,
    });
  });
});
