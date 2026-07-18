import { describe, expect, it } from "vitest";
import {
  resolveFloatingPlacement,
  resolveFloatingViewportPlacement,
} from "./floatingPlacement.ts";

describe("resolveFloatingPlacement", () => {
  it("places a surface after and below an anchor when there is room", () => {
    const anchor = { left: 100, top: 80, right: 140, bottom: 110, width: 40, height: 30 };
    expect(resolveFloatingPlacement(anchor, { width: 120, height: 90 }, { width: 800, height: 600 }))
      .toEqual({ left: 50, top: 40 });
  });

  it("flips before and above an anchor near the lower-right edge", () => {
    const anchor = { left: 750, top: 550, right: 780, bottom: 580, width: 30, height: 30 };
    expect(resolveFloatingPlacement(anchor, { width: 180, height: 120 }, { width: 800, height: 600 }))
      .toEqual({ left: -190, top: -130 });
  });

  it("clamps an oversized surface to the safe boundary padding", () => {
    const anchor = { left: 2, top: 3, right: 12, bottom: 13, width: 10, height: 10 };
    expect(resolveFloatingPlacement(anchor, { width: 500, height: 400 }, { width: 320, height: 240 }))
      .toEqual({ left: 6, top: 5 });
  });

  it("exposes the same policy in viewport coordinates for portaled surfaces", () => {
    const anchor = { left: 750, top: 550, right: 780, bottom: 580, width: 30, height: 30 };
    expect(resolveFloatingViewportPlacement(
      anchor,
      { width: 180, height: 120 },
      { width: 800, height: 600 },
    )).toEqual({ left: 560, top: 420 });
  });

  it("clamps to a zoomed visual viewport including its pan offset", () => {
    const anchor = { left: 100, top: 50, right: 110, bottom: 60, width: 10, height: 10 };
    expect(resolveFloatingViewportPlacement(
      anchor,
      { width: 240, height: 160 },
      { left: 120, top: 80, width: 800, height: 560 },
    )).toEqual({ left: 128, top: 88 });
  });

  it("moves away from shared safe regions instead of covering a toolbar", () => {
    const anchor = { left: 463, top: 634, right: 598, bottom: 665, width: 135, height: 31 };
    const toolbar = { left: 744, top: 516, right: 805, bottom: 548, width: 61, height: 32 };
    const placed = resolveFloatingViewportPlacement(
      anchor,
      { width: 322, height: 99 },
      { width: 1280, height: 720 },
      10,
      8,
      [toolbar],
    );
    const right = placed.left + 322;
    const bottom = placed.top + 99;
    const overlaps = placed.left < toolbar.right
      && right > toolbar.left
      && placed.top < toolbar.bottom
      && bottom > toolbar.top;
    expect(overlaps).toBe(false);
  });

  it("can move beyond the adjacent anchor slot on a dense narrow toolbar", () => {
    const anchor = { left: 12, top: 750, right: 147, bottom: 781, width: 135, height: 31 };
    const safeRegions = [
      { left: 12, top: 632, right: 285, bottom: 664, width: 273, height: 32 },
      { left: 293, top: 633, right: 354, bottom: 664, width: 61, height: 31 },
      { left: 12, top: 672, right: 118, bottom: 703, width: 106, height: 31 },
    ];
    const placed = resolveFloatingViewportPlacement(
      anchor,
      { width: 322, height: 99 },
      { width: 390, height: 844 },
      10,
      8,
      safeRegions,
    );
    const candidate = {
      left: placed.left,
      top: placed.top,
      right: placed.left + 322,
      bottom: placed.top + 99,
    };
    expect(safeRegions.every((safe) => (
      candidate.right <= safe.left
      || candidate.left >= safe.right
      || candidate.bottom <= safe.top
      || candidate.top >= safe.bottom
    ))).toBe(true);
  });
});
