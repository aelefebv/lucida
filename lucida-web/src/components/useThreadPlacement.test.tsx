// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { frameClock, IDLE_AFTER_MS } from "../frameClock.ts";
import { THREAD_GAP, useThreadPlacement } from "./threadPlacement.ts";

/** A thread drawn in a host away from its pin's anchor, as it draws over the controls. */
function Thread() {
  const [thread, setThread] = useState<HTMLDivElement | null>(null);
  const [mark, setMark] = useState<HTMLSpanElement | null>(null);
  useThreadPlacement(thread, mark);
  return (
    <>
      <div data-testid="clip">
        <div data-testid="anchor">
          <span ref={setMark} />
        </div>
      </div>
      <div data-testid="host">
        <div ref={setThread} data-testid="thread" />
      </div>
    </>
  );
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

function offsetParent(element: HTMLElement, parent: () => Element | null) {
  Object.defineProperty(element, "offsetParent", { configurable: true, get: parent });
}

/** Lays out what happy-dom doesn't: the clip box, a pin at `at`, and the thread's host at `host`. */
function layOut(at: { x: number; y: number }, host = { x: 0, y: 0 }) {
  const clip = screen.getByTestId("clip");
  const anchor = screen.getByTestId("anchor");
  const hostElement = screen.getByTestId("host");
  clip.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  offsetParent(anchor, () => clip);
  anchor.getBoundingClientRect = () => rect(at.x, at.y, 0, 0);
  offsetParent(screen.getByTestId("thread"), () => hostElement);
  hostElement.getBoundingClientRect = () => rect(host.x, host.y, 1200, 900);
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
    expect(thread.style.left).toBe(`${200 + THREAD_GAP}px`);

    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(frameClock.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // A pin near the right edge flips the thread to its left.
    layOut({ x: 990, y: 300 });
    window.dispatchEvent(new Event("pointermove"));
    expect(frameClock.running).toBe(true);
    vi.advanceTimersByTime(50);
    expect(Number.parseFloat(thread.style.left)).toBeLessThan(990);

    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(frameClock.running).toBe(false);
  });

  it("places the thread in its host's coordinates, wherever it draws", () => {
    render(<Thread />);
    layOut({ x: 200, y: 300 }, { x: 300, y: 40 });
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(50);
    const thread = screen.getByTestId("thread");
    expect(thread.style.left).toBe(`${200 + THREAD_GAP - 300}px`);
    expect(thread.style.top).toBe(`${300 + THREAD_GAP - 40}px`);
  });

  it("hides while the pin's anchor does, and shows beside it again", () => {
    render(<Thread />);
    layOut({ x: 200, y: 300 });
    const thread = screen.getByTestId("thread");
    offsetParent(screen.getByTestId("anchor"), () => null);
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(50);
    expect(thread.style.display).toBe("none");

    layOut({ x: 400, y: 300 });
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(50);
    expect(thread.style.display).toBe("");
    expect(thread.style.left).toBe(`${400 + THREAD_GAP}px`);
  });

  it("follows a pin moved in the same frame, though the move subscribed later", () => {
    render(<Thread />);
    layOut({ x: 200, y: 300 });
    let x = 200;
    const unsubscribe = frameClock.subscribe(() => {
      x += 10;
      layOut({ x, y: 300 });
    });
    vi.advanceTimersByTime(16);
    expect(screen.getByTestId("thread").style.left).toBe(`${x + THREAD_GAP}px`);
    unsubscribe();
  });

  it("leaves the clock when the thread closes", () => {
    const { unmount } = render(<Thread />);
    expect(frameClock.running).toBe(true);
    unmount();
    expect(frameClock.running).toBe(false);
  });
});
