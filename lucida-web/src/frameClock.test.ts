// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameClock, IDLE_AFTER_MS } from "./frameClock.ts";

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FrameClock", () => {
  it("draws while woken and stops requesting frames once the page is still", () => {
    const clock = new FrameClock();
    const frames = vi.fn();
    const unsubscribe = clock.subscribe(frames);
    expect(clock.running).toBe(true);

    vi.advanceTimersByTime(IDLE_AFTER_MS + 100);
    const drawn = frames.mock.calls.length;
    expect(drawn).toBeGreaterThan(10);
    expect(clock.running).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(frames.mock.calls.length).toBe(drawn);
    unsubscribe();
  });

  it("resumes on input anywhere on the page", () => {
    const clock = new FrameClock();
    const frames = vi.fn();
    const unsubscribe = clock.subscribe(frames);
    vi.advanceTimersByTime(IDLE_AFTER_MS + 100);
    expect(clock.running).toBe(false);

    window.dispatchEvent(new Event("pointermove"));
    expect(clock.running).toBe(true);
    const before = frames.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(frames.mock.calls.length).toBeGreaterThan(before);

    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(clock.running).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(clock.running).toBe(true);
    unsubscribe();
  });

  it("keeps running while a subscriber asks to, as a held key does", () => {
    const clock = new FrameClock();
    let held = true;
    const unsubscribe = clock.subscribe(() => held);
    vi.advanceTimersByTime(IDLE_AFTER_MS * 4);
    expect(clock.running).toBe(true);
    held = false;
    vi.advanceTimersByTime(IDLE_AFTER_MS + 100);
    expect(clock.running).toBe(false);
    unsubscribe();
  });

  it("requests nothing while the page is hidden and wakes when it shows", () => {
    const clock = new FrameClock();
    const frames = vi.fn();
    const unsubscribe = clock.subscribe(frames);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clock.running).toBe(false);
    clock.wake();
    window.dispatchEvent(new Event("pointerdown"));
    expect(clock.running).toBe(false);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clock.running).toBe(true);
    unsubscribe();
  });

  it("draws a follow callback after every move callback of the frame, whichever subscribed first", () => {
    const clock = new FrameClock();
    const order: string[] = [];
    const unsubscribeFollow = clock.subscribe(() => void order.push("follow"), "follow");
    const unsubscribeMove = clock.subscribe(() => void order.push("move"));
    vi.advanceTimersByTime(16);
    expect(order.slice(0, 2)).toEqual(["move", "follow"]);

    unsubscribeMove();
    expect(clock.running).toBe(true);
    unsubscribeFollow();
    expect(clock.running).toBe(false);
  });

  it("stops and stops listening once the last subscriber leaves", () => {
    const clock = new FrameClock();
    const unsubscribe = clock.subscribe(() => true);
    unsubscribe();
    expect(clock.running).toBe(false);
    window.dispatchEvent(new Event("pointermove"));
    expect(clock.running).toBe(false);
  });
});
