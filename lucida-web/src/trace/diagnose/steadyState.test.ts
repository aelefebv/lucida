/**
 * The steady-state ruleset (#1056), asserted on the diagnostic document
 * rather than on the recorder: each of the five rules fires on the interval
 * built for it and stays silent on a quiet one.
 *
 * The quiet fixture is the load-bearing case. A ruleset over the interval
 * after a settled view has no stall to anchor on, so every floor here is the
 * only thing between "the pipeline is still working" and "the pipeline is
 * fine" — a rule that fires on the heartbeat is a rule nobody will read
 * twice.
 */

import { describe, expect, it } from "vitest";

import { diagnoseDocument, diagnoseRun } from "./diagnose.ts";
import {
  availabilityLoopSteadyState,
  budgetBoundCoarseRun,
  healthyLocalOpen,
  makeDocument,
  prefetchSteadyState,
  quietSteadyState,
  refetchLoopSteadyState,
  sendHeavySteadyState,
} from "./fixtures.ts";
import { RULESET } from "./ruleset.ts";
import { renderDiagnostic } from "./renderText.ts";
import type { DiagnosticDocument, Finding } from "./types.ts";

const RULES = RULESET.steadyState;

function readingFor(interval: ReturnType<typeof quietSteadyState> | null): DiagnosticDocument {
  return diagnoseRun(healthyLocalOpen(), { steadyState: interval });
}

function steadyFindings(document: DiagnosticDocument): Finding[] {
  return document.findings.filter((finding) => finding.severity === "steady-state");
}

function firedRules(document: DiagnosticDocument): string[] {
  return steadyFindings(document).map((finding) => finding.rule);
}

describe("the quiet interval", () => {
  it("crosses none of the five thresholds", () => {
    const document = readingFor(quietSteadyState(healthyLocalOpen()));

    expect(firedRules(document)).toEqual([]);
    expect(document.verdict.kind).not.toBe("steady-state");
    expect(document.steadyState.statement).toContain("crossed no steady-state threshold");
  });

  it("still measures what it found, so a quiet interval reads as examined", () => {
    const { steadyState } = readingFor(quietSteadyState(healthyLocalOpen()));

    expect(steadyState.interval?.windowMs).toBe(10_000);
    // Two prefetch chunks, both inside the first second: busy, but for one
    // second of ten rather than the five the rule asks for.
    expect(steadyState.received?.requests).toBe(2);
    expect(steadyState.received?.busySeconds).toBe(1);
    expect(steadyState.refetch?.chunks).toBe(0);
    expect(steadyState.replans).toEqual({ passes: 1, availabilityWoken: 0 });
    expect(steadyState.sent?.bytes).toBe(3_000);
    expect(steadyState.tiers.map((tier) => tier.budgetBound)).toEqual([false, false]);
  });
});

describe("sustained receive after quiescence", () => {
  it("fires and attributes the traffic to the lane that carried it", () => {
    const document = readingFor(prefetchSteadyState(healthyLocalOpen()));
    const [finding] = steadyFindings(document);

    expect(finding.rule).toBe(RULES.received.id);
    expect(finding.observed.seconds).toBe(12);
    expect(finding.observed.windowMs).toBe(12_000);
    // 96 prefetch chunks and 2 detail chunks, at 40 KiB each.
    expect(finding.observed.breakdown).toEqual({
      prefetch: 96 * 40 * 1024,
      detail: 2 * 40 * 1024,
    });
    expect(document.verdict.text).toContain("most of it on the prefetch lane");
  });

  it("counts bytes once per wire request, not once per row that rode it", () => {
    const interval = prefetchSteadyState(healthyLocalOpen());
    const coalesced = {
      ...interval,
      // A second row on the first row's request, as the transport makes when
      // two members want the same chunk while one fetch is already out.
      rows: [...interval.rows, { ...interval.rows[0], entityId: "member-9" }],
    };

    expect(readingFor(coalesced).steadyState.received?.bytes).toBe(
      readingFor(interval).steadyState.received?.bytes,
    );
  });
});

describe("refetch", () => {
  it("states its window, its count and its bytes", () => {
    const document = readingFor(refetchLoopSteadyState(healthyLocalOpen()));
    const [finding] = steadyFindings(document);

    expect(finding.rule).toBe(RULES.refetch.id);
    // Twelve chunks fetched three times each: two refetches apiece at 2 KiB.
    expect(finding.observed.chunks).toBe(12);
    expect(finding.observed.refetches).toBe(24);
    expect(finding.observed.bytes).toBe(24 * 2 * 1024);
    expect(finding.observed.windowMs).toBe(8_000);
  });

  it("leaves the bytes alone below its floor, because a small loop is a boundary case", () => {
    const interval = refetchLoopSteadyState(healthyLocalOpen());
    const threeChunks = {
      ...interval,
      rows: interval.rows.filter((row) => Number(row.chunkKey.split("/")[4]) < 3),
    };

    expect(firedRules(readingFor(threeChunks))).toEqual([]);
    expect(readingFor(threeChunks).steadyState.refetch?.chunks).toBe(3);
  });
});

describe("a budget-bound tier", () => {
  it("reports a coverage loss rather than the timeout it caused", () => {
    const document = diagnoseRun(budgetBoundCoarseRun());
    const [finding] = steadyFindings(document);

    expect(document.run.endReason).toBe("timeout");
    expect(finding.rule).toBe(RULES.budgetBound.id);
    expect(finding.subject).toBe("coarse tier");
    expect(finding.observed.lossChunks).toBe(440);
    expect(finding.observed.lossPct).toBe(35);
    expect(finding.observed.fillPct).toBe(93);
    expect(document.verdict.kind).toBe("steady-state");
    expect(document.verdict.text).toContain("coverage loss of 35%, not a timeout");
    expect(document.verdict.text).not.toContain("never settled");
  });

  it("fires without an interval after the run, because the settle block is the evidence", () => {
    expect(diagnoseRun(budgetBoundCoarseRun()).steadyState.interval).toBeNull();
  });

  it("stays silent while the tier is still being filled", () => {
    const run = budgetBoundCoarseRun();
    const filling = {
      ...run,
      header: {
        ...run.header,
        outstandingAtSettle: { ...run.header.outstandingAtSettle, inFlight: 4 },
      },
    };

    expect(firedRules(diagnoseRun(filling))).toEqual([]);
    expect(diagnoseRun(filling).steadyState.tiers[1].budgetBound).toBe(false);
  });
});

describe("replans woken by an availability update alone", () => {
  it("counts the turns the client and the server took", () => {
    const document = readingFor(availabilityLoopSteadyState(healthyLocalOpen()));
    const [finding] = steadyFindings(document);

    expect(finding.rule).toBe(RULES.replans.id);
    expect(finding.observed.passes).toBe(10);
    expect(finding.observed.wokenPasses).toBe(8);
  });

  it("counts a pass once however many datasets it planned for", () => {
    const interval = availabilityLoopSteadyState(healthyLocalOpen());
    const twoDatasets = {
      ...interval,
      ticks: interval.ticks.flatMap((tick) => [tick, { ...tick, datasetId: "ds-b" }]),
    };

    expect(readingFor(twoDatasets).steadyState.replans).toEqual({
      passes: 10,
      availabilityWoken: 8,
    });
  });
});

describe("sustained send after quiescence", () => {
  it("fires and names the message type that kept the socket open", () => {
    const document = readingFor(sendHeavySteadyState(healthyLocalOpen()));
    const [finding] = steadyFindings(document);

    expect(finding.rule).toBe(RULES.sent.id);
    // 1,200 + 12,000 + 16,000 bytes over ten seconds.
    expect(finding.observed.bytes).toBe(29_200);
    expect(finding.observed.bytesPerS).toBe(2_920);
    expect(finding.observed.seconds).toBe(10);
    expect(document.verdict.text).toContain("mostly cursor messages");
  });
});

describe("the reading and the run's own findings", () => {
  it("ranks steady-state findings below the run's and above a note", () => {
    const document = diagnoseRun(budgetBoundCoarseRun(), {
      steadyState: refetchLoopSteadyState(budgetBoundCoarseRun()),
      // A baseline twice as fast makes the run's own phases regress, so the
      // list holds a stall and two steady-state findings at once.
      baseline: fasterBaseline(),
    });

    const severities = document.findings.map((finding) => finding.severity);
    expect(severities[0]).toBe("stall");
    expect(severities).toContain("steady-state");
    // Every stall precedes every steady-state finding: one is about the run,
    // the other about the interval after it.
    expect(severities.lastIndexOf("stall")).toBeLessThan(severities.indexOf("steady-state"));
    // The attribution is the run's answer to what it was waiting on, so it
    // rides the leading finding about the run rather than about the interval.
    expect(document.findings[0].attribution).not.toBeNull();
    for (const finding of steadyFindings(document)) expect(finding.attribution).toBeNull();
  });

  it("keeps the summary to three findings and prints each rule's rationale at depth", () => {
    const document = diagnoseRun(budgetBoundCoarseRun(), {
      steadyState: refetchLoopSteadyState(budgetBoundCoarseRun()),
      baseline: fasterBaseline(),
    });

    const summary = renderDiagnostic(document).text;
    expect(summary.match(/STEADY-STATE|STALL/g)?.length).toBeLessThanOrEqual(3);

    const deep = renderDiagnostic(document, { depth: "phases" }).text;
    expect(deep).toContain(RULES.budgetBound.why);
    expect(deep).toContain(RULES.refetch.why);
    expect(deep).toContain("STEADY STATE");
  });
});

describe("finding the interval", () => {
  it("reads the one that opened when the run closed", () => {
    const run = healthyLocalOpen();
    const document = makeDocument(
      [run],
      [quietSteadyState(run), sendHeavySteadyState({ ...run, header: { ...run.header, durationUs: 20_000_000 } })],
    );

    // Two intervals follow in the document; the first is the run's successor.
    expect(diagnoseDocument(document).steadyState.interval?.windowMs).toBe(10_000);
  });

  it("says when an interval handed over at the cap, so its numbers read as partial", () => {
    const run = healthyLocalOpen();
    const interval = quietSteadyState(run);
    const rotated = { ...interval, header: { ...interval.header, endReason: "rotated" as const } };

    expect(diagnoseRun(run, { steadyState: rotated }).steadyState.statement).toContain(
      "handed over to a fresh one",
    );
  });

  it("says so when the document holds none", () => {
    const document = diagnoseDocument(makeDocument([healthyLocalOpen()]));

    expect(document.steadyState.interval).toBeNull();
    expect(document.steadyState.statement).toContain("no steady-state interval followed this run");
  });

  it("leaves the interval out of a window on the run's clock", () => {
    const document = diagnoseRun(healthyLocalOpen(), {
      steadyState: prefetchSteadyState(healthyLocalOpen()),
      window: { startMs: 0, endMs: 100 },
    });

    expect(firedRules(document)).toEqual([]);
    expect(document.steadyState.statement).toContain("scoped to a window of the run's clock");
  });
});

/** A baseline whose phases are half this run's, so the comparative rule fires. */
function fasterBaseline(): DiagnosticDocument {
  const baseline = diagnoseRun(budgetBoundCoarseRun());
  return {
    ...baseline,
    phases: baseline.phases.map((phase) => ({ ...phase, p95Ms: phase.p95Ms / 4 })),
  };
}
