// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Bridge, type BridgeHandlers } from "./bridge.ts";

/** Records every socket the bridge opens, so a test can count reconnects. */
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
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function makeHandlers() {
  const onConnected = vi.fn<(generation: number) => void>();
  const onDisconnect = vi.fn<() => void>();
  const handlers: BridgeHandlers = {
    onSnapshot: vi.fn(),
    onCommand: vi.fn(),
    onAck: vi.fn(),
    onConnected,
    onDisconnect,
  };
  return { handlers, onConnected, onDisconnect };
}

function pageTransition(type: "pagehide" | "pageshow", persisted: boolean): void {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

describe("Bridge across the back-forward cache", () => {
  let bridge: Bridge | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    bridge?.destroy();
    bridge = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("leaves the session while the page is cached and rejoins when it comes back", () => {
    const { handlers, onConnected, onDisconnect } = makeHandlers();
    bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    const first = FakeWebSocket.instances[0];
    first.open();

    pageTransition("pagehide", true);

    expect(first.closed).toBe(true);
    expect(onDisconnect).toHaveBeenCalledOnce();
    // Nothing reconnects while it is away, however long that is.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    pageTransition("pageshow", true);

    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(onConnected).toHaveBeenLastCalledWith(2);
  });

  it("leaves when the page freezes and rejoins when it resumes", () => {
    const { handlers, onDisconnect } = makeHandlers();
    bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    FakeWebSocket.instances[0].open();

    document.dispatchEvent(new Event("freeze"));
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(onDisconnect).toHaveBeenCalledOnce();

    document.dispatchEvent(new Event("resume"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("leaves once and rejoins once for a trip through the cache, which also freezes", () => {
    const { handlers, onDisconnect } = makeHandlers();
    bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    FakeWebSocket.instances[0].open();

    pageTransition("pagehide", true);
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
    pageTransition("pageshow", true);

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("keeps the socket through a pagehide the page won't come back from", () => {
    const { handlers, onDisconnect } = makeHandlers();
    bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    FakeWebSocket.instances[0].open();

    pageTransition("pagehide", false);

    expect(FakeWebSocket.instances[0].closed).toBe(false);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("stops listening once destroyed", () => {
    bridge = new Bridge(makeHandlers().handlers, "ws://test/ws/workspaces/w1");
    bridge.destroy();

    pageTransition("pageshow", true);
    document.dispatchEvent(new Event("resume"));

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
