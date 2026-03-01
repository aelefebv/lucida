import { describe, expect, it } from "vitest";

import { buildMinimapState, computeViewportRect, selectOverviewLayer } from "../src/minimap";

describe("minimap overlays", () => {
  it("prefers pinned overview layer when present", () => {
    const selected = selectOverviewLayer(
      [
        { layerId: "lay_a", name: "A", sourceId: "src_a" },
        { layerId: "lay_b", name: "B", sourceId: "src_b" },
      ],
      "lay_b",
      "lay_a",
    );
    expect(selected).toBe("lay_b");
  });

  it("tracks viewport rectangle against current zoom and center", () => {
    const rect = computeViewportRect(1000, 500, {
      centerX: 600,
      centerY: 250,
      zoom: 2,
    });
    expect(rect.width).toBe(500);
    expect(rect.height).toBe(250);
    expect(rect.x).toBe(350);
    expect(rect.y).toBe(125);
  });

  it("builds minimap state with z indicator", () => {
    const state = buildMinimapState(
      [{ layerId: "lay_main", name: "Main", sourceId: "src_main" }],
      null,
      "lay_main",
      1024,
      1024,
      {
        centerX: 512,
        centerY: 512,
        zoom: 4,
      },
      7,
      16,
    );
    expect(state.overviewLayerId).toBe("lay_main");
    expect(state.zIndicatorLabel).toBe("z 7 / 15");
    expect(state.viewportRect.width).toBe(256);
  });
});
