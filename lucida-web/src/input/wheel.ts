/**
 * A wheel event as a zoom, the same in every view. Browsers report a wheel
 * in pixels, lines or pages, and a trackpad as a stream of small pixel
 * deltas, so the delta becomes CSS pixels first and the zoom is exponential
 * in them. Events then compound to the zoom of their summed delta: a
 * trackpad zooms by how far the fingers travel at any event rate, and a
 * notch in and a notch out land where they started.
 *
 * The page takes `deltaY` as the browser delivers it and never reads the
 * device pixel ratio, so a notch zooms alike at every ratio.
 */

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** One mouse notch's delta as Chrome on Windows reports it, in CSS pixels. */
export const WHEEL_NOTCH_PX = 100;
/** How far one notch zooms. */
export const WHEEL_NOTCH_ZOOM = 1.1;
/** A line-mode delta's line, in CSS pixels: a line of the default 16 px font. */
export const WHEEL_LINE_PX = 16;

/** Natural-log zoom per CSS pixel of a wheel's or a trackpad's scroll. */
export const WHEEL_ZOOM_PER_PIXEL = Math.log(WHEEL_NOTCH_ZOOM) / WHEEL_NOTCH_PX;

/**
 * Natural-log zoom per CSS pixel of a pinch. Browsers send a trackpad pinch
 * as wheel events with `ctrlKey` set whose deltas sum to −100·ln(scale), so
 * at this gain what was under the fingers stays there.
 */
export const PINCH_ZOOM_PER_PIXEL = 1 / 100;

/**
 * The most one pinch event zooms, in natural log: a notch's worth. Ctrl with
 * a mouse wheel arrives as the same `ctrlKey` event, 100 px a notch, which
 * the pinch gain alone would turn into a zoom of e.
 */
const PINCH_STEP_MAX = Math.log(WHEEL_NOTCH_ZOOM);

export interface WheelInput {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

/** The event's vertical delta in CSS pixels, a page being `pageHeightPx`,
 * or the window's height. */
export function wheelPixels(e: Pick<WheelInput, "deltaY" | "deltaMode">, pageHeightPx?: number): number {
  if (e.deltaMode === DOM_DELTA_LINE) return e.deltaY * WHEEL_LINE_PX;
  if (e.deltaMode === DOM_DELTA_PAGE) return e.deltaY * (pageHeightPx ?? window.innerHeight);
  return e.deltaY;
}

/**
 * The factor a wheel event scales what a view shows by: above 1, zooming
 * in, for a negative delta, and exactly 1 for none.
 */
export function wheelZoom(e: WheelInput, pageHeightPx?: number): number {
  const px = wheelPixels(e, pageHeightPx);
  if (!e.ctrlKey) return Math.exp(-px * WHEEL_ZOOM_PER_PIXEL);
  return Math.exp(Math.min(PINCH_STEP_MAX, Math.max(-PINCH_STEP_MAX, -px * PINCH_ZOOM_PER_PIXEL)));
}
