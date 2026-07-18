/**
 * Canonical main-view surface-dimension contract.
 *
 * CSS geometry is converted to device pixels by the render paths before it
 * reaches this boundary. Keeping validation here means neither an initial 0×0
 * mount nor a malformed/oversized value can reach OffscreenCanvas/WebGPU.
 */

/** WebGPU's guaranteed minimum maxTextureDimension2D. */
export const DEFAULT_MAX_RENDER_SURFACE_DIMENSION = 8192;

export type RenderSurfaceRejectionReason =
  | "non-finite"
  | "non-positive"
  | "unsafe-integer"
  | "exceeds-device-limit";

export interface RenderSurfaceSize {
  width: number;
  height: number;
}

export type RenderSurfaceValidation =
  | { ok: true; size: RenderSurfaceSize }
  | { ok: false; reason: RenderSurfaceRejectionReason };

/**
 * Round finite device-pixel inputs once, then validate the exact integers sent
 * over the worker boundary. Positive CSS sizes are never compared with the GPU
 * limit until their DPR-scaled device-pixel form reaches this function.
 */
export function validateRenderSurfaceSize(
  width: number,
  height: number,
  maxDimension = DEFAULT_MAX_RENDER_SURFACE_DIMENSION,
): RenderSurfaceValidation {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, reason: "non-finite" };
  }
  const normalizedWidth = Math.round(width);
  const normalizedHeight = Math.round(height);
  if (normalizedWidth <= 0 || normalizedHeight <= 0) {
    return { ok: false, reason: "non-positive" };
  }
  if (
    !Number.isSafeInteger(normalizedWidth) ||
    !Number.isSafeInteger(normalizedHeight) ||
    !Number.isSafeInteger(maxDimension) ||
    maxDimension <= 0
  ) {
    return { ok: false, reason: "unsafe-integer" };
  }
  if (normalizedWidth > maxDimension || normalizedHeight > maxDimension) {
    return { ok: false, reason: "exceeds-device-limit" };
  }
  return {
    ok: true,
    size: { width: normalizedWidth, height: normalizedHeight },
  };
}

/**
 * Validate non-allocation viewport geometry (for example cursor sizing).
 * Unlike a render target, this value may legitimately exceed the device's
 * texture limit when a reduced render scale keeps the actual canvas smaller.
 */
export function validateRenderViewportSize(
  width: number,
  height: number,
): RenderSurfaceValidation {
  return validateRenderSurfaceSize(width, height, Number.MAX_SAFE_INTEGER);
}
