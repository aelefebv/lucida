import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Bridge, type BridgeHandlers } from "./bridge.ts";

/**
 * Stand-in transport: records constructed sockets so the tests can count
 * (re)connect attempts, and exposes the event handlers for manual firing.
 */
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
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function makeHandlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers {
  return {
    onSnapshot: vi.fn(),
    onCommand: vi.fn(),
    onAck: vi.fn(),
    ...overrides,
  };
}

describe("Bridge.destroy", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects after a transport drop while alive (baseline)", () => {
    new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(2500);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("closes the socket and never reconnects after destroy", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];

    bridge.destroy();
    expect(ws.closed).toBe(true);

    // The browser fires `onclose` asynchronously after `close()`; the
    // destroyed bridge must not schedule a reconnect off it.
    ws.onclose?.();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("cancels an already-scheduled reconnect", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");

    FakeWebSocket.instances[0].onclose?.(); // arms the ~2s reconnect timer
    bridge.destroy();
    vi.advanceTimersByTime(10_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("is idempotent — double destroy is safe", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    bridge.destroy();
    expect(() => bridge.destroy()).not.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects pending dataset-health requests so callers settle", async () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    FakeWebSocket.instances[0].open();

    const pending = bridge.requestDatasetHealth();
    bridge.destroy();

    await expect(pending).rejects.toThrow("Bridge destroyed");
  });

  it("detaches the socket's event handlers on destroy", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    ws.open();

    bridge.destroy();

    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.onerror).toBeNull();
  });

  it("drops event tasks already in flight when destroy runs — no handler fires", () => {
    const handlers = makeHandlers({
      onConnected: vi.fn(),
      onDisconnect: vi.fn(),
      onWorkspaceArchived: vi.fn(),
    });
    const bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);

    // Capture the callbacks as attached: an event task dequeued before
    // destroy() nulls the fields still invokes the original functions,
    // so the `destroyed` gate inside each one must hold on its own.
    const onopen = ws.onopen!;
    const onmessage = ws.onmessage!;
    const onclose = ws.onclose!;

    bridge.destroy();

    onmessage({
      data: JSON.stringify({ type: "workspace_archived", workspace_id: "w1" }),
    });
    onmessage({
      data: JSON.stringify({ type: "snapshot", seq: 1, document: {}, peers: [], your_id: 7 }),
    });
    onclose();
    onopen();
    vi.advanceTimersByTime(10_000);

    expect(handlers.onWorkspaceArchived).not.toHaveBeenCalled();
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onDisconnect).not.toHaveBeenCalled();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1); // only the pre-destroy open
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect either
  });

  it("a CONNECTING socket completing after destroy does not report connected", () => {
    const handlers = makeHandlers({ onConnected: vi.fn() });
    const bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    const onopen = ws.onopen!;

    bridge.destroy();
    onopen();

    expect(handlers.onConnected).not.toHaveBeenCalled();
  });

  it("never transmits after destroy", () => {
    const bridge = new Bridge(makeHandlers(), "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[0];
    ws.open();
    bridge.sendFollow(3);
    expect(ws.sent).toHaveLength(1);

    bridge.destroy();
    ws.readyState = FakeWebSocket.OPEN; // even an OPEN-looking socket gets nothing
    bridge.send(JSON.stringify({ type: "cursor", position: null }));
    bridge.sendCommand(JSON.stringify({ kind: "noop" }));
    bridge.sendFollow(null);

    expect(ws.sent).toHaveLength(1);
  });
});
