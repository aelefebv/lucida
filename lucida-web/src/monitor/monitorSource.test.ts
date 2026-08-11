// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTraceSeam } from "../trace/seam.ts";
import { traceRecorder } from "../trace/recorder.ts";
import { createQuiescenceState } from "../trace/quiescence.ts";
import { readMonitor, traceFile } from "./monitorSource.ts";

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

    expect(runs.map((run) => run.cause)).toEqual(["camera_moved", "loop_start"]);
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
});
