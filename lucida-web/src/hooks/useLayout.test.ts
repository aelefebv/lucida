// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  responsiveLayoutBounds,
  responsiveSidebarMax,
  useLayout,
} from "./useLayout.ts";

function resizeViewport(width: number, height = 860): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("responsiveLayoutBounds", () => {
  it("reserves the desktop shell and sidebar without exceeding the viewport", () => {
    const layout = responsiveLayoutBounds(1280, 720, 280);
    expect(layout).toEqual({
      canvasWidth: 952,
      canvasHeight: 460,
      sidebarVisible: true,
    });
    expect(layout.canvasWidth).toBeLessThanOrEqual(1280);
    expect(layout.canvasHeight).toBeLessThanOrEqual(720);
  });

  it("collapses the sidebar at phone width and always returns usable geometry", () => {
    const layout = responsiveLayoutBounds(390, 720, 280);
    expect(layout.sidebarVisible).toBe(false);
    expect(layout.canvasWidth).toBe(342);
    expect(layout.canvasHeight).toBe(460);
    expect(layout.canvasWidth).toBeGreaterThan(0);
    expect(layout.canvasHeight).toBeGreaterThan(0);
  });

  it("uses the exact viewport in capture mode", () => {
    expect(responsiveLayoutBounds(1920, 1080, 280, true)).toEqual({
      canvasWidth: 1920,
      canvasHeight: 1080,
      sidebarVisible: false,
    });
  });

  it("sanitizes invalid and zero-sized viewport measurements", () => {
    const layout = responsiveLayoutBounds(Number.NaN, 0, Number.NaN);
    expect(Number.isFinite(layout.canvasWidth)).toBe(true);
    expect(Number.isFinite(layout.canvasHeight)).toBe(true);
    expect(layout.canvasWidth).toBeGreaterThan(0);
    expect(layout.canvasHeight).toBeGreaterThan(0);
  });
});

describe("responsiveSidebarMax", () => {
  it("reports the same narrow-desktop maximum enforced by resizing", () => {
    expect(responsiveSidebarMax(801)).toBe(441);
    expect(responsiveSidebarMax(959)).toBe(599);
    expect(responsiveSidebarMax(1280)).toBe(600);
  });
});

describe("useLayout responsive preferences", () => {
  it("clamps a wide sidebar on a narrower desktop and restores its preference", () => {
    resizeViewport(1280);
    const loopRef = { current: { markInteractiveDirty: vi.fn() } };
    const { result } = renderHook(() => useLayout({ loopRef: loopRef as never }));

    act(() => result.current.handleSidebarResizeKeyDown({
      key: "End",
      shiftKey: false,
      preventDefault: vi.fn(),
    } as never));
    expect(result.current.sidebarWidth).toBe(600);

    act(() => resizeViewport(900));
    expect(result.current.sidebarWidth).toBe(540);
    expect(result.current.sidebarWidth).toBeLessThanOrEqual(result.current.sidebarMaxWidth);

    act(() => resizeViewport(1280));
    expect(result.current.sidebarWidth).toBe(600);
  });

  it("regrows the default canvas after a narrow viewport expands", () => {
    resizeViewport(390, 720);
    const loopRef = { current: { markInteractiveDirty: vi.fn() } };
    const { result } = renderHook(() => useLayout({ loopRef: loopRef as never }));
    expect(result.current.canvasWidth).toBe(342);

    act(() => resizeViewport(1280, 860));
    expect(result.current.canvasWidth).toBe(800);
    expect(result.current.canvasHeight).toBe(600);
  });

  it("updates exposed bounds even when preferred dimensions still fit", () => {
    resizeViewport(900, 900);
    const loopRef = { current: { markInteractiveDirty: vi.fn() } };
    const { result } = renderHook(() => useLayout({ loopRef: loopRef as never }));
    expect(result.current.sidebarWidth).toBe(280);
    expect(result.current.sidebarMaxWidth).toBe(540);

    act(() => resizeViewport(910, 850));
    expect(result.current.sidebarWidth).toBe(280);
    expect(result.current.sidebarMaxWidth).toBe(550);
    expect(result.current.canvasMaxHeight).toBe(590);
  });
});
