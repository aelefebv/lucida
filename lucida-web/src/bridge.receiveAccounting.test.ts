/**
 * Every message the bridge receives is counted on the recorder's page-scoped
 * total at the bytes the socket carried, binary and text alike, and a
 * message that arrives after the bridge is destroyed is not counted, because
 * it is not handled either.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { traceRecorder } from "./trace/recorder.ts";

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

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function makeHandlers(): BridgeHandlers {
  return { onSnapshot: vi.fn(), onCommand: vi.fn(), onAck: vi.fn() };
}

/** A binary chunk message: client id, key length, key, payload. */
function binaryFrame(key: string, payloadBytes: number): ArrayBuffer {
  const keyBytes = new TextEncoder().encode(key);
  const buffer = new ArrayBuffer(6 + keyBytes.length + payloadBytes);
  const view = new DataView(buffer);
  view.setUint16(4, keyBytes.length, true);
  new Uint8Array(buffer, 6, keyBytes.length).set(keyBytes);
  return buffer;
}

describe("Bridge receive accounting", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts binary and text messages at the bytes the socket carried", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const before = traceRecorder.bytesReceived;

    const frame = binaryFrame("ds/img/0/0/0/0/0/0", 4_096);
    ws.onmessage?.({ data: frame });
    expect(traceRecorder.bytesReceived - before).toBe(frame.byteLength);

    const text = JSON.stringify({ type: "presence_update", name: "résumé" });
    ws.onmessage?.({ data: text });
    expect(traceRecorder.bytesReceived - before).toBe(frame.byteLength + new TextEncoder().encode(text).length);

    bridge.destroy();
  });

  it("counts nothing once the bridge is destroyed", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    ws.open();
    bridge.destroy();
    const before = traceRecorder.bytesReceived;
    ws.onmessage?.({ data: binaryFrame("k", 10) });
    ws.onmessage?.({ data: "{}" });
    expect(traceRecorder.bytesReceived).toBe(before);
  });
});
