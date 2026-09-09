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
  fallbackAdapterOpen,
  gpuTimedOpen,
  healthyLocalOpen,
  interactionRun,
  lateStallOpen,
  mainThreadOnlyOpen,
  makeRun,
  quietRun,
  saturatedReopen,
  sendHeavyIdleRun,
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
  sendHeavy: sendHeavyIdleRun(),
  lateStall: lateStallOpen(),
  gpuTimed: gpuTimedOpen(),
  mainThreadOnly: mainThreadOnlyOpen(),
  fallback: fallbackAdapterOpen(),
};

const DOCUMENTS = {
  ...(Object.fromEntries(
    Object.entries(RUNS).map(([name, run]) => [name, diagnoseRun(run)]),
  ) as Record<keyof typeof RUNS, DiagnosticDocument>),
  // Windowed readings sit beside the whole ones so every budget and parity
  // case below covers the window line and the scoped follow-ups too.
  firstHalf: diagnoseRun(lateStallOpen(), { window: { startMs: 0, endMs: 1_000 } }),
  tail: diagnoseRun(coldRemoteOpen(), { window: { startMs: 3_700, endMs: 4_120 } }),
  wholeWindow: diagnoseRun(saturatedReopen(), { window: { startMs: 0, endMs: 12_000 } }),
};

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

    // And a budget below what even the required lines occupy is still honoured:
    // a verdict's prose is unbounded, the budget is not.
    const clamped = renderDiagnostic(diagnoseRun(run), { maxLines: 8, maxBytes: 400 });
    expect(new TextEncoder().encode(clamped.text).length).toBeLessThanOrEqual(400);
    expect(clamped.text).toContain("…");
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
    expect(text).toContain("lucida trace perfetto");
    // A whole-run reading offers a narrower window too.
    expect(text).toMatch(/lucida trace show remote-cold --window \d+\.\.\d+/);
  });

  it("names the window it read, before the coverage it qualifies", () => {
    const lines = renderDiagnostic(DOCUMENTS.firstHalf).text.split("\n");
    const windowLine = lines.findIndex((line) => line.startsWith("window    "));
    const coverageLine = lines.findIndex((line) => line.startsWith("coverage  "));

    expect(windowLine).toBeGreaterThanOrEqual(0);
    expect(windowLine).toBeLessThan(coverageLine);
    expect(lines[windowLine]).toContain("0..1000 ms of the 2000 ms run");
    expect(lines[windowLine]).toContain("count for the part inside");
    expect(lines[windowLine]).toContain("with no position left out");
    expect(lines.some((line) => /--phases --window 0\.\.1000/.test(line))).toBe(true);

    const whole = renderDiagnostic(DOCUMENTS.wholeWindow).text;
    expect(whole).toContain("window    0..12000 ms of the 12000 ms run (the whole run)");
    expect(renderDiagnostic(DOCUMENTS.saturated).text).not.toContain("window    ");
  });

  it("starts a windowed critical path where the window does", () => {
    const { text } = renderDiagnostic(
      diagnoseRun(healthyLocalOpen(), { window: { startMs: 100, endMs: 330 } }),
      { depth: "phases" },
    );
    expect(text).toMatch(/CRITICAL PATH {2}from 100 ms to last chunk presented at \d+(\.\d+)? ms/);
    expect(renderDiagnostic(DOCUMENTS.healthy, { depth: "phases" }).text).toMatch(
      /CRITICAL PATH {2}to last chunk presented/,
    );
  });

  it("inlines nothing per-row at either depth", () => {
    for (const depth of ["summary", "phases"] as const) {
      const small = renderDiagnostic(diagnoseRun(rowCountRun(20)), { depth }).text;
      const large = renderDiagnostic(diagnoseRun(rowCountRun(4_000)), { depth }).text;

      expect(large.split("\n").length).toBe(small.split("\n").length);
      expect(large.length).toBeLessThan(small.length + 200);
    }
  });

  it("names the worst row's chunk and the spatial summary among the commands", () => {
    const { text } = renderDiagnostic(DOCUMENTS.healthy);
    expect(text).toContain("lucida trace show local-healthy --chunk member-7/1/0/0/0/119/0");
    expect(text).toContain("lucida trace show local-healthy --spatial");
  });
});

describe("the chunk depth", () => {
  it("prints the phase history, the queue rank and the age of the chunk", () => {
    const { text } = renderDiagnostic(DOCUMENTS.healthy, { depth: "chunk" });

    expect(text).toContain("CHUNK     member-7/1/0/0/0/119/0");
    expect(text).toContain("the row that spent longest in browser.wire");
    expect(text).toContain("plan 0.4 → queue 2 → wire 240 → decode 0.9 → upload 1.2 → present 2 ms");
    expect(text).toContain("9 ahead at admission");
    expect(text).toContain("waited 2 ms");
    expect(text).toContain("age 246.5 ms");
    expect(text).toContain("complete");
    // The chunk reading replaces the findings block.
    expect(text).not.toContain("FINDINGS");
    expect(text).toContain("cannot see:");
  });

  it("says the chunk is not in the run", () => {
    const document = diagnoseRun(RUNS.healthy, { chunk: "1/0/0/0/999/0" });
    const { text } = renderDiagnostic(document, { depth: "chunk" });
    expect(text).toContain("CHUNK     1/0/0/0/999/0");
    expect(text).toContain("not in this run");
    expect(text).toContain("never dispatched");
  });

  it("lists a chunk still in the queue with its rank now", () => {
    const document = diagnoseRun(RUNS.saturated, { chunk: "1/0/0/0/300/0" });
    const { text } = renderDiagnostic(document, { depth: "chunk" });
    expect(text).toContain("in queue");
    expect(text).toContain("170 ahead at admission");
    expect(text).toContain("not dispatched");
  });

  it("fits the default budget on every fixture and when a key matches a whole collection", () => {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const rendered = renderDiagnostic(document, { depth: "chunk" });
      expect(rendered.text.split("\n").length, name).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(new TextEncoder().encode(rendered.text).length, name).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    }
    const rendered = renderDiagnostic(diagnoseRun(collectionRun(), { chunk: "1/0/0/0/0/0" }), {
      depth: "chunk",
    });
    expect(rendered.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(rendered.droppedLines).toBeGreaterThan(0);
    expect(rendered.text).toContain("name the entity");
  });
});

describe("the spatial depth", () => {
  it("prints counts and boxes per state and level", () => {
    const { text } = renderDiagnostic(DOCUMENTS.saturated, { depth: "spatial" });

    expect(text).toContain("SPATIAL   400 rows");
    expect(text).toMatch(/queue\s+L1 detail\s+n=\s*140/);
    expect(text).toMatch(/complete\s+L1 detail\s+n=\s*260/);
    expect(text).toContain("y 260..399");
    expect(text).toContain("y 0..259");
    expect(text).toContain("chunk indices");
    expect(text).toContain("cannot show:");
    expect(text).not.toContain("FINDINGS");
  });

  it("names the dataset only when the run has more than one", () => {
    const groupLines = (text: string) => text.split("\n").filter((line) => /^ {2,3}\d+ {2}/.test(line));

    const one = renderDiagnostic(DOCUMENTS.healthy, { depth: "spatial" }).text;
    expect(groupLines(one)).toHaveLength(1);
    expect(groupLines(one)[0]).not.toContain(" ds ");

    const rows = [
      ...RUNS.healthy.rows.slice(0, 3),
      ...RUNS.healthy.rows.slice(3, 6).map((row) => ({ ...row, datasetId: "other" })),
    ];
    const two = renderDiagnostic(
      diagnoseRun(makeRun({ header: { durationUs: 330 * MS, datasetIds: ["ds", "other"] }, rows })),
      { depth: "spatial" },
    ).text;
    expect(groupLines(two)).toHaveLength(2);
    expect(groupLines(two)[0]).toContain(" ds ");
    expect(groupLines(two)[1]).toContain(" other ");
  });

  it("stays under 30 lines when there are more groups than fit", () => {
    const rendered = renderDiagnostic(diagnoseRun(manyGroupsRun()), { depth: "spatial" });
    const lines = rendered.text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(rendered.droppedLines).toBeGreaterThan(0);
    expect(rendered.text).toContain("lines dropped to fit");
    // In-flight groups sort first, so they survive the drop.
    expect(rendered.text).toMatch(/\bwire\b/);
  });
});

describe("render timing and the adapter", () => {
  function line(document: DiagnosticDocument, prefix: string): string {
    const found = renderDiagnostic(document).text.split("\n").find((l) => l.startsWith(prefix));
    expect(found, `${prefix} line`).toBeDefined();
    return found!;
  }

  it("prints GPU pass time beside main-thread frame time, each named for its clock", () => {
    const render = line(DOCUMENTS.gpuTimed, "render");
    expect(render).toContain("main-thread frame p50 3.5 ms · p95 3.5 ms (n=12)");
    expect(render).toContain("GPU pass p50 1.2 ms · p95 2.4 ms (n=11)");
  });

  it("calls frame time main-thread time and says why GPU time is missing, never printing a zero for it", () => {
    const render = line(DOCUMENTS.mainThreadOnly, "render");
    expect(render).toContain("main-thread frame p50 3.5 ms");
    expect(render).toContain("GPU pass not recorded: the adapter offers no timestamp queries");
    expect(render).not.toMatch(/GPU pass p\d+ /);
  });

  it("prints the adapter, its description, and its kind on the client line, in both states", () => {
    expect(line(DOCUMENTS.fallback, "client")).toContain(
      "generic software (software rasterizer) · software fallback adapter",
    );
    expect(line(DOCUMENTS.healthy, "client")).toContain("apple metal-3 · hardware adapter");
  });

  it("says so when no adapter was identified", () => {
    const document = diagnoseRun(makeRun({ header: { gpu: null } }));
    expect(line(document, "client")).toContain("unknown · adapter not identified");
    expect(line(document, "render")).toContain("no adapter was identified");
  });
});

describe("the sent line", () => {
  it("shows sent bytes per second by type for the run, naming only the types that sent", () => {
    const line = renderDiagnostic(DOCUMENTS.sendHeavy).text.split("\n").find((l) => l.startsWith("sent"));

    expect(line).toBe(
      "sent      3,038 B/s · chunk request 118 B/s n=12 · viewer interest 120 B/s n=10 · " +
        "presence 1,200 B/s n=40 · cursor 1,600 B/s n=400",
    );
  });

  it("says so when a run sent nothing", () => {
    const line = renderDiagnostic(DOCUMENTS.quiet).text.split("\n").find((l) => l.startsWith("sent"));
    expect(line).toBe("sent      nothing on the session socket");
  });

  it("lists every type with its bytes at the phases depth, zeros included", () => {
    const text = renderDiagnostic(DOCUMENTS.sendHeavy, { depth: "phases" }).text;
    const block = text.slice(text.indexOf("SENT"));

    expect(block).toMatch(/cursor\s+n=\s+400\s+16000 B\s+1600 B\/s/);
    expect(block).toMatch(/asset request\s+n=\s+0\s+0 B\s+0 B\/s/);
  });
});

describe("parity with the document", () => {
  it("prints no number that does not exist in the JSON", () => {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const inDocument = new Set(numericTokens(JSON.stringify(document)));
      for (const depth of ["summary", "phases", "chunk", "spatial"] as const) {
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
    window: document.window,
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
      adapter: document.run.adapter,
      build: document.run.build,
    },
    renderTiming: document.renderTiming,
    coverage: {
      wallMs: document.coverage.wallMs,
      accountedMs: document.coverage.accountedMs,
      accountedPct: document.coverage.accountedPct,
      gapCount: document.coverage.gapCount,
      incomplete: document.coverage.incomplete,
      truncated: document.coverage.truncated,
      window: document.coverage.window,
      gaps: document.coverage.gaps.map((gap) => ({
        kind: gap.kind,
        durationMs: gap.durationMs,
        records: gap.records,
        couldHideBottleneck: gap.couldHideBottleneck,
      })),
      notHealthSignals: document.coverage.notHealthSignals,
    },
    sent: {
      bytesPerS: document.sent.bytesPerS,
      byType: document.sent.byType
        .filter((entry) => entry.messages > 0)
        .map((entry) => ({ label: entry.label, messages: entry.messages, bytesPerS: entry.bytesPerS })),
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

/** One chunk key across forty tiles, the shape a bare key meets on a collection. */
function collectionRun() {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    ...healthyLocalOpen().rows[i],
    entityId: `tile-${i}`,
    y: 0,
    chunkKey: "1/0/0/0/0/0",
  }));
  return makeRun({ header: { runId: "collection", durationUs: 330 * MS }, rows });
}

/** Rows in every state at six levels: more groups than thirty lines can hold. */
function manyGroupsRun() {
  const template = healthyLocalOpen().rows[0];
  const rows = [];
  for (let level = 0; level < 6; level += 1) {
    for (const [outcome, phases] of [
      ["complete", template.phases],
      ["retired", { plan: template.phases.plan, queue: template.phases.queue }],
      ["in-flight", { plan: template.phases.plan, queue: template.phases.queue }],
      ["in-flight", { plan: template.phases.plan }],
    ] as const) {
      rows.push({ ...template, level, outcome, phases, chunkKey: `${level}/0/0/0/0/0` });
    }
  }
  return makeRun({ header: { runId: "many-groups", durationUs: 330 * MS }, rows });
}

/** The same run at two row counts. Identical rows, so only the count moves. */
function rowCountRun(count: number) {
  const template = healthyLocalOpen().rows[0];
  return makeRun({
    header: { runId: "sized", durationUs: 330 * MS },
    rows: Array.from({ length: count }, (_, i) => ({ ...template, rid: i, y: i })),
  });
}
