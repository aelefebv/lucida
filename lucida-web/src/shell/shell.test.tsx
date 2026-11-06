// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import type { ClientId, PresenceState } from "../bridge.ts";
import { themePreference } from "../theme/appearance.ts";
import {
  __resetPreferencesForTesting,
  developerToolsPreference,
  getPreference,
} from "../theme/preferences.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { CanvasStage } from "./CanvasStage.tsx";
import { leftPanelOpenPreference, leftPanelWidthPreference } from "./layoutPreferences.ts";
import { LeftPanel } from "./LeftPanel.tsx";
import { PresenceAvatars } from "./PresenceAvatars.tsx";
import { SettingsMenu } from "./SettingsMenu.tsx";

// The palette comes from the wasm module, which these tests never load.
vi.mock("../peerColor.ts", () => ({ peerColor: () => "#4ecdc4" }));

// The segmented control's selection indicator animates through the Web
// Animations API, which happy-dom lacks.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", { value: () => [] });
}

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

afterEach(() => {
  cleanup();
  __resetShortcutsForTesting();
});

describe("SettingsMenu", () => {
  it("writes each choice to its preference as it changes", async () => {
    render(<SettingsMenu />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("radio", { name: "Light" }));
    });
    expect(getPreference(themePreference)).toBe("light");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("switch", { name: /Developer tools/ }));
    });
    expect(getPreference(developerToolsPreference)).toBe(true);
  });
});

describe("LeftPanel", () => {
  it("resizes from the keyboard and keeps the width", () => {
    render(
      <LeftPanel label="Layers">
        <div>content</div>
      </LeftPanel>,
    );
    const handle = screen.getByRole("separator", { name: "Resize layers" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(getPreference(leftPanelWidthPreference)).toBe(296);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(getPreference(leftPanelWidthPreference)).toBe(200);
    expect(screen.getByRole("complementary", { name: "Layers" }).style.width).toBe("200px");
  });

  it("toggles on Alt+[ and stays mounted while closed", async () => {
    render(
      <LeftPanel label="Layers">
        <input aria-label="inside" />
      </LeftPanel>,
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: "[", code: "BracketLeft", altKey: true });
    });
    expect(getPreference(leftPanelOpenPreference)).toBe(false);
    expect(screen.getByLabelText("inside")).toBeTruthy();
  });
});

describe("CanvasStage", () => {
  it("puts each control in its named slot, with the canvas first", () => {
    const { container } = render(
      <CanvasStage
        canvasRef={createRef<HTMLCanvasElement>()}
        canvasKey={0}
        pixelated={false}
        slots={{ "top-center": <span>banner</span>, "bottom-right": <span>minimap</span> }}
      >
        <span>layer</span>
      </CanvasStage>,
    );
    expect(container.querySelector(".viewer-canvas-wrap > canvas:first-child")).toBeTruthy();
    expect(screen.getByText("banner").parentElement?.dataset.slot).toBe("top-center");
    expect(screen.getByText("minimap").parentElement?.dataset.slot).toBe("bottom-right");
  });

  it("marks the capture surface bare", () => {
    const { container } = render(
      <CanvasStage canvasRef={createRef<HTMLCanvasElement>()} canvasKey={0} pixelated bare />,
    );
    expect(container.querySelector(".lc-canvas-stage")?.hasAttribute("data-bare")).toBe(true);
  });
});

function peer(id: number, following: ClientId | null = null): PresenceState {
  return {
    client_id: id,
    camera: {},
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    following,
    cursor: null,
    dataset_order: [],
    dataset_settings: {},
    identity: { display_name: `Person ${id}` },
  };
}

describe("PresenceAvatars", () => {
  it("shows nothing when nobody else is here", () => {
    const { container } = render(<PresenceAvatars peers={new Map()} followTarget={null} onFollow={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("won't follow someone who is following, and collapses a crowd into a menu", () => {
    const onFollow = vi.fn();
    const peers = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, peer(id, id === 2 ? 1 : null)]));
    render(<PresenceAvatars peers={peers} followTarget={null} onFollow={onFollow} />);

    const busy = screen.getByRole("button", { name: "Person 2 is following someone" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Follow Person 1" }));
    expect(onFollow).toHaveBeenCalledWith(1);
    // Four avatars and a "+2" for the rest.
    expect(screen.getAllByRole("button", { name: /Follow Person|following someone/ })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "+2" })).toBeTruthy();
  });
});
