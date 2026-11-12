// @vitest-environment happy-dom

import { BookmarkSimpleIcon, ChatCircleIcon, StackIcon } from "@phosphor-icons/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetPreferencesForTesting, getPreference } from "../../theme/preferences.ts";
import { __resetEscapeLayersForTesting } from "../../ui/escape.ts";
import { __resetShortcutsForTesting } from "../../ui/shortcuts.ts";
import { rightPanelPreference } from "../layoutPreferences.ts";
import type { RailPanel } from "../RightRail.tsx";
import { __resetSidePanelsForTesting, isPanelOpen, openRightPanel } from "../sidePanels.ts";
import { PhoneSheet } from "./PhoneSheet.tsx";

function setViewport(width: number, height = 800) {
  (window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport(
    { width, height },
  );
}

const layerTabs: RailPanel[] = [{ id: "layers", label: "Layers", icon: StackIcon, render: () => <p>layers body</p> }];
const railTabs: RailPanel[] = [
  {
    id: "savedViews",
    label: "Saved views",
    shortLabel: "Views",
    icon: BookmarkSimpleIcon,
    render: (on) => on && <p>saved views body</p>,
  },
  { id: "comments", label: "Comments", icon: ChatCircleIcon, render: (on) => on && <p>comments body</p> },
];

function Shell() {
  return (
    <div className="lc-shell-center">
      <div className="lc-canvas-stage-above" />
      <PhoneSheet peek={<p>peek body</p>} layerTabs={layerTabs} railTabs={railTabs} />
    </div>
  );
}

const sheet = () => document.querySelector<HTMLElement>(".lc-phone-sheet")!;
const handle = () => screen.getByRole("separator", { name: "Viewer controls height" });
const tapHandle = () => {
  fireEvent.pointerDown(handle(), { pointerId: 1, button: 0, clientY: 600 });
  fireEvent.pointerUp(handle(), { pointerId: 1, button: 0, clientY: 600 });
};

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetSidePanelsForTesting();
  setViewport(390, 844);
});

afterEach(() => {
  cleanup();
  __resetShortcutsForTesting();
  __resetEscapeLayersForTesting();
  setViewport(1024, 768);
});

describe("PhoneSheet", () => {
  it("starts at peek, with the panels below out of reach", () => {
    render(<Shell />);
    expect(sheet().dataset.snap).toBe("peek");
    expect(screen.getByText("peek body")).toBeTruthy();
    expect(screen.queryByText("saved views body")).toBeNull();
    expect(document.querySelector(".lc-phone-sheet-body")?.hasAttribute("inert")).toBe(true);
  });

  it("steps up to full on a tap of the handle, then back to peek", () => {
    render(<Shell />);
    tapHandle();
    expect(sheet().dataset.snap).toBe("half");
    expect(handle().getAttribute("aria-valuetext")).toBe("Half");
    expect(isPanelOpen("left")).toBe(true);
    tapHandle();
    expect(sheet().dataset.snap).toBe("full");
    tapHandle();
    expect(sheet().dataset.snap).toBe("peek");
    expect(isPanelOpen("left")).toBe(false);
  });

  it("steps on a screen reader's click, but not again on a tap's own click", () => {
    render(<Shell />);
    fireEvent.click(handle());
    expect(sheet().dataset.snap).toBe("half");
    tapHandle();
    fireEvent.click(handle());
    expect(sheet().dataset.snap).toBe("full");
  });

  it("opens a rail panel as its tab, and remembers it as the rail does", () => {
    render(<Shell />);
    tapHandle();
    fireEvent.click(screen.getByRole("tab", { name: "Saved views" }));
    expect(screen.getByText("saved views body")).toBeTruthy();
    expect(isPanelOpen("right")).toBe(true);
    expect(getPreference(rightPanelPreference)).toBe("savedViews");
  });

  it("rises when a panel command opens a rail panel", () => {
    render(<Shell />);
    act(() => openRightPanel("comments"));
    expect(sheet().dataset.snap).toBe("half");
    expect(screen.getByText("comments body")).toBeTruthy();
  });

  it("follows the arrow keys and Escape", async () => {
    render(<Shell />);
    fireEvent.keyDown(handle(), { key: "End" });
    expect(sheet().dataset.snap).toBe("full");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(sheet().dataset.snap).toBe("half");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(sheet().dataset.snap).toBe("peek");
  });

  it("tells the toasts how much of the screen it covers, and stops when it goes", () => {
    const { unmount } = render(<Shell />);
    const clear = () => document.documentElement.style.getPropertyValue("--toast-clear-bottom");
    expect(clear()).toMatch(/^\d+px$/);
    unmount();
    expect(clear()).toBe("");
  });

  it("lowers to peek when a thread opens on the canvas", async () => {
    render(<Shell />);
    tapHandle();
    expect(sheet().dataset.snap).toBe("half");
    await act(async () => {
      const thread = document.createElement("div");
      thread.setAttribute("role", "dialog");
      document.querySelector(".lc-canvas-stage-above")!.append(thread);
    });
    expect(sheet().dataset.snap).toBe("peek");
  });
});
