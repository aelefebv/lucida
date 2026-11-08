/**
 * The lag reading and its rule over fixture runs: dropped frames counted
 * only where an input waited, the window, and which runs the rule judges.
 */

import { describe, expect, it } from "vitest";

import { type TraceInput, type TraceLag, type TraceRun } from "../types.ts";
import { diagnoseRun } from "./diagnose.ts";
import { interactionRunFor, makeRun } from "./fixtures.ts";
import { renderDiagnostic } from "./renderText.ts";
import { RULESET } from "./ruleset.ts";

const MS = 1_000;
const REFRESH_US = 16_700;

function withLag(run: TraceRun, lag: Partial<TraceLag>): TraceRun {
  return {
    ...run,
    lag: {
      inputs: [],
      inputsUnrecorded: 0,
      framesUs: [],
      framesUnrecorded: 0,
      longTasks: [],
      longTasksUnrecorded: 0,
      displayIntervalUs: REFRESH_US,
      ...lag,
    },
  };
}

function input(atMs: number, presentedMs: number | null): TraceInput {
  return {
    kind: "pan",
    atUs: atMs * MS,
    dispatchedUs: presentedMs === null ? null : (atMs + 2) * MS,
    presentedUs: presentedMs === null ? null : presentedMs * MS,
  };
}

/**
 * Inputs every 16 ms, each answered `latencyMs` later, one frame per input.
 * With a latency over 16 ms the next input is already waiting when a frame
 * finishes, which is the case a dropped frame is counted in.
 */
function steadyDrag(moves: number, latencyMs: number): Pick<TraceLag, "inputs" | "framesUs"> {
  const inputs = Array.from({ length: moves }, (_, i) => input(20 + i * 16, 20 + i * 16 + latencyMs));
  return { inputs, framesUs: inputs.map((each) => each.presentedUs!) };
}

describe("the lag reading", () => {
  it("is null on a run that took no input", () => {
    expect(diagnoseRun(interactionRunFor("pan")).lag).toBeNull();
    expect(diagnoseRun(withLag(interactionRunFor("pan"), {})).lag).toBeNull();
  });

  it("counts the refreshes a frame missed while an input waited", () => {
    const drag = steadyDrag(5, 30);
    // The last frame lands 100 ms after the one before: six refreshes, five
    // of them with its input waiting and no new frame.
    const late = 4;
    drag.framesUs[late] = drag.framesUs[late - 1] + 100 * MS;
    drag.inputs[late] = { ...drag.inputs[late], presentedUs: drag.framesUs[late] };
    const lag = diagnoseRun(withLag(interactionRunFor("pan"), drag)).lag!;
    expect(lag.frames).toEqual({ presented: 5, dropped: 5, displayIntervalMs: 16.7 });
  });

  it("counts the refreshes an input that arrived between frames waited through", () => {
    // The main thread blocks: the input lands 10 ms after a frame finished
    // and is drawn 300 ms later. A frame that keeps up takes two refreshes
    // from the input; the other sixteen of the eighteen are drops.
    const inputs = [input(0, 20), input(100, 400)];
    const lag = diagnoseRun(withLag(interactionRunFor("pan"), { inputs, framesUs: [90 * MS, 400 * MS] })).lag!;
    expect(lag.frames.dropped).toBe(16);
  });

  it("drops nothing where input came slower than the display refreshes", () => {
    // An input every 100 ms, each answered 20 ms later: the gaps between
    // frames are long, but no input waited through them.
    const inputs = Array.from({ length: 6 }, (_, i) => input(i * 100, i * 100 + 20));
    const lag = diagnoseRun(
      withLag(interactionRunFor("pan"), { inputs, framesUs: inputs.map((each) => each.presentedUs!) }),
    ).lag!;
    expect(lag.frames.dropped).toBe(0);
    expect(lag.inputToFrame).toEqual({ samples: 6, p50Ms: 20, p95Ms: 20, maxMs: 20 });
  });

  it("reads only the inputs inside a window, and the part of each long task inside it", () => {
    const run = withLag(interactionRunFor("pan"), {
      ...steadyDrag(20, 12),
      longTasks: [{ startUs: 150 * MS, durationUs: 100 * MS }],
    });
    const lag = diagnoseRun(run, { window: { startMs: 200, endMs: 400 } }).lag!;
    expect(lag.inputs).toBe(8);
    expect(lag.longTasks).toEqual({ count: 1, longestMs: 50, totalMs: 50 });
    expect(diagnoseRun(run, { window: { startMs: 600, endMs: 900 } }).lag).toBeNull();
  });
});

describe("the lag rule", () => {
  it("finds a gesture whose p95 fell behind, and leaves the run's attribution to the finding after it", () => {
    const run = withLag(interactionRunFor("orbit", { frameTimeUs: 80 * MS }), steadyDrag(30, 140));
    const doc = diagnoseRun(run);
    const lag = doc.findings.find((finding) => finding.rule === RULESET.lag.id)!;
    expect(lag).toMatchObject({
      severity: "stall",
      subject: "input-to-frame",
      observed: { stat: "p95", ms: 140, n: 30 },
      threshold: { kind: "absolute", value: RULESET.lag.p95.ceilMs, why: RULESET.lag.p95.why },
      attribution: null,
    });
    expect(doc.findings[0].rule).toBe(RULESET.lag.id);
    expect(doc.findings.find((finding) => finding.rule === RULESET.interaction.id)!.attribution).toEqual(
      doc.attribution,
    );
    expect(doc.verdict.text).toMatch(/^orbit lagged: input to frame p95 140 ms over the 100 ms ceiling, across 30 input\(s\)/);
  });

  it("holds a short gesture to the max alone, since its p95 is its slowest input", () => {
    // Seven wheel notches, one held 125 ms: over the p95 ceiling, under the max.
    const notches = steadyDrag(7, 25);
    notches.inputs[2] = { ...notches.inputs[2], presentedUs: notches.inputs[2].atUs + 125 * MS };
    const doc = diagnoseRun(withLag(interactionRunFor("zoom"), notches));
    expect(doc.lag!.inputToFrame!.p95Ms).toBe(125);
    expect(doc.findings.some((finding) => finding.rule === RULESET.lag.id)).toBe(false);

    notches.inputs[2] = { ...notches.inputs[2], presentedUs: notches.inputs[2].atUs + 240 * MS };
    const frozen = diagnoseRun(withLag(interactionRunFor("zoom"), notches));
    expect(frozen.findings.find((finding) => finding.rule === RULESET.lag.id)!.observed).toEqual({
      stat: "max",
      ms: 240,
      n: 7,
    });
  });

  it("reads a breach on a software fallback adapter as a note", () => {
    const run = withLag(interactionRunFor("pan"), steadyDrag(30, 400));
    run.header = { ...run.header, gpu: { ...run.header.gpu!, fallback: true } };
    const doc = diagnoseRun(run);
    const lag = doc.findings.find((finding) => finding.rule === RULESET.lag.id)!;
    expect(lag.severity).toBe("note");
    expect(lag.threshold.why).toContain(RULESET.lag.softwareAdapter);
    expect(doc.verdict.kind).toBe("clear");
  });

  it("judges only an interaction run, so input during a cold open is read and not judged", () => {
    const open = withLag(makeRun({ header: { durationUs: 2_000 * MS } }), steadyDrag(30, 400));
    const doc = diagnoseRun(open);
    expect(doc.lag!.inputToFrame!.p95Ms).toBe(400);
    expect(doc.findings.some((finding) => finding.rule === RULESET.lag.id)).toBe(false);
  });

  it("prints the reading in the summary and the statement at the phases depth", () => {
    const run = withLag(interactionRunFor("pan"), {
      ...steadyDrag(20, 12),
      longTasks: [{ startUs: 100 * MS, durationUs: 60 * MS }],
    });
    const doc = diagnoseRun(run);
    const summary = renderDiagnostic(doc).text;
    expect(summary).toContain(
      "lag       input-to-frame p50 12 ms · p95 12 ms · max 12 ms (n=20) · 1 long task(s), longest 60 ms, 60 ms total · 20 frames, 0 dropped against a 16.7 ms refresh",
    );
    expect(renderDiagnostic(doc, { depth: "phases" }).text).toContain(`LAG  ${doc.lag!.statement}`);
    expect(doc.lag!.statement).toContain("reads up to one display interval low");
  });
});
