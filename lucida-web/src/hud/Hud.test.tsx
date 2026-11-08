// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Hud } from "./Hud.tsx";
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

function renderHud() {
  const viewer = document.createElement("canvas");
  const canvasRef = { current: viewer };
  const datasets = new Map([["ds-1", { name: "one.zarr" }]]);
  return render(<Hud canvasRef={canvasRef} datasets={datasets} getCache={() => null} getGpuMemory={() => null} />);
}

describe("the HUD legend", () => {
  it("shows one toggle per overlay, reflecting the persisted state", () => {
    setOverlayEnabled("chunkGrid", true);
    renderHud();
    const boxes = within(screen.getByTestId("hud-legend")).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(DEBUG_OVERLAYS.length);
    DEBUG_OVERLAYS.forEach((name, i) => {
      expect(boxes[i].checked).toBe(name === "chunkGrid");
      expect(boxes[i].disabled).toBe(false);
    });
  });

  it("writes a toggle through the registry into the same preference the overlays read", async () => {
    const user = userEvent.setup();
    renderHud();
    await user.click(screen.getByRole("checkbox", { name: "planned rank" }));
    expect(isOverlayEnabled("plannedRank")).toBe(true);
    expect(getPreference(debugOverlaysPreference)).toEqual(["plannedRank"]);
    await user.click(screen.getByRole("checkbox", { name: "planned rank" }));
    expect(isOverlayEnabled("plannedRank")).toBe(false);
    expect(getPreference(debugOverlaysPreference)).toEqual([]);
  });

  it("reflects a toggle flipped from outside", async () => {
    renderHud();
    expect((screen.getByRole("checkbox", { name: "chunk grid" }) as HTMLInputElement).checked).toBe(false);
    await act(async () => {
      setOverlayEnabled("chunkGrid", true);
    });
    expect((screen.getByRole("checkbox", { name: "chunk grid" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("the HUD strip", () => {
  it("mounts a canvas with a text summary and keeps sampling on its own timer", () => {
    vi.useFakeTimers();
    renderHud();
    const strip = screen.getByRole("img", { name: /pipeline HUD/ }) as HTMLCanvasElement;
    expect(strip.getAttribute("aria-label")).toContain("unpublished");
    // No 2D context in this environment, so the tick samples and sizes but does not paint.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(strip.style.width).toMatch(/px$/);
  });

  it("sizes its backing store by the device pixel ratio", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    try {
      renderHud();
      const strip = screen.getByRole("img", { name: /pipeline HUD/ }) as HTMLCanvasElement;
      const cssWidth = Number.parseInt(strip.style.width, 10);
      const cssHeight = Number.parseInt(strip.style.height, 10);
      expect(cssWidth).toBeGreaterThan(0);
      expect(strip.width).toBe(cssWidth * 2);
      expect(strip.height).toBe(cssHeight * 2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops its timer on unmount", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHud();
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
