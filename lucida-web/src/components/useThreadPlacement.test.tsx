// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { frameClock, IDLE_AFTER_MS } from "../frameClock.ts";
import { THREAD_GAP, useThreadPlacement } from "./threadPlacement.ts";

function Thread() {
  const ref = useRef<HTMLDivElement>(null);
  useThreadPlacement(ref);
  return (
    <div data-testid="clip">
      <div data-testid="anchor">
        <div ref={ref} data-testid="thread" />
      </div>
    </div>
  );
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

/** Lays out what happy-dom doesn't: the clip box, and a pin at `at`. */
function layOut(at: { x: number; y: number }) {
  const clip = screen.getByTestId("clip");
  const anchor = screen.getByTestId("anchor");
  clip.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  Object.defineProperty(anchor, "offsetParent", { configurable: true, get: () => clip });
  anchor.getBoundingClientRect = () => rect(at.x, at.y, 0, 0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("innerWidth", 1200);
  vi.stubGlobal("innerHeight", 900);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useThreadPlacement", () => {
  it("requests no frames once the view is still, and follows the pin when input wakes it", () => {
    render(<Thread />);
    layOut({ x: 200, y: 300 });
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(50);
    const thread = screen.getByTestId("thread");
    expect(thread.style.left).toBe(`${THREAD_GAP}px`);

    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(frameClock.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // A pin near the right edge flips the thread to its left.
    layOut({ x: 990, y: 300 });
    window.dispatchEvent(new Event("pointermove"));
    expect(frameClock.running).toBe(true);
    vi.advanceTimersByTime(50);
    expect(Number.parseFloat(thread.style.left)).toBeLessThan(0);

    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(frameClock.running).toBe(false);
  });

  it("leaves the clock when the thread closes", () => {
    const { unmount } = render(<Thread />);
    expect(frameClock.running).toBe(true);
    unmount();
    expect(frameClock.running).toBe(false);
  });
});
