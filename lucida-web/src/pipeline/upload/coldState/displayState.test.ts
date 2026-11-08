/**
 * Unit tests for `buildDisplayStateByChannel`, the per-channel display state
 * baked into the cold-state message from the scene's resolved layer. Which
 * window and colormap win is the scene's to decide, so these check only that
 * each shown channel's resolution reaches the worker.
 */
import { describe, it, expect } from "vitest";
import { resolvedLayer, shownChannel } from "../../../resolvedLayerFixtures.ts";
import { buildDisplayStateByChannel } from "./displayState.ts";

describe("buildDisplayStateByChannel", () => {
  it("carries a lone channel's window, colormap and the layer opacity", () => {
    const layer = resolvedLayer("ds", [
      shownChannel(0, { contrast_min: 100, contrast_max: 4096, gamma: 1.8 }),
    ], { opacity: 0.75 });
    const out = buildDisplayStateByChannel(layer);

    expect(Object.keys(out)).toEqual(["0"]);
    const ch0 = out[0];
    expect(ch0.contrastMin).toBe(100);
    expect(ch0.contrastMax).toBe(4096);
    expect(ch0.gamma).toBeCloseTo(1.8);
    expect(ch0.opacity).toBeCloseTo(0.75);
    expect(ch0.colormapName).toBe("gray");
    expect(ch0.channelMask).toBe(1); // 1 << 0
  });

  it("gives each shown channel its own window and colormap, and nothing else", () => {
    const layer = resolvedLayer("ds", [
      shownChannel(0, { colormap: "viridis", contrast_min: 10, contrast_max: 100, gamma: 2 }),
      shownChannel(2, { colormap: "plasma", contrast_min: 30, contrast_max: 300, gamma: 1.5 }),
    ], { opacity: 0.5 });
    const out = buildDisplayStateByChannel(layer);

    // Channel 1 is not shown.
    expect(Object.keys(out).sort()).toEqual(["0", "2"]);

    expect(out[0].colormapName).toBe("viridis");
    expect(out[0].contrastMin).toBe(10);
    expect(out[0].contrastMax).toBe(100);
    expect(out[0].gamma).toBeCloseTo(2);
    expect(out[0].opacity).toBeCloseTo(0.5);
    expect(out[0].channelMask).toBe(1 << 0);

    expect(out[2].colormapName).toBe("plasma");
    expect(out[2].contrastMin).toBe(30);
    expect(out[2].contrastMax).toBe(300);
    expect(out[2].gamma).toBeCloseTo(1.5);
    expect(out[2].opacity).toBeCloseTo(0.5);
    expect(out[2].channelMask).toBe(1 << 2);
  });

  it("a layer the scene does not know yields an empty record", () => {
    expect(Object.keys(buildDisplayStateByChannel(undefined))).toEqual([]);
  });
});
