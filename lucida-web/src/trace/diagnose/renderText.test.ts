/**
 * The one renderer (#933). These cases assert on the rendered text as external
 * behaviour: what it always says, what it never exceeds, and that every number
 * in it exists in the document it came from.
 *
 * The parity check is the load-bearing one. Text is the agent default because
 * it is far smaller than the JSON, and that trade is only safe if a reader can
 * always go from a line of prose to the field it came from — a renderer that
 * computes a number of its own has produced a figure that exists nowhere and
 * can never be looked up.
 */

import { describe, expect, it } from "vitest";

import {
  coldRemoteOpen,
  healthyLocalOpen,
  interactionRun,
  makeRun,
  quietRun,
  saturatedReopen,
  uninstrumentedPrefixOpen,
} from "./fixtures.ts";
import { diagnoseRun } from "./diagnose.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  renderDiagnostic,
  type RenderedDiagnostic,
} from "./renderText.ts";
import type { DiagnosticDocument } from "./types.ts";

const MS = 1_000;

const RUNS = {
  healthy: healthyLocalOpen(),
  cold: coldRemoteOpen(),
  saturated: saturatedReopen(),
  interaction: interactionRun(),
  prefix: uninstrumentedPrefixOpen(),
  quiet: quietRun(),
};

const DOCUMENTS = Object.fromEntries(
  Object.entries(RUNS).map(([name, run]) => [name, diagnoseRun(run)]),
) as Record<keyof typeof RUNS, DiagnosticDocument>;

/** Numbers as the renderer prints them, with thousands separators removed. */
function numericTokens(text: string): string[] {
  return [...text.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

describe("the default rendering", () => {
  it("fits 30 lines and 3 kB on every fixture", () => {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const rendered = renderDiagnostic(document);
      const lines = rendered.text.split("\n");
      const bytes = new TextEncoder().encode(rendered.text).length;

      expect(lines.length, `${name}: ${lines.length} lines`).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(bytes, `${name}: ${bytes} bytes`).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    }
  });

  it("stays inside the budget when a run has many gaps and findings", () => {
    // Sixty gaps and a truncation record: the budget has to hold by dropping
    // bands, not by the input happening to be small.
    const run = makeRun({
      header: {
        durationUs: 60_000 * MS,
        endReason: "timeout",
        truncation: {
          reason: "per-run-cap",
          atUs: 30_000 * MS,
          capBytes: 2_000_000,
          rowsRecorded: 18_000,
          rowsUnrecorded: 45_412,
          ticksUnrecorded: 12,
          eventsUnrecorded: 3,
          serverRowsUnrecorded: 900,
        },
      },
      rows: coldRemoteOpen().rows,
      serverRows: coldRemoteOpen().serverRows,
      readings: saturatedReopen().readings,
      ticksDropped: 40,
      eventsDropped: 12,
      serverRowsDropped: 900,
    });
    const rendered = renderDiagnostic(diagnoseRun(run));
    expect(rendered.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(new TextEncoder().encode(rendered.text).length).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);

    // And when the budget genuinely cannot hold the content, it drops bands
    // and says so rather than overrunning.
    const squeezed = renderDiagnostic(diagnoseRun(run), { maxLines: 8 });
    expect(squeezed.text.split("\n").length).toBeLessThanOrEqual(8);
    expect(squeezed.droppedLines).toBeGreaterThan(0);
    expect(squeezed.text).toContain("lines dropped to fit");
    // The two unconditional lines survive every squeeze.
    expect(squeezed.text).toContain("coverage  ");
    expect(squeezed.text).toContain("NOT A HEALTH SIGNAL");
  });

  it("always carries the coverage line and the not-a-health-signal line", () => {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const { text } = renderDiagnostic(document);
      expect(text, name).toContain("coverage  ");
      expect(text, name).toContain("NOT A HEALTH SIGNAL");
      expect(text, name).toContain("VERDICT:");
      expect(text, name).toContain("degraded:");
    }
  });

  it("leads with truncation rather than footnoting it", () => {
    const run = makeRun({
      header: {
        durationUs: 330 * MS,
        truncation: {
          reason: "per-run-cap",
          atUs: 200 * MS,
          capBytes: 2_000_000,
          rowsRecorded: 18_000,
          rowsUnrecorded: 45_412,
          ticksUnrecorded: 12,
          eventsUnrecorded: 3,
          serverRowsUnrecorded: 900,
        },
      },
      rows: healthyLocalOpen().rows,
    });
    const lines = renderDiagnostic(diagnoseRun(run)).text.split("\n");

    const truncationLine = lines.findIndex((line) => line.startsWith("TRUNCATED"));
    const findingsLine = lines.findIndex((line) => line.startsWith("FINDINGS"));
    expect(truncationLine).toBeGreaterThanOrEqual(0);
    expect(truncationLine).toBeLessThan(findingsLine === -1 ? lines.length : findingsLine);
  });

  it("shows at most three findings and names the commands that go deeper", () => {
    const { text } = renderDiagnostic(DOCUMENTS.cold);
    const findingLines = text.split("\n").filter((line) => /^ {2}\d {2}/.test(line));

    expect(findingLines.length).toBeLessThanOrEqual(3);
    expect(text).toContain("lucida trace show");
    expect(text).toContain("--format chrome");
  });

  it("inlines nothing per-row at either depth", () => {
    for (const depth of ["summary", "stages"] as const) {
      const small = renderDiagnostic(diagnoseRun(rowCountRun(20)), { depth }).text;
      const large = renderDiagnostic(diagnoseRun(rowCountRun(4_000)), { depth }).text;

      expect(large.split("\n").length).toBe(small.split("\n").length);
      expect(large.length).toBeLessThan(small.length + 200);
    }
  });
});

describe("parity with the document", () => {
  it("prints no number that does not exist in the JSON", () => {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const inDocument = new Set(numericTokens(JSON.stringify(document)));
      for (const depth of ["summary", "stages"] as const) {
        const { text } = renderDiagnostic(document, { depth });
        for (const token of numericTokens(text)) {
          expect(inDocument.has(token), `${name}/${depth}: ${token} is printed but not in the document`).toBe(
            true,
          );
        }
      }
    }
  });

  it("records the document path of every number it prints", () => {
    const rendered: RenderedDiagnostic = renderDiagnostic(DOCUMENTS.saturated);
    expect(rendered.provenance.length).toBeGreaterThan(5);
    for (const entry of rendered.provenance) {
      expect(entry.path).not.toBe("");
      expect(entry.formatted).not.toBe("");
    }
  });

  it("keeps the text the smaller artifact, which is why it is the default", () => {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const text = renderDiagnostic(document).text;
      const identical = JSON.stringify(sameContentAsText(document));
      const whole = JSON.stringify(document);

      // Assert the shape and log the numbers. #893 measured about 2.6x for
      // identical content against its own document; re-derived here it is
      // 1.2-1.3x for identical content and 7-10x for the whole document, which
      // carries the ruleset and the structural limits the text never prints.
      // The direction is what the default rests on, and it holds either way; a
      // tight bound on a ratio that moves with a run's findings is a flake
      // waiting to happen, and this repo already has one of those.
      console.log(
        `${name}: text ${text.length} B · same-content JSON ${identical.length} B ` +
          `(${(identical.length / text.length).toFixed(1)}x) · whole document ${whole.length} B ` +
          `(${(whole.length / text.length).toFixed(1)}x)`,
      );
      expect(identical.length).toBeGreaterThan(text.length);
      expect(whole.length).toBeGreaterThan(identical.length);
    }
  });
});

/**
 * The document reduced to what the default text actually prints — no
 * rationales, no ruleset, no structural limits. This is the "identical
 * content" side of the size comparison; measuring the whole document against
 * the text would compare two different things and flatter the text.
 */
function sameContentAsText(document: DiagnosticDocument) {
  return {
    runId: document.runId,
    verdict: document.verdict,
    attribution: { confidence: document.attribution.confidence, degraded: document.attribution.degraded },
    run: {
      datasetIds: document.run.datasetIds,
      cause: document.run.cause,
      warmth: document.run.warmth,
      wallMs: document.run.wallMs,
      endReason: document.run.endReason,
      devicePixelRatio: document.run.devicePixelRatio,
      viewport: document.run.viewport,
      gpu: document.run.gpu,
      build: document.run.build,
    },
    coverage: {
      wallMs: document.coverage.wallMs,
      accountedMs: document.coverage.accountedMs,
      accountedPct: document.coverage.accountedPct,
      gapCount: document.coverage.gapCount,
      incomplete: document.coverage.incomplete,
      truncated: document.coverage.truncated,
      gaps: document.coverage.gaps.map((gap) => ({
        kind: gap.kind,
        durationMs: gap.durationMs,
        records: gap.records,
        couldHideBottleneck: gap.couldHideBottleneck,
      })),
      notHealthSignals: document.coverage.notHealthSignals,
    },
    findings: document.findings.slice(0, 3).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      subject: finding.subject,
      rule: finding.rule,
      observed: finding.observed,
      why: finding.attribution?.why,
    })),
    next: document.next,
  };
}

/** The same run at two row counts. Identical rows, so only the count moves. */
function rowCountRun(count: number) {
  const template = healthyLocalOpen().rows[0];
  return makeRun({
    header: { runId: "sized", durationUs: 330 * MS },
    rows: Array.from({ length: count }, (_, i) => ({ ...template, rid: i, y: i })),
  });
}
