// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import type { ClientId, PresenceState } from "../bridge.ts";
import { minimapCardPreference } from "../components/canvasCards.ts";
import { PeerStore } from "../peerStore.ts";
import { themePreference } from "../theme/appearance.ts";
import {
  __resetPreferencesForTesting,
  developerToolsPreference,
  getPreference,
  setPreference,
} from "../theme/preferences.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { CanvasStage } from "./CanvasStage.tsx";
import { leftPanelOpenPreference, leftPanelWidthPreference } from "./layoutPreferences.ts";
import { LeftPanel } from "./LeftPanel.tsx";
import { CompactPresence, PresenceAvatars } from "./PresenceAvatars.tsx";
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

  it("hides a canvas card and brings it back whole", async () => {
    setPreference(minimapCardPreference, "collapsed");
    render(<SettingsMenu />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const minimap = within(dialog).getByRole("switch", { name: "Minimap" });

    await act(async () => {
      fireEvent.click(minimap);
    });
    expect(getPreference(minimapCardPreference)).toBe("hidden");
    await act(async () => {
      fireEvent.click(minimap);
    });
    expect(getPreference(minimapCardPreference)).toBe("open");
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
    expect(screen.getByRole("complementary", { name: "Layers" }).style.getPropertyValue("--left-panel-width")).toBe(
      "200px",
    );
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
        label="2D view of sample"
        slots={{ "top-center": <span>banner</span>, "bottom-right": <span>minimap</span> }}
      >
        <span>layer</span>
      </CanvasStage>,
    );
    expect(container.querySelector(".viewer-canvas-wrap > canvas:first-child")).toBeTruthy();
    expect(screen.getByText("banner").parentElement?.dataset.slot).toBe("top-center");
    expect(screen.getByText("minimap").parentElement?.dataset.slot).toBe("bottom-right");
  });

  it("names the canvas for assistive technology", () => {
    render(<CanvasStage canvasRef={createRef<HTMLCanvasElement>()} canvasKey={0} pixelated label="2D view of sample" />);
    expect(screen.getByRole("img", { name: "2D view of sample" }).tagName).toBe("CANVAS");
  });

  it("marks the capture surface bare", () => {
    const { container } = render(
      <CanvasStage canvasRef={createRef<HTMLCanvasElement>()} canvasKey={0} pixelated bare label="Empty view" />,
    );
    expect(container.querySelector(".lc-canvas-stage")?.hasAttribute("data-bare")).toBe(true);
  });

  it("reports a pixel ratio change at the same CSS size, and re-arms for the next one", () => {
    const ratio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    // One fake query per call, holding its listeners, so the test can fire
    // the change a display switch or a browser zoom would.
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    vi.spyOn(window, "matchMedia").mockImplementation((media: string) => {
      const query = { media, listeners: new Set<() => void>() };
      queries.push(query);
      return {
        media,
        matches: true,
        addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
      } as unknown as MediaQueryList;
    });
    const armed = () => queries.filter((query) => query.listeners.size > 0);
    const changeRatio = (value: number) => {
      Object.defineProperty(window, "devicePixelRatio", { value, configurable: true });
      for (const query of armed()) for (const listener of [...query.listeners]) listener();
    };
    try {
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
      const onResize = vi.fn();
      render(
        <CanvasStage canvasRef={createRef<HTMLCanvasElement>()} canvasKey={0} pixelated onResize={onResize} label="2D view of sample" />,
      );
      expect(armed().map((query) => query.media)).toEqual(["(resolution: 1dppx)"]);
      const before = onResize.mock.calls.length;

      changeRatio(2);
      expect(onResize).toHaveBeenCalledTimes(before + 1);
      expect(armed().map((query) => query.media)).toEqual(["(resolution: 2dppx)"]);

      changeRatio(1);
      expect(onResize).toHaveBeenCalledTimes(before + 2);
      expect(armed().map((query) => query.media)).toEqual(["(resolution: 1dppx)"]);
    } finally {
      if (ratio) Object.defineProperty(window, "devicePixelRatio", ratio);
      vi.restoreAllMocks();
    }
  });
});

function peer(id: number, following: ClientId | null = null): PresenceState {
  return {
    client_id: id,
    camera: {},
    view: { z: { start: 0, end: 1 }, t: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    following,
    cursor: null,
    dataset_order: [],
    dataset_settings: {},
    identity: { display_name: `Person ${id}` },
  };
}

function peerStore(peers: Map<ClientId, PresenceState>, followTarget: ClientId | null = null): PeerStore {
  const store = new PeerStore();
  store.setPeers(peers);
  store.setFollowTarget(followTarget);
  return store;
}

describe("PresenceAvatars", () => {
  it("shows nothing when nobody else is here", () => {
    const { container } = render(<PresenceAvatars peerStore={peerStore(new Map())} onFollow={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("won't follow someone who is following, and collapses a crowd into a menu", () => {
    const onFollow = vi.fn();
    const peers = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, peer(id, id === 2 ? 1 : null)]));
    render(<PresenceAvatars peerStore={peerStore(peers)} onFollow={onFollow} />);

    const busy = screen.getByRole("button", { name: "Person 2 is following someone" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Follow Person 1" }));
    expect(onFollow).toHaveBeenCalledWith(1);
    // Four avatars and a "+2" for the rest.
    expect(screen.getAllByRole("button", { name: /Follow Person|following someone/ })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "+2" })).toBeTruthy();
  });
});

describe("CompactPresence", () => {
  it("shows nothing when nobody else is here", () => {
    const { container } = render(<CompactPresence peerStore={peerStore(new Map())} onFollow={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("is one button that counts everyone and follows from its menu", async () => {
    const onFollow = vi.fn();
    const peers = new Map([1, 2, 3].map((id) => [id, peer(id, id === 2 ? 1 : null)]));
    render(<CompactPresence peerStore={peerStore(peers)} onFollow={onFollow} />);

    const trigger = screen.getByRole("button", { name: "3 other people here" });
    expect(trigger.textContent).toContain("+1");
    await act(async () => {
      fireEvent.click(trigger);
    });
    const busy = await screen.findByRole("menuitem", { name: "Person 2 is following someone" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Follow Person 3" }));
    });
    expect(onFollow).toHaveBeenCalledWith(3);
  });

  it("names whom it follows, and stops from the menu", async () => {
    const onFollow = vi.fn();
    const peers = new Map([1, 2].map((id) => [id, peer(id, null)]));
    render(<CompactPresence peerStore={peerStore(peers, 2)} onFollow={onFollow} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Following Person 2, 2 other people here" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Stop following Person 2" }));
    });
    expect(onFollow).toHaveBeenCalledWith(null);
  });
});
