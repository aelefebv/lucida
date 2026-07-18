// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import type { KeyState } from "./useKeyState.ts";
import { useFlyCameraInput } from "./useFlyCameraInput.ts";

class TestKeyState implements KeyState {
  readonly pressed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(key: string, down: boolean): void {
    if (down) this.pressed.add(key);
    else this.pressed.delete(key);
    for (const listener of this.listeners) listener();
  }
}

describe("useFlyCameraInput idle scheduling", () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    callbacks = new Map();
    nextId = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function flush(timestamp = performance.now() + 16): void {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(timestamp);
  }

  it("settles at zero callbacks, runs while a key is held, and stops on release", () => {
    const keys = new TestKeyState();
    const mutate = vi.fn(() => true);
    const low = vi.fn();
    const settle = vi.fn();

    function Harness() {
      useFlyCameraInput(
        { current: {} as WasmScene },
        mutate,
        keys,
        true,
        low,
        settle,
      );
      return null;
    }

    render(<Harness />);
    expect(callbacks.size).toBe(0);

    act(() => keys.set("w", true));
    expect(callbacks.size).toBe(1);
    act(() => flush());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(1);

    act(() => keys.set("w", false));
    expect(callbacks.size).toBe(1);
    act(() => flush());
    expect(settle).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
  });
});
