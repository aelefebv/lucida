/**
 * How far a pointer or wheel input moves the view. The viewers read these,
 * and the trace seam publishes them, so the trace driver's scripted steps
 * turn an angle or a factor into the drag or the wheel delta a person would
 * make with the same constants the page applies. A change here reaches both
 * sides at once.
 */
import { WHEEL_ZOOM_PER_PIXEL } from "../input/wheel.ts";

/** Radians of orbit per CSS pixel of drag in the volume view. */
export const ORBIT_RADIANS_PER_PIXEL = 0.005;

export interface InputScale {
  orbitRadiansPerPixel: number;
  /** Every view zooms by `exp(−deltaY × this)` for a pixel-mode wheel event without Ctrl. */
  wheelZoomPerPixel: number;
}

/** The constants as the seam publishes them. */
export const INPUT_SCALE: Readonly<InputScale> = Object.freeze({
  orbitRadiansPerPixel: ORBIT_RADIANS_PER_PIXEL,
  wheelZoomPerPixel: WHEEL_ZOOM_PER_PIXEL,
});
