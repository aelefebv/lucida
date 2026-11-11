/**
 * The recorder's lag tier, through to the diagnostic: each input tied to the
 * frame that answers it by sequence number, the main thread's long tasks, and
 * the display interval, with a run that took no input carrying none of it.
 */

import { describe, expect, it } from "vitest";

import { diagnoseDocument } from "./diagnose/diagnose.ts";
import { renderDiagnostic } from "./diagnose/renderText.ts";
import { RULESET } from "./diagnose/ruleset.ts";
import { INPUT_CAPACITY } from "./lagRecord.ts";
import { TraceRecorder } from "./recorder.ts";

function makeRig() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 60_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({ detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0 }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 1,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 800, deviceHeight: 600 },
    }),
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
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
    }),
  });
  return {
    recorder,
    now: () => clock,
    at: (ms: number) => {
      clock = ms;
    },
  };
}

type Rig = ReturnType<typeof makeRig>;

/**
 * A drag at the display's pace: an input every 16 ms, handled 2 ms after its
 * event, drawn by a frame dispatched 4 ms after it and done 12 ms after it.
 * Returns the next frame sequence number and the time the drag ended.
 */
function drag(rig: Rig, startMs: number, moves: number, firstSeq = 1): { seq: number; endMs: number } {
  let seq = firstSeq;
  let t = startMs;
  for (let i = 0; i < moves; i++, t += 16) {
    rig.at(t + 2);
    rig.recorder.noteInput("pan", t);
    rig.at(t + 4);
    rig.recorder.noteFrameDispatched(seq);
    rig.at(t + 12);
    rig.recorder.noteFrameDone(seq, t + 12);
    seq++;
  }
  return { seq, endMs: t };
}

function exportRun(rig: Rig) {
  const document = rig.recorder.exportDocument();
  const run = document.runs[document.runs.length - 1];
  return { document, run, diagnostic: diagnoseDocument(document, { runId: run.header.runId }) };
}

describe("the lag tier", () => {
  it("ties each input to the next frame dispatched and times it from the event to that frame's done", () => {
    const rig = makeRig();
    // Two inputs before one frame: both are drawn by it.
    rig.at(1_002);
    rig.recorder.noteInput("pan", 1_000);
    rig.at(1_010);
    rig.recorder.noteInput("pan", 1_008);
    rig.at(1_012);
    rig.recorder.noteFrameDispatched(7);
    // An input after the dispatch waits for the next frame.
    rig.at(1_020);
    rig.recorder.noteInput("zoom", 1_019);
    rig.at(1_022);
    rig.recorder.noteFrameDispatched(8);
    // Frame 8's report covers frame 7 too: the worker finishes in order.
    rig.at(1_040);
    rig.recorder.noteFrameDone(8, 1_035);

    const { run, diagnostic } = exportRun(rig);
    // The run opened at the first input's handler, 2 ms after its event.
    expect(run.lag!.inputs).toEqual([
      { kind: "pan", atUs: -2_000, dispatchedUs: 10_000, presentedUs: 33_000 },
      { kind: "pan", atUs: 6_000, dispatchedUs: 10_000, presentedUs: 33_000 },
      { kind: "zoom", atUs: 17_000, dispatchedUs: 20_000, presentedUs: 33_000 },
    ]);
    expect(run.lag!.framesUs).toEqual([33_000]);
    expect(diagnostic.lag!.inputs).toBe(3);
    expect(diagnostic.lag!.inputToFrame).toEqual({ samples: 3, p50Ms: 27, p95Ms: 35, maxMs: 35 });
  });

  it("answers a hover when the overlays drew it, never with a viewport frame", () => {
    const rig = makeRig();
    rig.at(1_002);
    rig.recorder.noteInput("hover", 1_000);
    rig.at(1_010);
    rig.recorder.noteInput("hover", 1_008);
    // A frame residency asked for draws nothing a hover moved.
    rig.at(1_012);
    rig.recorder.noteFrameDispatched(3);
    rig.at(1_020);
    rig.recorder.noteFrameDone(3, 1_020);
    // A read that left with the first hover's point is drawn: only it is answered.
    rig.at(1_030);
    rig.recorder.noteOverlayDrawn(1_000, 1_016);
    rig.at(1_041);
    rig.recorder.noteInput("hover", 1_040);
    rig.at(1_050);
    rig.recorder.noteOverlayDrawn(1_040, 1_042);

    const { run, diagnostic } = exportRun(rig);
    expect(run.header.cause).toEqual({ epoch: null, dirtyKind: "interactive", source: "hover" });
    expect(run.lag!.inputs).toEqual([
      { kind: "hover", atUs: -2_000, dispatchedUs: 14_000, presentedUs: 28_000 },
      { kind: "hover", atUs: 6_000, dispatchedUs: 40_000, presentedUs: 48_000 },
      { kind: "hover", atUs: 38_000, dispatchedUs: 40_000, presentedUs: 48_000 },
    ]);
    expect(diagnostic.lag!.inputToFrame).toEqual({ samples: 3, p50Ms: 30, p95Ms: 42, maxMs: 42 });
  });

  it("summarises a scripted drag per input and finds nothing wrong with one that keeps up", () => {
    const rig = makeRig();
    for (let t = 800; t < 1_000; t += 16.7) rig.recorder.noteAnimationFrame(t);
    drag(rig, 1_000, 40);

    const { run, diagnostic } = exportRun(rig);
    expect(run.lag!.inputs).toHaveLength(40);
    expect(diagnostic.lag!.inputToFrame).toEqual({ samples: 40, p50Ms: 12, p95Ms: 12, maxMs: 12 });
    expect(diagnostic.lag!.longTasks).toEqual({ count: 0, longestMs: 0, totalMs: 0 });
    expect(diagnostic.lag!.frames).toEqual({ presented: 40, dropped: 0, displayIntervalMs: 16.7 });
    expect(diagnostic.findings.some((finding) => finding.rule === RULESET.lag.id)).toBe(false);
    expect(renderDiagnostic(diagnostic).text).toMatch(
      /^lag {7}input-to-frame first 12 ms · p50 12 ms · p95 12 ms · max 12 ms \(n=40\) · no long task · 40 frames, 0 dropped against a 16\.7 ms refresh$/m,
    );
  });

  it("keeps a long task and the input that waited behind it, and finds the lag", () => {
    const rig = makeRig();
    const { seq, endMs } = drag(rig, 1_000, 20);
    // The main thread blocks for 300 ms. The next input's event lands 20 ms
    // in and is handled when the block ends; the browser reports the block
    // as a long task once it is over.
    const blockStart = endMs;
    const eventAt = blockStart + 20;
    rig.at(blockStart + 300);
    rig.recorder.noteInput("pan", eventAt);
    rig.recorder.noteLongTask(blockStart, 300);
    rig.at(blockStart + 302);
    rig.recorder.noteFrameDispatched(seq);
    rig.recorder.noteFrameDone(seq, blockStart + 310);
    drag(rig, blockStart + 320, 19, seq + 1);

    const { run, diagnostic } = exportRun(rig);
    expect(run.lag!.longTasks).toEqual([{ startUs: (blockStart - 1_002) * 1000, durationUs: 300_000 }]);
    expect(diagnostic.lag!.longTasks).toEqual({ count: 1, longestMs: 300, totalMs: 300 });
    expect(diagnostic.lag!.inputToFrame!.maxMs).toBe(290);

    const lag = diagnostic.findings.find((finding) => finding.rule === RULESET.lag.id)!;
    expect(lag.severity).toBe("fail");
    expect(lag.subject).toBe("input-to-frame");
    expect(lag.observed).toEqual({ stat: "max", ms: 290, n: 40 });
    expect(lag.threshold.value).toBe(RULESET.lag.max.ceilMs);
    expect(diagnostic.verdict.kind).toBe("fail");
    // A run with no chunk rows carries the coverage caveat as well.
    expect(diagnostic.verdict.text.startsWith(
      "pan lagged: input to frame max 290 ms over the 200 ms ceiling, across 40 input(s); the longest main-thread task ran 300 ms",
    )).toBe(true);
  });

  it("carries no lag tier for a run that took no input, and no lag reading or line in its diagnostic", () => {
    const rig = makeRig();
    rig.recorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "dataset_added" });
    rig.recorder.noteFrameDispatched(1);
    rig.at(1_020);
    rig.recorder.noteFrameDone(1, 1_020);
    rig.recorder.noteLongTask(1_005, 80);

    const { run, diagnostic } = exportRun(rig);
    expect(run).not.toHaveProperty("lag");
    expect(diagnostic.lag).toBeNull();
    expect(renderDiagnostic(diagnostic).text).not.toMatch(/^lag /m);
  });

  it("leaves unanswered the inputs a replaced render client will never report", () => {
    const rig = makeRig();
    rig.recorder.noteInput("orbit", 1_000);
    rig.recorder.noteFrameDispatched(40);
    // A new client numbers its frames from one again.
    rig.at(1_010);
    rig.recorder.noteInput("orbit", 1_009);
    rig.recorder.noteFrameDispatched(1);
    rig.at(1_030);
    rig.recorder.noteFrameDone(1, 1_030);

    const { run, diagnostic } = exportRun(rig);
    expect(run.lag!.inputs.map((input) => input.presentedUs)).toEqual([null, 30_000]);
    expect(diagnostic.lag!.unanswered).toBe(1);
    expect(diagnostic.lag!.inputToFrame!.samples).toBe(1);
    expect(renderDiagnostic(diagnostic).text).toContain("(n=1 of 2 inputs)");
  });

  it("reads the display interval as the median recent gap between animation frames", () => {
    const rig = makeRig();
    // Jittered stamps as a headless browser draws them: an odd gap of a few
    // milliseconds, a skipped frame, two callbacks on one frame, and an idle
    // stretch that is no refresh at all.
    const gaps = [17.2, 17.6, 2.4, 15.0, 17.4, 34.8, 0, 17.3, 17.5, 17.1, 80];
    let t = 0;
    rig.recorder.noteAnimationFrame(t);
    for (const gap of gaps) rig.recorder.noteAnimationFrame((t += gap));
    rig.recorder.noteInput("pan", 1_000);

    expect(exportRun(rig).run.lag!.displayIntervalUs).toBe(17_300);
  });

  it("states no display interval before enough consecutive animation frames to tell", () => {
    const rig = makeRig();
    for (const t of [0, 16.7, 33.4, 50.1]) rig.recorder.noteAnimationFrame(t);
    rig.recorder.noteInput("pan", 1_000);
    const { run, diagnostic } = exportRun(rig);
    expect(run.lag!.displayIntervalUs).toBeNull();
    expect(diagnostic.lag!.frames.dropped).toBeNull();
    expect(diagnostic.lag!.statement).toContain("dropped frames are not counted");
  });

  it("counts the inputs past its capacity rather than growing", () => {
    const rig = makeRig();
    drag(rig, 1_000, INPUT_CAPACITY + 10);
    const { run, diagnostic } = exportRun(rig);
    expect(run.lag!.inputs).toHaveLength(INPUT_CAPACITY);
    expect(run.lag!.inputsUnrecorded).toBe(10);
    expect(diagnostic.lag!.unrecorded).toBe(10 + 10);
    expect(diagnostic.lag!.statement).toContain("20 record(s) past the lag tier's capacity");
  });
});
