/**
 * GPU errors, reported to the page. WebGPU raises none of them as an
 * exception: a failed allocation or an invalid command hands back an unusable
 * object and an error event, so nothing else would ever say the frame is wrong.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { GpuErrorKind } from "../workerProtocol.ts";

/**
 * Reports of one kind closer together than this fold into the next one, so
 * an error repeated every frame reaches the page about once a second.
 */
export const GPU_ERROR_REPORT_SPACING_MS = 1000;

/** Which of the three WebGPU error classes `error` is. */
export function gpuErrorKind(error: GPUError): GpuErrorKind {
  if (typeof GPUOutOfMemoryError !== "undefined" && error instanceof GPUOutOfMemoryError) return "out-of-memory";
  if (typeof GPUInternalError !== "undefined" && error instanceof GPUInternalError) return "internal";
  return "validation";
}

/** Tell the page about a GPU error now, or with the next report of its kind if one went out within the spacing. */
export function reportGpuError(ctx: WorkerCtx, kind: GpuErrorKind, message: string): void {
  const reports = ctx.state.gpuErrorReports;
  const pending = reports.get(kind);
  if (pending?.timer != null) {
    if (pending.folded === 0) pending.message = message;
    pending.folded++;
    return;
  }
  ctx.post({ type: "gpuError", kind, message, count: 1 });
  const report = { timer: null as ReturnType<typeof setTimeout> | null, folded: 0, message };
  report.timer = setTimeout(() => {
    report.timer = null;
    if (report.folded === 0) return;
    ctx.post({ type: "gpuError", kind, message: report.message, count: report.folded });
    report.folded = 0;
  }, GPU_ERROR_REPORT_SPACING_MS);
  reports.set(kind, report);
}

/** Drop the folded reports, so none posts after the worker stops. */
export function clearGpuErrorReports(ctx: WorkerCtx): void {
  for (const report of ctx.state.gpuErrorReports.values()) {
    if (report.timer !== null) clearTimeout(report.timer);
  }
  ctx.state.gpuErrorReports.clear();
}

/**
 * Allocate under an out-of-memory error scope and return what `allocate`
 * made. A failed allocation is not an exception: the object comes back
 * unusable, and `onOutOfMemory` hears of it once the GPU answers, with the
 * same object. Nothing is reported for a device that has since been replaced.
 */
export function allocateWatched<T>(
  ctx: WorkerCtx,
  allocate: () => T,
  onOutOfMemory: (allocated: T) => void,
): T {
  const device = ctx.device;
  device.pushErrorScope("out-of-memory");
  let allocated: T;
  try {
    allocated = allocate();
  } catch (err) {
    void device.popErrorScope().catch(() => {});
    throw err;
  }
  device.popErrorScope().then(
    (error) => {
      if (!error || ctx.device !== device) return;
      reportGpuError(ctx, "out-of-memory", error.message);
      onOutOfMemory(allocated);
    },
    () => {},
  );
  return allocated;
}
