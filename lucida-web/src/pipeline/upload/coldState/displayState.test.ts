/**
 * Unit tests for `buildDisplayStateByChannel`.
 *
 * Slice 6a (PRD #607): pure-function builder extracted from
 * `Orchestrator.sendColdState`. The build is testable with no mocks.
 *
 * Contract under test:
 *   - For each visible channel, a `ColdStateDisplayState` is produced
 *     keyed by the channel index.
 *   - Per-channel overrides (`channel_settings[ch]`) win over dataset-level
 *     `contrast_min` / `contrast_max` / `gamma`; `colormap` falls back to
 *     `"gray"`.
 *   - `opacity` is dataset-level only (no per-channel override).
 *   - Missing `dsSettings` → defaults `contrastMin=0`, `contrastMax=65535`,
 *     `gamma=1`, `opacity=1`, `colormapName="gray"`.
 *   - `channelMask = 1 << (ch & 31)`.
 *   - Empty `visibleChannels` → empty record.
 */
import { describe, it, expect } from "vitest";
import type { DatasetSettings, ChannelSettingsJS } from "../../../tickCommon.ts";
import { buildDisplayStateByChannel } from "./displayState.ts";

function makeChannelSettings(over: Partial<ChannelSettingsJS> = {}): ChannelSettingsJS {
  return {
    visible: true,
    colormap: "gray",
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    ...over,
  };
}

function makeDsSettings(over: Partial<DatasetSettings> = {}): DatasetSettings {
  return {
    visible: true,
    opacity: 1,
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    blend_mode: "alpha",
    channel_settings: [],
    channel_blend_mode: "additive",
    ...over,
  };
}

describe("buildDisplayStateByChannel", () => {
  it("falls back to dataset-level contrast/gamma for a single channel with no override", () => {
    const ds = makeDsSettings({
      opacity: 0.75,
      contrast_min: 100,
      contrast_max: 4096,
      gamma: 1.8,
      // No per-channel overrides — channel_settings is empty.
    });
    const out = buildDisplayStateByChannel([0], ds);

    expect(Object.keys(out)).toEqual(["0"]);
    const ch0 = out[0];
    expect(ch0.contrastMin).toBe(100);
    expect(ch0.contrastMax).toBe(4096);
    expect(ch0.gamma).toBeCloseTo(1.8);
    expect(ch0.opacity).toBeCloseTo(0.75);
    expect(ch0.colormapName).toBe("gray"); // default colormap
    expect(ch0.channelMask).toBe(1); // 1 << 0
  });

  it("multi-channel: each visible channel gets its own override (colormap, contrast, gamma)", () => {
    const ds = makeDsSettings({
      opacity: 0.5,
      contrast_min: 0,
      contrast_max: 1000,
      gamma: 1,
      channel_settings: [
        makeChannelSettings({ colormap: "viridis", contrast_min: 10, contrast_max: 100, gamma: 2 }),
        makeChannelSettings({ colormap: "magma", contrast_min: 20, contrast_max: 200, gamma: 0.8 }),
        makeChannelSettings({ colormap: "plasma", contrast_min: 30, contrast_max: 300, gamma: 1.5 }),
      ],
    });
    const out = buildDisplayStateByChannel([0, 2], ds);

    // Only channels 0 and 2 in the output — channel 1 was not visible.
    expect(Object.keys(out).sort()).toEqual(["0", "2"]);

    expect(out[0].colormapName).toBe("viridis");
    expect(out[0].contrastMin).toBe(10);
    expect(out[0].contrastMax).toBe(100);
    expect(out[0].gamma).toBeCloseTo(2);
    expect(out[0].opacity).toBeCloseTo(0.5); // dataset-level
    expect(out[0].channelMask).toBe(1 << 0);

    expect(out[2].colormapName).toBe("plasma");
    expect(out[2].contrastMin).toBe(30);
    expect(out[2].contrastMax).toBe(300);
    expect(out[2].gamma).toBeCloseTo(1.5);
    expect(out[2].opacity).toBeCloseTo(0.5);
    expect(out[2].channelMask).toBe(1 << 2);
  });

  it("missing dsSettings → defaults (contrast 0..65535, gamma 1, opacity 1, colormap 'gray')", () => {
    const out = buildDisplayStateByChannel([0, 1], undefined);

    expect(Object.keys(out).sort()).toEqual(["0", "1"]);
    for (const ch of [0, 1]) {
      expect(out[ch].contrastMin).toBe(0);
      expect(out[ch].contrastMax).toBe(65535);
      expect(out[ch].gamma).toBe(1);
      expect(out[ch].opacity).toBe(1);
      expect(out[ch].colormapName).toBe("gray");
    }
    expect(out[0].channelMask).toBe(1);
    expect(out[1].channelMask).toBe(2);
  });

  it("empty visibleChannels → empty record", () => {
    const ds = makeDsSettings();
    const out = buildDisplayStateByChannel([], ds);
    expect(Object.keys(out)).toEqual([]);
  });
});
