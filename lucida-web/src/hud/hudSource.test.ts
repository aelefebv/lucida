/**
 * The source reads the real recorder through its cheap seams and a fake
 * cache, and produces the sample the model expects.
 */

import { describe, expect, it } from "vitest";

import { fakeCache, makeRecorder, MIB } from "./hudFixtures.ts";
import { emptyLaneOutstanding, HudSource } from "./hudSource.ts";
import { createQuiescenceState, evaluateQuiescence } from "../trace/quiescence.ts";
import { TickCounter } from "../trace/types.ts";

describe("HudSource", () => {
  it("gathers the recorder's reads and the cache's into one sample", () => {
    const { recorder, now, advance } = makeRecorder();
    const cache = fakeCache();
    const source = new HudSource({
      recorder,
      now,
      getCache: () => cache,
      datasetName: (id) => `${id}.zarr`,
    });
    source.start();

    recorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "test" });
    const a = recorder.beginTick("ds-a")!;
    a.counters[TickCounter.PlannedChunks] = 4;
    a.setTargetLevel(2, 2, true);
    a.setDisplayedLevel({ min: 3, max: 4 });
    recorder.commitTick();
    recorder.beginTick("ds-b");
    recorder.commitTick();

    recorder.countSend(0, 100);
    recorder.countReceive(50_000);
    advance(16);
    recorder.noteReading(7, 3, 4_500, 6 * MIB, 1_200);
    recorder.noteQuiescence(
      evaluateQuiescence(Object.assign(createQuiescenceState(), { inFlight: 3 }), now()),
    );

    const sample = source.sample();
    expect(sample).toMatchObject({
      atMs: 1_016,
      bytesSent: 100,
      bytesReceived: 50_000,
      reading: { seq: 1, frameTimeUs: 4_500, gpuPassUs: 1_200 },
      quiescence: { quiescent: false, reason: "chunks_in_flight" },
      runOpen: true,
      gpu: null,
    });
    expect(sample.levels).toEqual([
      { datasetId: "ds-a", name: "ds-a.zarr", target: { min: 2, max: 2 }, pinned: true, displayed: { min: 3, max: 4 } },
      { datasetId: "ds-b", name: "ds-b.zarr", target: null, pinned: false, displayed: null },
    ]);
    expect(sample.lanes?.inFlight.detail).toBe(3);
    expect(sample.lanes?.pending.prefetch).toBe(7);
    expect(sample.pools?.main.bytes).toBe(5 * MIB);
    expect(cache.calls).toBe(1);
    source.dispose();
  });

  it("keeps a dataset's last levels across ticks that did not plan it, and prunes closed datasets", () => {
    const { recorder, now } = makeRecorder();
    const source = new HudSource({ recorder, now, getCache: () => null });
    source.start();

    recorder.beginTick("ds-a")!.setTargetLevel(1, 1, false);
    recorder.commitTick();
    recorder.beginTick("ds-b")!.setTargetLevel(0, 0, false);
    recorder.commitTick();
    recorder.beginTick("ds-b")!.setTargetLevel(2, 2, false);
    recorder.commitTick();

    expect(source.sample().levels.map((l) => [l.datasetId, l.target?.min])).toEqual([["ds-a", 1], ["ds-b", 2]]);
    expect(source.sample(new Set(["ds-b"])).levels.map((l) => l.datasetId)).toEqual(["ds-b"]);
    source.dispose();
  });

  it("reads null for the reading, quiescence, lanes, and pools before there is anything to read", () => {
    const { recorder, now } = makeRecorder();
    const source = new HudSource({ recorder, now, getCache: () => null });
    const sample = source.sample();
    expect(sample.reading).toBeNull();
    expect(sample.quiescence).toBeNull();
    expect(sample.lanes).toBeNull();
    expect(sample.pools).toBeNull();
    expect(sample.levels).toEqual([]);
    expect(sample.runOpen).toBe(false);
  });

  it("stops watching once disposed", () => {
    const { recorder, now } = makeRecorder();
    const source = new HudSource({ recorder, now, getCache: () => null });
    source.start();
    source.dispose();
    recorder.beginTick("ds-a");
    recorder.commitTick();
    expect(source.sample().levels).toEqual([]);
  });

  it("starts a lane tally at zero for every lane", () => {
    const tally = emptyLaneOutstanding();
    expect(Object.values(tally.inFlight).every((n) => n === 0)).toBe(true);
    expect(Object.keys(tally.pending).sort()).toEqual(["coarse", "detail", "minimap", "overview", "prefetch"]);
  });
});
