/**
 * How far a pointer or wheel input moves the view. The viewers read these,
 * and the trace seam publishes them, so the trace driver's scripted steps
 * turn an angle or a factor into the drag or the wheel delta a person would
 * make with the same constants the page applies (ADR 0051, as amended). A
 * change here reaches both sides at once.
 */

/** Radians of orbit per CSS pixel of drag in the volume view. */
export const ORBIT_RADIANS_PER_PIXEL = 0.005;

/** The slice view's zoom per wheel event: in on a negative delta, out on a positive one. */
export const SLICE_ZOOM_IN_PER_NOTCH = 1.1;
export const SLICE_ZOOM_OUT_PER_NOTCH = 0.9;

/** The volume view scales its camera distance by `1 + deltaY × this` per wheel event. */
export const VOLUME_ZOOM_PER_WHEEL_DELTA = 0.001;

export interface InputScale {
  orbitRadiansPerPixel: number;
  sliceZoomInPerNotch: number;
  sliceZoomOutPerNotch: number;
  volumeZoomPerWheelDelta: number;
}

/** The constants as the seam publishes them. */
export const INPUT_SCALE: Readonly<InputScale> = Object.freeze({
  orbitRadiansPerPixel: ORBIT_RADIANS_PER_PIXEL,
  sliceZoomInPerNotch: SLICE_ZOOM_IN_PER_NOTCH,
  sliceZoomOutPerNotch: SLICE_ZOOM_OUT_PER_NOTCH,
  volumeZoomPerWheelDelta: VOLUME_ZOOM_PER_WHEEL_DELTA,
});
