// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContrastControls } from "./ContrastControls.tsx";

afterEach(() => cleanup());

function renderControls(overrides: Partial<React.ComponentProps<typeof ContrastControls>> = {}) {
  const props: React.ComponentProps<typeof ContrastControls> = {
    dataMin: 0,
    dataMax: 255,
    contrastMin: 10,
    contrastMax: 200,
    gamma: 1,
    autoContrast: false,
    onContrastChange: vi.fn(),
    onGammaChange: vi.fn(),
    onAutoContrast: vi.fn(),
    onAutoContrastToggle: vi.fn(),
    fullRange: false,
    onFullRangeToggle: vi.fn(),
    fullRangeMax: 65535,
    ...overrides,
  };
  render(<ContrastControls {...props} />);
  return props;
}

describe("ContrastControls automatic contrast actions", () => {
  it("exposes distinct one-shot and persistent actions", () => {
    const props = renderControls();

    fireEvent.click(screen.getByRole("button", { name: "apply automatic contrast once" }));
    expect(props.onAutoContrast).toHaveBeenCalledOnce();
    expect(props.onAutoContrastToggle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "keep contrast automatic" }));
    expect(props.onAutoContrastToggle).toHaveBeenCalledOnce();
    expect(props.onAutoContrast).toHaveBeenCalledOnce();
  });

  it("announces the persistent auto state with aria-pressed", () => {
    renderControls({ autoContrast: true });
    expect(screen.getByRole("button", { name: "keep contrast automatic" }).getAttribute("aria-pressed"))
      .toBe("true");
  });
});
