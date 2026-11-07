/**
 * The recorder's cheap reads for a surface that samples at its own cadence:
 * the tick observer, the latest reading, the page-scoped byte totals, and
 * the adapter identity. None of them walks a row or closes anything.
 */

import { describe, expect, it, vi } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import type { TickScratch } from "./tickRing.ts";
import { TickCounter, type GpuIdentity } from "./types.ts";

function makeRecorder() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 5_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
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
  return { recorder, advance: (ms: number) => { clock += ms; } };
}

describe("the tick observer", () => {
  it("hands each committed sample to the listener, one call per dataset", () => {
    const { recorder } = makeRecorder();
    const seen: Array<{ dataset: string; planned: number; target: [number, number] | null; displayed: [number, number] | null }> = [];
    recorder.onTick((sample: TickScratch) => {
      seen.push({
        dataset: sample.datasetId,
        planned: sample.counters[TickCounter.PlannedChunks],
        target: sample.hasTarget ? [sample.targetMin, sample.targetMax] : null,
        displayed: sample.hasDisplayed ? [sample.displayedMin, sample.displayedMax] : null,
      });
    });

    const first = recorder.beginTick("ds-a")!;
    first.counters[TickCounter.PlannedChunks] = 12;
    first.setTargetLevel(2, 2, false);
    first.setDisplayedLevel({ min: 3, max: 3 });
    recorder.commitTick();

    const second = recorder.beginTick("ds-b")!;
    second.counters[TickCounter.PlannedChunks] = 3;
    recorder.commitTick();

    expect(seen).toEqual([
      { dataset: "ds-a", planned: 12, target: [2, 2], displayed: [3, 3] },
      { dataset: "ds-b", planned: 3, target: null, displayed: null },
    ]);
  });

  it("does not fire for a sample that was begun and never committed", () => {
    const { recorder } = makeRecorder();
    const listener = vi.fn();
    recorder.onTick(listener);
    recorder.beginTick("ds");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops after the returned function is called", () => {
    const { recorder } = makeRecorder();
    const listener = vi.fn();
    const stop = recorder.onTick(listener);
    recorder.beginTick("ds");
    recorder.commitTick();
    stop();
    recorder.beginTick("ds");
    recorder.commitTick();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("the latest reading", () => {
  it("is sequence zero before the first reading", () => {
    const { recorder } = makeRecorder();
    expect(recorder.latestReading.seq).toBe(0);
  });

  it("overwrites one object per reading and counts the sequence up", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteReading(4, 2, 5_200, 1_000_000);
    const first = recorder.latestReading;
    expect(first).toMatchObject({
      seq: 1,
      atMs: 1_000,
      queueDepth: 4,
      inFlight: 2,
      frameTimeUs: 5_200,
      residentBytes: 1_000_000,
      gpuPassUs: null,
    });

    advance(16);
    recorder.noteReading(0, 0, 900, 1_000_000, 2_300);
    expect(recorder.latestReading).toBe(first);
    expect(first).toMatchObject({ seq: 2, atMs: 1_016, frameTimeUs: 900, gpuPassUs: 2_300 });
  });
});

describe("the byte totals", () => {
  it("count sends and receives from page load, with or without an interval to record them in", () => {
    const { recorder } = makeRecorder();
    recorder.setEnvironment(null);
    recorder.countSend(0, 120);
    recorder.countReceive(4_096);
    expect(recorder.bytesSent).toBe(120);
    expect(recorder.bytesReceived).toBe(4_096);

    recorder.countSend(1, 30);
    recorder.countReceive(4);
    expect(recorder.bytesSent).toBe(150);
    expect(recorder.bytesReceived).toBe(4_100);
  });
});

describe("the adapter identity", () => {
  it("reads back what the page resolved, and null before that", () => {
    const { recorder } = makeRecorder();
    expect(recorder.gpu).toBeNull();
    const gpu: GpuIdentity = {
      vendor: "vendor",
      architecture: "arch",
      device: "",
      description: "Example Adapter",
      fallback: false,
      timestampQueries: true,
    };
    recorder.setGpu(gpu);
    expect(recorder.gpu).toBe(gpu);
  });
});
