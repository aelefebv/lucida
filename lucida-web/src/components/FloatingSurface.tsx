import { useLayoutEffect, type ComponentPropsWithoutRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFloatingSurfacePlacement } from "./useFloatingSurfacePlacement.ts";

interface FloatingPortalSurfaceProps extends ComponentPropsWithoutRef<"div"> {
  anchorElement: Element | null;
  fallbackSize: { width: number; height: number };
  gap?: number;
  boundaryPadding?: number;
  /** Called after the painted anchor becomes wholly unavailable. The owning
   * feature uses this to close its declarative open state (and therefore clear
   * trigger ARIA) instead of leaving a merely-hidden portal mounted. */
  onAnchorHidden?: () => void;
  focusFallbackRef?: RefObject<HTMLElement | null>;
}

/** Shared body portal + viewport placement contract for menus and popovers. */
export function FloatingPortalSurface({
  anchorElement,
  fallbackSize,
  gap,
  boundaryPadding,
  onAnchorHidden,
  focusFallbackRef,
  style,
  children,
  ...props
}: FloatingPortalSurfaceProps) {
  const { surfaceRef, placement, anchorHidden, maxSize } = useFloatingSurfacePlacement({
    anchorElement,
    fallbackSize,
    gap,
    padding: boundaryPadding,
    focusFallbackRef,
  });
  useLayoutEffect(() => {
    if (anchorHidden) onAnchorHidden?.();
  }, [anchorHidden, onAnchorHidden]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      {...props}
      data-floating-surface=""
      data-anchor-hidden={anchorHidden ? "true" : undefined}
      ref={surfaceRef}
      hidden={props.hidden || anchorHidden}
      aria-hidden={anchorHidden ? true : props["aria-hidden"]}
      inert={anchorHidden ? true : props.inert}
      style={{
        position: "fixed",
        zIndex: "var(--z-popover)",
        ...style,
        left: placement.left,
        top: placement.top,
        boxSizing: "border-box",
        maxWidth: maxSize?.width,
        maxHeight: maxSize?.height,
        overflow: style?.overflow ?? "auto",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
