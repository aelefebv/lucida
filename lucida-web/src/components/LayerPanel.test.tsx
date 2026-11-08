// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayerPanel, type LayerChannel, type LayerInfo } from "./LayerPanel.tsx";
import { __resetShortcutsForTesting, listShortcuts } from "../ui/shortcuts.ts";
import { __resetCommandsForTesting, listCommands } from "../ui/commands.ts";
import { resolvedLayer, resolvedLayers } from "../resolvedLayerFixtures.ts";
import type { ResolvedLayers } from "../resolvedLayers.ts";

/** The scene soloing `channel` of a three-channel layer `id`. */
function soloOn(id: string, channel: number): ResolvedLayers {
  return resolvedLayers(resolvedLayer(id, [channel], { solo: channel, channel_count: 3 }));
}

function channel(overrides: Partial<LayerChannel> = {}): LayerChannel {
  return {
    name: "Channel 1",
    nameOverride: null,
    inheritedName: "Channel 1",
    visible: true,
    colormap: "magenta",
    contrastMin: 0,
    contrastMax: 65535,
    gamma: 1,
    dataRange: null,
    ...overrides,
  };
}

/** `count` channels named `Channel n`, all visible. */
function channels(count: number, colormaps = ["magenta", "green", "cyan"]): LayerChannel[] {
  return Array.from({ length: count }, (_, i) =>
    channel({ name: `Channel ${i + 1}`, inheritedName: `Channel ${i + 1}`, colormap: colormaps[i % 3] }),
  );
}

function layer(overrides: Partial<LayerInfo> = {}): LayerInfo {
  return {
    id: "wds-1",
    name: "original.zarr",
    visible: true,
    opacity: 1,
    channels: [channel()],
    autoContrast: true,
    valueRange: [0, 65535],
    integerData: true,
    blendMode: "alpha",
    renderMode: "translucent",
    channelBlendMode: "additive",
    levelPin: null,
    levelPinOptions: [],
    targetLevel: null,
    displayedLevel: null,
    displayedCoarserThanTarget: false,
    downsamplingMethod: null,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof LayerPanel>[0]> = {}) {
  return {
    layers: [layer()],
    selectedLayerId: null as string | null,
    expandedLayerId: null as string | null,
    resolvedLayers: resolvedLayers() as ResolvedLayers,
    canEdit: true,
    onSelectLayer: vi.fn(),
    onToggleExpand: vi.fn(),
    onSetVisible: vi.fn(),
    onSetOpacity: vi.fn(),
    onRenameLayer: vi.fn(),
    onMoveLayer: vi.fn(),
    onRemoveLayer: vi.fn(),
    onAddData: vi.fn(),
    onSetBlendMode: vi.fn(),
    onSetRenderMode: vi.fn(),
    onSetLevelPin: vi.fn(),
    onAutoContrastChange: vi.fn(),
    onChannelSetVisible: vi.fn(),
    onChannelSetColormap: vi.fn(),
    onChannelSetName: vi.fn(),
    onChannelSetContrast: vi.fn(),
    onChannelSetGamma: vi.fn(),
    onChannelAutoFit: vi.fn(),
    onChannelSetBlendMode: vi.fn(),
    onSoloChannel: vi.fn(),
    onShowAllChannels: vi.fn(),
    onLabelSetVisible: vi.fn(),
    onLabelSetOpacity: vi.fn(),
    layoutRegistry: null,
    sendCommand: vi.fn(),
    ...overrides,
  };
}

/** Expanded, selected, with three channels. */
function multichannelProps(overrides: Partial<Parameters<typeof LayerPanel>[0]> = {}) {
  return baseProps({
    layers: [layer({ channels: channels(3) })],
    selectedLayerId: "wds-1",
    expandedLayerId: "wds-1",
    ...overrides,
  });
}

async function openMenu(name: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("menu");
}

async function openAdvanced() {
  await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
}

afterEach(() => {
  cleanup();
  __resetShortcutsForTesting();
  __resetCommandsForTesting();
});

describe("LayerPanel header", () => {
  it("offers Add data, which calls the handler", async () => {
    const props = baseProps();
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Add data" }));
    expect(props.onAddData).toHaveBeenCalledTimes(1);
  });

  it("offers Add data in the empty state too", async () => {
    const props = baseProps({ layers: [] });
    render(<LayerPanel {...props} />);
    expect(screen.getByText("No layers yet.")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: "Add data" })[1]);
    expect(props.onAddData).toHaveBeenCalledTimes(1);
  });
});

describe("LayerPanel layer row", () => {
  it("names every control", () => {
    render(<LayerPanel {...multichannelProps()} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
    }
  });

  it("toggles visibility and labels the opacity slider", async () => {
    const props = baseProps();
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Hide layer original.zarr" }));
    expect(props.onSetVisible).toHaveBeenCalledWith("wds-1", false);
    expect(screen.getByRole("slider", { name: "Opacity" })).toBeTruthy();
  });

  it("moves and removes the layer from its menu", async () => {
    const props = baseProps({ layers: [layer(), layer({ id: "wds-2", name: "second.zarr" })] });
    render(<LayerPanel {...props} />);

    let menu = await openMenu("More for layer original.zarr");
    expect(within(menu).getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move down" }));
    expect(props.onMoveLayer).toHaveBeenCalledWith("wds-1", "down");

    menu = await openMenu("More for layer second.zarr");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove" }));
    expect(props.onRemoveLayer).toHaveBeenCalledWith("wds-2");
  });
});

describe("LayerPanel rename", () => {
  it("offers Rename to an editor and not to a viewer", async () => {
    render(<LayerPanel {...baseProps({ canEdit: false })} />);
    const menu = await openMenu("More for layer original.zarr");
    expect(within(menu).queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("commits on Enter", async () => {
    const props = baseProps();
    render(<LayerPanel {...props} />);
    await userEvent.click(within(await openMenu("More for layer original.zarr")).getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Layer name" });
    fireEvent.change(input, { target: { value: "  Renamed Layer  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onRenameLayer).toHaveBeenCalledExactlyOnceWith("wds-1", "  Renamed Layer  ");
    expect(screen.queryByRole("textbox", { name: "Layer name" })).toBeNull();
  });

  it("cancels on Escape", () => {
    const props = baseProps();
    render(<LayerPanel {...props} />);
    fireEvent.doubleClick(screen.getByText("original.zarr"));
    const input = screen.getByRole("textbox", { name: "Layer name" });
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(props.onRenameLayer).not.toHaveBeenCalled();
    expect(screen.getByText("original.zarr")).toBeTruthy();
  });

  it("clears a channel's name override with a blank commit, and trims a new one", async () => {
    const named = channels(2);
    named[1] = channel({ name: "Custom", nameOverride: "Custom", inheritedName: "Channel 2" });
    const props = multichannelProps({ layers: [layer({ channels: named })] });
    render(<LayerPanel {...props} />);

    await userEvent.click(within(await openMenu("More for Custom")).getByRole("menuitem", { name: "Rename" }));
    let input = screen.getByRole("textbox", { name: "Channel name" }) as HTMLInputElement;
    expect(input.value).toBe("Custom");
    expect(input.placeholder).toBe("Channel 2");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onChannelSetName).toHaveBeenLastCalledWith("wds-1", 1, null);

    fireEvent.doubleClick(screen.getByText("Channel 1"));
    input = screen.getByRole("textbox", { name: "Channel name" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Signal  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onChannelSetName).toHaveBeenLastCalledWith("wds-1", 0, "Signal");
  });
});

describe("LayerPanel channels", () => {
  it("lists a row per channel for a multichannel image and none for one channel", () => {
    const { unmount } = render(<LayerPanel {...multichannelProps()} />);
    const list = screen.getByRole("group", { name: "original.zarr channels" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    unmount();

    render(<LayerPanel {...baseProps({ expandedLayerId: "wds-1" })} />);
    expect(screen.queryByRole("group", { name: "original.zarr channels" })).toBeNull();
    expect(screen.getByRole("group", { name: "original.zarr contrast" })).toBeTruthy();
  });

  it("hides and shows a channel in the composite", async () => {
    const props = multichannelProps();
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Hide Channel 2" }));
    expect(props.onChannelSetVisible).toHaveBeenCalledExactlyOnceWith("wds-1", 1, false);
    expect(props.onShowAllChannels).not.toHaveBeenCalled();
  });

  it("keeps the last visible channel on", () => {
    const one = channels(3).map((c, i) => ({ ...c, visible: i === 0 }));
    render(<LayerPanel {...multichannelProps({ layers: [layer({ channels: one })] })} />);
    expect(screen.getByRole("button", { name: "Hide Channel 1" }).hasAttribute("disabled")).toBe(true);
  });

  it("solos a channel on Alt-click", async () => {
    const props = multichannelProps();
    render(<LayerPanel {...props} />);
    const user = userEvent.setup();
    await user.keyboard("{Alt>}");
    await user.click(screen.getByRole("button", { name: "Hide Channel 2" }));
    await user.keyboard("{/Alt}");
    expect(props.onSoloChannel).toHaveBeenCalledExactlyOnceWith("wds-1", 1);
    expect(props.onChannelSetVisible).not.toHaveBeenCalled();
  });

  it("solos and un-solos from the channel menu", async () => {
    const props = multichannelProps();
    const { rerender } = render(<LayerPanel {...props} />);
    await userEvent.click(within(await openMenu("More for Channel 3")).getByRole("menuitem", { name: /^Solo/ }));
    expect(props.onSoloChannel).toHaveBeenLastCalledWith("wds-1", 2);

    rerender(<LayerPanel {...props} resolvedLayers={soloOn("wds-1", 2)} />);
    await userEvent.click(within(await openMenu("More for Channel 3")).getByRole("menuitem", { name: /^Show all channels/ }));
    expect(props.onSoloChannel).toHaveBeenLastCalledWith("wds-1", 2);
  });

  it("shows only the soloed channel as on, and returns to the composite from it", async () => {
    const props = multichannelProps({ resolvedLayers: soloOn("wds-1", 1) });
    render(<LayerPanel {...props} />);
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.getByText("Channel 2 is soloed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show Channel 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show Channel 3" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(props.onShowAllChannels).toHaveBeenCalledTimes(1);
  });

  it("showing another channel while soloed leaves solo with the two shown", async () => {
    const props = multichannelProps({ resolvedLayers: soloOn("wds-1", 1) });
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Show Channel 3" }));
    expect(vi.mocked(props.onChannelSetVisible).mock.calls).toEqual([["wds-1", 0, false]]);
    expect(props.onShowAllChannels).toHaveBeenCalledTimes(1);
  });

  it("solos per layer: another layer keeps its composite and says nothing", () => {
    const props = baseProps({
      layers: [layer({ channels: channels(3) }), layer({ id: "wds-2", name: "plain.zarr", channels: channels(2) })],
      expandedLayerId: "wds-2",
      resolvedLayers: soloOn("wds-1", 2),
    });
    render(<LayerPanel {...props} />);
    const plain = screen.getByRole("region", { name: "plain.zarr" });
    expect(within(plain).queryByText(/soloed/)).toBeNull();
    expect(within(plain).getByRole("button", { name: "Hide Channel 1" })).toBeTruthy();
    expect(within(plain).getByRole("button", { name: "Hide Channel 2" })).toBeTruthy();
  });

  it("says when the scene's z or t reaches past a layer, and what it shows instead", () => {
    const clamped = resolvedLayer("wds-2", [0], {
      z_range: { start: 9, end: 10 }, t: 0, z_clamped: true, t_clamped: true,
    });
    const props = baseProps({
      layers: [layer(), layer({ id: "wds-2", name: "plain.zarr" })],
      resolvedLayers: resolvedLayers(resolvedLayer("wds-1"), clamped),
    });
    render(<LayerPanel {...props} />);
    const plain = screen.getByRole("region", { name: "plain.zarr" });
    expect(within(plain).getByTestId("layer-clamped-wds-2").textContent).toBe(
      "Past this layer's extent; showing Z 10 · T 1.",
    );
    const original = screen.getByRole("region", { name: "original.zarr" });
    expect(within(original).queryByText(/Past this layer/)).toBeNull();
  });

  it("opens a channel's contrast without touching its visibility", async () => {
    const props = multichannelProps();
    render(<LayerPanel {...props} />);
    const toggle = screen.getByRole("button", { name: "Show Channel 2 contrast" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(screen.getByRole("group", { name: "Channel 2 contrast" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Channel 1 contrast" })).toBeNull();
    expect(props.onChannelSetVisible).not.toHaveBeenCalled();
  });

  it("picks a colormap from the swatch", async () => {
    const props = multichannelProps();
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Channel 2 colormap: Green" }));
    await userEvent.click(await screen.findByRole("option", { name: "Viridis" }));
    expect(props.onChannelSetColormap).toHaveBeenCalledWith("wds-1", 1, "viridis");
  });

  it("turns continuous auto-contrast on and off for the layer", async () => {
    const props = multichannelProps();
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByRole("switch", { name: "Keep contrast fitted" }));
    expect(props.onAutoContrastChange).toHaveBeenCalledWith("wds-1", false);
  });
});

describe("LayerPanel channel keys", () => {
  it("toggles channel n on n and solos it on Alt n, on the selected layer", async () => {
    const props = multichannelProps();
    render(<LayerPanel {...props} />);

    await act(async () => {
      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
    });
    expect(props.onChannelSetVisible).toHaveBeenCalledExactlyOnceWith("wds-1", 1, false);

    await act(async () => {
      fireEvent.keyDown(window, { key: "™", code: "Digit3", altKey: true });
    });
    expect(props.onSoloChannel).toHaveBeenCalledExactlyOnceWith("wds-1", 2);

    await act(async () => {
      fireEvent.keyDown(window, { key: "9", code: "Digit9" });
    });
    expect(props.onChannelSetVisible).toHaveBeenCalledTimes(1);
  });

  it("offers each channel's toggle and solo in the command palette and shortcut sheet, by name", () => {
    const named = channels(2);
    named[1] = channel({ name: "Signal", inheritedName: "Channel 2" });
    const { rerender } = render(<LayerPanel {...multichannelProps({ layers: [layer({ channels: named })] })} />);
    expect(listCommands().map((c) => c.label)).toEqual([
      "Show or hide Channel 1",
      "Solo Channel 1",
      "Show or hide Signal",
      "Solo Signal",
    ]);
    expect(listShortcuts().find((s) => s.id === "channels.solo2")?.keys).toEqual(["Alt+2"]);

    rerender(<LayerPanel {...multichannelProps({ layers: [layer({ channels: named })], resolvedLayers: soloOn("wds-1", 1) })} />);
    expect(listCommands().map((c) => c.label)).toContain("Show all channels");
  });

  it("names the key in the channel toggle's tooltip", () => {
    render(<LayerPanel {...multichannelProps()} />);
    expect(screen.getByRole("button", { name: "Hide Channel 1" }).getAttribute("aria-keyshortcuts")).toBe("1");
  });

  it("leaves the digits free without a multichannel layer", async () => {
    const props = baseProps();
    render(<LayerPanel {...props} />);
    const event = new KeyboardEvent("keydown", { key: "1", code: "Digit1", cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("LayerPanel labels", () => {
  const labelRows = [
    { index: 0, name: "region-a", visible: false, opacity: 0.5 },
    { index: 2, name: "", visible: true, opacity: 0.25 },
    { index: 3, name: "big", visible: false, opacity: 0.5, disabledReason: "too large to render in 3D" },
  ];

  it("counts the drawable labels on the row", () => {
    render(<LayerPanel {...baseProps({ layers: [layer({ labelRows })] })} />);
    expect(screen.getByTestId("layer-label-count-wds-1").textContent).toBe("3 labels");
  });

  it("toggles a label by its manifest index, names a blank label, and disables an inert one", async () => {
    const props = baseProps({ expandedLayerId: "wds-1", layers: [layer({ labelRows })] });
    render(<LayerPanel {...props} />);
    await userEvent.click(screen.getByTestId("label-eye-wds-1-2"));
    expect(props.onLabelSetVisible).toHaveBeenCalledWith("wds-1", 2, false);
    expect(screen.getByText("Label 2")).toBeTruthy();

    const inert = screen.getByTestId("label-eye-wds-1-3");
    expect(inert.hasAttribute("disabled")).toBe(true);
    expect(inert.getAttribute("aria-label")).toBe("original.zarr big: too large to render in 3D");
    expect(screen.getByText("too large to render in 3D")).toBeTruthy();
  });

  it("shows no Labels section or count without drawable labels", () => {
    render(<LayerPanel {...baseProps({ expandedLayerId: "wds-1" })} />);
    expect(screen.queryByTestId("labels-section-wds-1")).toBeNull();
    expect(screen.queryByTestId("layer-label-count-wds-1")).toBeNull();
  });
});

describe("LayerPanel data problems", () => {
  const shape = "tiles differ in shape, and smaller tiles are padded with fill";
  const sampled = "label discovery was sampled";

  it("marks a layer degraded and spells out what is shown wrong, collapsed or not", () => {
    const importWarnings = new Map([
      [
        "wds-1",
        [
          { target: "wds-1", message: shape, degrades: true },
          { target: "wds-1", message: sampled, degrades: false },
        ],
      ],
    ]);
    render(<LayerPanel {...baseProps({ importWarnings })} />);

    expect(screen.getByTestId("layer-degraded-wds-1").textContent).toBe("Degraded");
    const list = screen.getByRole("list", { name: "original.zarr data problems" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([shape]);
    expect(screen.queryByText(sampled)).toBeNull();
  });

  it("leaves a layer whose warnings are only informational unmarked", () => {
    const importWarnings = new Map([["wds-1", [{ target: "wds-1", message: sampled, degrades: false }]]]);
    render(<LayerPanel {...baseProps({ importWarnings })} />);

    expect(screen.queryByTestId("layer-degraded-wds-1")).toBeNull();
    expect(screen.queryByRole("list", { name: "original.zarr data problems" })).toBeNull();
  });
});

describe("LayerPanel advanced", () => {
  it("is closed by default and holds blend, channel blend, and rendering", async () => {
    render(<LayerPanel {...multichannelProps()} />);
    const toggle = screen.getByRole("button", { name: "Advanced" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Layer blend")).toBeNull();

    await openAdvanced();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("How this layer combines with the layers below it")).toBeTruthy();
    expect(screen.getByText("How this layer's channels combine with each other")).toBeTruthy();
    expect(screen.getByText("Rendering")).toBeTruthy();
  });

  it("has no channel blend for a single channel", async () => {
    render(<LayerPanel {...baseProps({ expandedLayerId: "wds-1" })} />);
    await openAdvanced();
    expect(screen.getByText("Layer blend")).toBeTruthy();
    expect(screen.queryByText("Channel blend")).toBeNull();
  });
});

describe("LayerPanel level readout", () => {
  async function renderLevels(overrides: Partial<LayerInfo>) {
    render(<LayerPanel {...baseProps({ expandedLayerId: "wds-1", layers: [layer(overrides)] })} />);
    await openAdvanced();
  }

  // Slider readouts are `<output>`s, which are status regions too.
  function levelNotice(): HTMLElement | null {
    return screen.queryAllByRole("status").find((el) => el.tagName !== "OUTPUT") ?? null;
  }

  it("shows the target level, and no notice, once the target is what is displayed", async () => {
    await renderLevels({ targetLevel: { min: 2, max: 2 }, displayedLevel: { min: 2, max: 2 } });
    expect(screen.getByLabelText("original.zarr target level").textContent).toBe("2");
    expect(screen.queryByLabelText("original.zarr displayed level")).toBeNull();
    expect(levelNotice()).toBeNull();
  });

  it("shows both levels, and a notice naming them, while a coarser level is displayed", async () => {
    await renderLevels({
      targetLevel: { min: 1, max: 1 },
      displayedLevel: { min: 3, max: 3 },
      displayedCoarserThanTarget: true,
    });
    expect(screen.getByLabelText("original.zarr target level").textContent).toBe("1");
    expect(screen.getByLabelText("original.zarr displayed level").textContent).toBe("showing 3");
    expect(levelNotice()?.textContent).toBe("Displaying level 3 where level 1 is the target.");
  });

  it("shows ranges for a collection whose tiles differ", async () => {
    await renderLevels({
      targetLevel: { min: 1, max: 3 },
      displayedLevel: { min: 1, max: 4 },
      displayedCoarserThanTarget: true,
    });
    expect(screen.getByLabelText("original.zarr target level").textContent).toBe("1-3");
    expect(levelNotice()?.textContent).toBe("Displaying levels 1-4 where levels 1-3 are the target.");
  });

  it("shows no level row before the worker has reported one", async () => {
    await renderLevels({});
    expect(screen.queryByLabelText("original.zarr target level")).toBeNull();
  });

  it("shows the downsampling method only when the metadata declares one", async () => {
    await renderLevels({ downsamplingMethod: "gaussian" });
    expect(screen.getByLabelText("original.zarr downsampling method").textContent).toBe("Downsampled by gaussian");
    cleanup();

    await renderLevels({ downsamplingMethod: null });
    expect(screen.queryByLabelText("original.zarr downsampling method")).toBeNull();
  });
});

describe("LayerPanel level pin", () => {
  const levelPinOptions = [
    { level: 0, label: "Level 0 (4096 x 4096)" },
    { level: 1, label: "Level 1 (2048 x 2048)" },
    { level: 2, label: "Level 2 (1024 x 1024)" },
  ];

  async function renderPin(levelPin: number | null, onSetLevelPin = vi.fn()) {
    render(
      <LayerPanel
        {...baseProps({ expandedLayerId: "wds-1", layers: [layer({ levelPin, levelPinOptions })], onSetLevelPin })}
      />,
    );
    await openAdvanced();
    return onSetLevelPin;
  }

  async function openPin() {
    await userEvent.click(screen.getByRole("button", { name: /level pin/ }));
    return screen.getByRole("listbox");
  }

  it("offers follow-the-screen first, then every pinnable level, level 0 included", async () => {
    await renderPin(null);
    expect(screen.getByRole("button", { name: /level pin/ }).textContent).toContain("Follow the screen");
    const options = within(await openPin()).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "Follow the screen",
      "Level 0 (4096 x 4096)",
      "Level 1 (2048 x 2048)",
      "Level 2 (1024 x 1024)",
    ]);
  });

  it("shows the current pin, level 0 included", async () => {
    await renderPin(0);
    expect(screen.getByRole("button", { name: /level pin/ }).textContent).toContain("Level 0 (4096 x 4096)");
  });

  it("pins to level 0 as the number 0, and clears the pin as null", async () => {
    const onSetLevelPin = await renderPin(2);
    await userEvent.click(within(await openPin()).getByRole("option", { name: "Level 0 (4096 x 4096)" }));
    expect(onSetLevelPin).toHaveBeenLastCalledWith("wds-1", 0);

    await userEvent.click(within(await openPin()).getByRole("option", { name: "Follow the screen" }));
    expect(onSetLevelPin).toHaveBeenLastCalledWith("wds-1", null);
  });

  it("hides the control when the dataset reports no pinnable level", async () => {
    await renderPin(null);
    cleanup();
    render(<LayerPanel {...baseProps({ expandedLayerId: "wds-1" })} />);
    await openAdvanced();
    expect(screen.queryByRole("button", { name: /level pin/ })).toBeNull();
  });
});
