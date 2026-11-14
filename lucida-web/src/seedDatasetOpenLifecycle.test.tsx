// @vitest-environment happy-dom
//
// The seed open must wait for the WebSocket to be OPEN. `Bridge.send` drops
// anything sent while CONNECTING, with no queue or resend, and the hook's
// one-shot guard would latch after a dropped send, so gating on the Bridge
// object's existence loses the open for good.
//
// Drives the real `Bridge` over a controllable mock WebSocket through the same
// `connected` gate the app uses, and asserts: nothing is sent while
// CONNECTING, the open is sent exactly once after OPEN, and a re-render does
// not re-open. Also pins that `send` drops before OPEN and that `onConnected`
// fires on `onopen`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { useSeedDatasetOpens } from "./hooks/useSeedDatasetOpens.ts";

/**
 * Minimal controllable WebSocket stand-in. Starts in CONNECTING; `send` throws
 * before OPEN as a browser does, so a bridge that skips its `readyState` check
 * fails loudly. `flipOpen()` moves it to OPEN and fires `onopen`.
 */
class MockWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  readyState: number = MockWebSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  /** Every frame the bridge handed to `send` while OPEN. */
  readonly sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      // A real browser WebSocket throws InvalidStateError here; surface the
      // same so an early send is unmistakably a bug rather than a no-op.
      throw new Error("INVALID_STATE_ERR: send before OPEN");
    }
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1005, reason: "" });
  }

  /** Test control: complete the handshake. */
  flipOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  static instances: MockWebSocket[] = [];
  static latest(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1);
    if (!ws) throw new Error("no MockWebSocket constructed");
    return ws;
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockWebSocket.instances.length = 0;
});

/** Frames the bridge sent that are `open_remote_dataset` for `url`. */
function openFramesFor(ws: MockWebSocket, url: string): unknown[] {
  return ws.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.type === "open_remote_dataset" && m.url === url);
}

/**
 * Mirrors App.tsx's wiring: the real Bridge flips a `connected` flag from
 * `onConnected`, which gates `useSeedDatasetOpens`. The open goes through the
 * real `bridge.sendOpenRemoteDataset`, so a too-early send would be dropped.
 */
function SeedHarness({ url }: { url: string }) {
  const [connected, setConnected] = useState(false);
  // The bridge identity is stable; keep it in a ref so creating it doesn't
  // trigger a synchronous setState-in-effect. The `connected` state (flipped by
  // the bridge's onConnected) is what re-runs the seed effect.
  const bridgeRef = useRef<Bridge | null>(null);

  useEffect(() => {
    const handlers: Partial<BridgeHandlers> = {
      onSnapshot: () => {},
      onCommand: () => {},
      onAck: () => {},
      onConnected: () => setConnected(true),
    };
    const b = new Bridge(handlers as BridgeHandlers, "ws://test/seed");
    bridgeRef.current = b;
    return () => b.destroy();
  }, []);

  useSeedDatasetOpens({
    seed: { urls: [url], sideBySide: false },
    // The gate is the socket being open, not `Boolean(bridge)`.
    ready: connected,
    openDataset: (u) => bridgeRef.current?.sendOpenRemoteDataset(u),
    viewsForEach: () => [],
  });

  return null;
}

describe("seed dataset open lifecycle (CONNECTING → OPEN)", () => {
  it("does NOT send while CONNECTING, then sends exactly once after OPEN", () => {
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    const url = "/data/sample.ome.zarr";

    act(() => {
      render(<SeedHarness url={url} />);
    });

    const ws = MockWebSocket.latest();
    // The bridge exists but its socket is CONNECTING, so nothing is sent yet.
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    expect(ws.sent).toEqual([]);

    // The socket completes its handshake on a later tick, firing `onopen`.
    act(() => {
      ws.flipOpen();
    });

    // The open reaches the server exactly once, now that the transport carries it.
    const frames = openFramesFor(ws, url);
    expect(frames).toHaveLength(1);
  });

  it("a re-render after OPEN does not re-open (one-shot holds)", () => {
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    const url = "/data/a.zarr";

    let rerender: (ui: React.ReactElement) => void = () => {};
    act(() => {
      const r = render(<SeedHarness url={url} />);
      rerender = r.rerender;
    });

    const ws = MockWebSocket.latest();
    act(() => {
      ws.flipOpen();
    });
    expect(openFramesFor(ws, url)).toHaveLength(1);

    // Force a re-render with the same seed: must not re-send.
    act(() => {
      rerender(<SeedHarness url={url} />);
    });
    expect(openFramesFor(ws, url)).toHaveLength(1);
  });

  it("bridge invariants: send drops before OPEN; onConnected fires on onopen", () => {
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    const onConnected = vi.fn();
    const bridge = new Bridge(
      {
        onSnapshot: () => {},
        onCommand: () => {},
        onAck: () => {},
        onConnected,
      } as unknown as BridgeHandlers,
      "ws://test/invariants",
    );
    const ws = MockWebSocket.latest();

    // Before OPEN a send is dropped by the guard: it must not throw or reach the
    // socket. Without the guard, MockWebSocket.send would throw.
    expect(() => bridge.sendOpenRemoteDataset("/early.zarr")).not.toThrow();
    expect(ws.sent).toEqual([]);
    expect(onConnected).not.toHaveBeenCalled();

    // onopen fires onConnected; later sends reach the socket.
    ws.flipOpen();
    expect(onConnected).toHaveBeenCalledTimes(1);
    bridge.sendOpenRemoteDataset("/ready.zarr");
    expect(openFramesFor(ws, "/ready.zarr")).toHaveLength(1);

    bridge.destroy();
  });
});
