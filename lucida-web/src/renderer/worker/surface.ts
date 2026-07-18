/** Defensive surface admission at the worker/GPU boundary. */
import { getDeviceLimits } from "../gpuContext.ts";
import {
  validateRenderSurfaceSize,
  validateRenderViewportSize,
  type RenderSurfaceSize,
} from "../renderSurfaceContract.ts";
import type { WorkerCtx } from "../workerContext.ts";

/**
 * Validate and normalize a canvas allocation before OffscreenCanvas or WebGPU
 * sees it. The main thread owns the normal admission path; this duplicate
 * check protects the GPU boundary from malformed or out-of-order messages.
 */
export function admitWorkerRenderSurface(
  ctx: WorkerCtx,
  width: number,
  height: number,
): RenderSurfaceSize | null {
  const result = validateRenderSurfaceSize(
    width,
    height,
    getDeviceLimits(ctx.device).maxTextureDimension2D,
  );
  return result.ok ? result.size : null;
}

/** Validate non-allocation geometry without applying a GPU texture limit. */
export function admitWorkerRenderViewport(
  width: number,
  height: number,
): RenderSurfaceSize | null {
  const result = validateRenderViewportSize(width, height);
  return result.ok ? result.size : null;
}
