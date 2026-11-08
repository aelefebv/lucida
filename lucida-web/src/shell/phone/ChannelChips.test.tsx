// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayerChannel, LayerInfo } from "../../components/LayerPanel.tsx";
import { ChannelChips } from "./ChannelChips.tsx";
import { resolvedLayer, resolvedLayers } from "../../resolvedLayerFixtures.ts";

vi.mock("../../colormaps.ts", () => ({ getColormapData: () => new Uint8Array(256 * 4) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function channel(name: string, visible = true): LayerChannel {
  return {
    name,
    nameOverride: null,
    inheritedName: name,
    visible,
    colormap: "gray",
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    dataRange: null,
  };
}

function layer(id: string, channels: LayerChannel[]): LayerInfo {
  return {
    id,
    name: id,
    visible: true,
    opacity: 1,
    channels,
    autoContrast: false,
    valueRange: [0, 255],
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
  };
}

function setup(layers: LayerInfo[], soloChannel: number | null = null) {
  const handlers = {
    onChannelSetVisible: vi.fn(),
    onSoloChannel: vi.fn(),
    onShowAllChannels: vi.fn(),
  };
  // The chips read solo from the scene's resolved layers.
  const resolved = resolvedLayers(
    ...layers.map((l) => resolvedLayer(l.id, [0], { solo: soloChannel, channel_count: l.channels.length })),
  );
  render(<ChannelChips layers={layers} selectedLayerId={null} resolvedLayers={resolved} {...handlers} />);
  return handlers;
}

describe("ChannelChips", () => {
  it("shows a chip per channel of the first layer with several, pressed when shown", () => {
    setup([layer("single", [channel("Only")]), layer("multi", [channel("A"), channel("B", false)])]);
    expect(screen.getByRole("group", { name: "multi channels" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "B" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Only" })).toBeNull();
  });

  it("shows nothing for a single channel", () => {
    setup([layer("single", [channel("Only")])]);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("hides and shows a channel on a tap, as the layer panel's eye does", () => {
    const handlers = setup([layer("multi", [channel("A"), channel("B"), channel("C", false)])]);
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(handlers.onChannelSetVisible).toHaveBeenCalledWith("multi", 1, false);
    fireEvent.click(screen.getByRole("button", { name: "C" }));
    expect(handlers.onChannelSetVisible).toHaveBeenCalledWith("multi", 2, true);
    expect(handlers.onSoloChannel).not.toHaveBeenCalled();
  });

  it("solos on an Alt-click, and a tap on another channel leaves solo", () => {
    const handlers = setup([layer("multi", [channel("A"), channel("B")])], 0);
    expect(screen.getByRole("button", { name: "A, soloed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "B" }), { altKey: true });
    expect(handlers.onSoloChannel).toHaveBeenCalledWith("multi", 1);
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(handlers.onShowAllChannels).toHaveBeenCalledWith("multi");
  });

  it("solos on a long press without also toggling", () => {
    vi.useFakeTimers();
    const handlers = setup([layer("multi", [channel("A"), channel("B")])]);
    const chip = screen.getByRole("button", { name: "B" });
    fireEvent.pointerDown(chip, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerUp(chip, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.click(chip);
    expect(handlers.onSoloChannel).toHaveBeenCalledWith("multi", 1);
    expect(handlers.onChannelSetVisible).not.toHaveBeenCalled();
  });
});
