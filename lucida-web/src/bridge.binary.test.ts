import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { FakeWebSocket, installFakeWebSocket } from "./test/fakeWebSocket.ts";

function makeFrame(clientId: number, key: string, payload: number[]): ArrayBuffer {
  const encodedKey = new TextEncoder().encode(key);
  const bytes = new Uint8Array(6 + encodedKey.byteLength + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, clientId, true);
  view.setUint16(4, encodedKey.byteLength, true);
  bytes.set(encodedKey, 6);
  bytes.set(payload, 6 + encodedKey.byteLength);
  return bytes.buffer;
}

describe("Bridge binary recipient boundary", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts chunks only after the snapshot and only for this client", () => {
    const onBinary = vi.fn();
    const handlers: BridgeHandlers = {
      onSnapshot: vi.fn(),
      onCommand: vi.fn(),
      onAck: vi.fn(),
      onBinary,
    };
    const bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const ownFrame = makeFrame(7, "ds/image/0/0/0/0/0/0", [1, 2, 3]);
    socket.onmessage?.({ data: ownFrame });
    expect(onBinary).not.toHaveBeenCalled();

    socket.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        seq: 0,
        document: {},
        peers: [],
        your_id: 7,
      }),
    });
    socket.onmessage?.({ data: makeFrame(8, "ds/image/0/0/0/0/0/0", [9]) });
    expect(onBinary).not.toHaveBeenCalled();

    socket.onmessage?.({ data: ownFrame });
    expect(onBinary).toHaveBeenCalledTimes(1);
    expect(onBinary).toHaveBeenCalledWith(
      "ds/image/0/0/0/0/0/0",
      expect.any(ArrayBuffer),
    );

    bridge.destroy();
  });
});
