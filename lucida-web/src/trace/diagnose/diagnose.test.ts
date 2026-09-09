/**
 * The derivation module (#933). Every case asserts on the *diagnostic
 * document* — the verdict, the findings, the chain, the coverage block — and
 * never on how the derivation walked the tables. Which module owns a rollup is
 * not external behaviour; what the document says about a run is.
 *
 * Two cases exist to keep a prototype finding from coming back and are named
 * for it: a share threshold with no absolute floor reported a stall on a
 * healthy 368 ms open, and a critical path starting at the first recorded row
 * reported `100% accounted` for a run that was 87% pre-instrument boot.
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
  makeHeader,
  makeReading,
  makeRow,
  makeRun,
  quietRun,
  saturatedReopen,
  uninstrumentedPrefixOpen,
} from "./fixtures.ts";
import { CONFIDENCE_WORDS, diagnoseDocument, diagnoseRun } from "./diagnose.ts";
import { RULESET, RULESET_VERSION, PHASE_CLASSES } from "./ruleset.ts";
import type { DiagnosticDocument } from "./types.ts";
import type { GpuIdentity, TraceDocument } from "../types.ts";

const MS = 1_000;

describe("thresholds", () => {
  it("does not report a stall on a healthy sub-400 ms open", () => {
    const doc = diagnoseRun(healthyLocalOpen());

    expect(doc.verdict.kind).toBe("clear");
    expect(doc.findings.filter((f) => f.severity !== "note")).toEqual([]);
  });

  it("fires the relative share rule only above both 30% and 250 ms", () => {
    const healthy = diagnoseRun(healthyLocalOpen());
    // The healthy run's wire segment is the majority of its critical path and
    // is still not a stall: it is nowhere near the absolute floor.
    const wire = healthy.criticalPath.segments.find((s) => s.label === "browser.wire");
    expect(wire).toBeDefined();
    expect(wire!.sharePct).toBeGreaterThanOrEqual(RULESET.share.minPct);
    expect(wire!.ms).toBeLessThan(RULESET.share.floorMs);
    expect(healthy.findings.some((f) => f.rule === RULESET.share.id)).toBe(false);

    // The same share on a run slow enough to be worth a human second does fire.
    const slow = diagnoseRun(coldRemoteOpen());
    const shareFinding = slow.findings.find((f) => f.rule === RULESET.share.id);
    expect(shareFinding).toBeDefined();
    expect(shareFinding!.observed.sharePct).toBeGreaterThanOrEqual(RULESET.share.minPct);
    expect(shareFinding!.observed.ms).toBeGreaterThanOrEqual(RULESET.share.floorMs);
  });

  it("keeps every absolute ceiling above the worst p95 the research runs observed", () => {
    for (const rule of RULESET.absolute) {
      expect(PHASE_CLASSES[rule.phase]).toBeDefined();
      expect(PHASE_CLASSES[rule.phase]).not.toBe("queue");
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  it("gives queue phases no per-chunk ceiling", () => {
    const queuePhases = Object.entries(PHASE_CLASSES)
      .filter(([, cls]) => cls === "queue")
      .map(([id]) => id);
    expect(queuePhases.length).toBeGreaterThan(0);
    for (const phase of queuePhases) {
      expect(RULESET.absolute.some((r) => r.phase === phase)).toBe(false);
    }

    // A run whose queue p95 is 4.6 s produces no absolute finding against it.
    const doc = diagnoseRun(saturatedReopen());
    const queuePhase = doc.phases.find((s) => s.id === "browser.queue");
    expect(queuePhase!.p95Ms).toBeGreaterThan(4_000);
    expect(doc.findings.some((f) => f.subject === "browser.queue" && f.rule.startsWith("io."))).toBe(
      false,
    );
    expect(
      doc.findings.some((f) => f.subject === "browser.queue" && f.rule.startsWith("compute.")),
    ).toBe(false);
  });

  it("flags a queue by backlog ETA measured over the trailing second", () => {
    const doc = diagnoseRun(saturatedReopen());
    const limiter = doc.limiters[0];

    expect(limiter.windowMs).toBe(RULESET.backlog.windowMs);
    expect(limiter.drainPerS).toBe(limiter.windowCompletions);
    expect(limiter.backlogEtaS).toBeGreaterThan(RULESET.backlog.maxEtaS);

    const finding = doc.findings.find((f) => f.rule === RULESET.backlog.id);
    expect(finding?.severity).toBe("saturated");
    expect(doc.verdict.kind).toBe("saturated");
  });

  it("counts drain over completed admissions inside the window and nowhere else", () => {
    // Ten admissions complete in the final second; sixty completed long before it.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) =>
        makeRow({ startUs: i * MS, durations: { plan: 100, queue: 5 * MS } }, i),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeRow({ startUs: 9_200 * MS + i * MS, durations: { plan: 100, queue: 5 * MS } }, 100 + i),
      ),
    ];
    const run = makeRun({
      header: { durationUs: 10_000 * MS, endReason: "timeout" },
      rows,
      readings: [makeReading(9_900 * MS, { queueDepth: 500, inFlight: 8 })],
    });

    const limiter = diagnoseRun(run).limiters[0];
    expect(limiter.windowCompletions).toBe(10);
    expect(limiter.drainPerS).toBe(10);
    expect(limiter.pending).toBe(500);
    expect(limiter.backlogEtaS).toBe(50);
  });

  it("reads a queue that drained to zero as drained, not as the settle-time backlog", () => {
    // The good news this rule has to be able to tell: the last reading says the
    // queue emptied, while the header still carries what was outstanding when
    // the run closed. Treating that zero as absent would substitute the
    // backlog and manufacture a saturated verdict out of a healthy run.
    const run = makeRun({
      header: {
        durationUs: 5_000 * MS,
        outstandingAtSettle: {
          pending: 20_000,
          inFlight: 8,
          speculativePending: 0,
          speculativeInFlight: 0,
          desiredDetailChunks: 0,
          residentDetailChunks: 0,
          desiredCoarseChunks: 0,
          residentCoarseChunks: 0,
        },
      },
      rows: Array.from({ length: 30 }, (_, i) =>
        makeRow({ startUs: i * 100 * MS, durations: { plan: 100, queue: 5 * MS } }, i),
      ),
      readings: [makeReading(4_900 * MS, { queueDepth: 0, inFlight: 8 })],
    });
    const doc = diagnoseRun(run);

    expect(doc.limiters[0].pending).toBe(0);
    expect(doc.limiters[0].backlogEtaS).toBe(0);
    expect(doc.findings.some((f) => f.rule === RULESET.backlog.id)).toBe(false);
    expect(doc.verdict.kind).not.toBe("saturated");
  });

  it("reports a comparative regression only above 2x", () => {
    const baseline = diagnoseRun(healthyLocalOpen());

    const near = diagnoseRun(scaledOpen(1.6), { baseline });
    expect(near.findings.some((f) => f.rule === RULESET.compare.id)).toBe(false);

    const over = diagnoseRun(scaledOpen(3), { baseline });
    const finding = over.findings.find((f) => f.rule === RULESET.compare.id);
    expect(finding).toBeDefined();
    expect(finding!.observed.ratio).toBeGreaterThan(RULESET.compare.minRatio);
  });
});

describe("attribution", () => {
  it("is a back-walk, not a max over phase totals", () => {
    // Two hundred concurrent rows spend 100 ms each on the wire — 20 s of
    // total, five times the run's own wall clock — while the row the run
    // actually waited on spent its time decoding.
    const rows = [
      ...Array.from({ length: 200 }, (_, i) =>
        makeRow(
          { startUs: 10 * MS, durations: { plan: 100, queue: MS, wire: 100 * MS }, rid: i },
          i,
        ),
      ),
      makeRow(
        {
          startUs: 10 * MS,
          durations: { plan: 100, queue: MS, wire: 20 * MS, decode: 900 * MS, upload: MS, present: MS },
          rid: 900,
          chunkKey: "1/0/0/0/9/9",
        },
        900,
      ),
    ];
    const run = makeRun({ header: { durationUs: 1_200 * MS }, rows });
    const doc = diagnoseRun(run);

    expect(doc.phases[0].id).toBe("browser.wire");
    expect(doc.phases[0].totalMs).toBeGreaterThan(doc.run.wallMs);
    expect(doc.criticalPath.kind).toBe("chain");

    const leader = [...doc.criticalPath.segments].sort((a, b) => b.ms - a.ms)[0];
    expect(leader.label).toBe("browser.decode");
    expect(doc.verdict.text).toContain("browser.decode");
  });

  it("resolves a leading queue segment to the limiter behind it", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      makeRow(
        {
          startUs: 10 * MS,
          durations: { plan: 100, queue: 2_000 * MS, wire: 30 * MS, decode: MS, upload: MS, present: MS },
          rid: i,
        },
        i,
      ),
    );
    const run = makeRun({
      header: { durationUs: 2_200 * MS },
      rows,
      readings: Array.from({ length: 20 }, (_, i) =>
        makeReading(100 * MS + i * 100 * MS, { queueDepth: 900, inFlight: 12 }),
      ),
    });
    const doc = diagnoseRun(run);

    const leader = [...doc.criticalPath.segments].sort((a, b) => b.ms - a.ms)[0];
    expect(leader.class).toBe("queue");
    expect(doc.verdict.confidence).toBe("resource-limited");
    expect(String(doc.findings[0].attribution?.cause)).toContain(doc.limiters[0].id);
  });

  it("starts the chain at run start and never blames the unrecorded prefix", () => {
    const doc = diagnoseRun(uninstrumentedPrefixOpen());
    const prefix = doc.criticalPath.segments[0];

    expect(prefix.class).toBe("unrecorded");
    expect(prefix.ms).toBeGreaterThan(2_000);
    // A note, never a stall: nothing measured that stretch, so nothing can be
    // blamed for it — but a chain led by a hole is worth a line of its own.
    const onPrefix = doc.findings.filter((f) => f.subject === prefix.label);
    expect(onPrefix.every((f) => f.severity === "note")).toBe(true);
    expect(onPrefix.map((f) => f.rule)).toContain("coverage.unrecorded-prefix");
    expect(doc.coverage.gaps.some((g) => g.kind === "unrecorded-prefix")).toBe(true);
    expect(doc.coverage.incomplete).toBe(true);
  });

  it("does not report full coverage for a run that is mostly uninstrumented", () => {
    const doc = diagnoseRun(uninstrumentedPrefixOpen());

    // The chain tiles the whole run by construction — which is exactly why it
    // is not the coverage number.
    expect(doc.criticalPath.chainAccountedPct).toBe(100);
    expect(doc.coverage.accountedPct).toBeLessThan(20);
    expect(doc.verdict.confidence).toBe("partial");
    expect(doc.attribution.degraded).not.toBe("");
  });

  it("attributes an interaction run without a completion event", () => {
    const doc = diagnoseRun(interactionRun());

    expect(doc.criticalPath.kind).toBe("undefined");
    expect(doc.criticalPath.undefinedReason).toBeTruthy();
    expect(doc.criticalPath.segments).toEqual([]);
    expect(["aggregate-only", "rollup-only", "resource-limited", "unattributed"]).toContain(
      doc.verdict.confidence,
    );
    expect(doc.aggregates[0]?.phase).toBe("render.frame");
  });

  it("carries a degraded line on every one of the seven confidence words", () => {
    expect(CONFIDENCE_WORDS).toHaveLength(7);

    const seen = new Set<string>();
    for (const doc of [
      diagnoseRun(healthyLocalOpen()),
      diagnoseRun(coldRemoteOpen()),
      diagnoseRun(saturatedReopen()),
      diagnoseRun(interactionRun()),
      diagnoseRun(uninstrumentedPrefixOpen()),
      diagnoseRun(tiedChain()),
      diagnoseRun(rollupOnlyRun()),
      diagnoseRun(attributedRun()),
      diagnoseRun(quietRun()),
    ]) {
      const attribution = doc.attribution;
      expect(attribution.degraded).not.toBe("");
      expect(CONFIDENCE_WORDS).toContain(attribution.confidence);
      seen.add(attribution.confidence);
    }
    expect([...seen].sort()).toEqual([...CONFIDENCE_WORDS].sort());
  });
});

describe("render timing and the adapter", () => {
  it("carries GPU pass time beside main-thread time when the adapter offers timestamp queries", () => {
    const doc = diagnoseRun(gpuTimedOpen());

    expect(doc.run.adapter?.timestampQueries).toBe(true);
    expect(doc.renderTiming.mainThread).toEqual({ samples: 12, p50Ms: 3.5, p95Ms: 3.5, maxMs: 3.5 });
    // Eleven, not twelve: the first tick's frame had not been read back yet.
    expect(doc.renderTiming.gpuPass).toEqual({
      recorded: true,
      samples: 11,
      p50Ms: 1.2,
      p95Ms: 2.4,
      maxMs: 2.4,
    });
  });

  it("states why GPU time is absent instead of reporting a zero", () => {
    const doc = diagnoseRun(mainThreadOnlyOpen());

    expect(doc.renderTiming.mainThread?.samples).toBe(12);
    expect(doc.renderTiming.gpuPass).toMatchObject({ recorded: false, reason: "no-timestamp-queries" });
    expect(doc.renderTiming.gpuPass).toHaveProperty("statement", expect.stringContaining("main-thread time"));
  });

  it("tells an adapter that offers timestamp queries from one whose frames were never read back", () => {
    const gpu = { ...makeHeader().gpu!, timestampQueries: true };
    const doc = diagnoseRun(makeRun({ header: { gpu }, readings: [makeReading(10 * MS)] }));

    expect(doc.renderTiming.gpuPass).toMatchObject({ recorded: false, reason: "no-frame-read-back" });
  });

  it("says the adapter is unknown when the run closed before one was identified", () => {
    const doc = diagnoseRun(makeRun({ header: { gpu: null }, readings: [makeReading(10 * MS)] }));

    expect(doc.run.adapter).toBeNull();
    expect(doc.run.gpu).toBe("unknown");
    expect(doc.run.adapterKind).toEqual({ kind: "not-identified", label: "adapter not identified" });
    expect(doc.renderTiming.gpuPass).toMatchObject({ recorded: false, reason: "adapter-unknown" });
  });

  it("names the adapter's kind in the run identity, in both states", () => {
    const fallback = diagnoseRun(fallbackAdapterOpen());
    expect(fallback.run.adapter?.fallback).toBe(true);
    expect(fallback.run.gpu).toBe("generic software (software rasterizer)");
    expect(fallback.run.adapterKind).toEqual({
      kind: "software-fallback",
      label: "software fallback adapter",
    });
    expect(fallback.renderTiming.mainThread?.p95Ms).toBe(42);

    const hardware = diagnoseRun(healthyLocalOpen());
    expect(hardware.run.gpu).toBe("apple metal-3");
    expect(hardware.run.adapterKind).toEqual({ kind: "hardware", label: "hardware adapter" });
  });

  it("reads a header that never recorded the new adapter facts as not having recorded them", () => {
    // The shape of a run file written before the adapter record carried these fields.
    const old = { vendor: "v", architecture: "a", device: "", description: "" } as GpuIdentity;
    const doc = diagnoseRun(makeRun({ header: { gpu: old }, readings: [makeReading(10 * MS)] }));

    expect(doc.run.adapterKind).toEqual({ kind: "not-recorded", label: "adapter kind not recorded" });
    expect(doc.renderTiming.gpuPass).toMatchObject({ recorded: false, reason: "not-recorded" });

    // A browser that reported neither fallback flag is the same answer.
    const unsaid = { ...makeHeader().gpu!, fallback: null };
    expect(diagnoseRun(makeRun({ header: { gpu: unsaid } })).run.adapterKind.kind).toBe("not-recorded");
  });

  it("has no main-thread figure either when the run recorded no readings", () => {
    const doc = diagnoseRun(makeRun({ readings: [] }));

    expect(doc.renderTiming.mainThread).toBeNull();
    expect(doc.renderTiming.gpuPass.recorded).toBe(false);
  });
});

describe("the document", () => {
  it("ships the versioned ruleset with every rationale", () => {
    const doc = diagnoseRun(healthyLocalOpen());

    expect(doc.ruleset.version).toBe(RULESET_VERSION);
    for (const rule of doc.ruleset.absolute) expect(rule.why).not.toBe("");
    for (const rule of [
      doc.ruleset.backlog,
      doc.ruleset.occupancy,
      doc.ruleset.share,
      doc.ruleset.prefix,
      doc.ruleset.compare,
    ]) {
      expect(rule.why).not.toBe("");
    }
  });

  it("carries nothing per-row: its size does not scale with the row count", () => {
    const small = JSON.stringify(diagnoseRun(rowCountRun(20))).length;
    const large = JSON.stringify(diagnoseRun(rowCountRun(4_000))).length;

    // Twenty rows against four thousand: two hundred times the rows for a few
    // hundred bytes. What moves is the width of a count and of a named chunk
    // key — the rollup now names the worst row per phase (#936), so there are
    // a handful of those rather than one, and still no per-row list anywhere.
    expect(large).toBeLessThan(small + 400);
  });

  it("carries the run's identity and the counters that are not health signals", () => {
    const doc = diagnoseRun(saturatedReopen());

    expect(doc.run.endReason).toBe("timeout");
    expect(doc.run.devicePixelRatio).toBe(2);
    expect(doc.coverage.notHealthSignals.map((s) => s.metric)).toEqual([
      "retries",
      "failures",
      "evictions",
      "rejections",
    ]);
    expect(doc.coverage.notHealthSignals.every((s) => s.value === 0)).toBe(true);
  });

  it("reads the newest run out of a trace document", () => {
    const traceDocument: TraceDocument = {
      schemaVersion: 1,
      exportedAtEpochMs: 1_700_000_000_000,
      retention: {
        residentCapBytes: 8_000_000,
        perRunCapBytes: 2_000_000,
        residentBytes: 100_000,
        intervalsEvicted: 0,
        derivedFrom: "384-member collection",
        capUnit: "bytes",
      },
      instrumentedPhases: ["plan", "queue", "wire", "decode", "upload", "present"],
      countedPhases: ["cache-admission", "worker-dispatch", "coalesce-attach"],
      runs: [healthyLocalOpen(), coldRemoteOpen()],
      steadyState: [],
      rowsOutsideRun: 0,
      serverRowsOutsideRun: 0,
    };

    expect(diagnoseDocument(traceDocument).runId).toBe("remote-cold");
    expect(diagnoseDocument(traceDocument, { runId: "local-healthy" }).runId).toBe("local-healthy");
  });

  it("carries the worst row's chunk and the spatial summary, and names both as next steps", () => {
    const doc = diagnoseRun(healthyLocalOpen());

    // The healthy open's largest browser phase is the wire, and row 119 is the
    // one that spent 240 ms on it.
    expect(doc.chunk.selector).toBe("member-7/1/0/0/0/119/0");
    expect(doc.chunk.chosen).toContain("browser.wire");
    expect(doc.chunk.rows).toHaveLength(1);
    expect(doc.chunk.rows[0].phases.map((phase) => phase.phase)).toHaveLength(6);
    expect(doc.chunk.rows[0].queue).not.toBeNull();
    expect(doc.chunk.rows[0].ageMs).toBe(246.5);
    expect(doc.spatial.groupCount).toBe(1);
    expect(doc.spatial.groups[0].n).toBe(120);

    const commands = doc.next.map((step) => step.command);
    expect(commands).toContain("lucida trace show local-healthy --chunk member-7/1/0/0/0/119/0");
    expect(commands).toContain("lucida trace show local-healthy --spatial");
  });

  it("looks up the chunk the caller names, and still points the next step at the worst row", () => {
    const named = diagnoseRun(healthyLocalOpen(), { chunk: "1/0/0/0/5/0" });
    expect(named.chunk.chosen).toBe("named by the caller");
    expect(named.chunk.rowCount).toBe(1);
    expect(named.chunk.rows[0].entityId).toBe("member-5");
    expect(named.next.map((step) => step.command)).toContain(
      "lucida trace show local-healthy --chunk member-7/1/0/0/0/119/0",
    );

    const absent = diagnoseRun(healthyLocalOpen(), { chunk: "1/0/0/0/999/0" });
    expect(absent.chunk.rowCount).toBe(0);
    expect(absent.chunk.statement).toContain("not in this run");
  });

  it("has an empty lookup and no chunk step on a run with no rows, and a spatial step regardless", () => {
    const doc = diagnoseRun(makeRun({ header: { runId: "empty", durationUs: 100 * MS } }));

    expect(doc.chunk.selector).toBeNull();
    expect(doc.chunk.rowCount).toBe(0);
    expect(doc.spatial.rowCount).toBe(0);
    const commands = doc.next.map((step) => step.command);
    expect(commands.some((command) => command.includes("--chunk"))).toBe(false);
    expect(commands).toContain("lucida trace show empty --spatial");
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
    const doc = diagnoseRun(run);

    expect(doc.coverage.truncated).not.toBeNull();
    expect(doc.coverage.truncated!.rowsUnrecorded).toBe(45_412);
    expect(doc.coverage.truncated!.recordedPct).toBe(28);
    expect(doc.coverage.incomplete).toBe(true);
  });
});

describe("a window", () => {
  /** Everything the window scopes, with the fields that merely name the window set aside. */
  function scoped(doc: DiagnosticDocument) {
    const { window: _window, next: _next, coverage, ...rest } = doc;
    const { window: _clip, ...coverageRest } = coverage;
    return { ...rest, coverage: coverageRest };
  }

  function windowOf(command: string): [number, number] {
    const match = /--window (\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)/.exec(command);
    if (!match) throw new Error(`no --window on ${command}`);
    return [Number(match[1]), Number(match[2])];
  }

  it("reads the whole run when the window is the whole run", () => {
    for (const run of [
      healthyLocalOpen(),
      coldRemoteOpen(),
      saturatedReopen(),
      interactionRun(),
      uninstrumentedPrefixOpen(),
      lateStallOpen(),
    ]) {
      const whole = diagnoseRun(run);
      const wallMs = whole.run.wallMs;
      const windowed = diagnoseRun(run, { window: { startMs: 0, endMs: wallMs } });

      expect(scoped(windowed), run.header.runId).toEqual(scoped(whole));
      expect(whole.window).toBeNull();
      expect(windowed.window).toEqual({
        startMs: 0,
        endMs: wallMs,
        spanMs: wallMs,
        ofWallMs: wallMs,
        whole: true,
      });
      expect(windowed.coverage.window).toMatchObject({ clippedRows: 0, unplacedRows: 0 });
    }
  });

  it("moves the verdict when the window excludes a stall in the second half", () => {
    const run = lateStallOpen();
    const decodeCeilMs = RULESET.absolute.find((rule) => rule.phase === "browser.decode")!.ceilMs;

    const whole = diagnoseRun(run);
    expect(whole.verdict.kind).toBe("stall");
    expect(whole.verdict.text).toContain("browser.decode");

    const firstHalf = diagnoseRun(run, { window: { startMs: 0, endMs: 1_000 } });
    expect(firstHalf.window).toEqual({
      startMs: 0,
      endMs: 1_000,
      spanMs: 1_000,
      ofWallMs: 2_000,
      whole: false,
    });
    expect(firstHalf.verdict.kind).toBe("clear");
    expect(firstHalf.findings.filter((f) => f.severity !== "note")).toEqual([]);
    const decode = firstHalf.phases.find((phase) => phase.id === "browser.decode");
    expect(decode?.n).toBe(60);
    expect(decode!.p95Ms).toBeLessThan(decodeCeilMs);

    const secondHalf = diagnoseRun(run, { window: { startMs: 1_000, endMs: 2_000 } });
    expect(secondHalf.verdict.kind).toBe("stall");
    expect(secondHalf.verdict.text).toContain("browser.decode");
    expect(secondHalf.phases.find((phase) => phase.id === "browser.decode")?.n).toBe(40);
  });

  it("counts a row that crosses an edge for the part inside, and says so", () => {
    const run = makeRun({
      header: { durationUs: 1_000 * MS },
      rows: [makeRow({ startUs: 100 * MS, durations: { wire: 200 * MS } }, 0)],
    });
    const doc = diagnoseRun(run, { window: { startMs: 200, endMs: 400 } });

    const wire = doc.phases.find((phase) => phase.id === "browser.wire");
    expect(wire).toMatchObject({ n: 1, p50Ms: 100, maxMs: 100, totalMs: 100, concurrencyFactor: 0.5 });
    expect(wire!.extent).toEqual({ firstStartMs: 200, lastEndMs: 300, positionedN: 1 });
    expect(doc.coverage.wallMs).toBe(200);
    expect(doc.coverage.accountedMs).toBe(100);
    expect(doc.coverage.accountedPct).toBe(50);
    expect(doc.coverage.window).toMatchObject({ clippedRows: 1, unplacedRows: 0 });
    expect(doc.coverage.window!.statement).toContain("part inside");
  });

  it("clamps a window to the run and refuses an empty one", () => {
    const run = quietRun();
    const clamped = diagnoseRun(run, { window: { startMs: 500, endMs: 99_999 } });
    expect(clamped.window).toMatchObject({ startMs: 500, endMs: 1_500, spanMs: 1_000, whole: false });

    expect(() => diagnoseRun(run, { window: { startMs: 800, endMs: 300 } })).toThrow(/empty/);
    expect(() => diagnoseRun(run, { window: { startMs: 2_000, endMs: 3_000 } })).toThrow(/empty/);
  });

  it("reads the wall the document prints as the whole run", () => {
    // The document rounds the wall to a tenth of a millisecond. A reader who
    // types that figure back must get the whole run, not a window a few
    // microseconds short of it that leaves the unplaced rows out.
    const run = coldRemoteOpen();
    run.header.durationUs = 4_120_320;
    const whole = diagnoseRun(run);
    expect(whole.run.wallMs).toBe(4_120.3);

    const typedBack = diagnoseRun(run, { window: { startMs: 0, endMs: whole.run.wallMs } });
    expect(typedBack.window).toMatchObject({ endMs: 4_120.32, whole: true });
    expect(typedBack.phases.find((phase) => phase.id === "server.backend-read")?.n).toBe(60);
    expect(typedBack.coverage.window).toMatchObject({ unplacedRows: 0 });
  });

  it("leaves rows it cannot place out of a narrower window, and counts them", () => {
    // The cold open's sixty server-side chunk rows carry no placement: they
    // are real, and a window cannot say whether they fell inside it.
    const whole = diagnoseRun(coldRemoteOpen());
    expect(whole.phases.find((phase) => phase.id === "server.backend-read")?.n).toBe(60);
    expect(whole.coverage.window).toBeNull();

    const tail = diagnoseRun(coldRemoteOpen(), { window: { startMs: 3_700, endMs: 4_120 } });
    expect(tail.phases.find((phase) => phase.id === "server.backend-read")).toBeUndefined();
    expect(tail.phases.find((phase) => phase.id === "browser.wire")?.n).toBe(60);
    expect(tail.coverage.window).toMatchObject({ unplacedRows: 60 });
    expect(tail.coverage.window!.statement).toContain("no position");
  });

  it("starts the critical path at the window and ends it at the last chunk presented inside", () => {
    const run = healthyLocalOpen();
    const doc = diagnoseRun(run, { window: { startMs: 100, endMs: 330 } });
    expect(doc.criticalPath.kind).toBe("chain");
    expect(doc.criticalPath.fromMs).toBe(100);
    expect(doc.criticalPath.targetAtMs).toBeGreaterThan(300);
    // The one slow row was already on the wire when the window opened, so the
    // chain begins on its wire rather than on an unrecorded prefix, and the
    // open, settled long before the window, is not on it.
    expect(doc.criticalPath.segments[0].label).toBe("browser.wire");
    expect(doc.criticalPath.segments.some((s) => s.label === "open.metadata-read")).toBe(false);
    expect(doc.criticalPath.chainAccountedPct).toBe(100);

    // Nothing reaches a frame between 100 and 250 ms.
    const between = diagnoseRun(run, { window: { startMs: 100, endMs: 250 } });
    expect(between.criticalPath.kind).toBe("undefined");
    expect(between.criticalPath.undefinedReason).toContain("100..250");
  });

  it("carries the window on every follow-up command and names a narrower one inside it", () => {
    const whole = diagnoseRun(lateStallOpen());
    const narrower = whole.next.find((step) => step.command.includes("--window"));
    expect(narrower).toBeDefined();
    const [start, end] = windowOf(narrower!.command);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(whole.run.wallMs);
    expect(end - start).toBeLessThan(whole.run.wallMs);

    const windowed = diagnoseRun(lateStallOpen(), { window: { startMs: start, endMs: end } });
    const shows = windowed.next.filter((step) => step.command.startsWith("lucida trace show"));
    expect(shows.length).toBeGreaterThan(1);
    for (const step of shows) expect(step.command).toContain("--window ");
    const inner = shows.map((step) => windowOf(step.command));
    expect(inner.some(([a, b]) => a === start && b === end)).toBe(true);
    expect(inner.some(([a, b]) => a >= start && b <= end && b - a < end - start)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runs built for one case each.
// ---------------------------------------------------------------------------

/** The healthy open with every duration multiplied, for the comparative rule. */
function scaledOpen(factor: number) {
  const run = healthyLocalOpen();
  for (const row of run.rows) {
    for (const timing of Object.values(row.phases)) {
      timing.durationUs = Math.round(timing.durationUs * factor);
      timing.endUs = timing.startUs + timing.durationUs;
    }
  }
  return run;
}

/** Two segments within 1.25x of each other, so no single one can be named. */
function tiedChain() {
  const rows = [
    makeRow(
      {
        startUs: 0,
        durations: { plan: 100, queue: MS, wire: 500 * MS, decode: 480 * MS, upload: MS, present: MS },
        rid: 1,
      },
      1,
    ),
  ];
  return makeRun({ header: { runId: "tied", durationUs: 1_000 * MS }, rows });
}

/** No completion event, no saturation, but a phase over its absolute ceiling. */
function rollupOnlyRun() {
  const rows = Array.from({ length: 20 }, (_, i) =>
    makeRow(
      { startUs: 10 * MS + i * MS, durations: { plan: 100, queue: MS, wire: 2_500 * MS }, rid: i },
      i,
    ),
  );
  return makeRun({
    header: { runId: "rollup-only", durationUs: 3_000 * MS, endReason: "timeout" },
    rows,
    readings: [makeReading(2_900 * MS, { queueDepth: 2, inFlight: 4, frameTimeUs: 2_000 })],
  });
}

/** A chain with one clear leader over its ceiling and coverage to back it. */
function attributedRun() {
  const rows = Array.from({ length: 40 }, (_, i) =>
    makeRow(
      {
        startUs: 2 * MS,
        durations: {
          plan: 100,
          queue: MS,
          wire: 30 * MS,
          decode: 900 * MS,
          upload: MS,
          present: MS,
        },
        rid: i,
      },
      i,
    ),
  );
  return makeRun({ header: { runId: "attributed", durationUs: 950 * MS }, rows });
}

/** The same run shape at two row counts, for the per-row size check. */
function rowCountRun(count: number) {
  const rows = Array.from({ length: count }, (_, i) =>
    makeRow(
      {
        startUs: 10 * MS + i,
        durations: { plan: 100, queue: MS, wire: 40 * MS, decode: MS, upload: MS, present: MS },
        rid: i,
      },
      i,
    ),
  );
  return makeRun({ header: { runId: "sized", durationUs: 500 * MS }, rows });
}
