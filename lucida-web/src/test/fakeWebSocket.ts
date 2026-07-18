import { vi } from "vitest";

import type { BridgeHandlers } from "../bridge.ts";

/**
 * Browser-shaped WebSocket test transport shared by the bridge suites.
 *
 * It deliberately starts in CONNECTING and throws when `send` is called
 * before OPEN, matching the browser contract closely enough to expose
 * lifecycle mistakes instead of silently accepting them. Closing is kept
 * asynchronous from the test's perspective: suites fire a captured
 * `onclose` callback themselves when the ordering matters.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("INVALID_STATE_ERR: send before OPEN");
    }
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

  /** Compatibility name for tests that emphasize the handshake transition. */
  flipOpen(): void {
    this.open();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no FakeWebSocket constructed");
    return socket;
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
}

export function makeBridgeHandlers(
  overrides: Partial<BridgeHandlers> = {},
): BridgeHandlers {
  return {
    onSnapshot: vi.fn(),
    onCommand: vi.fn(),
    onAck: vi.fn(),
    ...overrides,
  };
}
