/**
 * The bridge reads a chunk frame's envelope and hands the fetch pipeline its
 * key, payload, codec list and planes, laid out as
 * `lucida_protocol::codec::encode_chunk_frame` writes them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Bridge } from "./bridge.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const ENCODED = 0x8000;
const PLANES = 0x4000;

/** A frame with `flags` on its key length and `extra` between key and payload. */
function frame(key: string, flags: number, extra: number[], payload: number[]): ArrayBuffer {
  const keyBytes = new TextEncoder().encode(key);
  const out = new Uint8Array(6 + keyBytes.length + extra.length + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 9, true);
  view.setUint16(4, keyBytes.length | flags, true);
  out.set(keyBytes, 6);
  out.set(extra, 6 + keyBytes.length);
  out.set(payload, 6 + keyBytes.length + extra.length);
  return out.buffer;
}

describe("Bridge chunk frames", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function receive(data: ArrayBuffer) {
    const onBinary = vi.fn();
    new Bridge({ onSnapshot: vi.fn(), onCommand: vi.fn(), onAck: vi.fn(), onBinary }, "ws://test/ws");
    FakeWebSocket.instances[0].onmessage?.({ data });
    return onBinary;
  }

  const key = "ds/img/0/0/0/1/0/0";

  it("hands a whole decoded chunk over as it always has", () => {
    const onBinary = receive(frame(key, 0, [], [1, 2]));
    expect(onBinary).toHaveBeenCalledWith(key, expect.any(ArrayBuffer), null, null);
    expect([...new Uint8Array(onBinary.mock.calls[0][1])]).toEqual([1, 2]);
  });

  it("reads a plane frame's planes, and its codecs after them", () => {
    const planes = [3, 0, 0, 0, 5, 0, 0, 0];
    const onBinary = receive(frame(key, PLANES | ENCODED, [...planes, 1, 4], [7, 8]));
    const [gotKey, payload, codecs, gotPlanes] = onBinary.mock.calls[0];
    expect(gotKey).toBe(key);
    expect([...new Uint8Array(payload)]).toEqual([7, 8]);
    expect([...codecs]).toEqual([4]);
    expect(gotPlanes).toEqual([3, 5]);
  });

  it("drops a plane frame cut short before its planes end", () => {
    const onBinary = receive(frame(key, PLANES, [3, 0, 0, 0, 5], []));
    expect(onBinary).not.toHaveBeenCalled();
  });
});
