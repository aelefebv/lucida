// @vitest-environment happy-dom
//
// Lifecycle regression test for the #697 seed-open race: the seed open must be
// sent ONLY when the WebSocket transport is GENUINELY ready (OPEN), and must
// not be silently dropped against a still-CONNECTING socket.
//
// The original bug: `useSeedDatasetOpens` was gated on `Boolean(bridge.bridge)`,
// which flips true SYNCHRONOUSLY when the Bridge is constructed — while its
// WebSocket is still CONNECTING. `Bridge.send` drops anything sent before OPEN
// (no queue, no resend), and the hook latched its one-shot guard after that
// premature send, so the open never reached the server and never retried.
//
// This test drives the REAL `Bridge` over a controllable mock WebSocket so the
// CONNECTING→OPEN transition is explicit, wires it to `useSeedDatasetOpens`
// through the SAME readiness gate the app now uses (a `connected` flag flipped
// by the bridge's `onConnected`/`onopen`), and asserts:
//   - while CONNECTING: nothing is sent (no silent drop, the hook waits);
//   - after OPEN: the open frame is sent EXACTLY ONCE and reaches the socket;
//   - a re-render after open does not re-open (one-shot holds).
// It also pins the bridge-level invariants the fix relies on: `send` drops
// before OPEN, and `onConnected` fires on `onopen`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { useSeedDatasetOpens } from "./hooks/useSeedDatasetOpens.ts";
import { FakeWebSocket, installFakeWebSocket } from "./test/fakeWebSocket.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeWebSocket.reset();
});

/** Frames the bridge sent that are `open_remote_dataset` for `url`. */
function openFramesFor(ws: FakeWebSocket, url: string): unknown[] {
  return ws.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.type === "open_remote_dataset" && m.url === url);
}

/**
 * Harness that mirrors App.tsx's wiring: construct the real Bridge, flip a
 * `connected` flag from the bridge's `onConnected` (the readiness signal the
 * fix added), and gate `useSeedDatasetOpens` on it. The seed open is issued via
 * the real `bridge.sendOpenRemoteDataset` — the exact path App uses — so a send
 * that fires too early hits the CONNECTING socket and is dropped by `Bridge.send`.
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
    initialDatasetUrls: [url],
    // The REAL gate: WS open, not merely `Boolean(bridge)`.
    ready: connected,
    openDataset: (u) => bridgeRef.current?.sendOpenRemoteDataset(u),
  });

  return null;
}

describe("seed dataset open lifecycle (CONNECTING → OPEN), #697 race", () => {
  it("does NOT send while CONNECTING, then sends exactly once after OPEN", () => {
    installFakeWebSocket();
    const url = "/data/sample.ome.zarr";

    act(() => {
      render(<SeedHarness url={url} />);
    });

    const ws = FakeWebSocket.latest();
    // The bridge object exists and its socket is CONNECTING — the OLD gate
    // (`Boolean(bridge)`) would have fired the open here, into a socket that
    // drops it. The real gate keeps it pending: nothing sent yet.
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(ws.sent).toEqual([]);

    // Socket completes its handshake on a later tick → `onopen` → `connected`.
    act(() => {
      ws.flipOpen();
    });

    // The open reaches the server exactly once, now that the transport carries it.
    const frames = openFramesFor(ws, url);
    expect(frames).toHaveLength(1);
  });

  it("a re-render after OPEN does not re-open (one-shot holds)", () => {
    installFakeWebSocket();
    const url = "/data/a.zarr";

    let rerender: (ui: React.ReactElement) => void = () => {};
    act(() => {
      const r = render(<SeedHarness url={url} />);
      rerender = r.rerender;
    });

    const ws = FakeWebSocket.latest();
    act(() => {
      ws.flipOpen();
    });
    expect(openFramesFor(ws, url)).toHaveLength(1);

    // Force a re-render with the same seed — must not re-send.
    act(() => {
      rerender(<SeedHarness url={url} />);
    });
    expect(openFramesFor(ws, url)).toHaveLength(1);
  });

  it("bridge invariants: send drops before OPEN; onConnected fires on onopen", () => {
    installFakeWebSocket();
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
    const ws = FakeWebSocket.latest();

    // Before OPEN: a send is silently dropped (guarded) — it must NOT throw and
    // must NOT reach the socket. (If the guard regressed, FakeWebSocket.send
    // would throw INVALID_STATE_ERR.)
    expect(() => bridge.sendOpenRemoteDataset("/early.zarr")).not.toThrow();
    expect(ws.sent).toEqual([]);
    expect(onConnected).not.toHaveBeenCalled();

    // onopen → onConnected fires; subsequent sends now reach the socket.
    ws.flipOpen();
    expect(onConnected).toHaveBeenCalledTimes(1);
    bridge.sendOpenRemoteDataset("/ready.zarr");
    expect(openFramesFor(ws, "/ready.zarr")).toHaveLength(1);

    bridge.destroy();
  });
});
