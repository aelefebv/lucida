// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigTab } from "./ConfigTab.tsx";
import {
  getRenderRadiusPreviewTier,
  setRenderRadiusPreviewTier,
} from "./logging.ts";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import { configStore } from "../pipeline/planning/configStore.ts";

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

describe("ConfigTab", () => {
  it("renders the surviving chunk-planning controls", () => {
    render(<ConfigTab />);

    expect(screen.getByLabelText(/Prefetch depth.*slider/i)).toBeTruthy();
    expect(screen.getByLabelText(/Importance weight.*slider/i)).toBeTruthy();
    expect(screen.getByLabelText(/Distance weight.*slider/i)).toBeTruthy();
    expect(screen.getByLabelText(/Detail render radius.*slider/i)).toBeTruthy();
    expect(screen.getByLabelText(/Coarse render radius.*slider/i)).toBeTruthy();
    expect(screen.queryByText(/threshold/i)).toBeNull();
  });

  it("collapses structural lane offsets until requested", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);

    expect(screen.queryByLabelText(/MINIMAP lane offset.*slider/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /show/i }));

    expect(screen.getByLabelText(/MINIMAP lane offset.*slider/i)).toBeTruthy();
    expect(screen.getByLabelText(/COARSE lane offset.*slider/i)).toBeTruthy();
    expect(screen.getByText(/canonical order/i)).toBeTruthy();
  });

  it("writes numeric controls through the config store", () => {
    render(<ConfigTab />);

    fireEvent.change(screen.getByLabelText(/Prefetch depth.*value/i), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText(/Detail render radius.*slider/i), {
      target: { value: "0.75" },
    });

    expect(configStore.get().prefetchDepth).toBe(4);
    expect(configStore.get().detailRenderRadiusView).toBe(0.75);
  });

  it("previews only the radius tier being dragged", () => {
    render(<ConfigTab />);

    fireEvent.pointerDown(screen.getByLabelText(/Detail render radius.*slider/i));
    expect(getRenderRadiusPreviewTier()).toBe("detail");
    fireEvent.pointerUp(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();

    fireEvent.pointerDown(screen.getByLabelText(/Coarse render radius.*slider/i));
    expect(getRenderRadiusPreviewTier()).toBe("coarse");
    fireEvent.pointerCancel(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();
  });

  it("resets one dirty value and then all dirty values", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);

    fireEvent.change(screen.getByLabelText(/Prefetch depth.*slider/i), {
      target: { value: "4" },
    });
    await user.click(screen.getByRole("button", { name: /Reset Prefetch depth/i }));
    expect(configStore.get().prefetchDepth).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);

    fireEvent.change(screen.getByLabelText(/Importance weight.*slider/i), {
      target: { value: "1500" },
    });
    await user.click(screen.getByRole("button", { name: /reset all to defaults/i }));
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("warns when lane offsets invert the canonical chunk-lane order", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await user.click(screen.getByRole("button", { name: /show/i }));

    fireEvent.change(screen.getByLabelText(/DETAIL lane offset.*slider/i), {
      target: { value: "2000" },
    });
    expect(screen.getAllByText(/inverts canonical lane order/i).length).toBeGreaterThan(0);
  });

  it("keeps production mode read-only while retaining the reset safety valve", async () => {
    const user = userEvent.setup();
    act(() => configStore.set("importanceWeight", 1500));
    render(<ConfigTab editable={false} />);

    const input = screen.getByLabelText(/Importance weight.*value/i) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "1200" } });
    expect(configStore.get().importanceWeight).toBe(1500);

    await user.click(screen.getByRole("button", { name: /reset all to defaults/i }));
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    expect(localStorage.getItem("lucida.planning.config")).toBeNull();
  });

  it("reacts to external store updates", async () => {
    render(<ConfigTab />);
    await act(async () => configStore.set("prefetchDepth", 5));
    expect((screen.getByLabelText(/Prefetch depth.*slider/i) as HTMLInputElement).value).toBe("5");
  });
});
