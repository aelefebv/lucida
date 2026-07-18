/** WebGPU render worker — thin entry point that delegates to `worker/`. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { bootstrapWorker } from "./worker/bootstrap.ts";
import { dispatchMessage } from "./worker/dispatch.ts";
import { handleDestroy } from "./worker/lifecycle.ts";
import {
  GpuDeviceFailure,
  observeGpuDeviceFailure,
} from "./worker/deviceLifecycle.ts";
import type { RenderWorkerErrorCode } from "./workerProtocol.ts";
import { getDeviceLimits } from "./gpuContext.ts";

let ctx: WorkerCtx | null = null;
let terminating = false;
let stopObservingDevice: (() => void) | null = null;

// `self` is typed as `Window` here (the app tsconfig's lib has DOM but not
// WebWorker), whose `postMessage` overloads don't include the
// `(message, transfer[])` form the dedicated-worker scope provides at runtime.
// Narrow to just the shape we use so the transfer-list call type-checks.
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

function post(msg: WorkerToMainMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerScope.postMessage(msg, transfer);
  } else {
    workerScope.postMessage(msg);
  }
}

/** Fatal worker/device boundary: notify once, reclaim, and close the worker. */
function failTerminal(error: unknown): void {
  if (terminating) return;
  terminating = true;
  stopObservingDevice?.();
  stopObservingDevice = null;
  const message = error instanceof Error ? error.message : String(error);
  let code: RenderWorkerErrorCode | undefined;
  if (error instanceof GpuDeviceFailure) {
    code = error.kind === "out-of-memory"
      ? "gpu-out-of-memory"
      : error.kind === "device-lost"
        ? "gpu-device-lost"
        : "gpu-uncaptured-error";
  }
  post({ type: "error", message, ...(code ? { code } : {}) });
  const current = ctx;
  ctx = null;
  if (current) {
    try {
      handleDestroy(current);
      return;
    } catch {
      // A lost device may reject individual destroy calls. The allocator's
      // bookkeeping has still been invalidated by device loss; close below.
    }
  }
  self.close();
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      const initialized = await bootstrapWorker(msg.canvas, post);
      ctx = initialized;
      // Device loss is asynchronous and otherwise bypasses the message
      // dispatch try/catch. Route it through the same terminal policy.
      stopObservingDevice = observeGpuDeviceFailure(initialized.device, failTerminal);
      post({
        type: "ready",
        maxTextureDimension2D: getDeviceLimits(initialized.device).maxTextureDimension2D,
      });
      return;
    }
    if (!ctx) return; // ignore messages before init completes
    if (msg.type === "destroy") {
      const current = ctx;
      ctx = null;
      terminating = true;
      stopObservingDevice?.();
      stopObservingDevice = null;
      handleDestroy(current);
      return;
    }
    await dispatchMessage(ctx, msg);
  } catch (err) {
    failTerminal(err);
  }
};

self.onmessageerror = () => {
  failTerminal(new Error("Render worker input could not be deserialized"));
};
