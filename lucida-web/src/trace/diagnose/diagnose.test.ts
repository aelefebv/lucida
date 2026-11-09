/**
 * The derivation module. Every case asserts on the *diagnostic
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
  firstPaintOpen,
  gpuTimedOpen,
  healthyLocalOpen,
  interactionRun,
  interactionRunFor,
  lateStallOpen,
  mainThreadOnlyOpen,
  makeHeader,
  makeReading,
  makeRow,
  makeRun,
  makeTick,
  quietRun,
  saturatedReopen,
  sendHeavyIdleRun,
  slowPresentInteraction,
  uninstrumentedPrefixOpen,
} from "./fixtures.ts";
import { CONFIDENCE_WORDS, diagnoseDocument, diagnoseRun } from "./diagnose.ts";
import { renderDiagnostic } from "./renderText.ts";
import { RULESET, RULESET_VERSION, PHASE_CLASSES } from "./ruleset.ts";
import type { DiagnosticDocument } from "./types.ts";
import {
  CLIENT_MESSAGE_TYPES,
  INPUT_KINDS,
  interactionCause,
  TRACE_SCHEMA_VERSION,
  type ChromePart,
  type ChromeReading,
  type GpuIdentity,
  type PageError,
  type RunCause,
  type TraceDocument,
  type TracePointEvent,
  type TraceRun,
} from "../types.ts";

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

  it("still stalls on a slow decoder once the worker reports its own time", () => {
    const decodeCeilMs = RULESET.absolute.find((rule) => rule.phase === "browser.decode")!.ceilMs;
    const doc = diagnoseRun(decodeOpen({ roundTripUs: 90 * MS, workUs: 80 * MS }));

    const decode = doc.phases.find((phase) => phase.id === "browser.decode");
    expect(decode?.p95Ms).toBe(80);
    expect(decode!.p95Ms).toBeGreaterThan(decodeCeilMs);
    const finding = doc.findings.find((f) => f.subject === "browser.decode");
    expect(finding?.rule).toBe("compute.decode");
    expect(finding?.severity).toBe("stall");
    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("browser.decode");
  });

  it("reads a decode backlog as a queue rather than as decode work", () => {
    // Every chunk waits 400 ms for a worker or for the main thread, and each
    // decode takes 2 ms of it: the round trip is eight times the decode
    // ceiling, and nothing decoded slowly.
    const doc = diagnoseRun(decodeOpen({ roundTripUs: 400 * MS, workUs: 2 * MS }));

    const decode = doc.phases.find((phase) => phase.id === "browser.decode");
    const wait = doc.phases.find((phase) => phase.id === "browser.decode-wait");
    expect(decode?.p95Ms).toBe(2);
    expect(wait).toMatchObject({ class: "queue", p95Ms: 398 });
    expect(doc.findings.filter((f) => f.severity !== "note")).toEqual([]);
    expect(doc.verdict.kind).toBe("clear");

    const segments = doc.criticalPath.segments;
    expect(segments.find((s) => s.label === "browser.decode-wait")).toMatchObject({ class: "queue", ms: 398 });
    expect(segments.find((s) => s.label === "browser.decode")).toMatchObject({ class: "compute", ms: 2 });
  });

  it("reads a prefetched chunk's wait for the view as a queue rather than as upload", () => {
    // A zoom whose prefetched chunks waited 690 ms for the view to reach
    // their level, then reached the GPU in 10 ms.
    const doc = diagnoseRun(prefetchedZoom({ uploadUs: 700 * MS, unwantedUs: 690 * MS }));

    const upload = doc.phases.find((phase) => phase.id === "browser.upload");
    const unwanted = doc.phases.find((phase) => phase.id === "browser.unwanted");
    expect(upload?.p95Ms).toBe(12);
    expect(unwanted).toMatchObject({ class: "queue", p95Ms: 690 });
    expect(doc.findings.filter((f) => f.severity !== "note")).toEqual([]);
    expect(doc.verdict.kind).toBe("clear");

    const segments = doc.criticalPath.segments;
    expect(segments.find((s) => s.label === "browser.unwanted")).toMatchObject({ class: "queue", ms: 690 });
    expect(segments.find((s) => s.label === "browser.upload")).toMatchObject({ class: "compute", ms: 10 });
  });

  it("still stalls on a slow delivery once the view wanted the chunk", () => {
    const doc = diagnoseRun(prefetchedZoom({ uploadUs: 400 * MS, unwantedUs: 100 * MS }));

    const upload = doc.phases.find((phase) => phase.id === "browser.upload");
    expect(upload?.p95Ms).toBe(300);
    expect(doc.findings.some((f) => f.subject === "browser.upload" && f.severity === "stall")).toBe(true);
    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("browser.upload");
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
          detailBytes: 0,
          detailBudgetBytes: 0,
          coarseBytes: 0,
          coarseBudgetBytes: 0,
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
      diagnoseRun(interactionRunFor("orbit", { frameTimeUs: 80 * MS })),
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

describe("chunks the uploader held", () => {
  function held(chunkKey: string, reason: TracePointEvent["reason"], atUs: number): TracePointEvent {
    const [level, t, c, z, y, x] = chunkKey.split("/").map(Number);
    return {
      atUs,
      kind: "held",
      reason,
      chunk: {
        datasetId: "",
        entityId: "tile-0",
        imageId: "image-0",
        residencyTier: "detail",
        level, t, c, z, y, x,
        chunkKey,
      },
      levelChange: null,
    };
  }

  it("leads with a stall that names each held chunk and the renderer's reason, and the verdict says the view settled without them", () => {
    const run = healthyLocalOpen();
    run.events = [
      held("0/0/0/1/0/0", "wrong-slice", 200 * MS),
      held("0/0/0/0/1/2", "evicted", 200 * MS),
      held("0/0/0/0/1/2", "evicted", 250 * MS),
    ];
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("0/0/0/1/0/0 (wrong-slice)");
    expect(doc.verdict.text).toContain("the view settled without them");
    const lead = doc.findings[0];
    expect(lead.rule).toBe(RULESET.held.id);
    expect(lead.severity).toBe("stall");
    expect(lead.observed.chunks).toBe(2);
    expect(lead.observed.held).toEqual([
      { entityId: "tile-0", chunkKey: "0/0/0/1/0/0", reason: "wrong-slice" },
      { entityId: "tile-0", chunkKey: "0/0/0/0/1/2", reason: "evicted" },
    ]);
    // The attribution is about the critical path, which the held chunks are not.
    expect(lead.attribution).toBeNull();
  });

  it("finds nothing held on a run that held nothing", () => {
    expect(diagnoseRun(healthyLocalOpen()).findings.some((f) => f.rule === RULESET.held.id)).toBe(false);
  });
});

describe("GPU errors", () => {
  function gpuError(reason: TracePointEvent["reason"], atUs: number): TracePointEvent {
    return { atUs, kind: "gpu-error", reason, chunk: null, levelChange: null };
  }

  it("lead every other stall, held chunks included, and the verdict counts them by kind", () => {
    const run = healthyLocalOpen();
    run.events = [
      gpuError("out-of-memory", 100 * MS),
      gpuError("out-of-memory", 120 * MS),
      gpuError("device-lost", 300 * MS),
      {
        atUs: 400 * MS,
        kind: "held",
        reason: "out-of-memory",
        chunk: {
          datasetId: "", entityId: "tile-0", imageId: "image-0", residencyTier: "detail",
          level: 0, t: 0, c: 0, z: 0, y: 0, x: 0, chunkKey: "0/0/0/0/0/0",
        },
        levelChange: null,
      },
    ];
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("the GPU reported 3 error(s) (out-of-memory 2, device-lost 1)");
    const [lead, next] = doc.findings;
    expect(lead.rule).toBe(RULESET.gpuError.id);
    expect(lead.observed).toEqual({ n: 3, breakdown: { "out-of-memory": 2, "device-lost": 1 } });
    expect(lead.attribution).toBeNull();
    expect(next.rule).toBe(RULESET.held.id);
  });

  it("are not found on a run without any", () => {
    expect(diagnoseRun(healthyLocalOpen()).findings.some((f) => f.rule === RULESET.gpuError.id)).toBe(false);
  });
});

describe("errors the page raised", () => {
  function pageError(overrides: Partial<PageError> = {}): PageError {
    return {
      atUs: 120 * MS,
      pageMs: 2_000,
      source: "exception",
      message: "Uncaught TypeError: x is undefined",
      location: "/assets/index.js:1:20",
      count: 1,
      allowed: null,
      ...overrides,
    };
  }

  it("are a stall that names the first, with its time on the run's clock", () => {
    const run = healthyLocalOpen();
    run.errors = [pageError(), pageError({ atUs: 200 * MS, source: "console", message: "[commands] clash", location: null, count: 2 })];
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain(
      "the page raised 3 error(s); the first at 120 ms, an uncaught exception: Uncaught TypeError: x is undefined (/assets/index.js:1:20)",
    );
    const [lead] = doc.findings;
    expect(lead.rule).toBe(RULESET.pageError.id);
    expect(lead.attribution).toBeNull();
    expect(lead.observed.errors).toEqual([
      { atMs: 120, source: "exception", message: "Uncaught TypeError: x is undefined", location: "/assets/index.js:1:20", count: 1 },
      { atMs: 200, source: "console", message: "[commands] clash", location: null, count: 2 },
    ]);
    expect(renderDiagnostic(doc).text).toContain("exception at 120 ms: Uncaught TypeError: x is undefined");
  });

  it("leave out what the allow list names, and a window leaves out what falls outside it", () => {
    const run = healthyLocalOpen();
    run.errors = [pageError({ allowed: "known benign" })];
    expect(diagnoseRun(run).findings.some((f) => f.rule === RULESET.pageError.id)).toBe(false);

    run.errors = [pageError({ atUs: 10 * MS })];
    const windowed = diagnoseRun(run, { window: { startMs: 50, endMs: 100 } });
    expect(windowed.findings.some((f) => f.rule === RULESET.pageError.id)).toBe(false);
  });

  it("leave the GPU's own errors to the GPU finding, which quotes the first", () => {
    const run = healthyLocalOpen();
    run.events = [{ atUs: 100 * MS, kind: "gpu-error", reason: "validation", chunk: null, levelChange: null }];
    run.errors = [pageError({ source: "gpu", message: "validation: bad buffer usage", location: null })];
    const doc = diagnoseRun(run);

    expect(doc.findings.map((f) => f.rule)).not.toContain(RULESET.pageError.id);
    expect(doc.verdict.text).toContain("the first said validation: bad buffer usage");
  });

  it("follow a GPU error and lead a blank frame", () => {
    const run = healthyLocalOpen();
    run.events = [{ atUs: 100 * MS, kind: "gpu-error", reason: "validation", chunk: null, levelChange: null }];
    run.errors = [pageError()];
    run.frame = { width: 8, height: 4, flatColour: "#000000", unread: null };
    expect(diagnoseRun(run).findings.slice(0, 3).map((f) => f.rule)).toEqual([
      RULESET.gpuError.id,
      RULESET.pageError.id,
      RULESET.blankFrame.id,
    ]);
  });

  it("are not found on a document written before errors were recorded", () => {
    const run = healthyLocalOpen();
    delete run.errors;
    expect(diagnoseRun(run).findings.some((f) => f.rule === RULESET.pageError.id)).toBe(false);
  });
});

describe("a blank settled frame", () => {
  it("is a stall that names its colour and size", () => {
    const run = healthyLocalOpen();
    run.frame = { width: 2880, height: 1800, flatColour: "#000000", unread: null };
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("the settled frame was one flat colour, #000000, across all 2880x1800 pixels");
    expect(doc.findings[0]).toMatchObject({
      rule: RULESET.blankFrame.id,
      observed: { colour: "#000000", width: 2880, height: 1800 },
      attribution: null,
    });
    expect(renderDiagnostic(doc).text).toContain("one flat colour, #000000, across all 2880x1800 pixels");
  });

  it("is not found on a frame with a picture, one not read, or a window short of the run's end", () => {
    const run = healthyLocalOpen();
    run.frame = { width: 8, height: 4, flatColour: null, unread: null };
    expect(diagnoseRun(run).findings.some((f) => f.rule === RULESET.blankFrame.id)).toBe(false);
    run.frame = { width: 0, height: 0, flatColour: null, unread: "the render worker could not read its canvas" };
    expect(diagnoseRun(run).findings.some((f) => f.rule === RULESET.blankFrame.id)).toBe(false);
    run.frame = { width: 8, height: 4, flatColour: "#000000", unread: null };
    const windowed = diagnoseRun(run, { window: { startMs: 0, endMs: 10 } });
    expect(windowed.findings.some((f) => f.rule === RULESET.blankFrame.id)).toBe(false);
  });
});

describe("a page that scrolled or overflows", () => {
  const fits = {
    scrollX: 0,
    scrollY: 0,
    scrollWidth: 390,
    scrollHeight: 844,
    viewportWidth: 390,
    viewportHeight: 844,
  };

  it("is a stall when the page overflows its viewport, as a 100vh body does under a phone's address bar", () => {
    const run = healthyLocalOpen();
    run.pageScroll = { ...fits, scrollHeight: 924 };
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("its document is 390x924 CSS pixels in a 390x844 viewport");
    expect(doc.findings[0]).toMatchObject({
      rule: RULESET.pageScroll.id,
      observed: { scroll: { scrollHeight: 924, viewportHeight: 844 } },
      attribution: null,
    });
    expect(renderDiagnostic(doc).text).toContain("scrolled to 0,0, document 390x924 in a 390x844 viewport");
  });

  it("is a stall when the page was scrolled, even with nothing left to scroll", () => {
    const run = healthyLocalOpen();
    run.pageScroll = { ...fits, scrollY: 80 };
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("the page was scrolled to 0,80;");
  });

  it("is not found on a page that fits, one never read, or a window short of the run's end", () => {
    const run = healthyLocalOpen();
    run.pageScroll = fits;
    expect(diagnoseRun(run).findings.some((f) => f.rule === RULESET.pageScroll.id)).toBe(false);
    delete run.pageScroll;
    expect(diagnoseRun(run).findings.some((f) => f.rule === RULESET.pageScroll.id)).toBe(false);
    run.pageScroll = { ...fits, scrollY: 80 };
    const windowed = diagnoseRun(run, { window: { startMs: 0, endMs: 10 } });
    expect(windowed.findings.some((f) => f.rule === RULESET.pageScroll.id)).toBe(false);
  });

  it("follows a blank frame", () => {
    const run = healthyLocalOpen();
    run.frame = { width: 8, height: 4, flatColour: "#000000", unread: null };
    run.pageScroll = { ...fits, scrollY: 80 };
    expect(diagnoseRun(run).findings.slice(0, 2).map((f) => f.rule)).toEqual([
      RULESET.blankFrame.id,
      RULESET.pageScroll.id,
    ]);
  });
});

describe("chrome off the screen", () => {
  const phone = (parts: ChromePart[]): ChromeReading => ({ viewportWidth: 390, viewportHeight: 844, parts });
  const topBar: ChromePart = { part: "top bar", left: 0, top: 0, right: 390, bottom: 52.33 };
  const sheet: ChromePart = { part: "bottom sheet", left: 0, top: 660, right: 390, bottom: 844 };

  it("is a stall when a scroll carried the top bar off the top, as a route that kept the last page's offset does", () => {
    const run = healthyLocalOpen();
    run.chrome = phone([{ ...topBar, top: -80, bottom: -27.67 }, sheet]);
    const doc = diagnoseRun(run);

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain(
      "the top bar spans 0,-80 to 390,-27.67 CSS pixels in a 390x844 viewport, so all of it is off the screen",
    );
    expect(doc.findings.filter((f) => f.rule === RULESET.chrome.id).map((f) => f.subject)).toEqual(["top bar"]);
    expect(doc.findings[0]).toMatchObject({
      rule: RULESET.chrome.id,
      subject: "top bar",
      observed: { chrome: { top: -80, viewportHeight: 844 } },
      attribution: null,
    });
    expect(renderDiagnostic(doc).text).toContain("spans 0,-80 to 390,-27.67 in a 390x844 viewport, CSS pixels");
  });

  it("is a stall when the sheet reaches below the viewport, with nothing for the page to scroll", () => {
    const run = healthyLocalOpen();
    run.chrome = phone([topBar, { ...sheet, top: 740, bottom: 924 }]);
    const doc = diagnoseRun(run);

    expect(doc.verdict.text).toContain("the bottom sheet spans 0,740 to 390,924 CSS pixels in a 390x844 viewport, so part of it");
    expect(doc.findings.filter((f) => f.rule === RULESET.chrome.id).map((f) => f.subject)).toEqual(["bottom sheet"]);
  });

  it("is not found on chrome inside the viewport or within rounding of its edge, none rendered, none read, or a window", () => {
    const run = healthyLocalOpen();
    const chromeFindings = (options?: Parameters<typeof diagnoseRun>[1]) =>
      diagnoseRun(run, options).findings.filter((f) => f.rule === RULESET.chrome.id);
    run.chrome = phone([topBar, { ...sheet, bottom: 844.4 }]);
    expect(chromeFindings()).toEqual([]);
    run.chrome = phone([]);
    expect(chromeFindings()).toEqual([]);
    delete run.chrome;
    expect(chromeFindings()).toEqual([]);
    run.chrome = phone([{ ...topBar, top: -80, bottom: -28 }]);
    expect(chromeFindings({ window: { startMs: 0, endMs: 10 } })).toEqual([]);
  });

  it("follows the scroll that carried it off", () => {
    const run = healthyLocalOpen();
    run.pageScroll = {
      scrollX: 0,
      scrollY: 80,
      scrollWidth: 390,
      scrollHeight: 924,
      viewportWidth: 390,
      viewportHeight: 844,
    };
    run.chrome = phone([{ ...topBar, top: -80, bottom: -28 }, sheet]);
    expect(diagnoseRun(run).findings.slice(0, 2).map((f) => f.rule)).toEqual([
      RULESET.pageScroll.id,
      RULESET.chrome.id,
    ]);
  });
});

describe("first paint on a cold open", () => {
  const presentCeiling = RULESET.absolute.find((rule) => rule.phase === "browser.present")!;

  it("reads a present breach on a run opened by content as a first-paint note, not a stall", () => {
    const doc = diagnoseRun(firstPaintOpen());

    expect(doc.findings.filter((finding) => finding.severity !== "note")).toEqual([]);
    const note = doc.findings.find((finding) => finding.rule === RULESET.firstPaint.id);
    expect(note).toBeDefined();
    expect(note?.subject).toBe("browser.present");
    expect(note?.observed.stat).toBe("p95");
    expect(note?.observed.ms).toBeGreaterThan(presentCeiling.ceilMs);
    // The ceiling that measured it still prints; the rationale is first paint's.
    expect(note?.threshold).toEqual({
      kind: "absolute",
      value: presentCeiling.ceilMs,
      why: RULESET.firstPaint.why,
    });
    expect(doc.findings.some((finding) => finding.rule === presentCeiling.id)).toBe(false);
  });

  it("reads an upload breach the same way, because upload also runs to a frame dispatch", () => {
    const uploadCeiling = RULESET.absolute.find((rule) => rule.phase === "browser.upload")!;
    const doc = diagnoseRun(firstPaintOpen("upload"));

    expect(doc.findings.filter((finding) => finding.severity !== "note")).toEqual([]);
    const note = doc.findings.find((finding) => finding.rule === RULESET.firstPaint.id);
    expect(note?.subject).toBe("browser.upload");
    expect(note?.observed.ms).toBeGreaterThan(uploadCeiling.ceilMs);
    expect(doc.verdict.kind).toBe("clear");
    expect(doc.verdict.text).toContain("browser.upload ran p95");
    expect(doc.verdict.text).toContain("first paint");
  });

  it("says first paint in the verdict and offers the interaction run that confirms a regression", () => {
    const doc = diagnoseRun(firstPaintOpen());

    expect(doc.verdict.kind).toBe("clear");
    expect(doc.verdict.text).toContain("first paint");
    expect(doc.verdict.text).toContain("browser.present ran p95");
    expect(doc.verdict.text).toContain("interaction run after settle");
    const confirm = doc.next.find((step) => step.why.includes("first paint"));
    expect(confirm?.why).toContain("browser.present");
    expect(confirm?.command).toBe("lucida trace ds --pan 120,60");
  });

  it("says what a phase held when it led the chain, as a volume open's upload does", () => {
    const doc = diagnoseRun(firstPaintOpen("upload", { heldMs: 800 }));

    expect(doc.findings.filter((finding) => finding.severity !== "note")).toEqual([]);
    expect(doc.verdict.kind).toBe("clear");
    expect(doc.verdict.text).toMatch(/browser\.upload held 800 ms \(\d+% of the chain\) on the first paint/);
  });

  it("keeps the stall when a dataset is added to a live page, whose cache is warm", () => {
    const doc = diagnoseRun(firstPaintOpen("present", { warm: true }));

    expect(doc.run.cause?.epoch).toBe("content");
    expect(doc.run.warmth).toContain("warm");
    expect(doc.verdict.kind).toBe("stall");
    expect(doc.findings[0].rule).toBe(presentCeiling.id);
    expect(doc.findings.some((finding) => finding.rule === RULESET.firstPaint.id)).toBe(false);
  });

  it("keeps the stall on an interaction run with the same present, for each of the five", () => {
    for (const input of INPUT_KINDS) {
      const doc = diagnoseRun(slowPresentInteraction(input));

      const lead = doc.findings[0];
      expect(lead.severity, input).toBe("stall");
      expect(lead.rule, input).toBe(presentCeiling.id);
      expect(lead.subject, input).toBe("browser.present");
      expect(doc.verdict.kind, input).toBe("stall");
      expect(doc.verdict.text, input).toContain("browser.present ran p95");
      expect(doc.findings.some((finding) => finding.rule === RULESET.firstPaint.id), input).toBe(false);
      expect(doc.next.some((step) => step.why.includes("first paint")), input).toBe(false);
    }
  });

  it("leaves every other ceiling a stall on a cold open", () => {
    const doc = diagnoseRun(coldRemoteOpen());

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.findings.some((finding) => finding.rule === RULESET.firstPaint.id)).toBe(false);
  });
});

describe("the plan ceiling on a cold open", () => {
  const planCeiling = RULESET.absolute.find((rule) => rule.id === RULESET.coldPlan.widens)!;

  /** One plan pass of `planMs` over an active set of `entities`, the shape a wide collection's first open has. */
  function widePlanRun(planMs: number, entities: number, cause: RunCause, warm = false): TraceRun {
    const tick = makeTick(10 * MS);
    tick.counters.activeSetTotal = entities;
    return makeRun({
      header: {
        runId: "wide-plan",
        durationUs: 600 * MS,
        cause,
        ...(warm
          ? { cacheWarmth: { detailChunks: 40, detailBytes: 40 * 8_192, coarseChunks: 0, coarseBytes: 0 } }
          : {}),
      },
      rows: Array.from({ length: 40 }, (_, i) =>
        makeRow({ startUs: 0, durations: { plan: planMs * MS, queue: 1 * MS, wire: 5 * MS } }, i),
      ),
      ticks: [tick],
    });
  }

  const open: RunCause = { epoch: "content", dirtyKind: "interactive", source: "loop_start" };

  it("allows the first pass of a wide collection a cost per entity it walks", () => {
    const doc = diagnoseRun(widePlanRun(56, 700, open));

    expect(doc.findings.some((finding) => finding.subject === "browser.plan")).toBe(false);
    expect(doc.verdict.kind).toBe("clear");
  });

  it("still fails a pass far over the allowance, and names the widened ceiling", () => {
    const doc = diagnoseRun(widePlanRun(400, 700, open));

    const lead = doc.findings[0];
    expect(lead.severity).toBe("stall");
    expect(lead.rule).toBe(RULESET.coldPlan.id);
    expect(lead.observed.entities).toBe(700);
    expect(lead.threshold).toEqual({
      kind: "absolute",
      value: planCeiling.ceilMs + RULESET.coldPlan.perEntityMs * 700,
      why: RULESET.coldPlan.why,
    });
  });

  it("holds a narrow dataset to the flat ceiling, near enough", () => {
    const doc = diagnoseRun(widePlanRun(56, 12, open));

    expect(doc.findings[0].subject).toBe("browser.plan");
    expect(doc.verdict.kind).toBe("stall");
  });

  it("keeps the flat ceiling on an interaction run and on a warm open", () => {
    for (const run of [
      widePlanRun(56, 700, interactionCause("scrub")),
      widePlanRun(56, 700, open, true),
    ]) {
      const lead = diagnoseRun(run).findings[0];
      expect(lead.rule).toBe(planCeiling.id);
      expect(lead.threshold.value).toBe(planCeiling.ceilMs);
    }
  });
});

describe("interaction runs", () => {
  it("carries the cause that names the input, for each of the five", () => {
    for (const input of INPUT_KINDS) {
      const doc = diagnoseRun(interactionRunFor(input));

      expect(doc.run.cause, input).toEqual(interactionCause(input));
      expect(doc.run.cause?.source, input).toBe(input);
    }
  });

  it("does not call a gesture at a healthy frame rate a stall", () => {
    // A drag ticks every frame, so its main-thread share is near total at any
    // frame rate. The ceiling, not share, is the criterion.
    for (const input of INPUT_KINDS) {
      const doc = diagnoseRun(interactionRunFor(input));

      expect(doc.verdict.kind, input).toBe("clear");
      expect(doc.findings.filter((f) => f.severity !== "note"), input).toEqual([]);
      expect(doc.attribution.confidence, input).toBe("unattributed");
    }
  });

  it("fails a gesture whose frame time exceeds the ceiling, naming the input", () => {
    const doc = diagnoseRun(interactionRunFor("orbit", { frameTimeUs: 80 * MS }));

    expect(doc.verdict.kind).toBe("stall");
    expect(doc.verdict.text).toContain("orbit");
    expect(doc.verdict.text).toContain(`${RULESET.interaction.ceilMs} ms`);
    const lead = doc.findings[0];
    expect(lead.rule).toBe(RULESET.interaction.id);
    expect(lead.subject).toBe(RULESET.interaction.phase);
    expect(lead.observed.stat).toBe("p95");
    expect(lead.observed.ms).toBe(80);
    expect(lead.threshold).toEqual({
      kind: "absolute",
      value: RULESET.interaction.ceilMs,
      why: RULESET.interaction.why,
    });
    expect(doc.attribution.confidence).toBe("aggregate-only");
    expect(doc.attribution.cause).toBe(RULESET.interaction.phase);
    expect(doc.attribution.why).toContain(`${RULESET.interaction.ceilMs} ms`);
  });

  it("applies the ceiling to interaction runs only", () => {
    const open = interactionRunFor("orbit", { frameTimeUs: 80 * MS });
    open.header.cause = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" };
    const doc = diagnoseRun(open);

    expect(doc.findings.some((f) => f.rule === RULESET.interaction.id)).toBe(false);
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
      doc.ruleset.interaction,
    ]) {
      expect(rule.why).not.toBe("");
    }
  });

  it("carries nothing per-row: its size does not scale with the row count", () => {
    const small = JSON.stringify(diagnoseRun(rowCountRun(20))).length;
    const large = JSON.stringify(diagnoseRun(rowCountRun(4_000))).length;

    // Twenty rows against four thousand: two hundred times the rows for a few
    // hundred bytes. What moves is the width of a count and of a named chunk
    // key: the rollup names the worst row per phase, so there are a handful
    // of those rather than one, and still no per-row list anywhere.
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

  it("refuses a run recorded under another trace schema, and says which", () => {
    const old = TRACE_SCHEMA_VERSION - 1;
    const run = makeRun({ header: { schemaVersion: old } });

    expect(() => diagnoseRun(run)).toThrow(
      new RegExp(`trace schema ${old}; this build reads schema ${TRACE_SCHEMA_VERSION}`),
    );
  });

  it("reads the newest run out of a trace document", () => {
    const traceDocument: TraceDocument = {
      schemaVersion: TRACE_SCHEMA_VERSION,
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

describe("the send side", () => {
  it("carries the per-type totals of a send-heavy idle run as rates over the wall clock", () => {
    const doc = diagnoseRun(sendHeavyIdleRun());

    expect(doc.sent.messages).toBe(462);
    expect(doc.sent.bytes).toBe(30_376);
    expect(doc.sent.bytesPerS).toBe(3_038);
    const byType = Object.fromEntries(doc.sent.byType.map((entry) => [entry.type, entry]));
    expect(byType.cursor).toEqual({
      type: "cursor", label: "cursor", messages: 400, bytes: 16_000, bytesPerS: 1_600,
    });
    expect(byType.presence).toMatchObject({ messages: 40, bytes: 12_000, bytesPerS: 1_200 });
    expect(byType.viewerInterest).toMatchObject({ messages: 10, bytes: 1_200, bytesPerS: 120 });
    expect(byType.chunkRequest).toMatchObject({ messages: 12, bytes: 1_176, bytesPerS: 118 });
  });

  it("reads the run's totals rather than summing the tick samples", () => {
    const run = sendHeavyIdleRun();
    expect(run.ticks.every((tick) => tick.sent.cursor.messages === 0)).toBe(true);

    const cursor = diagnoseRun(run).sent.byType.find((entry) => entry.type === "cursor");
    expect(cursor?.messages).toBe(400);
  });

  it("names every type of the closed set, in its order, zeros included", () => {
    const doc = diagnoseRun(quietRun());

    expect(doc.sent.byType.map((entry) => entry.type)).toEqual([...CLIENT_MESSAGE_TYPES]);
    expect(doc.sent.byType.every((entry) => entry.messages === 0 && entry.bytesPerS === 0)).toBe(true);
    expect(doc.sent.bytesPerS).toBe(0);
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

// Runs built for one case each.

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

/**
 * A local open of 40 chunks that land together, each decode round trip
 * `roundTripUs` long, of which the worker spent `workUs` decoding.
 */
function decodeOpen({ roundTripUs, workUs }: { roundTripUs: number; workUs: number }): TraceRun {
  const rows = Array.from({ length: 40 }, (_, i) =>
    makeRow(
      {
        startUs: 40 * MS + i * 200,
        durations: { plan: 400, queue: 2 * MS, wire: 18 * MS, decode: roundTripUs, upload: 1_200, present: 2 * MS },
        rid: i,
        decodeWorkUs: workUs,
      },
      i,
    ),
  );
  return makeRun({
    header: { runId: "decode-open", durationUs: 1_000 * MS },
    rows,
    readings: Array.from({ length: 12 }, (_, i) =>
      makeReading(30 * MS + i * 25 * MS, { queueDepth: 0, inFlight: (i % 3) + 1, frameTimeUs: 3_500 }),
    ),
  });
}

/**
 * A zoom's run: 40 chunks prefetched ahead of the view, each `uploadUs` from
 * decoded to resident, `unwantedUs` of it before the view wanted it, and ten
 * chunks the view asked for that reached the GPU in 12 ms. The prefetched
 * ones land last, so the critical path ends on one.
 */
function prefetchedZoom({ uploadUs, unwantedUs }: { uploadUs: number; unwantedUs: number }): TraceRun {
  const wanted = Array.from({ length: 10 }, (_, i) =>
    makeRow(
      {
        startUs: 20 * MS + i * 200,
        durations: { plan: 400, queue: MS, wire: 15 * MS, decode: MS, upload: 12 * MS, present: 16 * MS },
        rid: i,
      },
      i,
    ),
  );
  const ahead = Array.from({ length: 40 }, (_, i) =>
    makeRow(
      {
        startUs: 20 * MS + i * 200,
        durations: { plan: 400, queue: 2 * MS, wire: 15 * MS, decode: MS, upload: uploadUs, present: 16 * MS },
        rid: 10 + i,
        lane: "prefetch",
        unwantedUs,
      },
      10 + i,
    ),
  );
  return makeRun({
    header: {
      runId: "prefetched-zoom",
      durationUs: uploadUs + 400 * MS,
      cause: interactionCause("zoom"),
    },
    rows: [...wanted, ...ahead],
    readings: Array.from({ length: 30 }, (_, i) =>
      makeReading(i * 25 * MS, { queueDepth: 0, inFlight: 2, frameTimeUs: 3_000 }),
    ),
  });
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
