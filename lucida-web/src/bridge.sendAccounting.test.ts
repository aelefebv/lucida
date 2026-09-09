/**
 * Every message the bridge transmits is counted once, under one client
 * message type, at the bytes the socket carries; a message it drops is not
 * counted at all. Asserted on the trace document the process recorder
 * exports, because that is the artifact the accounting exists for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { emptySendTallies } from "./trace/diagnose/fixtures.ts";
import { traceRecorder, type TraceEnvironment } from "./trace/recorder.ts";
import type { ClientMessageType, SendTallies } from "./trace/types.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  url: string;
  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const ENVIRONMENT: TraceEnvironment = {
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
  }),
};

function makeHandlers(): BridgeHandlers {
  return { onSnapshot: vi.fn(), onCommand: vi.fn(), onAck: vi.fn() };
}

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** The tallies a list of transmitted messages should produce. */
function expectedTallies(frames: [string, ClientMessageType][]): SendTallies {
  const tallies = emptySendTallies();
  for (const [frame, type] of frames) {
    tallies[type].messages += 1;
    tallies[type].bytes += utf8(frame);
  }
  return tallies;
}

/** Close the run the sends landed in and read what it recorded of them. */
function recordedSends(): SendTallies {
  const [run] = traceRecorder.exportDocument().runs;
  return run.sent;
}

describe("Bridge send accounting", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    // A labelled run, so the interval is retained whether or not it sent.
    traceRecorder.setEnvironment(ENVIRONMENT);
    traceRecorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "test" });
  });

  afterEach(() => {
    traceRecorder.reset();
    traceRecorder.setEnvironment(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A bridge on a live socket. Opening transmits nothing on its own. */
  function openBridge(): { bridge: Bridge; ws: FakeWebSocket } {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(ws.sent).toHaveLength(0);
    return { bridge, ws };
  }

  it("counts each public send under its own type, once, at the message's UTF-8 length", () => {
    const { bridge, ws } = openBridge();

    const sends: [() => void, ClientMessageType][] = [
      [() => bridge.sendCommand(JSON.stringify({ type: "rename_dataset", name: "résumé" })), "command"],
      [() => bridge.sendPresence(JSON.stringify({ camera: { zoom: 1.5 } })), "presence"],
      [() => bridge.sendViewerInterest({ mode: "slice" }), "viewerInterest"],
      [() => bridge.sendCursor(null), "cursor"],
      [() => bridge.sendFollow(null), "other"],
      [() => bridge.sendOpenRemoteDataset("https://example.test/set.zarr"), "other"],
      [() => bridge.sendDatasetRetry("ds-1"), "other"],
      [() => bridge.send(JSON.stringify({ type: "request_snapshot" })), "other"],
      [() => bridge.send(JSON.stringify({ type: "chunk_request", rid: 7, dataset_id: "d", image_id: "i", key: "0/0/0/0/0/0" })), "chunkRequest"],
      [() => bridge.send(JSON.stringify({ type: "asset_request", rid: 8, dataset_id: "d", entity_id: "e", kind: "k", t: 0, c: 0 })), "assetRequest"],
    ];

    const frames: [string, ClientMessageType][] = [];
    for (const [send, type] of sends) {
      const before = ws.sent.length;
      send();
      expect(ws.sent.length, "one message per send").toBe(before + 1);
      frames.push([ws.sent[before], type]);
    }

    expect(recordedSends()).toEqual(expectedTallies(frames));
  });

  it("counts throttled sends when they go out, not when they are asked for", () => {
    const { bridge, ws } = openBridge();

    bridge.sendDatasetPresence(JSON.stringify({ dataset_id: "ds-1" }));
    bridge.sendCursor([1, 2]);
    expect(ws.sent).toHaveLength(0);

    vi.advanceTimersByTime(5_000);

    expect(ws.sent).toHaveLength(2);
    const datasetPresence = ws.sent.find((frame) => frame.startsWith('{"type":"dataset_presence"'));
    const cursor = ws.sent.find((frame) => frame.startsWith('{"type":"cursor"'));
    expect(datasetPresence).toBeDefined();
    expect(cursor).toBeDefined();
    expect(recordedSends()).toEqual(
      expectedTallies([
        [datasetPresence!, "datasetPresence"],
        [cursor!, "cursor"],
      ]),
    );
  });

  it("counts nothing for a message dropped on a socket that is not open", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];

    bridge.sendCursor(null);
    expect(ws.sent).toHaveLength(0);
    expect(recordedSends()).toEqual(emptySendTallies());
  });

  it("counts nothing after destroy", () => {
    const { bridge, ws } = openBridge();
    bridge.destroy();

    bridge.sendCursor(null);
    expect(ws.sent).toHaveLength(0);
    expect(recordedSends()).toEqual(emptySendTallies());
  });
});
