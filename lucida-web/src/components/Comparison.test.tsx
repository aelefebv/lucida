// @vitest-environment happy-dom
/**
 * A blink runs at the rate its comparison records, so a view an agent set
 * blinking blinks for a person who opens it, and holds still for a capture,
 * whose image shows the side the comparison records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Comparison, ComparisonActions } from "../comparison.ts";
import { ComparisonBar } from "./Comparison.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BLINK: Comparison = { a: "a", b: "b", mode: "blink", divider: 0.5, showing: "a" };

function actions(): ComparisonActions {
  return {
    current: () => null,
    start: vi.fn(() => ({ verdict: "yes" as const })),
    end: vi.fn(),
    setMode: vi.fn(),
    setDivider: vi.fn(),
    flip: vi.fn(),
    setBlinkRate: vi.fn(),
  };
}

function bar(comparison: Comparison, controls: ComparisonActions, { active = true, still = false } = {}) {
  return render(
    <ComparisonBar
      comparison={comparison}
      actions={controls}
      nameOf={(id) => id}
      setAside={null}
      active={active}
      still={still}
    />,
  );
}

describe("a blink's rate", () => {
  it("flips the comparison as often as it records, while its view is active", () => {
    const controls = actions();
    bar({ ...BLINK, rate: 2 }, controls);
    vi.advanceTimersByTime(1000);
    expect(controls.flip).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Stop blinking" })).toBeTruthy();
  });

  it("holds still without a rate, in an inactive view, and for a capture", () => {
    for (const [comparison, options] of [
      [BLINK, {}],
      [{ ...BLINK, rate: 2 }, { active: false }],
      [{ ...BLINK, rate: 4 }, { still: true }],
    ] as const) {
      const controls = actions();
      bar(comparison, controls, options);
      vi.advanceTimersByTime(1000);
      expect(controls.flip).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("is what the play button and a flip by hand set", () => {
    const still = actions();
    bar(BLINK, still);
    fireEvent.click(screen.getByRole("button", { name: "Blink" }));
    expect(still.setBlinkRate).toHaveBeenCalledWith(2);
    cleanup();

    const running = actions();
    bar({ ...BLINK, rate: 4 }, running);
    fireEvent.click(screen.getByRole("button", { name: "Show b" }));
    expect(running.setBlinkRate).toHaveBeenCalledWith(null);
    expect(running.flip).toHaveBeenCalledTimes(1);
  });
});
