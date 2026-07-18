// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import {
  PersistentViewerOverlays,
} from "./PersistentViewerOverlays.tsx";
import {
  resolvePersistentOverlayLayout,
  suppressPersistentOverlayCollisions,
} from "./persistentOverlayLayout.ts";

function domRect(left: number, top: number, width: number, height: number): DOMRect {
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function intersects(
  left: { left: number; top: number; right: number; bottom: number } | null,
  right: { left: number; top: number; right: number; bottom: number } | null,
): boolean {
  return Boolean(left && right)
    && left!.left < right!.right
    && left!.right > right!.left
    && left!.top < right!.bottom
    && left!.bottom > right!.top;
}

describe("resolvePersistentOverlayLayout", () => {
  it("preserves desktop corner ownership when both surfaces fit", () => {
    const layout = resolvePersistentOverlayLayout(
      { left: 16, top: 16, width: 968, height: 568 },
      { width: 352, height: 120 },
      { width: 200, height: 200 },
    );

    expect(layout.stacked).toBe(false);
    expect(layout.collection).toMatchObject({ left: 16, bottom: 584 });
    expect(layout.minimap).toMatchObject({ right: 984, bottom: 584 });
    expect(intersects(layout.collection, layout.minimap)).toBe(false);
  });

  it("stacks a wide collection selector above the minimap in a 342px canvas", () => {
    const layout = resolvePersistentOverlayLayout(
      { left: 16, top: 16, width: 310, height: 560 },
      { width: 352, height: 148 },
      { width: 200, height: 200 },
    );

    expect(layout.stacked).toBe(true);
    expect(layout.collection).toMatchObject({ left: 16, width: 310 });
    expect(layout.collection!.bottom + 12).toBe(layout.minimap!.top);
    expect(layout.minimap).toMatchObject({ right: 326, bottom: 576 });
    expect(intersects(layout.collection, layout.minimap)).toBe(false);
  });

  it("caps selector height into its scrollport when stacked height is constrained", () => {
    const layout = resolvePersistentOverlayLayout(
      { left: 22, top: 14, width: 300, height: 320 },
      { width: 300, height: 260 },
      { width: 200, height: 200 },
    );

    expect(layout.stacked).toBe(true);
    expect(layout.collection).toMatchObject({ top: 14, height: 108 });
    expect(layout.collection!.bottom + 12).toBe(layout.minimap!.top);
    expect(intersects(layout.collection, layout.minimap)).toBe(false);
  });

  it("omits a fixed-size minimap rather than cropping it below its usable size", () => {
    const layout = resolvePersistentOverlayLayout(
      { left: 16, top: 16, width: 180, height: 500 },
      null,
      { width: 200, height: 200 },
    );

    expect(layout.minimap).toBeNull();
  });

  it("preserves interactive collection navigation over the passive minimap under height pressure", () => {
    const layout = resolvePersistentOverlayLayout(
      { left: 16, top: 16, width: 310, height: 230 },
      { width: 352, height: 148 },
      { width: 200, height: 200 },
    );

    expect(layout.collection).toMatchObject({ width: 310, height: 148 });
    expect(layout.minimap).toBeNull();
  });

  it("omits both surfaces from a one-pixel boundary", () => {
    expect(resolvePersistentOverlayLayout(
      { left: 0, top: 0, width: 1, height: 1 },
      { width: 352, height: 148 },
      { width: 200, height: 200 },
    )).toMatchObject({ collection: null, minimap: null });
  });

  it("lets a transient dialog suppress only the persistent surface it collides with", () => {
    const base = resolvePersistentOverlayLayout(
      { left: 16, top: 16, width: 658, height: 428 },
      { width: 354, height: 82 },
      { width: 202, height: 202 },
    );
    const resolved = suppressPersistentOverlayCollisions(base, [{
      left: 363,
      top: 90,
      right: 603,
      bottom: 250,
      width: 240,
      height: 160,
    }]);

    expect(resolved.collection).toEqual(base.collection);
    expect(resolved.minimap).toBeNull();
    expect(resolved.stacked).toBe(false);
  });
});

describe("PersistentViewerOverlays", () => {
  it("owns collection navigation before the minimap without intercepting the canvas", () => {
    const viewerFocusRef = createRef<HTMLCanvasElement>();
    render(
      <>
        <canvas ref={viewerFocusRef} tabIndex={0} aria-label="2D viewer" />
        <PersistentViewerOverlays
          collection={<div data-testid="collection">Collection</div>}
          minimap={<div data-testid="minimap">Minimap</div>}
          viewerFocusRef={viewerFocusRef}
        />
      </>,
    );

    const owner = screen.getByTestId("persistent-viewer-overlays");
    expect(owner.hasAttribute("data-overlay-layout")).toBe(true);
    expect(owner.children).toHaveLength(2);
    expect(owner.children[0].contains(screen.getByTestId("collection"))).toBe(true);
    expect(owner.children[1].contains(screen.getByTestId("minimap"))).toBe(true);
  });

  it("uses an overflow ancestor's visible clip as its placement boundary", () => {
    const viewerFocusRef = createRef<HTMLCanvasElement>();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "clip") return domRect(0, 0, 400, 500);
      if (this.dataset.testid === "persistent-viewer-overlays") return domRect(0, 0, 400, 800);
      if (this.classList.contains("persistent-viewer-overlay-collection")) {
        return domRect(0, 0, 300, 100);
      }
      if (this.classList.contains("persistent-viewer-overlay-minimap")) {
        return domRect(0, 0, 200, 200);
      }
      return domRect(0, 0, 0, 0);
    });

    render(
      <>
        <canvas ref={viewerFocusRef} tabIndex={0} aria-label="2D viewer" />
        <div data-testid="clip" style={{ overflow: "hidden" }}>
          <PersistentViewerOverlays
            collection={<div>Collection</div>}
            minimap={<div>Minimap</div>}
            viewerFocusRef={viewerFocusRef}
          />
        </div>
      </>,
    );

    const owner = screen.getByTestId("persistent-viewer-overlays");
    const collection = owner.children[0] as HTMLElement;
    const minimap = owner.children[1] as HTMLElement;
    expect(owner.dataset.overlayLayout).toBe("stacked");
    expect(minimap.style.top).toBe("284px");
    expect(collection.style.top).toBe("172px");
  });

  it("measures the painted child instead of feeding a stale slot height back into layout", () => {
    const viewerFocusRef = createRef<HTMLCanvasElement>();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "persistent-viewer-overlays") {
        return domRect(0, 0, 658, 460);
      }
      if (this.classList.contains("persistent-viewer-overlay-collection")) {
        // This is the bad prior-layout value: it must not become the next
        // natural height when the child itself only paints 82px tall.
        return domRect(0, 0, 354, 428);
      }
      if (this.classList.contains("persistent-viewer-overlay-minimap")) {
        return domRect(0, 0, 202, 202);
      }
      if (this.dataset.testid === "natural-collection") return domRect(0, 0, 354, 82);
      if (this.dataset.testid === "natural-minimap") return domRect(0, 0, 202, 202);
      return domRect(0, 0, 0, 0);
    });

    render(
      <>
        <canvas ref={viewerFocusRef} tabIndex={0} aria-label="2D viewer" />
        <PersistentViewerOverlays
          collection={(
            <div data-testid="natural-collection" data-floating-safe-region>
              Collection
            </div>
          )}
          minimap={(
            <div data-testid="natural-minimap" data-floating-safe-region>
              Minimap
            </div>
          )}
          viewerFocusRef={viewerFocusRef}
        />
      </>,
    );

    const owner = screen.getByTestId("persistent-viewer-overlays");
    const collectionSlot = owner.children[0] as HTMLElement;
    const minimapSlot = owner.children[1] as HTMLElement;
    expect(owner.dataset.overlayLayout).toBe("inline");
    expect(collectionSlot.style.height).toBe("82px");
    expect(collectionSlot.style.top).toBe("362px");
    expect(minimapSlot.style.height).toBe("202px");
    expect(minimapSlot.style.top).toBe("242px");
  });

  it("hides and inerts every overlay slot when a one-pixel canvas leaves no usable boundary", () => {
    const viewerFocusRef = createRef<HTMLCanvasElement>();
    let dockSize = 1;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "persistent-viewer-overlays") {
        return domRect(0, 0, dockSize, dockSize);
      }
      if (this.classList.contains("persistent-viewer-overlay-collection")) {
        return domRect(0, 0, 352, 148);
      }
      if (this.classList.contains("persistent-viewer-overlay-minimap")) {
        return domRect(0, 0, 200, 200);
      }
      return domRect(0, 0, 1, 1);
    });

    render(
      <>
        <canvas ref={viewerFocusRef} tabIndex={0} aria-label="2D viewer" />
        <PersistentViewerOverlays
          collection={<button type="button">Collection action</button>}
          minimap={<button type="button">Minimap action</button>}
          viewerFocusRef={viewerFocusRef}
        />
      </>,
    );

    const slots = Array.from(
      screen.getByTestId("persistent-viewer-overlays").children,
    ) as HTMLElement[];
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.style.visibility).toBe("hidden");
      expect(slot.style.pointerEvents).toBe("none");
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(slot.hasAttribute("inert")).toBe(true);
      expect(slot.dataset.overlayHidden).toBe("true");
      expect(slot.classList.contains("persistent-viewer-overlay-slot")).toBe(true);
    }

    dockSize = 500;
    act(() => window.dispatchEvent(new Event("resize")));
    for (const slot of slots) {
      expect(slot.style.visibility).toBe("");
      expect(slot.style.pointerEvents).toBe("");
      expect(slot.getAttribute("aria-hidden")).toBe("false");
      expect(slot.hasAttribute("inert")).toBe(false);
      expect(slot.dataset.overlayHidden).toBeUndefined();
    }
  });

  it("keeps collection focus at a 310x230 boundary, then evacuates it before hiding smaller", () => {
    const viewerFocusRef = createRef<HTMLCanvasElement>();
    let dockWidth = 500;
    let dockHeight = 500;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "persistent-viewer-overlays") {
        return domRect(0, 0, dockWidth, dockHeight);
      }
      if (this.classList.contains("persistent-viewer-overlay-collection")) {
        return domRect(0, 0, 352, 148);
      }
      if (this.classList.contains("persistent-viewer-overlay-minimap")) {
        return domRect(0, 0, 200, 200);
      }
      return domRect(0, 0, 20, 20);
    });

    render(
      <>
        <canvas ref={viewerFocusRef} tabIndex={0} aria-label="2D viewer" />
        <PersistentViewerOverlays
          collection={<button type="button">Collection action</button>}
          minimap={<button type="button">Minimap action</button>}
          viewerFocusRef={viewerFocusRef}
        />
      </>,
    );
    const collectionAction = screen.getByRole("button", { name: "Collection action" });
    const owner = screen.getByTestId("persistent-viewer-overlays");
    const collectionSlot = owner.children[0] as HTMLElement;
    const minimapSlot = owner.children[1] as HTMLElement;
    collectionAction.focus();

    // Dock padding turns 342x262 into the requested 310x230 usable boundary.
    dockWidth = 342;
    dockHeight = 262;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(collectionSlot.dataset.overlayUsable).toBe("true");
    expect(minimapSlot.dataset.overlayUsable).toBe("false");
    expect(document.activeElement).toBe(collectionAction);

    dockWidth = 100;
    dockHeight = 70;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(collectionSlot.dataset.overlayUsable).toBe("false");
    expect(minimapSlot.dataset.overlayUsable).toBe("false");
    expect(collectionSlot.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(viewerFocusRef.current);
    expect(document.activeElement).not.toBe(document.body);
  });
});
