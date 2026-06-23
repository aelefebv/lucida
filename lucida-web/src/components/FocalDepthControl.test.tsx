// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocalDepthControl } from "./FocalDepthControl.tsx";
import { configStore } from "../pipeline/planning/configStore.ts";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import type { ViewMode } from "../types.ts";

beforeEach(() => {
  configStore.__resetForTesting();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  configStore.__resetForTesting();
  localStorage.clear();
});

// Mirrors the gating expression in App.tsx's dimension-controls row:
// the focal-depth control is a 3-D-only concept, shown only in 3-D mode.
function DimensionRow({ viewMode }: { viewMode: ViewMode }) {
  return (
    <div className="dimension-controls">
      {viewMode === "3d" && <FocalDepthControl />}
    </div>
  );
}

describe("FocalDepthControl — 3D-mode gating (#532)", () => {
  it("renders in the dimension-controls row in 3D mode", () => {
    render(<DimensionRow viewMode="3d" />);
    expect(screen.getByTestId("focal-depth-control")).toBeTruthy();
    expect(screen.getByLabelText(/Focal depth \(near.*far\)/i)).toBeTruthy();
  });

  it("is absent in 2D mode", () => {
    render(<DimensionRow viewMode="2d" />);
    expect(screen.queryByTestId("focal-depth-control")).toBeNull();
    expect(screen.queryByLabelText(/Focal depth \(near.*far\)/i)).toBeNull();
  });
});

describe("FocalDepthControl — value + configStore binding (#532)", () => {
  it("defaults to centered (0)", () => {
    render(<FocalDepthControl />);
    const slider = screen.getByLabelText(
      /Focal depth \(near.*far\)/i,
    ) as HTMLInputElement;
    expect(Number(slider.value)).toBe(DEFAULT_PLANNING_CONFIG.depthBiasView);
    expect(Number(slider.value)).toBe(0);
    // Centered = default, so the reset-to-center affordance is disabled.
    const reset = screen.getByRole("button", {
      name: /Reset focal depth to center/i,
    }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
  });

  it("changing the slider updates configStore.depthBiasView (one source of truth)", () => {
    render(<FocalDepthControl />);
    const slider = screen.getByLabelText(
      /Focal depth \(near.*far\)/i,
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "-0.5" } });
    expect(configStore.get().depthBiasView).toBe(-0.5);
  });

  it("reflects the same configStore value the Debug surface persists", () => {
    // The control reads from the shared store, so a value set elsewhere
    // (e.g. a persisted localStorage hydrate) shows up here unchanged.
    configStore.set("depthBiasView", 0.4);
    render(<FocalDepthControl />);
    const slider = screen.getByLabelText(
      /Focal depth \(near.*far\)/i,
    ) as HTMLInputElement;
    expect(Number(slider.value)).toBe(0.4);
  });

  it("offers a reset-to-center affordance once moved and restores the default", async () => {
    const user = userEvent.setup();
    configStore.set("depthBiasView", 0.75);
    render(<FocalDepthControl />);
    const reset = screen.getByRole("button", {
      name: /Reset focal depth to center/i,
    }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    await user.click(reset);
    expect(configStore.get().depthBiasView).toBe(
      DEFAULT_PLANNING_CONFIG.depthBiasView,
    );
  });
});
