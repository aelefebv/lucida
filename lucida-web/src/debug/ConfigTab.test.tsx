// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigTab } from "./ConfigTab.tsx";
import { configStore } from "../pipeline/planning/configStore.ts";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import {
  getRenderRadiusPreviewTier,
  setRenderRadiusPreviewTier,
} from "./logging.ts";

beforeEach(() => {
  configStore.__resetForTesting();
  setRenderRadiusPreviewTier(null);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  configStore.__resetForTesting();
  setRenderRadiusPreviewTier(null);
  localStorage.clear();
});

describe("ConfigTab — rendering", () => {
  it("renders each tunable's label and current value", () => {
    render(<ConfigTab />);
    // Mode thresholds.
    expect(screen.getByText(/FAR threshold/)).toBeTruthy();
    expect(screen.getByText(/DETAIL threshold/)).toBeTruthy();
    expect(screen.getByText(/Hysteresis/)).toBeTruthy();
    expect(screen.getByText(/Prefetch depth/)).toBeTruthy();

    // Priority weights.
    expect(screen.getByText(/Importance weight/)).toBeTruthy();
    expect(screen.getByText(/Distance weight/)).toBeTruthy();
    expect(screen.getByText(/Well-proxy priority bump/)).toBeTruthy();
    expect(screen.getByText(/Detail render radius/)).toBeTruthy();
    expect(screen.getByText(/Coarse render radius/)).toBeTruthy();

    // The slider for FAR shows the default value.
    const farSlider = screen.getByLabelText(/FAR threshold.*slider/i) as HTMLInputElement;
    expect(Number(farSlider.value)).toBe(DEFAULT_PLANNING_CONFIG.farThresholdPx);

    // The number input for FAR shows the default value.
    const farNumber = screen.getByLabelText(/FAR threshold.*value/i) as HTMLInputElement;
    expect(Number(farNumber.value)).toBe(DEFAULT_PLANNING_CONFIG.farThresholdPx);
  });

  it("collapses lane-offsets section by default", () => {
    render(<ConfigTab />);
    // Lane offset rows are not in the DOM until toggled open.
    expect(screen.queryByLabelText(/MINIMAP lane offset.*slider/i)).toBeNull();
    expect(screen.queryByLabelText(/DETAIL lane offset.*slider/i)).toBeNull();
    // The section header + toggle are present.
    expect(screen.getByText(/Lane offsets/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /show/i })).toBeTruthy();
  });

  it("renders lane-offsets and the structural-warning banner once expanded", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await user.click(screen.getByRole("button", { name: /show/i }));
    expect(screen.getByLabelText(/MINIMAP lane offset.*slider/i)).toBeTruthy();
    expect(screen.getByLabelText(/OVERVIEW lane offset.*slider/i)).toBeTruthy();
    // Warning banner mentions the canonical priority order.
    expect(screen.getByText(/canonical order/i)).toBeTruthy();
  });
});

// NOTE: the 3-D focal-depth control (issue #532) moved out of the Debug
// Config tab into the main 3-D view UI. Its tests now live in
// components/FocalDepthControl.test.tsx.

describe("ConfigTab — slider + number input edits", () => {
  it("dragging the FAR slider updates the configStore", () => {
    render(<ConfigTab />);
    const slider = screen.getByLabelText(/FAR threshold.*slider/i) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "120" } });
    expect(configStore.get().farThresholdPx).toBe(120);
  });

  it("dragging the detail radius slider updates the configStore", () => {
    render(<ConfigTab />);
    const slider = screen.getByLabelText(/Detail render radius.*slider/i) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.75" } });
    expect(configStore.get().detailRenderRadiusView).toBe(0.75);
  });

  it("previews only the active radius tier while dragging radius sliders", () => {
    render(<ConfigTab />);

    const detail = screen.getByLabelText(/Detail render radius.*slider/i);
    fireEvent.pointerDown(detail);
    expect(getRenderRadiusPreviewTier()).toBe("detail");
    fireEvent.pointerUp(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();

    const coarse = screen.getByLabelText(/Coarse render radius.*slider/i);
    fireEvent.pointerDown(coarse);
    expect(getRenderRadiusPreviewTier()).toBe("coarse");
    fireEvent.pointerCancel(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();
  });

  it("does not preview radius visuals for unrelated sliders", () => {
    render(<ConfigTab />);
    fireEvent.pointerDown(screen.getByLabelText(/FAR threshold.*slider/i));
    expect(getRenderRadiusPreviewTier()).toBeNull();
  });

  it("typing into the number input updates the configStore", () => {
    render(<ConfigTab />);
    const number = screen.getByLabelText(/FAR threshold.*value/i) as HTMLInputElement;
    fireEvent.change(number, { target: { value: "55" } });
    expect(configStore.get().farThresholdPx).toBe(55);
  });

  it("clamps inputs above the slider max", () => {
    render(<ConfigTab />);
    const number = screen.getByLabelText(/FAR threshold.*value/i) as HTMLInputElement;
    fireEvent.change(number, { target: { value: "999999" } });
    // FAR slider max is 200 in the schema.
    expect(configStore.get().farThresholdPx).toBe(200);
  });
});

describe("ConfigTab — reset arrow", () => {
  it("does not appear when value matches default", () => {
    render(<ConfigTab />);
    expect(screen.queryByRole("button", { name: /Reset FAR threshold/i })).toBeNull();
  });

  it("appears when value differs from default and restores on click", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    const slider = screen.getByLabelText(/FAR threshold.*slider/i) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "120" } });

    const resetBtn = await screen.findByRole("button", { name: /Reset FAR threshold/i });
    await user.click(resetBtn);

    expect(configStore.get().farThresholdPx).toBe(
      DEFAULT_PLANNING_CONFIG.farThresholdPx,
    );
  });
});

describe("ConfigTab — reset all", () => {
  it("Reset all to defaults restores every field", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);

    fireEvent.change(
      screen.getByLabelText(/FAR threshold.*slider/i),
      { target: { value: "120" } },
    );
    fireEvent.change(
      screen.getByLabelText(/Importance weight.*slider/i),
      { target: { value: "1500" } },
    );
    expect(configStore.get().farThresholdPx).toBe(120);
    expect(configStore.get().importanceWeight).toBe(1500);

    await user.click(screen.getByRole("button", { name: /reset all to defaults/i }));
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("is disabled when state already matches defaults", () => {
    render(<ConfigTab />);
    const btn = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("ConfigTab — cross-constraint warnings", () => {
  it("shows the middle-band warning when DETAIL <= FAR + 2*hysteresis", () => {
    render(<ConfigTab />);
    // Push detail down to a value that collapses the middle band.
    // Defaults: far=80, hysteresis=5, detail=150 -> band is 90..145.
    // Force detail=85: dynamicMin clamps it to far+10=90 (still <= 80+10=90).
    fireEvent.change(
      screen.getByLabelText(/DETAIL threshold.*slider/i),
      { target: { value: "30" } },
    );
    // The warning text should appear.
    expect(screen.getAllByText(/middle band collapsed/i).length).toBeGreaterThan(0);
  });

  it("shows lane-order inversion warning when offsets violate the canonical order", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await user.click(screen.getByRole("button", { name: /show/i }));

    // Push DETAIL lane offset above PROXY lane offset (default 500 vs 1000)
    // by setting DETAIL to 2000.
    fireEvent.change(
      screen.getByLabelText(/DETAIL lane offset.*slider/i),
      { target: { value: "2000" } },
    );
    expect(screen.getAllByText(/inverts canonical lane order/i).length).toBeGreaterThan(0);
  });
});

describe("ConfigTab — read-only mode (production builds)", () => {
  it("shows live values with disabled inputs, no per-field resets, and the note", () => {
    act(() => {
      configStore.set("farThresholdPx", 120);
    });
    render(<ConfigTab editable={false} />);

    const slider = screen.getByLabelText(/FAR threshold.*slider/i) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(Number(slider.value)).toBe(120);

    const number = screen.getByLabelText(/FAR threshold.*value/i) as HTMLInputElement;
    expect(number.disabled).toBe(true);

    // Dirty value, but no per-field reset in read-only mode.
    expect(screen.queryByRole("button", { name: /Reset FAR threshold/i })).toBeNull();

    expect(screen.getByText(/read-only in this build/i)).toBeTruthy();
  });

  it("keeps Reset all enabled and working — the recovery path for persisted knobs", async () => {
    // A previous session persisted non-default knobs; they still apply in
    // this build, so the user must be able to clear them from the UI.
    const user = userEvent.setup();
    act(() => {
      configStore.set("farThresholdPx", 120);
      configStore.set("importanceWeight", 1500);
    });
    render(<ConfigTab editable={false} />);

    const resetAll = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(false);

    await user.click(resetAll);
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    // Persisted envelope cleared too — nothing stale left for next load.
    expect(localStorage.getItem("lucida.planning.config")).toBeNull();
  });

  it("disables Reset all when nothing differs from defaults", () => {
    render(<ConfigTab editable={false} />);
    const resetAll = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(true);
  });

  it("ignores change events on sliders and number inputs", () => {
    render(<ConfigTab editable={false} />);
    fireEvent.change(
      screen.getByLabelText(/FAR threshold.*slider/i),
      { target: { value: "120" } },
    );
    fireEvent.change(
      screen.getByLabelText(/FAR threshold.*value/i),
      { target: { value: "55" } },
    );
    expect(configStore.get().farThresholdPx).toBe(
      DEFAULT_PLANNING_CONFIG.farThresholdPx,
    );
  });

  it("renders the coarse/detail toggle disabled and inert", () => {
    render(<ConfigTab editable={false} />);
    const toggle = screen.getByLabelText(/Coarse\/detail path/i) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(configStore.get().coarseDetailEnabled).toBe(
      DEFAULT_PLANNING_CONFIG.coarseDetailEnabled,
    );
  });
});

describe("ConfigTab — store subscription", () => {
  it("re-renders when configStore changes externally", async () => {
    render(<ConfigTab />);
    const slider = screen.getByLabelText(/FAR threshold.*slider/i) as HTMLInputElement;
    expect(Number(slider.value)).toBe(DEFAULT_PLANNING_CONFIG.farThresholdPx);

    // Change the store directly (bypassing the UI).
    await act(async () => {
      configStore.set("farThresholdPx", 175);
    });
    const sliderAfter = screen.getByLabelText(/FAR threshold.*slider/i) as HTMLInputElement;
    expect(Number(sliderAfter.value)).toBe(175);
  });
});
