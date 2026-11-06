// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { LONG_PRESS_MS, type Gesture } from "./gestures.ts";
import { useTouchGestures } from "./useTouchGestures.ts";

let element: HTMLDivElement;
let gestures: Gesture[];

beforeEach(() => {
  vi.useFakeTimers();
  element = document.createElement("div");
  document.body.appendChild(element);
  gestures = [];
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function bind(options: { enabled?: boolean; claimsPress?: boolean } = {}) {
  return renderHook(() =>
    useTouchGestures(element, options.enabled ?? true, {
      claimsPress: () => options.claimsPress ?? false,
      onGesture: (g) => gestures.push(g),
    }),
  );
}

function pointer(type: string, pointerType: string, id: number, x: number, y: number): PointerEvent {
  const event = new PointerEvent(type, { pointerType, pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe("useTouchGestures", () => {
  it("turns touch pointers into gestures", () => {
    bind();
    pointer("pointerdown", "touch", 1, 100, 100);
    pointer("pointermove", "touch", 1, 140, 100);
    pointer("pointerup", "touch", 1, 140, 100);
    expect(gestures).toEqual([{ type: "drag", x: 140, y: 100, dx: 40, dy: 0 }]);
  });

  it("leaves mouse and pen to the viewer", () => {
    bind();
    for (const kind of ["mouse", "pen"]) {
      pointer("pointerdown", kind, 1, 100, 100);
      pointer("pointermove", kind, 1, 140, 100);
      pointer("pointerup", kind, 1, 140, 100);
    }
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(gestures).toEqual([]);
  });

  it("fires a long press on a timer while the finger holds still", () => {
    bind();
    pointer("pointerdown", "touch", 1, 100, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    expect(gestures).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(gestures).toEqual([{ type: "longPress", x: 100, y: 100 }]);
    pointer("pointerup", "touch", 1, 100, 100);
    expect(gestures).toHaveLength(1);
  });

  it("asks whether to claim the first finger as it lands", () => {
    bind({ claimsPress: true });
    pointer("pointerdown", "touch", 1, 100, 100);
    pointer("pointerdown", "touch", 2, 200, 100);
    expect(gestures).toEqual([{ type: "pressStart", x: 100, y: 100 }, { type: "pressCancel" }]);
  });

  it("keeps the browser's menu off a touch, and on a mouse", () => {
    bind();
    pointer("pointerdown", "touch", 1, 100, 100);
    const duringTouch = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(duringTouch);
    expect(duringTouch.defaultPrevented).toBe(true);
    pointer("pointerup", "touch", 1, 100, 100);
    const fromMouse = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(fromMouse);
    expect(fromMouse.defaultPrevented).toBe(false);
  });

  it("listens to nothing while disabled", () => {
    bind({ enabled: false });
    pointer("pointerdown", "touch", 1, 100, 100);
    pointer("pointermove", "touch", 1, 140, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(gestures).toEqual([]);
  });
});
