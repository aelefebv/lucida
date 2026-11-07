// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocalDepthControl } from "./FocalDepthControl.tsx";
import { configStore } from "../pipeline/planning/configStore.ts";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";

beforeEach(() => {
  configStore.__resetForTesting();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  configStore.__resetForTesting();
  localStorage.clear();
});

const slider = () => screen.getByRole("slider", { name: "Focal depth" }) as HTMLInputElement;
const reset = () => screen.getByRole("button", { name: "Reset focal depth to center" });

describe("FocalDepthControl", () => {
  it("defaults to centered, with the reset disabled", () => {
    render(<FocalDepthControl />);
    expect(Number(slider().value)).toBe(DEFAULT_PLANNING_CONFIG.depthBiasView);
    expect(Number(slider().value)).toBe(0);
    expect(reset().hasAttribute("disabled")).toBe(true);
  });

  it("writes the slider to configStore.depthBiasView, its one source of truth", () => {
    render(<FocalDepthControl />);
    fireEvent.change(slider(), { target: { value: "-0.5" } });
    expect(configStore.get().depthBiasView).toBe(-0.5);
  });

  it("shows a value set elsewhere, such as the developer surface or a stored hydrate", () => {
    configStore.set("depthBiasView", 0.4);
    render(<FocalDepthControl />);
    expect(Number(slider().value)).toBe(0.4);
  });

  it("resets a moved value to center", async () => {
    const user = userEvent.setup();
    configStore.set("depthBiasView", 0.75);
    render(<FocalDepthControl />);
    expect(reset().hasAttribute("disabled")).toBe(false);
    await user.click(reset());
    expect(configStore.get().depthBiasView).toBe(DEFAULT_PLANNING_CONFIG.depthBiasView);
  });
});
