import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { resolveFloatingViewportPlacement } from "./floatingPlacement.ts";
import {
  elementVisibleGeometry,
  overflowClippingAncestors,
  visualViewportRect,
} from "./visibleGeometry.ts";
import {
  announceFloatingLayoutSettled,
  FLOATING_LAYOUT_SETTLED_EVENT,
} from "./floatingLayoutEvents.ts";

const DEFAULT_AVOID_SELECTOR = "[data-floating-safe-region], [data-floating-surface]";

interface FloatingPlacementOptions {
  /** A portal surface receives its explicit trigger. An anchored surface such
   * as an annotation thread can instead use its parent element. */
  anchorElement?: Element | null;
  parentAnchor?: boolean;
  coordinateSpace?: "viewport" | "anchor";
  fallbackSize: { width: number; height: number };
  gap?: number;
  padding?: number;
  enabled?: boolean;
  /** Optional moving-anchor source (the render loop for projected annotations). */
  subscribe?: (listener: () => void) => () => void;
  /** Declarative safe regions shared by all portaled viewer surfaces. */
  avoidSelector?: string | null;
  /** Meaningful stable control used when the painted anchor itself cannot
   * receive restored focus (for example a search field above a scrolled list). */
  focusFallbackRef?: RefObject<HTMLElement | null>;
  /** Element form of focusFallbackRef for owners that already receive a live
   * host element rather than its React ref (annotation overlays receive the
   * viewer canvas this way). */
  focusFallbackElement?: HTMLElement | null;
  /** Restore focus when the surface itself unmounts, but only if focus was still
   * owned by that surface. Normal closes return to the painted anchor; an
   * anchor removed by the same commit falls back after the commit settles. */
  restoreFocusOnUnmount?: boolean;
}

function resolveAnchor(
  surface: HTMLDivElement | null,
  anchorElement: Element | null,
  parentAnchor: boolean,
): Element | null {
  const parent = parentAnchor ? surface?.parentElement ?? null : null;
  // Parent-anchored surfaces commonly live beside a zero-size transformed
  // positioning wrapper (annotation pins are the canonical example). Prefer
  // the wrapper's explicitly-declared painted target so clipping is decided
  // from the pixels the user can actually see and interact with. Falling back
  // to the parent preserves the contract for ordinary measurable wrappers.
  return anchorElement
    ?? parent?.querySelector(":scope > [data-floating-anchor]")
    ?? parent;
}

function isPaintedFocusTarget(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const geometry = elementVisibleGeometry(element);
  return !geometry.paintSuppressed
    && (!geometry.measurable || geometry.visibleRect !== null);
}

function focusWithoutScroll(element: HTMLElement | null | undefined): boolean {
  if (!element?.isConnected) return false;
  element.focus({ preventScroll: true });
  return element.ownerDocument.activeElement === element;
}

/**
 * Return focus only while a disappearing floating surface still owns it.
 *
 * React runs layout-effect cleanup before every node removed by a parent commit
 * has necessarily detached. We can therefore focus a marker that is about to
 * disappear (pin deletion, mode switch), only to have the browser collapse
 * focus to body a moment later. The microtask verifies that marker after the
 * commit and uses the stable fallback only if focus collapsed. A user who moved
 * to another real control is never overridden.
 */
function restoreOwnedSurfaceFocus(
  surface: HTMLElement,
  anchor: Element | null,
  fallback: HTMLElement | null,
  ownedFocusBeforeRemoval: boolean,
): void {
  const document = surface.ownerDocument;
  const active = document.activeElement;
  const activeInside = Boolean(active && (active === surface || surface.contains(active)));
  const activeAtAnchor = Boolean(active && anchor && (
    active === anchor || anchor.contains(active)
  ));
  const activeOwned = activeInside || activeAtAnchor;
  if (!activeOwned && !ownedFocusBeforeRemoval) return;
  // If the browser has already moved to another connected control, that is a
  // deliberate user choice even when an earlier event said the surface owned
  // focus. Only body/document collapse is eligible for recovery.
  if (!activeOwned && active instanceof HTMLElement
    && active.isConnected
    && active !== document.body
    && active !== document.documentElement) return;

  const paintedAnchor = anchor instanceof HTMLElement && isPaintedFocusTarget(anchor)
    ? anchor
    : null;
  const immediateTarget = paintedAnchor ?? fallback;
  const focused = focusWithoutScroll(immediateTarget);
  if (!focused && active instanceof HTMLElement) active.blur();

  if (!paintedAnchor || !fallback) return;
  queueMicrotask(() => {
    if (isPaintedFocusTarget(paintedAnchor)) return;
    const current = document.activeElement;
    // Detaching the focused marker normally collapses focus to body. If a user
    // deliberately chose another connected control during the commit, preserve
    // that choice rather than stealing focus back to the viewer.
    const focusCollapsed = !current
      || current === document.body
      || current === document.documentElement
      || (current instanceof HTMLElement && !current.isConnected);
    if (focusCollapsed) focusWithoutScroll(fallback);
  });
}

/**
 * One placement lifecycle for every floating viewer surface.
 *
 * The pure geometry helper owns flip/clamp policy. This hook owns layout
 * measurement, resize/scroll tracking, and optional moving-anchor updates, so
 * components do not grow their own positioning timers and viewport listeners.
 */
export function useFloatingSurfacePlacement({
  anchorElement = null,
  parentAnchor = false,
  coordinateSpace = "viewport",
  fallbackSize,
  gap = 10,
  padding = 8,
  enabled = true,
  subscribe,
  avoidSelector = DEFAULT_AVOID_SELECTOR,
  focusFallbackRef,
  focusFallbackElement = null,
  restoreFocusOnUnmount = false,
}: FloatingPlacementOptions) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: padding, top: padding });
  const [anchorHidden, setAnchorHidden] = useState(false);
  const [anchorSeenVisible, setAnchorSeenVisible] = useState(false);
  const [maxSize, setMaxSize] = useState<{ width: number; height: number } | null>(null);

  const update = useCallback(() => {
    const surface = surfaceRef.current;
    const anchor = resolveAnchor(surface, anchorElement, parentAnchor);
    if (!surface || !anchor || typeof window === "undefined") return;
    const anchorGeometry = elementVisibleGeometry(anchor);
    const evacuateFocus = () => {
      const active = surface.ownerDocument.activeElement;
      const activeInSurface = Boolean(active && (
        active === surface || surface.contains(active)
      ));
      const activeAtAnchor = Boolean(active && (
        active === anchor || anchor.contains(active)
      ));
      if (!activeInSurface && !activeAtAnchor) return;
      // Preserve the trigger relationship when it can still receive focus.
      // CSS-hidden or detached triggers cannot, so blur the disappearing
      // surface as a safe fallback instead of leaving focus inside `inert`.
      const focusFallback = focusFallbackRef?.current ?? focusFallbackElement;
      // A generic toolbar trigger can be transiently clipped while a scroll or
      // page-scale relocation settles. With no declared stable fallback there
      // is nowhere better to send its focus, so preserve it. Annotation markers
      // explicitly provide the viewer canvas and still evacuate immediately.
      if (activeAtAnchor && !focusFallback?.isConnected) return;
      if (focusFallback?.isConnected) {
        focusFallback.focus({ preventScroll: true });
      } else if (!activeAtAnchor && anchor instanceof HTMLElement
        && anchor.isConnected
        && !anchorGeometry.paintSuppressed
        && (!anchorGeometry.measurable || anchorGeometry.visibleRect !== null)) {
        anchor.focus({ preventScroll: true });
      }
      const remaining = surface.ownerDocument.activeElement;
      if (remaining && (
        remaining === surface
        || surface.contains(remaining)
        || remaining === anchor
        || anchor.contains(remaining)
      )
        && remaining instanceof HTMLElement) {
        remaining.blur();
      }
    };
    const hidden = !anchor.isConnected
      || anchorGeometry.paintSuppressed
      || (anchorGeometry.measurable && anchorGeometry.visibleRect === null);
    if (hidden) evacuateFocus();
    if (hidden) {
      setAnchorHidden((current) => current === hidden ? current : hidden);
      return;
    }
    const anchorRect = anchorGeometry.rect;
    const viewport = coordinateSpace === "anchor"
      ? anchorGeometry.clip ?? visualViewportRect()
      : visualViewportRect();
    const nextMaxSize = {
      width: Math.max(0, viewport.width - padding * 2),
      height: Math.max(0, viewport.height - padding * 2),
    };
    setMaxSize((current) => current?.width === nextMaxSize.width
      && current.height === nextMaxSize.height ? current : nextMaxSize);
    const boundaryHidden = nextMaxSize.width <= 0 || nextMaxSize.height <= 0;
    if (boundaryHidden) evacuateFocus();
    setAnchorHidden((current) => current === boundaryHidden ? current : boundaryHidden);
    if (boundaryHidden) return;
    setAnchorSeenVisible(true);
    const surfaceRect = surface.getBoundingClientRect();
    const obstacleElements = new Set<HTMLElement>();
    if (avoidSelector) {
      for (const element of document.querySelectorAll<HTMLElement>(avoidSelector)) {
        if (element === surface || element === anchor || element.contains(surface)) continue;
        if (element.hasAttribute("data-floating-surface")) {
          // Portals are appended in open order. Only the later surface moves;
          // earlier surfaces stay put, which prevents two collision observers
          // from chasing each other between equally valid positions.
          const relation = surface.compareDocumentPosition(element);
          if ((relation & Node.DOCUMENT_POSITION_PRECEDING) === 0) continue;
        }
        if (element.contains(anchor)) {
          // A toolbar can be one safe region while also containing the trigger.
          // Expand it into its actual controls so the trigger is excluded but
          // every sibling remains protected.
          for (const control of element.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
          )) {
            if (control !== anchor && !control.contains(anchor)) obstacleElements.add(control);
          }
        } else {
          obstacleElements.add(element);
        }
      }
    }
    const obstacles = Array.from(obstacleElements)
      .map((element) => elementVisibleGeometry(element).visibleRect)
      .filter((rect): rect is NonNullable<typeof rect> => rect !== null);
    const absolute = resolveFloatingViewportPlacement(
      anchorRect,
      {
        width: Math.min(surfaceRect.width || fallbackSize.width, nextMaxSize.width),
        height: Math.min(surfaceRect.height || fallbackSize.height, nextMaxSize.height),
      },
      {
        width: viewport.width,
        height: viewport.height,
        left: viewport.left,
        top: viewport.top,
      },
      gap,
      padding,
      obstacles,
    );
    // CSS `left`/`top` are relative to the positioned containing block, not to
    // the painted anchor button. Annotation markers deliberately center a
    // 24px button on a zero-size transformed wrapper, so subtracting the
    // button's top-left reintroduced a 12px collision after an otherwise exact
    // obstacle solution. Resolve against the actual parent containing block.
    const coordinateOrigin = parentAnchor
      ? surface.parentElement?.getBoundingClientRect()
      : null;
    const next = coordinateSpace === "anchor"
      ? {
          left: absolute.left - (coordinateOrigin?.left ?? anchorRect.left),
          top: absolute.top - (coordinateOrigin?.top ?? anchorRect.top),
        }
      : absolute;
    setPlacement((current) =>
      current.left === next.left && current.top === next.top ? current : next);
  }, [anchorElement, avoidSelector, coordinateSpace, fallbackSize.height, fallbackSize.width, focusFallbackElement, focusFallbackRef, gap, padding, parentAnchor]);

  const unmountFocusRef = useRef({
    anchorElement,
    focusFallbackElement,
    focusFallbackRef,
    parentAnchor,
    restoreFocusOnUnmount,
  });
  useLayoutEffect(() => {
    unmountFocusRef.current = {
      anchorElement,
      focusFallbackElement,
      focusFallbackRef,
      parentAnchor,
      restoreFocusOnUnmount,
    };
  });
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const focusIsOwned = (target: EventTarget | null) => {
      if (!surface || !(target instanceof Node)) return false;
      const anchor = resolveAnchor(
        surface,
        unmountFocusRef.current.anchorElement,
        unmountFocusRef.current.parentAnchor,
      );
      return surface === target
        || surface.contains(target)
        || anchor === target
        || Boolean(anchor?.contains(target));
    };
    let ownedFocus = focusIsOwned(surface?.ownerDocument.activeElement ?? null);
    const trackFocus = (event: FocusEvent) => {
      ownedFocus = focusIsOwned(event.target);
    };
    surface?.ownerDocument.addEventListener("focusin", trackFocus, true);
    return () => {
      surface?.ownerDocument.removeEventListener("focusin", trackFocus, true);
      const latest = unmountFocusRef.current;
      if (!surface || !latest.restoreFocusOnUnmount) return;
      const anchor = resolveAnchor(
        surface,
        latest.anchorElement,
        latest.parentAnchor,
      );
      restoreOwnedSurfaceFocus(
        surface,
        anchor,
        latest.focusFallbackRef?.current ?? latest.focusFallbackElement,
        ownedFocus,
      );
    };
  }, []);

  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    update();
    const surface = surfaceRef.current;
    const anchor = resolveAnchor(surface, anchorElement, parentAnchor);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    if (surface) observer?.observe(surface);
    if (anchor) observer?.observe(anchor);
    for (const ancestor of anchor ? overflowClippingAncestors(anchor) : []) {
      observer?.observe(ancestor);
    }
    const unsubscribe = subscribe?.(update);
    let updateFrame: number | null = null;
    const requestUpdate = () => {
      if (updateFrame !== null) return;
      updateFrame = requestAnimationFrame(() => {
        updateFrame = null;
        update();
      });
    };
    // A sibling dock or portal can mount after this surface. Observe structural
    // and visibility changes while the surface is open so the shared collision
    // solution is recomputed without feature-specific wiring.
    const mutationObserver = avoidSelector && document.body
      ? new MutationObserver(requestUpdate)
      : null;
    mutationObserver?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-floating-safe-region"],
    });
    // React commits every sibling's DOM before layout effects run, but a
    // sibling layout owner can reveal or reposition a safe region from its own
    // layout effect. Recheck across the next two frames so a newly opened
    // surface cannot retain the obstacle-free placement from that transient
    // commit (the persistent minimap/collection dock is the canonical case).
    // These are bounded opening checks, not an animation loop.
    let settleFrame: number | null = requestAnimationFrame(() => {
      update();
      settleFrame = requestAnimationFrame(update);
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener(FLOATING_LAYOUT_SETTLED_EVENT, requestUpdate);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      if (updateFrame !== null) cancelAnimationFrame(updateFrame);
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      observer?.disconnect();
      mutationObserver?.disconnect();
      unsubscribe?.();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener(FLOATING_LAYOUT_SETTLED_EVENT, requestUpdate);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchorElement, avoidSelector, enabled, parentAnchor, subscribe, update]);

  // Placement state is reflected into CSS only after React commits. Announce
  // that committed geometry so later-priority floating surfaces and the
  // persistent overlay owner can resolve against the pixels users actually
  // see, independent of MutationObserver scheduling differences across DPRs.
  useLayoutEffect(() => {
    if (!enabled) return;
    announceFloatingLayoutSettled();
  }, [anchorHidden, enabled, placement.left, placement.top]);

  return { surfaceRef, placement, anchorHidden, anchorSeenVisible, maxSize, update };
}
