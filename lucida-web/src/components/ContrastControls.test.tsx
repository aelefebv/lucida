// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContrastControls } from "./ContrastControls.tsx";
import { contrastBounds, orderLimits } from "./contrastLimits.ts";

function renderControls(overrides: Partial<Parameters<typeof ContrastControls>[0]> = {}) {
  const props = {
    label: "Channel 1",
    contrastMin: 100,
    contrastMax: 3000,
    gamma: 1,
    dataRange: { min: 50, max: 4000 } as { min: number; max: number } | null,
    valueRange: [0, 65535] as readonly [number, number] | null,
    integer: true,
    fullRange: false,
    onFullRangeChange: vi.fn(),
    onContrastChange: vi.fn(),
    onGammaChange: vi.fn(),
    onAutoFit: vi.fn(),
    ...overrides,
  };
  render(<ContrastControls {...props} />);
  return props;
}

function field(name: string): HTMLInputElement {
  return screen.getByRole("textbox", { name }) as HTMLInputElement;
}

async function typeInto(name: string, text: string, commit: "{Enter}" | "blur") {
  const input = field(name);
  await userEvent.clear(input);
  await userEvent.type(input, text);
  if (commit === "blur") await userEvent.tab();
  else await userEvent.keyboard(commit);
}

afterEach(cleanup);

describe("ContrastControls typed limits", () => {
  it("applies a typed minimum on Enter", async () => {
    const props = renderControls();
    await typeInto("Contrast minimum", "250", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(250, 3000);
  });

  it("applies a typed maximum on blur", async () => {
    const props = renderControls();
    await typeInto("Contrast maximum", "3500", "blur");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(100, 3500);
  });

  it("clamps a typed value to the slider's span", async () => {
    const props = renderControls();
    await typeInto("Contrast maximum", "90000", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(100, 4000);
  });

  it("keeps the minimum below the maximum", async () => {
    const props = renderControls();
    await typeInto("Contrast minimum", "3800", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(2999, 3000);
  });

  it("applies a typed gamma, clamped", async () => {
    const props = renderControls();
    await typeInto("Gamma", "2.5", "{Enter}");
    expect(props.onGammaChange).toHaveBeenLastCalledWith(2.5);
    await typeInto("Gamma", "9", "blur");
    expect(props.onGammaChange).toHaveBeenLastCalledWith(5);
  });
});

describe("ContrastControls auto", () => {
  it("fits once on Auto, and waits for data before offering it", async () => {
    const props = renderControls();
    await userEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(props.onAutoFit).toHaveBeenCalledTimes(1);
    cleanup();

    renderControls({ dataRange: null });
    expect(screen.getByRole("button", { name: "Auto" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows continuous auto-contrast as a switch when given one", async () => {
    const onChange = vi.fn();
    renderControls({ continuous: { isSelected: true, onChange } });
    await userEvent.click(screen.getByRole("switch", { name: "Continuous" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("contrast bounds", () => {
  it("spans the loaded data, or the whole range, and always holds the limits", () => {
    expect(contrastBounds(100, 3000, { min: 50, max: 4000 }, [0, 65535], false)).toEqual([50, 4000]);
    expect(contrastBounds(100, 3000, { min: 50, max: 4000 }, [0, 65535], true)).toEqual([0, 65535]);
    expect(contrastBounds(0, 65535, { min: 50, max: 4000 }, [0, 65535], false)).toEqual([0, 65535]);
    expect(contrastBounds(10, 20, null, [0, 255], false)).toEqual([0, 255]);
    expect(contrastBounds(-5, 20, null, [-32768, 32767], true)).toEqual([-32768, 32767]);
    // A float type spans its loaded data, or its limits before any loads.
    expect(contrastBounds(0, 100, { min: -5, max: 500 }, null, false)).toEqual([-5, 500]);
    expect(contrastBounds(0, 100, { min: -5, max: 500 }, null, true)).toEqual([-5, 500]);
    expect(contrastBounds(-2, 7.5, null, null, false)).toEqual([-2, 7.5]);
  });

  it("moves whichever limit the user did not set", () => {
    expect(orderLimits([100, 3000], 100, 1)).toEqual([100, 3000]);
    expect(orderLimits([3000, 3000], 100, 1)).toEqual([2999, 3000]);
    expect(orderLimits([100, 100], 100, 1)).toEqual([100, 101]);
  });
});
