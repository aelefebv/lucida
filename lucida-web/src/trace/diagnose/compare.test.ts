/**
 * Two runs compared (#1059). Every case asserts on the comparison document or
 * its text, never on how the deltas were walked: which phase grew, which
 * finding appeared, which header field makes the pair incomparable.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PLANNING_CONFIG } from "../../pipeline/planning/config.ts";
import { compareTraces, renderComparison } from "./compare.ts";
import { coldRemoteOpen, healthyLocalOpen, makeDocument, makeRun } from "./fixtures.ts";

const MS = 1_000;

function healthyDocument() {
  return makeDocument([healthyLocalOpen()]);
}

function coldDocument() {
  return makeDocument([coldRemoteOpen()]);
}

describe("compareTraces", () => {
  it("compares a run with itself as identical", () => {
    const comparison = compareTraces({ trace: healthyDocument() }, { trace: healthyDocument() });

    expect(comparison.left.runId).toBe("local-healthy");
    expect(comparison.right.runId).toBe("local-healthy");
    expect(comparison.comparable).toBe(true);
    expect(comparison.warnings).toEqual([]);
    expect(comparison.header.every((field) => field.same)).toBe(true);
    expect(comparison.wall.deltaMs).toBe(0);
    expect(comparison.verdictChanged).toBe(false);
    expect(comparison.phases.length).toBeGreaterThan(0);
    for (const phase of comparison.phases) {
      expect(phase.left).not.toBeNull();
      expect(phase.right).not.toBeNull();
      expect(phase.delta).toEqual({ n: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, totalMs: 0 });
    }
    for (const finding of comparison.findings) {
      expect(finding.status).toBe("both");
      expect(Object.values(finding.delta ?? {}).every((value) => value === 0)).toBe(true);
    }
  });

  it("reports phase deltas as right minus left, with one-sided phases named as such", () => {
    const comparison = compareTraces({ trace: healthyDocument() }, { trace: coldDocument() });

    const wire = comparison.phases.find((phase) => phase.id === "browser.wire");
    expect(wire).toBeDefined();
    expect(wire!.left).not.toBeNull();
    expect(wire!.right).not.toBeNull();
    expect(wire!.delta).not.toBeNull();
    expect(wire!.delta!.p95Ms).toBe(wire!.right!.p95Ms - wire!.left!.p95Ms);
    expect(wire!.delta!.p95Ms).toBeGreaterThan(0);
    expect(wire!.delta!.n).toBe(60 - 120);

    // The cold remote open carries server rows the healthy local open does not.
    const permit = comparison.phases.find((phase) => phase.id === "server.permit-wait");
    expect(permit).toBeDefined();
    expect(permit!.left).toBeNull();
    expect(permit!.right).not.toBeNull();
    expect(permit!.delta).toBeNull();

    expect(comparison.wall.leftMs).toBe(330);
    expect(comparison.wall.rightMs).toBe(4120);
    expect(comparison.wall.deltaMs).toBe(4120 - 330);
  });

  it("reports findings as shared, left only, or right only, and the verdict change", () => {
    const comparison = compareTraces({ trace: healthyDocument() }, { trace: coldDocument() });

    expect(comparison.left.verdict.kind).toBe("clear");
    expect(comparison.right.verdict.kind).not.toBe("clear");
    expect(comparison.verdictChanged).toBe(true);
    const rightOnly = comparison.findings.filter((finding) => finding.status === "right-only");
    expect(rightOnly.length).toBeGreaterThan(0);
    expect(rightOnly.some((finding) => finding.right?.severity === "stall")).toBe(true);
    for (const finding of rightOnly) {
      expect(finding.left).toBeNull();
      expect(finding.delta).toBeNull();
    }
    const shared = comparison.findings.filter((finding) => finding.status === "both");
    for (const finding of shared) {
      expect(finding.left).not.toBeNull();
      expect(finding.right).not.toBeNull();
      expect(finding.delta).not.toBeNull();
    }
  });

  it("warns when a header field the runs must share differs, and stays quiet when only the experiment differs", () => {
    const retina = makeDocument([makeRun({ header: { runId: "retina", durationUs: 400 * MS } })]);
    const lowDpr = makeDocument([
      makeRun({
        header: {
          runId: "low",
          durationUs: 400 * MS,
          devicePixelRatio: 1,
          viewport: { cssWidth: 1440, cssHeight: 900, deviceWidth: 1440, deviceHeight: 900 },
        },
      }),
    ]);
    const comparison = compareTraces({ trace: retina }, { trace: lowDpr });

    expect(comparison.comparable).toBe(false);
    expect(comparison.warnings.some((warning) => warning.includes("device pixel ratio"))).toBe(true);
    const dpr = comparison.header.find((field) => field.field === "devicePixelRatio");
    expect(dpr).toEqual({
      field: "devicePixelRatio",
      group: "run",
      left: 2,
      right: 1,
      same: false,
      breaksComparability: true,
    });
    // The identity block states the viewport in device pixels, so the same
    // CSS window at another ratio is another viewport, and warned about too.
    expect(comparison.header.find((field) => field.field === "viewport")?.same).toBe(false);
    expect(comparison.warnings.some((warning) => warning.includes("viewport"))).toBe(true);

    // A run file that set no knob ran at the defaults, and says so with an
    // empty object.
    const experiment = compareTraces(
      { trace: healthyDocument(), planning: { prefetchDepth: 0 } },
      { trace: healthyDocument(), planning: {} },
    );
    expect(experiment.comparable).toBe(true);
    expect(experiment.warnings).toEqual([]);
    const prefetch = experiment.header.find((field) => field.field === "planning.prefetchDepth");
    expect(prefetch).toEqual({
      field: "planning.prefetchDepth",
      group: "planning",
      left: 0,
      right: DEFAULT_PLANNING_CONFIG.prefetchDepth,
      same: false,
      breaksComparability: false,
    });
    // A planning field neither side set is the default on both, and same.
    expect(experiment.header.find((field) => field.field === "planning.distanceWeight")?.same).toBe(true);

    // A side that says nothing about its configuration is unknown, not the defaults.
    const unknown = compareTraces(
      { trace: healthyDocument(), planning: { prefetchDepth: 0 } },
      { trace: healthyDocument() },
    );
    expect(unknown.header.find((field) => field.field === "planning.distanceWeight")).toMatchObject({
      left: DEFAULT_PLANNING_CONFIG.distanceWeight,
      right: null,
      same: false,
    });
    expect(renderComparison(unknown)).toContain("planning.prefetchDepth 0 → unknown");
  });

  it("lists a cache knob only when a side set one, and reads the other side as the default", () => {
    const none = compareTraces({ trace: healthyDocument() }, { trace: healthyDocument() });
    expect(none.header.some((field) => field.field.startsWith("cache."))).toBe(false);

    const one = compareTraces(
      { trace: healthyDocument(), cache: { maxConcurrentFetches: 2 } },
      { trace: healthyDocument() },
    );
    expect(one.header.find((field) => field.field === "cache.maxConcurrentFetches")).toEqual({
      field: "cache.maxConcurrentFetches",
      group: "cache",
      left: 2,
      right: null,
      same: false,
      breaksComparability: false,
    });
    expect(one.header.some((field) => field.field === "cache.mainBudgetBytes")).toBe(false);
  });

  it("carries the conditions a caller knows and the trace does not, without judging them", () => {
    const comparison = compareTraces(
      { trace: healthyDocument(), conditions: { "server warmth": "cold" } },
      { trace: healthyDocument(), conditions: { "server warmth": "warm" } },
    );
    expect(comparison.comparable).toBe(true);
    expect(comparison.header.find((field) => field.field === "server warmth")).toEqual({
      field: "server warmth",
      group: "condition",
      left: "cold",
      right: "warm",
      same: false,
      breaksComparability: false,
    });
  });

  it("reads the run a side names out of a document holding several, and labels sides by run id unless told otherwise", () => {
    const both = makeDocument([healthyLocalOpen(), coldRemoteOpen()]);
    const comparison = compareTraces(
      { trace: both, runId: "local-healthy", label: "before.json" },
      { trace: both, runId: "remote-cold" },
    );
    expect(comparison.left.runId).toBe("local-healthy");
    expect(comparison.left.label).toBe("before.json");
    expect(comparison.right.runId).toBe("remote-cold");
    expect(comparison.right.label).toBe("remote-cold");
    expect(comparison.next.map((step) => step.command)).toEqual([
      "lucida trace show local-healthy --phases",
      "lucida trace show remote-cold --phases",
    ]);

    expect(() => compareTraces({ trace: both, runId: "nope" }, { trace: both })).toThrow(/no run nope/);
  });
});

describe("renderComparison", () => {
  it("names both runs, says which way the deltas go, and prints the phase and finding deltas", () => {
    const comparison = compareTraces({ trace: healthyDocument() }, { trace: coldDocument() });
    const text = renderComparison(comparison);
    const lines = text.split("\n");

    expect(lines[0]).toContain("lucida trace diff local-healthy remote-cold");
    expect(lines[0]).toContain("right minus left");
    expect(text).toContain("left      local-healthy");
    expect(text).toContain("right     remote-cold");
    expect(text).not.toContain("NOT COMPARABLE");
    expect(text).toContain("wall      330 → 4120 ms (+3790");
    expect(text).toContain("verdict clear → stall");
    expect(text).toContain("PHASES");
    expect(text).toMatch(/browser\.wire\s+n 120→60 \(-60\)/);
    expect(text).toMatch(/server\.permit-wait\s+right only/);
    expect(text).toContain("FINDINGS");
    expect(text).toMatch(/\n {3}right {5}STALL/);
    expect(text).toContain("lucida trace show local-healthy --phases");
    expect(text).toContain("lucida trace show remote-cold --phases");
  });

  it("leads with the comparability warning when the headers differ", () => {
    const retina = makeDocument([makeRun({ header: { runId: "retina", durationUs: 400 * MS } })]);
    const lowDpr = makeDocument([
      makeRun({ header: { runId: "low", durationUs: 400 * MS, devicePixelRatio: 1 } }),
    ]);
    const text = renderComparison(compareTraces({ trace: retina }, { trace: lowDpr }));
    expect(text).toContain("NOT COMPARABLE  device pixel ratio 2 vs 1");
  });

  it("prints the header fields that differ and says when none do", () => {
    const same = renderComparison(compareTraces({ trace: healthyDocument() }, { trace: healthyDocument() }));
    expect(same).toContain("header    no difference");

    const experiment = renderComparison(
      compareTraces(
        { trace: healthyDocument(), planning: { prefetchDepth: 0 } },
        { trace: healthyDocument(), planning: {}, cache: { maxConcurrentFetches: 2 } },
      ),
    );
    expect(experiment).toContain("planning.prefetchDepth 0 → 2");
    expect(experiment).toContain("cache.maxConcurrentFetches default → 2");
  });
});
