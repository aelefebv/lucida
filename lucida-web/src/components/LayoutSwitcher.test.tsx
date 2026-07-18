// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";
import { LayoutSwitcher } from "./LayoutSwitcher.tsx";
import { LayoutSwitcherController } from "./LayoutSwitcherController.tsx";

afterEach(cleanup);

const LAYOUTS = [
  { id: "grid", name: "Grid" },
  { id: "strip", name: "Strip" },
];

describe("LayoutSwitcher presentation", () => {
  it("renders only when a choice exists and emits the selected id", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <LayoutSwitcher layouts={[]} activeLayoutId={null} onSelect={onSelect} />,
    );
    expect(screen.queryByRole("combobox", { name: "Layout" })).toBeNull();

    rerender(
      <LayoutSwitcher layouts={LAYOUTS} activeLayoutId="grid" onSelect={onSelect} />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Layout" }), {
      target: { value: "strip" },
    });
    expect(onSelect).toHaveBeenCalledWith("strip");
  });
});

describe("LayoutSwitcherController application adapter", () => {
  it("owns registry mutation and post-change invalidation", () => {
    const setActive = vi.fn();
    const sendCommand = vi.fn();
    const onAfterChange = vi.fn();
    const registry = {
      subscribe: vi.fn(() => () => {}),
      getVersion: vi.fn(() => 1),
      available: vi.fn(() => LAYOUTS),
      activeId: vi.fn(() => "grid"),
      setActive,
    } as unknown as LayoutRegistry;

    render(
      <LayoutSwitcherController
        datasetId="ds-1"
        registry={registry}
        sendCommand={sendCommand}
        onAfterChange={onAfterChange}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Layout" }), {
      target: { value: "strip" },
    });

    expect(setActive).toHaveBeenCalledWith("ds-1", "strip", sendCommand);
    expect(onAfterChange).toHaveBeenCalledTimes(1);
  });
});
