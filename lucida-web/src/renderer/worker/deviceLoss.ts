/**
 * Device loss. A driver reset, a crashed GPU process, or `destroy()` loses
 * the device and everything built on it, but not the canvas: a new device
 * configures the same context, so the worker carries on without a reload.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { configureCanvas } from "../gpuContext.ts";
import { applyColdState } from "../coldState/index.ts";
import { rebindMinimapCanvas } from "../minimapHandlers.ts";
import { releaseDeviceResources } from "./lifecycle.ts";
import { postGpuMemoryIfChanged } from "./gpuBudget.ts";
import { gpuErrorKind, reportGpuError } from "./gpuErrors.ts";

/**
 * A device lost more often than this inside the window is not replaced: a
 * loss the worker's own work causes would otherwise repeat for as long as the
 * page stays open.
 */
export const MAX_DEVICE_LOSSES = 3;
export const DEVICE_LOSS_WINDOW_MS = 60_000;

export interface DeviceRecovery {
  /**
   * Run a task in message order. Recovery swaps the device and renderers, and
   * a handler that awaited across the swap would mix the two devices.
   */
  schedule(task: () => Promise<void>): void;
  requestDevice(): Promise<GPUDevice>;
  /** Make `device` the context's device and rebuild the renderers on it. */
  adopt(device: GPUDevice): void;
}

/** Report `device`'s uncaught errors, and replace it when it is lost. */
export function watchDevice(ctx: WorkerCtx, device: GPUDevice, recovery: DeviceRecovery): void {
  device.addEventListener("uncapturederror", (event) => {
    if (ctx.device !== device) return;
    const { error } = event as GPUUncapturedErrorEvent;
    reportGpuError(ctx, gpuErrorKind(error), error.message);
  });
  device.lost.then((info) => {
    if (ctx.device !== device || ctx.state.closing) return;
    reportGpuError(ctx, "device-lost", info.message || `the device was lost (${info.reason})`);
    recovery.schedule(() => recoverDevice(ctx, recovery));
  }, () => {});
}

/**
 * Replace the lost device: free what was built on it, take a new one,
 * configure the same canvas, and rebuild every dataset's pools from the cold
 * state the worker holds. The pools start empty, so the page is told to send
 * again what it wants.
 */
export async function recoverDevice(
  ctx: WorkerCtx,
  recovery: DeviceRecovery,
  now: number = performance.now(),
): Promise<void> {
  const state = ctx.state;
  if (state.closing || state.gpuFailed) return;
  releaseDeviceResources(ctx);

  state.deviceLosses = state.deviceLosses.filter((at) => now - at < DEVICE_LOSS_WINDOW_MS);
  state.deviceLosses.push(now);
  if (state.deviceLosses.length > MAX_DEVICE_LOSSES) {
    giveUp(ctx, `it was lost ${state.deviceLosses.length} times in a minute`);
    return;
  }

  let device: GPUDevice;
  try {
    device = await recovery.requestDevice();
  } catch (err) {
    giveUp(ctx, err instanceof Error ? err.message : String(err));
    return;
  }
  if (state.closing) {
    device.destroy();
    return;
  }

  recovery.adopt(device);
  configureCanvas(ctx.context, device, ctx.format);
  rebindMinimapCanvas(ctx);
  watchDevice(ctx, device, recovery);
  if (state.canvasColors) {
    ctx.getCompositor().setBackground(state.canvasColors.background);
    ctx.getSliceRenderer().setTileBorderColor(state.canvasColors.tileBorder);
  }
  if (state.cursors) ctx.getCursorRenderer().updateCursors(state.cursors.data, state.cursors.count);

  // Told before the wanted sets, so the page forgets what it sent first.
  ctx.post({ type: "gpuDeviceRestored" });
  for (const cold of state.coldStateByDataset.values()) applyColdState(ctx, cold);
  for (const datasetId of state.coldStateByDataset.keys()) ctx.postWantedSet(datasetId);
  postGpuMemoryIfChanged(ctx);
}

function giveUp(ctx: WorkerCtx, reason: string): void {
  ctx.state.gpuFailed = true;
  ctx.post({ type: "gpuFailed", message: `The GPU device was lost and could not be replaced (${reason})` });
}
