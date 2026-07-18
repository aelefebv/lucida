export interface VisibleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ElementVisibleGeometry {
  /** Unclipped border box reported by layout. */
  rect: VisibleRect;
  /** Visual viewport after every overflow-clipping ancestor is applied. */
  clip: VisibleRect | null;
  /** The pixels that can actually be painted. */
  visibleRect: VisibleRect | null;
  /** False in non-layout DOMs such as happy-dom's default zero rectangles. */
  measurable: boolean;
  /** True when CSS or DOM connectivity makes painting impossible regardless of geometry. */
  paintSuppressed: boolean;
}

const CLIPPING_OVERFLOW = /(?:^|\s)(?:auto|clip|hidden|scroll)(?:\s|$)/;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function rectFromBounds(
  bounds: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
): VisibleRect {
  const left = finite(bounds.left) ? bounds.left : 0;
  const top = finite(bounds.top) ? bounds.top : 0;
  const width = finite(bounds.width) ? Math.max(0, bounds.width) : 0;
  const height = finite(bounds.height) ? Math.max(0, bounds.height) : 0;
  const right = finite(bounds.right) ? bounds.right : left + width;
  const bottom = finite(bounds.bottom) ? bounds.bottom : top + height;
  return { left, top, right, bottom, width, height };
}

export function intersectVisibleRects(
  left: VisibleRect | null,
  right: VisibleRect | null,
): VisibleRect | null {
  if (!left || !right) return null;
  const intersectionLeft = Math.max(left.left, right.left);
  const intersectionTop = Math.max(left.top, right.top);
  const intersectionRight = Math.min(left.right, right.right);
  const intersectionBottom = Math.min(left.bottom, right.bottom);
  if (intersectionRight <= intersectionLeft || intersectionBottom <= intersectionTop) return null;
  return {
    left: intersectionLeft,
    top: intersectionTop,
    right: intersectionRight,
    bottom: intersectionBottom,
    width: intersectionRight - intersectionLeft,
    height: intersectionBottom - intersectionTop,
  };
}

export function visualViewportRect(targetWindow: Window = window): VisibleRect {
  const visual = targetWindow.visualViewport;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  const width = visual?.width && visual.width > 0 ? visual.width : targetWindow.innerWidth;
  const height = visual?.height && visual.height > 0 ? visual.height : targetWindow.innerHeight;
  return {
    left,
    top,
    right: left + Math.max(0, width),
    bottom: top + Math.max(0, height),
    width: Math.max(0, width),
    height: Math.max(0, height),
  };
}

function clipsAxis(style: CSSStyleDeclaration, axis: "x" | "y"): boolean {
  const axisValue = axis === "x" ? style.overflowX : style.overflowY;
  // Browsers expose the computed longhand. Lightweight test DOMs sometimes
  // leave it empty and expose only the shorthand, so use the shorthand strictly
  // as a fallback. Combining both values would make `overflow: hidden visible`
  // incorrectly clip both axes merely because either token clips one axis.
  return CLIPPING_OVERFLOW.test(axisValue || style.overflow);
}

function styleSuppressesPaint(style: CSSStyleDeclaration): boolean {
  const contentVisibility = style.getPropertyValue("content-visibility")
    || (style as CSSStyleDeclaration & { contentVisibility?: string }).contentVisibility
    || "";
  return style.display === "none"
    || style.visibility === "hidden"
    || style.visibility === "collapse"
    || contentVisibility === "hidden";
}

/** Whether the element or one of its ancestors is disconnected or CSS-hidden. */
export function elementPaintSuppressed(element: Element): boolean {
  if (!element.isConnected) return true;
  const targetWindow = element.ownerDocument.defaultView;
  if (!targetWindow) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (styleSuppressesPaint(targetWindow.getComputedStyle(current))) return true;
  }
  return false;
}

/** Overflow ancestors whose paint clips constrain a descendant surface. */
export function overflowClippingAncestors(element: Element): HTMLElement[] {
  const targetWindow = element.ownerDocument.defaultView;
  if (!targetWindow) return [];
  const ancestors: HTMLElement[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = targetWindow.getComputedStyle(ancestor);
    if (clipsAxis(style, "x") || clipsAxis(style, "y")) ancestors.push(ancestor);
  }
  return ancestors;
}

/**
 * Compute geometry in painted coordinates, not merely layout coordinates.
 *
 * `getBoundingClientRect()` does not account for an overflow-clipping ancestor.
 * Centralising that distinction keeps placement, visibility, and tests from
 * disagreeing about a surface that is inside the viewport but cannot paint.
 */
export function elementVisibleGeometry(
  element: Element,
  viewport: VisibleRect = visualViewportRect(element.ownerDocument.defaultView ?? window),
): ElementVisibleGeometry {
  const targetWindow = element.ownerDocument.defaultView ?? window;
  const rect = rectFromBounds(element.getBoundingClientRect());
  const paintSuppressed = elementPaintSuppressed(element);
  let clip: VisibleRect | null = viewport;
  for (let ancestor = element.parentElement; ancestor && clip; ancestor = ancestor.parentElement) {
    const style = targetWindow.getComputedStyle(ancestor);
    const clipsX = clipsAxis(style, "x");
    const clipsY = clipsAxis(style, "y");
    if (!clipsX && !clipsY) continue;
    const bounds = rectFromBounds(ancestor.getBoundingClientRect());
    const axisClip: VisibleRect = {
      left: clipsX ? bounds.left : clip.left,
      right: clipsX ? bounds.right : clip.right,
      top: clipsY ? bounds.top : clip.top,
      bottom: clipsY ? bounds.bottom : clip.bottom,
      width: 0,
      height: 0,
    };
    axisClip.width = Math.max(0, axisClip.right - axisClip.left);
    axisClip.height = Math.max(0, axisClip.bottom - axisClip.top);
    clip = intersectVisibleRects(clip, axisClip);
  }
  const measurable = rect.width > 0 && rect.height > 0;
  return {
    rect,
    clip,
    visibleRect: measurable && !paintSuppressed ? intersectVisibleRects(rect, clip) : null,
    measurable,
    paintSuppressed,
  };
}
