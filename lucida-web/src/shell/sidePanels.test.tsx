// @vitest-environment happy-dom

import { BookmarkSimpleIcon, InfoIcon } from "@phosphor-icons/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasCard } from "../components/CanvasCard.tsx";
import { __resetCanvasCardsForTesting, minimapCardPreference } from "../components/canvasCards.ts";
import { __resetPreferencesForTesting, getPreference, setPreference } from "../theme/preferences.ts";
import { __resetEscapeLayersForTesting } from "../ui/escape.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { leftPanelOpenPreference, rightPanelOpenPreference } from "./layoutPreferences.ts";
import { LeftPanel } from "./LeftPanel.tsx";
import { RightRail, type RailPanel } from "./RightRail.tsx";
import { __resetSidePanelsForTesting, isPanelOpen, togglePanel } from "./sidePanels.ts";

function setViewport(width: number, height = 800) {
  (window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport(
    { width, height },
  );
}

const panels: RailPanel[] = [
  { id: "savedViews", label: "Saved views", icon: BookmarkSimpleIcon, render: (on) => on && <p>saved views body</p> },
  { id: "info", label: "Info", icon: InfoIcon, render: (on) => on && <p>info body</p> },
];

function Shell() {
  return (
    <div className="lc-shell-body">
      <LeftPanel label="Layers">
        <p>layers body</p>
      </LeftPanel>
      <div className="lc-shell-center" />
      <RightRail panels={panels} />
    </div>
  );
}

const leftPanel = () => document.querySelector<HTMLElement>(".lc-left-panel")!;
const altBracket = (key: "[" | "]") =>
  act(async () => {
    fireEvent.keyDown(window, { key, code: key === "[" ? "BracketLeft" : "BracketRight", altKey: true });
  });

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetSidePanelsForTesting();
  __resetCanvasCardsForTesting();
});

afterEach(() => {
  cleanup();
  __resetShortcutsForTesting();
  __resetEscapeLayersForTesting();
  setViewport(1024, 768);
});

describe("side panels below desktop", () => {
  beforeEach(() => setViewport(820, 1180));

  it("overlay the canvas, start closed, and never touch the desktop state", async () => {
    setPreference(rightPanelOpenPreference, true);
    render(<Shell />);
    expect(leftPanel().hidden).toBe(true);
    expect(leftPanel().dataset.mode).toBe("overlay");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByText("saved views body")).toBeNull();

    await altBracket("[");
    expect(leftPanel().hidden).toBe(false);
    await altBracket("[");
    expect(leftPanel().hidden).toBe(true);
    expect(getPreference(leftPanelOpenPreference)).toBe(true);
    expect(getPreference(rightPanelOpenPreference)).toBe(true);
  });

  it("close on a tap outside or Escape", async () => {
    render(<Shell />);
    await altBracket("[");
    fireEvent.click(screen.getByTestId("panel-scrim"));
    expect(leftPanel().hidden).toBe(true);
    expect(screen.queryByTestId("panel-scrim")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByText("info body")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByText("info body")).toBeNull();
  });

  it("show one at a time, and the rail stays to switch between them", async () => {
    render(<Shell />);
    await altBracket("[");
    fireEvent.click(screen.getByRole("button", { name: "Saved views" }));
    expect(screen.getByText("saved views body")).toBeTruthy();
    expect(leftPanel().hidden).toBe(true);

    togglePanel("left");
    await act(async () => {});
    expect(leftPanel().hidden).toBe(false);
    expect(screen.queryByText("saved views body")).toBeNull();
    expect(isPanelOpen("right")).toBe(false);
  });
});

describe("side panels on desktop", () => {
  it("sit beside the canvas and keep their open state in the preferences", async () => {
    render(<Shell />);
    expect(leftPanel().dataset.mode).toBe("docked");
    expect(leftPanel().hidden).toBe(false);
    await altBracket("]");
    expect(screen.getByText("saved views body")).toBeTruthy();
    expect(leftPanel().hidden).toBe(false);
    expect(getPreference(rightPanelOpenPreference)).toBe(true);
    expect(screen.queryByTestId("panel-scrim")).toBeNull();
  });
});

describe("canvas cards below desktop", () => {
  function Minimap() {
    return (
      <CanvasCard title="Minimap" label="Minimap" preference={minimapCardPreference}>
        <p>minimap body</p>
      </CanvasCard>
    );
  }

  it("start folded and unfold without changing the stored state", () => {
    setViewport(820, 1180);
    render(<Minimap />);
    expect(screen.getByText("minimap body").parentElement?.hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand minimap" }));
    expect(screen.getByText("minimap body").parentElement?.hidden).toBe(false);
    expect(getPreference(minimapCardPreference)).toBe("open");
  });

  it("store a hide, and come back from it whole", () => {
    setViewport(820, 1180);
    render(<Minimap />);
    fireEvent.click(screen.getByRole("button", { name: "Hide minimap" }));
    expect(getPreference(minimapCardPreference)).toBe("hidden");
    act(() => setPreference(minimapCardPreference, "open"));
    expect(screen.getByText("minimap body").parentElement?.hidden).toBe(false);
  });

  it("show as stored on desktop", () => {
    render(<Minimap />);
    expect(screen.getByText("minimap body").parentElement?.hidden).toBe(false);
  });
});
