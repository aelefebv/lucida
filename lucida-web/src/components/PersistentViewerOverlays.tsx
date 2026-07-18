import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  resolvePersistentOverlayLayout,
  suppressPersistentOverlayCollisions,
  type OverlayBoundary,
  type OverlaySize,
  type PersistentOverlayLayout,
} from "./persistentOverlayLayout.ts";
import {
  elementVisibleGeometry,
  overflowClippingAncestors,
} from "./visibleGeometry.ts";
import { FLOATING_LAYOUT_SETTLED_EVENT } from "./floatingLayoutEvents.ts";
import "./PersistentViewerOverlays.css";

const OVERLAY_PADDING = 16;

interface PersistentViewerOverlaysProps {
  collection: ReactNode;
  minimap: ReactNode;
  /** Stable viewer control that receives focus before an overlay slot becomes
   * unavailable. Required so focus never collapses to the document body. */
  viewerFocusRef: RefObject<HTMLElement | null>;
}

type SuppressionReason = "boundary-too-small" | "transient-collision" | null;

interface OverlaySuppression {
  collection: SuppressionReason;
  minimap: SuppressionReason;
}

function visibleBoundary(dock: HTMLElement): OverlayBoundary {
  const dockRect = dock.getBoundingClientRect();
  const visible = elementVisibleGeometry(dock).visibleRect;
  if (!visible) return { left: 0, top: 0, width: 0, height: 0 };
  const left = visible.left + OVERLAY_PADDING;
  const top = visible.top + OVERLAY_PADDING;
  const right = visible.right - OVERLAY_PADDING;
  const bottom = visible.bottom - OVERLAY_PADDING;
  return {
    left: Math.max(0, left - dockRect.left),
    top: Math.max(0, top - dockRect.top),
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function measuredSize(element: HTMLElement | null): OverlaySize | null {
  if (!element) return null;
  // Measure the painted surface, not this absolutely-positioned slot. Once a
  // layout has been applied the slot carries the previous explicit width and
  // height; feeding those dimensions back in makes a formerly constrained
  // selector look permanently tall after the canvas grows again. Every owned
  // overlay declares itself as a shared safe region, so that direct child is
  // the stable source of its natural size. The wrapper fallback keeps the
  // owner usable with simple/custom children and in non-layout test DOMs.
  const child = element.firstElementChild;
  const surface = child instanceof HTMLElement
    && child.hasAttribute("data-floating-safe-region")
    ? child
    : element;
  const bounds = surface.getBoundingClientRect();
  const scrollport = surface.querySelector<HTMLElement>("[data-overlay-scrollport]");
  const scrollportBounds = scrollport?.getBoundingClientRect();
  // A nested scrollport retains the selector's natural grid size after its
  // wrapper has been capped by an earlier narrow-layout measurement. Add back
  // the panel chrome outside that scrollport to recover the natural surface.
  const naturalWidth = scrollport && scrollportBounds
    ? scrollport.scrollWidth + Math.max(0, bounds.width - scrollportBounds.width)
    : surface.scrollWidth;
  const naturalHeight = scrollport && scrollportBounds
    ? scrollport.scrollHeight + Math.max(0, bounds.height - scrollportBounds.height)
    : surface.scrollHeight;
  return {
    width: Math.max(naturalWidth, surface.scrollWidth, bounds.width),
    height: Math.max(naturalHeight, surface.scrollHeight, bounds.height),
  };
}

function evacuateFocus(
  element: HTMLElement | null,
  viewerFocusRef: RefObject<HTMLElement | null>,
): void {
  const active = element?.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || !element?.contains(active)) return;
  const fallback = viewerFocusRef.current;
  if (fallback?.isConnected) fallback.focus({ preventScroll: true });
}

/** Shared owner for persistent canvas overlays such as collection navigation and the minimap. */
export function PersistentViewerOverlays({
  collection,
  minimap,
  viewerFocusRef,
}: PersistentViewerOverlaysProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const collectionRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const hasCollection = Boolean(collection);
  const hasMinimap = Boolean(minimap);
  const [layout, setLayout] = useState<PersistentOverlayLayout>({
    collection: null,
    minimap: null,
    stacked: false,
  });
  const [suppression, setSuppression] = useState<OverlaySuppression>({
    collection: null,
    minimap: null,
  });

  const update = useCallback(() => {
    const dock = dockRef.current;
    if (!dock || typeof window === "undefined") return;
    const base = resolvePersistentOverlayLayout(
      visibleBoundary(dock),
      hasCollection ? measuredSize(collectionRef.current) : null,
      hasMinimap ? measuredSize(minimapRef.current) : null,
    );
    const dockRect = dock.getBoundingClientRect();
    const transientObstacles = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-floating-surface]",
    )).filter((element) => !dock.contains(element))
      .map((element) => elementVisibleGeometry(element).visibleRect)
      .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null)
      .map((bounds) => ({
        left: bounds.left - dockRect.left,
        top: bounds.top - dockRect.top,
        right: bounds.right - dockRect.left,
        bottom: bounds.bottom - dockRect.top,
        width: bounds.width,
        height: bounds.height,
      }));
    const next = suppressPersistentOverlayCollisions(base, transientObstacles);
    const nextSuppression: OverlaySuppression = {
      collection: hasCollection && !base.collection
        ? "boundary-too-small"
        : base.collection && !next.collection
          ? "transient-collision"
          : null,
      minimap: hasMinimap && !base.minimap
        ? "boundary-too-small"
        : base.minimap && !next.minimap
          ? "transient-collision"
          : null,
    };
    // Move focus before React applies visibility:hidden + aria-hidden + inert;
    // otherwise a focused control can remain stranded in an unavailable slot.
    if (!next.collection) evacuateFocus(collectionRef.current, viewerFocusRef);
    if (!next.minimap) evacuateFocus(minimapRef.current, viewerFocusRef);
    setLayout((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    setSuppression((current) => current.collection === nextSuppression.collection
      && current.minimap === nextSuppression.minimap ? current : nextSuppression);
  }, [hasCollection, hasMinimap, viewerFocusRef]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (dockRef.current) observer?.observe(dockRef.current);
    if (collectionRef.current) observer?.observe(collectionRef.current);
    if (minimapRef.current) observer?.observe(minimapRef.current);
    for (const ancestor of dockRef.current ? overflowClippingAncestors(dockRef.current) : []) {
      observer?.observe(ancestor);
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    let updateFrame: number | null = null;
    const requestUpdate = () => {
      if (updateFrame !== null) return;
      updateFrame = requestAnimationFrame(() => {
        updateFrame = null;
        update();
      });
    };
    // Transient surfaces are portaled or annotation-anchored outside this
    // owner. Observe their bounded mount/visibility/placement changes so the
    // persistent layer yields without feature-specific wiring.
    const transientObserver = document.body ? new MutationObserver(requestUpdate) : null;
    transientObserver?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "hidden", "aria-hidden", "data-floating-surface"],
    });
    window.addEventListener(FLOATING_LAYOUT_SETTLED_EVENT, requestUpdate);
    return () => {
      if (updateFrame !== null) cancelAnimationFrame(updateFrame);
      observer?.disconnect();
      transientObserver?.disconnect();
      window.removeEventListener(FLOATING_LAYOUT_SETTLED_EVENT, requestUpdate);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [update]);

  if (!collection && !minimap) return null;
  return (
    <div
      ref={dockRef}
      className="persistent-viewer-overlays"
      data-testid="persistent-viewer-overlays"
      data-overlay-layout={layout.stacked ? "stacked" : "inline"}
    >
      {collection && (
        <div
          ref={collectionRef}
          className="persistent-viewer-overlay-slot persistent-viewer-overlay-collection"
          aria-hidden={!layout.collection}
          inert={!layout.collection}
          data-overlay-hidden={!layout.collection ? "true" : undefined}
          data-overlay-usable={layout.collection ? "true" : "false"}
          data-overlay-suppression={suppression.collection ?? undefined}
          style={layout.collection ? {
            left: layout.collection.left,
            top: layout.collection.top,
            right: "auto",
            bottom: "auto",
            width: layout.collection.width,
            height: layout.collection.height,
          } : { visibility: "hidden", pointerEvents: "none" }}
        >
          {collection}
        </div>
      )}
      {minimap && (
        <div
          ref={minimapRef}
          className="persistent-viewer-overlay-slot persistent-viewer-overlay-minimap"
          aria-hidden={!layout.minimap}
          inert={!layout.minimap}
          data-overlay-hidden={!layout.minimap ? "true" : undefined}
          data-overlay-usable={layout.minimap ? "true" : "false"}
          data-overlay-suppression={suppression.minimap ?? undefined}
          style={layout.minimap ? {
            left: layout.minimap.left,
            top: layout.minimap.top,
            right: "auto",
            bottom: "auto",
            width: layout.minimap.width,
            height: layout.minimap.height,
          } : { visibility: "hidden", pointerEvents: "none" }}
        >
          {minimap}
        </div>
      )}
    </div>
  );
}
