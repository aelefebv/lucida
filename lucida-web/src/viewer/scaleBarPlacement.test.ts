import { describe, expect, it } from "vitest";
import { placeScaleBar, SCALE_BAR_CLEARANCE, SCALE_BAR_INSET, snapLength, type Box } from "./scaleBarPlacement.ts";

const PANE: Box = { left: 280, top: 44, right: 1352, bottom: 900 };
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

describe("placeScaleBar", () => {
  it("sits in the view's bottom-left corner when nothing covers it", () => {
    expect(placeScaleBar(PANE, 120, 23, [])).toEqual({
      left: SCALE_BAR_INSET,
      top: PANE.bottom - PANE.top - SCALE_BAR_INSET - 23,
    });
  });

  it("rises above a control under the corner, and over a stack of them", () => {
    const bottomBar = box(350, 846, 1125, 888);
    expect(placeScaleBar(PANE, 150, 23, [bottomBar])?.top).toBe(846 - SCALE_BAR_CLEARANCE - 23 - PANE.top);
    const banner = box(300, 800, 500, 830);
    expect(placeScaleBar(PANE, 150, 23, [bottomBar, banner])?.top).toBe(800 - SCALE_BAR_CLEARANCE - 23 - PANE.top);
  });

  it("ignores a control beside it and a hidden one", () => {
    const minimap = box(1138, 646, 1340, 888);
    const hidden = box(0, 0, 0, 0);
    expect(placeScaleBar(PANE, 150, 23, [minimap, hidden])?.top).toBe(PANE.bottom - PANE.top - SCALE_BAR_INSET - 23);
  });

  it("lands on a whole pixel when the pane's edge falls between them", () => {
    const pane = box(815.5, 44, 1352, 900.25);
    const at = placeScaleBar(pane, 100, 23, [])!;
    expect(Number.isInteger(pane.left + at.left)).toBe(true);
    expect(Number.isInteger(pane.top + at.top)).toBe(true);
  });

  it("gives up rather than cover a control when the view has no room", () => {
    const tall = box(280, 60, 600, 900);
    expect(placeScaleBar(PANE, 150, 23, [tall])).toBeNull();
  });
});

describe("snapLength", () => {
  it("rounds to whole pixels, never to nothing", () => {
    expect(snapLength(90.9)).toBe(91);
    expect(snapLength(52.34)).toBe(52);
    expect(snapLength(0.1)).toBe(1);
  });
});
