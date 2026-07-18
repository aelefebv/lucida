// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingPortalSurface } from "./FloatingSurface.tsx";
import { useFloatingSurfacePlacement } from "./useFloatingSurfacePlacement.ts";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function ClippedAnchoredSurface() {
  const { surfaceRef, placement, maxSize } = useFloatingSurfacePlacement({
    parentAnchor: true,
    coordinateSpace: "anchor",
    fallbackSize: { width: 240, height: 280 },
  });
  return (
    <div data-testid="paint-clip" style={{ overflow: "hidden" }}>
      <div data-testid="inline-anchor">
        <div
          ref={surfaceRef}
          data-testid="inline-surface"
          style={{
            position: "absolute",
            left: placement.left,
            top: placement.top,
            maxWidth: maxSize?.width,
            maxHeight: maxSize?.height,
          }}
        >
          Oversized inline surface
        </div>
      </div>
    </div>
  );
}

function DeferredSafeRegionSurface() {
  const { surfaceRef, placement } = useFloatingSurfacePlacement({
    parentAnchor: true,
    coordinateSpace: "anchor",
    fallbackSize: { width: 240, height: 152 },
  });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const obstacle = document.querySelector<HTMLElement>("[data-testid='deferred-obstacle']");
      obstacle?.style.removeProperty("display");
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      <div data-testid="deferred-wrapper">
        <button type="button" data-testid="deferred-anchor" data-floating-anchor>Anchor</button>
        <div
          ref={surfaceRef}
          data-testid="deferred-surface"
          style={{ position: "absolute", left: placement.left, top: placement.top }}
        >
          Surface
        </div>
      </div>
      <div
        data-testid="deferred-obstacle"
        data-floating-safe-region
        style={{ display: "none" }}
      >
        Minimap
      </div>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("FloatingPortalSurface", () => {
  it("hides and inerts a surface while its measurable anchor is fully offscreen", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    let anchorRect = rect(2_000, 20, 80, 32);
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => anchorRect);

    render(
      <FloatingPortalSurface
        anchorElement={anchor}
        fallbackSize={{ width: 200, height: 100 }}
        data-testid="surface"
      >
        Surface
      </FloatingPortalSurface>,
    );

    const surface = screen.getByTestId("surface");
    await waitFor(() => expect(surface.hidden).toBe(true));
    expect(surface.getAttribute("aria-hidden")).toBe("true");
    expect(surface.hasAttribute("inert")).toBe(true);
    expect(surface.dataset.anchorHidden).toBe("true");

    anchorRect = rect(40, 40, 80, 32);
    await act(async () => window.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(surface.hidden).toBe(false));
    expect(surface.hasAttribute("aria-hidden")).toBe(false);
    expect(surface.hasAttribute("inert")).toBe(false);
    expect(surface.dataset.anchorHidden).toBeUndefined();
  });

  it("preserves trigger focus across transient clipping when no stable fallback is declared", async () => {
    const anchor = document.createElement("button");
    anchor.textContent = "Toolbar trigger";
    document.body.append(anchor);
    let anchorRect = rect(40, 40, 80, 32);
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => anchorRect);

    render(
      <FloatingPortalSurface
        anchorElement={anchor}
        fallbackSize={{ width: 200, height: 100 }}
        data-testid="surface"
      >
        Surface
      </FloatingPortalSurface>,
    );
    anchor.focus();
    anchorRect = rect(2_000, 20, 80, 32);
    await act(async () => window.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(screen.getByTestId("surface").hidden).toBe(true));

    expect(document.activeElement).toBe(anchor);
  });

  it("does not hide zero-layout happy-dom anchors whose visibility is unknown", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);

    render(
      <FloatingPortalSurface
        anchorElement={anchor}
        fallbackSize={{ width: 200, height: 100 }}
        data-testid="surface"
      >
        Surface
      </FloatingPortalSurface>,
    );

    expect(screen.getByTestId("surface").hidden).toBe(false);
  });

  it("hides a surface whose anchor has been detached", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);

    render(
      <FloatingPortalSurface
        anchorElement={anchor}
        fallbackSize={{ width: 200, height: 100 }}
        data-testid="surface"
      >
        Surface
      </FloatingPortalSurface>,
    );
    expect(screen.getByTestId("surface").hidden).toBe(false);

    anchor.remove();
    await act(async () => window.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(screen.getByTestId("surface").hidden).toBe(true));
  });

  it("hides and inerts a surface for a CSS-hidden anchor and evacuates focus", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(40, 40, 80, 32));

    render(
      <FloatingPortalSurface
        anchorElement={anchor}
        fallbackSize={{ width: 200, height: 100 }}
        data-testid="surface"
      >
        <button type="button">Surface action</button>
      </FloatingPortalSurface>,
    );

    const surface = screen.getByTestId("surface");
    const action = screen.getByRole("button", { name: "Surface action" });
    action.focus();
    expect(document.activeElement).toBe(action);

    anchor.style.contentVisibility = "hidden";
    await act(async () => window.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(surface.hidden).toBe(true));

    expect(surface.getAttribute("aria-hidden")).toBe("true");
    expect(surface.hasAttribute("inert")).toBe(true);
    expect(surface.contains(document.activeElement)).toBe(false);
  });

  it("caps an oversized portaled surface to the painted viewport boundary", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(180);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(120);
    const anchor = document.createElement("button");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(20, 20, 40, 30));

    render(
      <FloatingPortalSurface
        anchorElement={anchor}
        fallbackSize={{ width: 500, height: 400 }}
        data-testid="surface"
      >
        Oversized surface
      </FloatingPortalSurface>,
    );

    const surface = screen.getByTestId("surface");
    await waitFor(() => expect(surface.style.maxWidth).toBe("164px"));
    expect(surface.style.maxHeight).toBe("104px");
    expect(surface.style.left).toBe("8px");
    expect(surface.style.top).toBe("8px");
    expect(surface.style.overflow).toBe("auto");
  });

  it("caps an oversized anchored surface to its painted ancestor clip", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      switch (this.dataset.testid) {
        case "paint-clip":
          return rect(30, 20, 100, 80);
        case "inline-anchor":
          return rect(40, 30, 10, 10);
        case "inline-surface":
          return rect(0, 0, 240, 280);
        default:
          return rect(0, 0, 0, 0);
      }
    });

    render(<ClippedAnchoredSurface />);

    const surface = screen.getByTestId("inline-surface");
    await waitFor(() => expect(surface.style.maxWidth).toBe("84px"));
    expect(surface.style.maxHeight).toBe("64px");
  });

  it("rechecks placement after a sibling layout owner reveals a safe region", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      switch (this.dataset.testid) {
        case "deferred-anchor":
          return rect(634, 165, 24, 24);
        case "deferred-wrapper":
          return rect(646, 177, 0, 0);
        case "deferred-surface":
          return rect(668, 199, 240, 152);
        case "deferred-obstacle":
          return rect(745, 327, 202, 202);
        default:
          return rect(0, 0, 0, 0);
      }
    });

    render(<DeferredSafeRegionSurface />);
    const surface = screen.getByTestId("deferred-surface");
    await waitFor(() => expect(surface.style.top).toBe("22px"));

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await waitFor(() => expect(surface.style.top).toBe("-12px"));
  });
});
