// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { WasmScene } from "lucida-core";
import type { HeldAction } from "../config/keyBindings.ts";
import type { ViewportCommand } from "../commands.ts";

// The test steps the frame clock by hand, one frame per call.
const frames = vi.hoisted(() => ({ tick: null as null | (() => boolean | void) }));
vi.mock("../frameClock.ts", () => ({
  frameClock: {
    subscribe: (callback: () => boolean | void) => {
      frames.tick = callback;
      return () => {
        frames.tick = null;
      };
    },
  },
}));

import { useFlyCameraInput } from "./useFlyCameraInput.ts";

function pointer(init: { button?: number; movementX?: number; movementY?: number; timeStamp?: number }): PointerEvent {
  return { button: 0, movementX: 0, movementY: 0, timeStamp: 0, pointerId: 1, currentTarget: null, ...init } as unknown as PointerEvent;
}

function setup() {
  const scene = {} as WasmScene;
  const keys = { current: new Set<HeldAction>() };
  const applied: ViewportCommand[] = [];
  const moved = vi.fn<(atMs: number | undefined) => void>();
  const stopped = vi.fn<() => void>();
  const { result } = renderHook(() =>
    useFlyCameraInput(
      { current: scene },
      (_scene, cmd) => applied.push(cmd),
      keys,
      true,
      { moved, stopped },
    ),
  );
  return { keys, applied, moved, stopped, pointers: result.current, frame: () => frames.tick!() };
}

describe("useFlyCameraInput", () => {
  beforeEach(() => {
    frames.tick = null;
  });

  it("moves on every frame a key is held, and says once when the move stops", () => {
    const { keys, applied, moved, stopped, frame } = setup();
    keys.current.add("forward");
    expect(frame()).toBe(true);
    expect(frame()).toBe(true);
    expect(applied.map((cmd) => cmd.type === "fly_tick" && cmd.forward)).toEqual([1, 1]);
    expect(moved.mock.calls).toEqual([[undefined], [undefined]]);

    keys.current.clear();
    expect(frame()).toBe(false);
    expect(frame()).toBe(false);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(2);
  });

  it("looks with a left drag, timed from the first pointer event the frame answers", () => {
    const { applied, moved, stopped, pointers, frame } = setup();
    pointers.onPointerDown(pointer({}));
    pointers.onPointerMove(pointer({ movementX: 4, timeStamp: 120 }));
    pointers.onPointerMove(pointer({ movementX: 6, timeStamp: 128 }));
    frame();
    expect(moved.mock.calls).toEqual([[120]]);
    const look = applied[0];
    expect(look.type === "fly_tick" && look.yaw < 0 && look.pitch === 0).toBe(true);

    frame();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("leaves a right press to the view's menu", () => {
    const { applied, moved, pointers, frame } = setup();
    pointers.onPointerDown(pointer({ button: 2 }));
    pointers.onPointerMove(pointer({ movementX: 10, timeStamp: 50 }));
    frame();
    expect(applied).toHaveLength(0);
    expect(moved).not.toHaveBeenCalled();
  });
});
