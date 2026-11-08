// @vitest-environment happy-dom

/**
 * The legend's two trace-reading toggles: phase color and churn tint
 * sit beside the cache toggles, and the churn toggle states its window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { HudLegend } from "./HudLegend.tsx";
import { DEBUG_OVERLAYS, debugOverlaysPreference, isOverlayEnabled, setOverlayEnabled } from "../debug/logging.ts";
import { getPreference } from "../theme/preferences.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const name of DEBUG_OVERLAYS) setOverlayEnabled(name, false);
  localStorage.clear();
  vi.useRealTimers();
});

describe("the phase and churn toggles", () => {
  it("are overlay toggles like the others, persisted in the same preference", () => {
    render(<HudLegend windowSource={{ openIntervalMs: null }} />);
    const phase = screen.getByRole("checkbox", { name: "phase" }) as HTMLInputElement;
    const churn = screen.getByRole("checkbox", { name: /^churn/ }) as HTMLInputElement;
    expect(phase.checked).toBe(false);
    expect(churn.checked).toBe(false);

    act(() => {
      phase.click();
      churn.click();
    });
    expect(isOverlayEnabled("phaseColor")).toBe(true);
    expect(isOverlayEnabled("churnTint")).toBe(true);
    expect(getPreference(debugOverlaysPreference)).toEqual(["phaseColor", "churnTint"]);
  });

  it("states the churn window beside the toggle, and says when no interval is open", () => {
    render(<HudLegend windowSource={{ openIntervalMs: null }} />);
    expect(screen.getByTestId("hud-legend-churn-window").textContent).toBe("no interval open");
    cleanup();

    render(<HudLegend windowSource={{ openIntervalMs: 12_340 }} />);
    expect(screen.getByTestId("hud-legend-churn-window").textContent).toBe("over the open interval, 12.3 s");
  });

  it("re-reads the window on a timer, so the stated denominator keeps up with the interval", () => {
    vi.useFakeTimers();
    const source = { openIntervalMs: 2_000 };
    render(<HudLegend windowSource={source} />);
    expect(screen.getByTestId("hud-legend-churn-window").textContent).toContain("2.0 s");

    source.openIntervalMs = 7_500;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("hud-legend-churn-window").textContent).toContain("7.5 s");
  });
});
