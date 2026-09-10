// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTraceSeam } from "../trace/seam.ts";
import { traceRecorder } from "../trace/recorder.ts";
import { createQuiescenceState } from "../trace/quiescence.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareLoaded,
  compareSideFor,
  downloadBundle,
  loadArtifact,
  pageArtifact,
  readArtifactFile,
  readMonitor,
  readProvisional,
  rereadLoaded,
  traceFile,
} from "./monitorSource.ts";
import { coldRemoteOpen, healthyLocalOpen, makeDocument } from "../trace/diagnose/fixtures.ts";
import { configStore } from "../pipeline/planning/configStore.ts";

const GOLDEN_BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "trace-fixtures", "bundle-v1.json");

/**
 * Stands in for the render loop, which registers the real one. A run cannot
 * open without an environment — its conditions are what make it a comparable
 * artifact, and they are exactly what a saved file has to carry.
 */
function registerEnvironment(): void {
  traceRecorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0,
      detailBytes: 0,
      coarseChunks: 0,
      coarseBytes: 0,
      proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => createQuiescenceState(),
  });
}

const OPEN = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" } as const;

beforeEach(() => {
  traceRecorder.reset();
});

afterEach(() => {
  traceRecorder.reset();
  delete window.lucidaTrace;
});

describe("reading the run in progress", () => {
  it("takes the provisional reading through the seam without closing the run (#1057)", () => {
    registerEnvironment();
    installTraceSeam();
    expect(readProvisional()).toBeNull();

    traceRecorder.openRun(OPEN);
    const reading = readProvisional();

    expect(reading?.provisional).toBe(true);
    expect(traceRecorder.isRunOpen).toBe(true);
    // The same object the seam hands an agent, so the two cannot disagree.
    expect(reading?.runId).toBe(window.lucidaTrace!.provisional()!.runId);
  });

  it("reads null where there is no seam, as progress does", () => {
    expect(readProvisional()).toBeNull();
  });
});

describe("reading a run", () => {
  it("reads the newest run through the seam the CLI uses", () => {
    registerEnvironment();
    installTraceSeam();
    traceRecorder.openRun(OPEN);

    const { read } = readMonitor();

    expect(read.ok).toBe(true);
    expect(read.ok && read.document.verdict.text.length).toBeGreaterThan(0);
  });

  it("reports an empty recorder as a reason rather than throwing", () => {
    installTraceSeam();

    const { read } = readMonitor();

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason.length).toBeGreaterThan(0);
  });

  it("says so when the page has no seam at all", () => {
    const snapshot = readMonitor(undefined, undefined);

    expect(snapshot.read.ok).toBe(false);
    expect(snapshot.runs).toEqual([]);
  });

  it("takes the diagnosis and the run list from one export", () => {
    // Exporting closes the run in progress. Asking twice for one answer would
    // close an interval on the way to each half of it.
    registerEnvironment();
    const seam = installTraceSeam();
    const exportTrace = vi.spyOn(seam, "exportTrace");
    traceRecorder.openRun(OPEN);

    readMonitor(undefined, seam);

    expect(exportTrace).toHaveBeenCalledTimes(1);
  });

  it("lists the runs the recording still holds, newest first, so a reader can pick one", () => {
    // The newest interval is often the quiet tail rather than the open that
    // sent someone to the monitor in the first place.
    registerEnvironment();
    const seam = installTraceSeam();
    traceRecorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "loop_start" });
    traceRecorder.closeRun("quiescent");
    traceRecorder.openRun({ epoch: "view", dirtyKind: "residency", source: "camera_moved" });

    const { runs } = readMonitor(undefined, seam);

    expect(runs.map((run) => run.cause)).toEqual([
      "view/residency/camera_moved",
      "content/interactive/loop_start",
    ]);
    expect(runs[1].endReason).toBe("quiescent");
    // And the older one is readable by id.
    const older = readMonitor(runs[1].runId, seam);
    expect(older.read.ok && older.read.document.runId).toBe(runs[1].runId);
  });
});

describe("saving a run", () => {
  it("writes the merged document, headers included, through the export seam", () => {
    registerEnvironment();
    const seam = installTraceSeam();
    traceRecorder.openRun(OPEN);

    const file = traceFile("trace", undefined, seam);
    const document = JSON.parse(file.text);

    // The header is what makes two runs comparable — or visibly not.
    const header = document.runs[document.runs.length - 1].header;
    expect(header.build.version).toBeTruthy();
    expect(header.devicePixelRatio).toBeGreaterThan(0);
    expect(header.viewport.deviceWidth).toBeGreaterThan(0);
    expect(header.cacheWarmth).toBeDefined();
    expect(header.runId).toBeTruthy();
  });

  it("names the file for the run being read, not for the newest one", () => {
    registerEnvironment();
    const seam = installTraceSeam();
    traceRecorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "loop_start" });
    traceRecorder.closeRun("quiescent");
    traceRecorder.openRun({ epoch: "view", dirtyKind: "residency", source: "camera_moved" });
    const { runs } = readMonitor(undefined, seam);
    const older = runs[1].runId;

    // Saving while an older run is on screen has to produce a file named for
    // that run: the name is what the follow-up command takes.
    expect(traceFile("trace", older, seam).filename).toBe(`lucida-${older}.trace.json`);
    expect(traceFile("perfetto", older, seam).filename).toBe(`lucida-${older}.perfetto.json`);
    expect(traceFile("trace", undefined, seam).filename).toBe(`lucida-${runs[0].runId}.trace.json`);
  });

  it("projects the same run into Chrome Trace Event JSON without a second export path", () => {
    registerEnvironment();
    const seam = installTraceSeam();
    const spy = vi.spyOn(seam, "exportChromeTrace");
    traceRecorder.openRun(OPEN);

    const file = traceFile("perfetto", "run-x", seam);

    expect(spy).toHaveBeenCalled();
    expect(JSON.parse(file.text).traceEvents).toBeDefined();
  });

  /**
   * The bundle goes through the seam's one bundle function (#1055), named
   * for the run on screen and without the Perfetto projection, which has its
   * own control.
   */
  it("saves the bundle through the seam's bundle function, named for the run being read", async () => {
    registerEnvironment();
    const seam = installTraceSeam();
    const spy = vi.spyOn(seam, "exportBundle");
    traceRecorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "loop_start" });
    traceRecorder.closeRun("quiescent");
    traceRecorder.openRun({ epoch: "view", dirtyKind: "residency", source: "camera_moved" });
    const { runs } = readMonitor(undefined, seam);
    const older = runs[1].runId;
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:bundle", revokeObjectURL: () => {} });
    try {
      await expect(downloadBundle(older, seam)).resolves.toBe(`lucida-${older}.bundle.json`);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    expect(spy).toHaveBeenCalledWith({ runId: older });
    expect(clicked).toEqual([`lucida-${older}.bundle.json`]);
  });
});

describe("reading a dropped file (#1066)", () => {
  it("reads the golden bundle about the run its header names, at every depth the page reads a live run", () => {
    const loaded = readArtifactFile(readFileSync(GOLDEN_BUNDLE, "utf-8"), "lucida-local-healthy.bundle.json");

    expect(loaded.origin).toBe("file");
    expect(loaded.artifact.kind).toBe("bundle");
    expect(loaded.runId).toBe("local-healthy");
    expect(loaded.runs.map((run) => run.runId)).toEqual(["local-healthy"]);
    expect(loaded.read.ok).toBe(true);
    if (!loaded.read.ok) return;
    // Derived from the document, not read off the bundle's own diagnostic.
    expect(loaded.read.document.verdict.text.length).toBeGreaterThan(0);
    expect(loaded.read.document.phases.length).toBeGreaterThan(0);
    expect(loaded.read.document.timeline.axis.startMs).toBe(0);
  });

  it("reads a file the way the drop handler hands it over: by name and text", async () => {
    const document = makeDocument([healthyLocalOpen(), coldRemoteOpen()]);
    const file = { name: "lucida-remote-cold.trace.json", text: () => Promise.resolve(JSON.stringify(document)) };

    const loaded = await loadArtifact(file);

    // A saved run names no run, so the newest is read, and the others are offered.
    expect(loaded.runId).toBe("remote-cold");
    expect(loaded.runs.map((run) => run.runId)).toEqual(["remote-cold", "local-healthy"]);
    const older = rereadLoaded(loaded, "local-healthy");
    expect(older.runId).toBe("local-healthy");
    expect(older.read.ok && older.read.document.runId).toBe("local-healthy");
    expect(older.runs).toEqual(loaded.runs);
  });

  it("rejects an unreadable file by name and reason, and reports a readable file with no run as a reason", async () => {
    await expect(loadArtifact({ name: "notes.json", text: () => Promise.resolve("{}") })).rejects.toThrow(
      "notes.json is not a lucida trace bundle, run file, or saved run",
    );

    const empty = readArtifactFile(JSON.stringify(makeDocument([])), "empty.trace.json");
    expect(empty.read.ok).toBe(false);
    expect(empty.read.ok === false && empty.read.reason).toContain("no run");
    expect(empty.runId).toBeNull();
  });
});

describe("comparing two loaded runs (#1066)", () => {
  it("is the seam's own compare function: the dock's text is the text lucida trace diff prints", () => {
    const seam = installTraceSeam();
    const baseline = readArtifactFile(readFileSync(GOLDEN_BUNDLE, "utf-8"), "baseline.bundle.json");
    const candidate = readArtifactFile(JSON.stringify(makeDocument([coldRemoteOpen()])), "candidate.trace.json");

    const result = compareLoaded(baseline, candidate);

    // `lucida trace diff` prints what the seam's compareTracesText returns.
    expect(result.text).toBe(seam.compareTracesText(compareSideFor(baseline), compareSideFor(candidate)));
    expect(result.comparison).toEqual(seam.compareTraces(compareSideFor(baseline), compareSideFor(candidate)));
    expect(result.comparison.left.label).toBe("baseline.bundle.json");
    expect(result.comparison.right.label).toBe("candidate.trace.json");
    expect(result.text).toContain("lucida trace diff local-healthy remote-cold");
  });

  it("compares the run a side was re-read to, not the one its header named", () => {
    const both = readArtifactFile(JSON.stringify(makeDocument([healthyLocalOpen(), coldRemoteOpen()])), "two.trace.json");
    const older = rereadLoaded(both, "local-healthy");

    const result = compareLoaded(older, both);

    expect(result.comparison.left.runId).toBe("local-healthy");
    expect(result.comparison.right.runId).toBe("remote-cold");
  });

  it("offers the run on screen as a side that knows this page's planning configuration", () => {
    registerEnvironment();
    const seam = installTraceSeam();
    traceRecorder.openRun(OPEN);
    const snapshot = readMonitor(undefined, seam);

    const page = pageArtifact(snapshot);

    expect(page).not.toBeNull();
    expect(page!.origin).toBe("page");
    expect(page!.name).toBe("this page");
    expect(page!.runId).toBe(snapshot.read.ok ? snapshot.read.document.runId : null);
    // The page knows what a bundle's header would carry, and nothing a bundle
    // would not: the planning configuration, and no cache knob.
    expect(compareSideFor(page!)).toMatchObject({
      label: "this page",
      planning: configStore.get(),
      cache: null,
      conditions: {},
    });
    expect(pageArtifact({ read: { ok: false, reason: "no seam" }, runs: [], trace: null })).toBeNull();
  });
});
