/**
 * The page's end of the watch stream (#1068): what a toggled-on session
 * publishes, and what it never publishes.
 *
 * Driven against a real `TraceRecorder` rather than a stubbed one, because
 * the claims worth testing are about the recording: that an aggregate carries
 * the newest sample per dataset since the previous one, that a run's edges
 * arrive with the end reason a poll could not have seen, and that no
 * lifecycle row reaches the wire from a run that is full of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import {
  Boundary,
  ClientMessageTypeIndex,
  CountedPhaseIndex,
  TickCounter,
  type ChunkRowSource,
  type RunConditions,
} from "./types.ts";
import { WatchStream, type WatchItem } from "./watchStream.ts";

const OPEN_CAUSE = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" } as const;
const ORBIT_CAUSE = { epoch: "view", dirtyKind: "interactive", source: "orbit" } as const;

const CONDITIONS: RunConditions = {
  datasetIds: ["ds-a"],
  composedView: { url: "/w/ws-1", mode: "volume" },
  devicePixelRatio: 2,
  viewport: { cssWidth: 1600, cssHeight: 1000, deviceWidth: 3200, deviceHeight: 2000 },
};

const CHUNK: ChunkRowSource = {
  datasetId: "ds-a",
  entityId: "member-1",
  imageId: "image-1",
  lane: "detail",
  level: 1,
  t: 0,
  c: 0,
  z: 0,
  y: 2,
  x: 3,
};

const EPOCH_MS = 1_700_000_000_000;

function harness() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => EPOCH_MS,
    quiescenceHoldMs: 500,
    timeoutMs: 60_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0,
      detailBytes: 0,
      coarseChunks: 0,
      coarseBytes: 0,
      proxyBytes: 0,
    }),
    captureConditions: () => CONDITIONS,
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
      speculativePending: 0,
      speculativeInFlight: 0,
      desiredDetailChunks: 0,
      residentDetailChunks: 0,
      desiredCoarseChunks: 0,
      residentCoarseChunks: 0,
    }),
  });

  const sent: WatchItem[] = [];
  const transport = {
    send: (json: string) => {
      const frame = JSON.parse(json) as { type: string; item: WatchItem };
      expect(frame.type).toBe("watch_publish");
      sent.push(frame.item);
    },
  };
  const stream = new WatchStream({
    recorder,
    now: () => EPOCH_MS + clock,
    aggregateMs: 250,
    provisionalMs: 1_000,
  });

  /** Move both clocks: the recorder's own, and the one the timers run on. */
  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  const plan = (datasetId: string, planned: number) => {
    const tick = recorder.beginTick(datasetId);
    tick!.counters[TickCounter.LaneDetail] = planned;
    for (let i = 0; i < planned; i++) tick!.addPlanned(1);
    recorder.commitTick();
  };

  return { recorder, stream, transport, sent, advance, plan };
}

const kinds = (items: WatchItem[]) => items.map((item) => item.kind);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the toggle", () => {
  it("is off until somebody turns it on, and publishes nothing while it is off", () => {
    const { stream, transport, sent, advance, plan } = harness();
    stream.attach(transport);

    plan("ds-a", 4);
    advance(1_000);

    expect(stream.on).toBe(false);
    expect(sent).toEqual([]);
  });

  it("refuses to start with no connection to publish over", () => {
    const { stream, sent } = harness();
    stream.start();
    expect(stream.state).toEqual({ on: false, attached: false });
    expect(sent).toEqual([]);
  });

  it("opens with its own boundary, naming the run in progress", () => {
    const { recorder, stream, transport, sent } = harness();
    recorder.openRun(ORBIT_CAUSE);
    stream.attach(transport);
    stream.start();

    expect(stream.on).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "boundary",
      event: "watch_started",
      cause: ORBIT_CAUSE,
      end_reason: null,
    });
  });

  it("says so before it stops, and then goes quiet", () => {
    const { stream, transport, sent, advance, plan } = harness();
    stream.attach(transport);
    stream.start();
    stream.stop();

    expect(stream.on).toBe(false);
    expect(kinds(sent)).toEqual(["boundary", "boundary"]);
    expect(sent[1]).toMatchObject({ kind: "boundary", event: "watch_stopped" });

    plan("ds-a", 4);
    advance(1_000);
    expect(sent).toHaveLength(2);
  });

  /**
   * The server forgot the publisher when the connection dropped, so a page
   * that resumed on its own would be pushing without anyone having asked on
   * the new socket.
   */
  it("is off again after a reconnect", () => {
    const { stream, transport, sent, advance, plan } = harness();
    stream.attach(transport);
    stream.start();
    expect(stream.on).toBe(true);

    stream.detach();
    expect(stream.on).toBe(false);
    stream.attach(transport);
    expect(stream.on).toBe(false);

    const before = sent.length;
    plan("ds-a", 4);
    advance(1_000);
    expect(sent).toHaveLength(before);
  });

  it("tells a surface when it changes, so the toggle can be shown while it is on", () => {
    const { stream, transport } = harness();
    const seen: string[] = [];
    stream.subscribe((state) => seen.push(`${state.on ? "on" : "off"}/${state.attached ? "socket" : "none"}`));

    stream.attach(transport);
    stream.start();
    stream.stop();
    stream.detach();

    expect(seen).toEqual(["off/socket", "on/socket", "off/socket", "off/none"]);
  });
});

describe("aggregates", () => {
  it("carries the newest planning sample per dataset and the newest reading", () => {
    const { recorder, stream, transport, sent, advance, plan } = harness();
    recorder.openRun(OPEN_CAUSE);
    stream.attach(transport);
    stream.start();

    advance(50);
    plan("ds-a", 4);
    plan("ds-b", 2);
    advance(50);
    plan("ds-a", 9);
    recorder.noteReading(1_204, 12, 16_700, 5_000_000_000, 2_100);
    advance(150);

    const aggregates = sent.filter((item) => item.kind === "aggregate");
    expect(aggregates).toHaveLength(1);
    const [aggregate] = aggregates;
    expect(aggregate.run_id).toMatch(/^run-/);
    expect(aggregate.reading).toMatchObject({ queueDepth: 1_204, gpuPassUs: 2_100 });
    expect(aggregate.ticks.map((tick) => [tick.datasetId, tick.counters.laneDetail])).toEqual([
      ["ds-a", 9],
      ["ds-b", 2],
    ]);
  });

  it("carries each sample once, so two aggregates never repeat a tick", () => {
    const { recorder, stream, transport, sent, advance, plan } = harness();
    recorder.openRun(OPEN_CAUSE);
    stream.attach(transport);
    stream.start();

    advance(50);
    plan("ds-a", 4);
    advance(250);
    plan("ds-a", 7);
    advance(250);

    const aggregates = sent.filter((item) => item.kind === "aggregate");
    expect(aggregates).toHaveLength(2);
    expect(aggregates.map((item) => item.ticks.map((tick) => tick.counters.laneDetail))).toEqual([
      [4],
      [7],
    ]);
  });

  /** Four empty frames a second would be a stream of the instrument's own traffic. */
  it("says nothing while the page has nothing to report", () => {
    const { recorder, stream, transport, sent, advance } = harness();
    recorder.openRun(OPEN_CAUSE);
    stream.attach(transport);
    stream.start();

    advance(900);

    expect(sent.filter((item) => item.kind === "aggregate")).toEqual([]);
  });

  /**
   * The counted phases and the send tallies describe what happened *between*
   * passes, so a dropped pass would take its bytes with it and quietly
   * understate the send accounting the whole send-side story rests on.
   */
  it("sums what happened between the passes it dropped", () => {
    const { recorder, stream, transport, sent, advance } = harness();
    recorder.openRun(OPEN_CAUSE);
    stream.attach(transport);
    stream.start();

    for (let pass = 0; pass < 4; pass++) {
      advance(10);
      recorder.countSend(ClientMessageTypeIndex.ChunkRequest, 100);
      recorder.countPhase(CountedPhaseIndex.CacheAdmission, 3);
      recorder.beginTick("ds-a");
      recorder.commitTick();
    }
    advance(250);

    const [aggregate] = sent.filter((item) => item.kind === "aggregate");
    expect(aggregate.ticks).toHaveLength(1);
    expect(aggregate.sent.chunkRequest).toEqual({ messages: 4, bytes: 400 });
    expect(aggregate.counted["cache-admission"]).toBe(12);
  });

  /** Turning the toggle on mid-run must not put the tick ring's history into one message. */
  it("does not replay what happened before it was switched on", () => {
    const { recorder, stream, transport, sent, advance, plan } = harness();
    recorder.openRun(OPEN_CAUSE);
    advance(50);
    for (let i = 0; i < 20; i++) plan("ds-a", i);

    stream.attach(transport);
    stream.start();
    advance(250);
    expect(sent.filter((item) => item.kind === "aggregate")).toEqual([]);

    plan("ds-a", 99);
    advance(250);
    const aggregates = sent.filter((item) => item.kind === "aggregate");
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].ticks.map((tick) => tick.counters.laneDetail)).toEqual([99]);
  });

  /**
   * A run's opening lands in the interval the previous cadence did not cover,
   * so the handover reads the new interval from its start rather than from
   * now.
   */
  it("carries a run's first passes across the handover into it", () => {
    const { recorder, stream, transport, sent, advance, plan } = harness();
    stream.attach(transport);
    stream.start();
    advance(250);

    recorder.openRun(ORBIT_CAUSE);
    plan("ds-a", 6);
    advance(250);

    const aggregates = sent.filter((item) => item.kind === "aggregate");
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].run_id).toMatch(/^run-/);
    expect(aggregates[0].ticks.map((tick) => tick.counters.laneDetail)).toEqual([6]);
  });
});

describe("run boundaries", () => {
  it("names a run's opening and its end, with the reason a poll could not see", () => {
    const { recorder, stream, transport, sent } = harness();
    stream.attach(transport);
    stream.start();

    recorder.openRun(ORBIT_CAUSE);
    recorder.closeRun("timeout");

    const boundaries = sent.filter((item) => item.kind === "boundary");
    expect(boundaries.map((item) => item.event)).toEqual([
      "watch_started",
      "run_opened",
      "run_closed",
    ]);
    expect(boundaries[1]).toMatchObject({ cause: ORBIT_CAUSE, end_reason: null, duration_us: null });
    expect(boundaries[2]).toMatchObject({ cause: ORBIT_CAUSE, end_reason: "timeout" });
    expect(boundaries[2].run_id).toBe(boundaries[1].run_id);
    expect(boundaries[2].duration_us).toBeGreaterThanOrEqual(0);
  });

  /** The unlabelled steady-state interval has no cause to name. */
  it("says nothing about the steady-state interval's own edges", () => {
    const { recorder, stream, transport, sent } = harness();
    recorder.openRun(ORBIT_CAUSE);
    stream.attach(transport);
    stream.start();

    recorder.closeRun("quiescent");

    expect(sent.filter((item) => item.kind === "boundary").map((item) => item.event)).toEqual([
      "watch_started",
      "run_closed",
    ]);
  });

  it("stops listening once the toggle is off", () => {
    const { recorder, stream, transport, sent } = harness();
    stream.attach(transport);
    stream.start();
    stream.stop();

    recorder.openRun(ORBIT_CAUSE);
    expect(kinds(sent)).toEqual(["boundary", "boundary"]);
  });
});

describe("provisional readings", () => {
  it("goes out on its own interval while a run is open, labelled provisional", () => {
    const { recorder, stream, transport, sent, advance } = harness();
    recorder.openRun(ORBIT_CAUSE);
    stream.attach(transport);
    stream.start();

    advance(2_100);

    const readings = sent.filter((item) => item.kind === "provisional");
    expect(readings).toHaveLength(2);
    expect(readings[0].provisional_reading.provisional).toBe(true);
    expect(readings[0].provisional_reading.statement).toMatch(/^provisional/i);
    expect(readings[0].provisional_reading).not.toHaveProperty("verdict");
  });

  it("says nothing between runs, where there is nothing to read", () => {
    const { stream, transport, sent, advance } = harness();
    stream.attach(transport);
    stream.start();

    advance(2_100);

    expect(sent.filter((item) => item.kind === "provisional")).toEqual([]);
  });
});

/**
 * No item kind a lifecycle row could ride in, and an aggregate's finest grain
 * is a dataset.
 */
describe("what never streams", () => {
  it("carries no lifecycle row from a run that is made of them", () => {
    const { recorder, stream, transport, sent, advance, plan } = harness();
    recorder.openRun(OPEN_CAUSE);
    stream.attach(transport);
    stream.start();

    for (let i = 0; i < 40; i++) {
      const handle = recorder.beginChunkRow({ ...CHUNK, x: i }, 0);
      recorder.stamp(handle, Boundary.WireStart);
    }
    advance(50);
    plan("ds-a", 40);
    recorder.noteReading(40, 40, 16_000, 1_000);
    advance(200);
    advance(1_000);
    recorder.closeRun("quiescent");

    expect(sent.length).toBeGreaterThan(3);
    const json = JSON.stringify(sent);
    for (const rowField of [
      '"chunkKey"',
      '"entityId"',
      '"imageId"',
      '"residencyTier"',
      '"outcome"',
    ]) {
      expect(json).not.toContain(rowField);
    }
    for (const item of sent) {
      expect(["aggregate", "boundary", "provisional"]).toContain(item.kind);
      if (item.kind === "aggregate") {
        for (const tick of item.ticks) expect(tick).not.toHaveProperty("chunkKey");
      }
    }
  });
});
