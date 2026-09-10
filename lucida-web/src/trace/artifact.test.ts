/**
 * Reading a run or a bundle back from a file (#1066), held to the CLI's
 * reader. The golden bundle under `trace-fixtures/` is the file both sides
 * read, so a case here that names a field is a case the CLI's tests name
 * too, and the side each reader hands the compare function is asserted
 * field by field against what `CompareSide::from_bundle` and
 * `from_run_file` write.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactRunId,
  artifactTrace,
  compareSideOf,
  readArtifact,
  RUN_FILE_VERSION,
  type TraceRunFile,
} from "./artifact.ts";
import { BUNDLE_VERSION } from "./bundle.ts";
import { compareTraces } from "./diagnose/compare.ts";
import { coldRemoteOpen, healthyLocalOpen, makeDocument } from "./diagnose/fixtures.ts";
import { TRACE_SCHEMA_VERSION } from "./types.ts";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "trace-fixtures");
const GOLDEN = join(FIXTURE_ROOT, "bundle-v1.json");
const GOLDEN_SIDE = join(FIXTURE_ROOT, "compare-side-v1.json");

function goldenText(): string {
  return readFileSync(GOLDEN, "utf-8");
}

function regen(): boolean {
  const flag = process.env.REGEN_TRACE_FIXTURES;
  return flag !== undefined && flag !== "" && flag !== "0";
}

function runFile(overrides: Partial<TraceRunFile> = {}, header: Partial<TraceRunFile["header"]> = {}): TraceRunFile {
  return {
    fileVersion: RUN_FILE_VERSION,
    header: {
      runId: "remote-cold",
      composedView: { url: "/w/ws-1?d=set", mode: "slice" },
      quiescenceHoldMs: 500,
      settled: true,
      endReason: "quiescent",
      serverWarmth: { datasetOpenBeforeRun: true, openedByDriver: false, summary: "server warm: the dataset was open before the run" },
      serverUrl: "http://localhost:9876",
      workspaceId: "ws-1",
      ...header,
    },
    renderings: { summary: "", phases: "", perPhase: {}, spatial: "", perChunk: {} },
    diagnostic: {},
    trace: makeDocument([coldRemoteOpen()]),
    ...overrides,
  };
}

describe("reading a bundle", () => {
  it("reads the golden bundle as the CLI does: by its format field, at its version, about its run", () => {
    const artifact = readArtifact(goldenText(), "lucida-local-healthy.bundle.json");

    expect(artifact.kind).toBe("bundle");
    if (artifact.kind !== "bundle") return;
    expect(artifact.bundle.bundleVersion).toBe(BUNDLE_VERSION);
    expect(artifact.bundle.header.runId).toBe("local-healthy");
    expect(artifact.bundle.diagnostic?.verdict).toBeDefined();
    expect(artifact.bundle.frame?.capturedBy).toBe("page");
    expect(artifactRunId(artifact)).toBe("local-healthy");
    expect(artifactTrace(artifact).runs.map((run) => run.header.runId)).toEqual(["local-healthy"]);
  });

  it("refuses a bundle from another version by number, as the CLI does", () => {
    const bundle = JSON.parse(goldenText());
    bundle.bundleVersion = BUNDLE_VERSION + 1;

    expect(() => readArtifact(JSON.stringify(bundle), "later.bundle.json")).toThrow(
      `later.bundle.json was written by bundle version ${BUNDLE_VERSION + 1}, and this page reads version ${BUNDLE_VERSION}`,
    );
  });

  it("refuses a file that claims to be a bundle and carries no trace document", () => {
    const text = JSON.stringify({ format: "lucida-trace-bundle", bundleVersion: BUNDLE_VERSION, header: {} });

    expect(() => readArtifact(text, "hollow.json")).toThrow(/^hollow\.json is not a lucida trace bundle: /);
  });
});

describe("reading a run file", () => {
  it("reads the driver's run file by its version, about the run its header names", () => {
    const artifact = readArtifact(JSON.stringify(runFile()), "run-1.json");

    expect(artifact.kind).toBe("run-file");
    expect(artifactRunId(artifact)).toBe("remote-cold");
    expect(artifactTrace(artifact).runs[0].header.runId).toBe("remote-cold");
  });

  it("refuses a run file from another version by number, as the CLI does", () => {
    const text = JSON.stringify(runFile({ fileVersion: RUN_FILE_VERSION + 1 }));

    expect(() => readArtifact(text, "run-2.json")).toThrow(
      `run-2.json was written by run file version ${RUN_FILE_VERSION + 1}, and this page reads version ${RUN_FILE_VERSION}`,
    );
  });
});

describe("reading a saved run", () => {
  it("reads the document the monitor's Save run writes, which is about its newest run", () => {
    const document = makeDocument([healthyLocalOpen(), coldRemoteOpen()]);

    const artifact = readArtifact(JSON.stringify(document), "lucida-remote-cold.trace.json");

    expect(artifact.kind).toBe("saved-run");
    // The document alone names no run, so the newest is read, as the CLI's
    // and the seam's defaults do.
    expect(artifactRunId(artifact)).toBeNull();
    expect(artifactTrace(artifact).runs).toHaveLength(2);
  });

  it("refuses a saved run from another trace schema by number", () => {
    const document = makeDocument([healthyLocalOpen()]);
    document.schemaVersion = TRACE_SCHEMA_VERSION - 1;

    expect(() => readArtifact(JSON.stringify(document), "old.trace.json")).toThrow(
      `old.trace.json was recorded under trace schema ${TRACE_SCHEMA_VERSION - 1}; this build reads schema ${TRACE_SCHEMA_VERSION}`,
    );
  });

  it("says what a file is not, rather than guessing, and says when it is not JSON at all", () => {
    expect(() => readArtifact(JSON.stringify({ hello: "world" }), "notes.json")).toThrow(
      "notes.json is not a lucida trace bundle, run file, or saved run",
    );
    expect(() => readArtifact("<html>", "page.html")).toThrow(/^page\.html is not JSON: /);
  });
});

describe("the side a file hands the compare function", () => {
  it("hands over a bundle as the CLI's from_bundle does: its run, its whole planning configuration, no cache knobs, no conditions", () => {
    const artifact = readArtifact(goldenText(), "baseline.bundle.json");
    if (artifact.kind !== "bundle") throw new Error("expected a bundle");

    const side = compareSideOf(artifact, "baseline.bundle.json");

    expect(side).toEqual({
      trace: artifact.bundle.trace,
      runId: "local-healthy",
      label: "baseline.bundle.json",
      planning: artifact.bundle.header.planning,
      cache: null,
      conditions: {},
    });
    const comparison = compareTraces(side, compareSideOf(artifact, "candidate.bundle.json"));
    expect(comparison.comparable).toBe(true);
    expect(comparison.left.label).toBe("baseline.bundle.json");
    expect(comparison.wall.deltaMs).toBe(0);
  });

  /**
   * The CLI's tests hold `CompareSide::from_bundle` to the golden this test
   * writes, `trace-fixtures/compare-side-v1.json`. Regenerate with
   * `REGEN_TRACE_FIXTURES=1 pnpm exec vitest run src/trace/artifact.test.ts`.
   */
  it("hands the compare function the side the CLI hands it for the golden bundle, held by a golden of its own", () => {
    const label = "trace-fixtures/bundle-v1.json";
    const side = compareSideOf(readArtifact(goldenText(), label), label);
    const facts = {
      label: side.label,
      runId: side.runId,
      planning: side.planning,
      cache: side.cache,
      conditions: side.conditions,
    };
    const produced = JSON.parse(JSON.stringify(facts));

    if (regen()) writeFileSync(GOLDEN_SIDE, `${JSON.stringify(produced, null, 2)}\n`);

    expect(existsSync(GOLDEN_SIDE), `missing ${GOLDEN_SIDE}; regenerate with REGEN_TRACE_FIXTURES=1`).toBe(true);
    expect(produced).toStrictEqual(JSON.parse(readFileSync(GOLDEN_SIDE, "utf-8")));
  });

  it("hands over a run file as the CLI's from_run_file does: the knobs the driver set, and the server's warmth as a condition", () => {
    const withKnobs = readArtifact(
      JSON.stringify(runFile({}, { knobs: { planning: { prefetchDepth: 0 }, cache: { maxConcurrentFetches: 8 } } })),
      "runs/left.json",
    );

    expect(compareSideOf(withKnobs, "runs/left.json")).toEqual({
      trace: artifactTrace(withKnobs),
      runId: "remote-cold",
      label: "runs/left.json",
      planning: { prefetchDepth: 0 },
      cache: { maxConcurrentFetches: 8 },
      conditions: { "server warmth": "server warm: the dataset was open before the run" },
    });

    // A run file that set no knob ran at the page's defaults, and says so
    // with empty objects rather than with unknowns.
    const plain = readArtifact(JSON.stringify(runFile()), "runs/plain.json");
    expect(compareSideOf(plain, "runs/plain.json")).toMatchObject({ planning: {}, cache: {} });
  });

  it("hands over a saved run knowing nothing beyond the document, since the document alone records no knob", () => {
    const artifact = readArtifact(JSON.stringify(makeDocument([healthyLocalOpen()])), "saved.trace.json");

    expect(compareSideOf(artifact, "saved.trace.json")).toEqual({
      trace: artifactTrace(artifact),
      runId: undefined,
      label: "saved.trace.json",
      planning: null,
      cache: null,
      conditions: null,
    });
  });
});
