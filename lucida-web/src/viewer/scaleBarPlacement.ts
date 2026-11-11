/**
 * Where a view's scale bar sits: the view's bottom-left corner, raised
 * above whatever floating control or notice would cover it there. A view's
 * corner can fall under any of the stage's controls, depending on the view
 * layout and the window, so the bar measures them rather than assuming.
 */

/** A rectangle in CSS pixels, in one coordinate space. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The bar's gap from its view's edges, in CSS pixels. */
export const SCALE_BAR_INSET = 12;
/** Its gap from a control it clears, in CSS pixels. */
export const SCALE_BAR_CLEARANCE = 8;

/** Enough rounds to climb over a stack of controls without looping on a pathological one. */
const MAX_RAISES = 8;

/**
 * The top-left corner of a bar `width` by `height` CSS pixels in `pane`,
 * in CSS pixels from the pane's own corner, raised until it covers none of
 * `obstacles`. The corner lands on a whole CSS pixel, so the bar's edges
 * stay sharp wherever the pane's edge falls. `null` when no height in the
 * pane clears them.
 */
export function placeScaleBar(
  pane: Box,
  width: number,
  height: number,
  obstacles: readonly Box[],
): { left: number; top: number } | null {
  const left = pane.left + SCALE_BAR_INSET;
  let bottom = pane.bottom - SCALE_BAR_INSET;
  for (let round = 0; round < MAX_RAISES; round++) {
    const bar = { left, top: bottom - height, right: left + width, bottom };
    const covered = obstacles.filter((obstacle) => near(obstacle, bar));
    if (covered.length === 0) {
      if (bar.top < pane.top + SCALE_BAR_INSET) return null;
      return { left: Math.round(bar.left) - pane.left, top: Math.round(bar.top) - pane.top };
    }
    bottom = Math.min(...covered.map((obstacle) => obstacle.top)) - SCALE_BAR_CLEARANCE;
  }
  return null;
}

/** Whether `obstacle` comes within the clearance of `bar`. An empty box, a hidden control's, is nowhere. */
function near(obstacle: Box, bar: Box): boolean {
  if (obstacle.right <= obstacle.left || obstacle.bottom <= obstacle.top) return false;
  const gap = SCALE_BAR_CLEARANCE;
  return (
    obstacle.left < bar.right + gap &&
    obstacle.right > bar.left - gap &&
    obstacle.top < bar.bottom + gap &&
    obstacle.bottom > bar.top - gap
  );
}

/**
 * A length rounded to whole CSS pixels, so a line of it has sharp ends.
 * Not to device pixels: a headless browser emulating a pixel ratio, as
 * every capture does, lays out in whole CSS pixels and would round a half
 * pixel again. Half a CSS pixel is at most one device pixel at ratio 2.
 */
export function snapLength(pixels: number): number {
  return Math.max(1, Math.round(pixels));
}
