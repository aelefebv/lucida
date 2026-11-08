// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { frameClock, IDLE_AFTER_MS } from "../frameClock.ts";
import { FpsCounter } from "./FpsCounter.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FpsCounter", () => {
  it("reads the clock's frame rate while it runs, and lets a still page stop drawing", () => {
    render(<FpsCounter />);
    expect(screen.getByText("– FPS")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/^\d+ FPS$/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(IDLE_AFTER_MS * 3);
    });
    expect(frameClock.running).toBe(false);
    expect(screen.getByText("– FPS")).toBeTruthy();
  });
});
