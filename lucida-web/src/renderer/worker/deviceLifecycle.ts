export type GpuDeviceFailureKind =
  | "out-of-memory"
  | "device-lost"
  | "uncaptured-error";

/** A typed terminal failure at the WebGPU device boundary. */
export class GpuDeviceFailure extends Error {
  readonly kind: GpuDeviceFailureKind;

  constructor(kind: GpuDeviceFailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GpuDeviceFailure";
    this.kind = kind;
  }
}

function isOutOfMemoryError(error: GPUError): boolean {
  // `GPUOutOfMemoryError` is not present in every test/browser global even
  // when WebGPU is available. Constructor-name detection keeps this boundary
  // portable while still distinguishing the standard WebGPU error class.
  return error.constructor?.name === "GPUOutOfMemoryError";
}

function uncapturedFailure(error: GPUError): GpuDeviceFailure {
  if (isOutOfMemoryError(error)) {
    return new GpuDeviceFailure(
      "out-of-memory",
      "WebGPU ran out of memory while allocating renderer resources; " +
        "restart the renderer, reduce active layers, or close other GPU-heavy views",
      error,
    );
  }
  return new GpuDeviceFailure(
    "uncaptured-error",
    `Uncaptured WebGPU error: ${error.message}`,
    error,
  );
}

/**
 * Route the first asynchronous WebGPU failure into the worker's terminal
 * lifecycle and detach immediately. A terminal worker restart is deliberate:
 * an async allocation OOM can invalidate a newly-created resource after its
 * synchronous factory returned successfully, so continuing would publish that
 * resource and produce repeated validation errors. Closing the worker reclaims
 * the whole session budget and gives the UI one actionable recovery path.
 */
export function observeGpuDeviceFailure(
  device: GPUDevice,
  fail: (error: Error) => void,
): () => void {
  let active = true;
  const stop = (): void => {
    if (!active) return;
    active = false;
    device.removeEventListener?.("uncapturederror", onUncapturedError);
  };
  const settle = (error: Error): void => {
    if (!active) return;
    stop();
    fail(error);
  };
  const onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    settle(uncapturedFailure(event.error));
  };
  device.addEventListener?.("uncapturederror", onUncapturedError);
  void device.lost.then(
    (info) => {
      settle(new GpuDeviceFailure(
        "device-lost",
        `WebGPU device lost (${info.reason || "unknown"})` +
          (info.message ? `: ${info.message}` : ""),
      ));
    },
    (error) => {
      settle(new GpuDeviceFailure(
        "device-lost",
        error instanceof Error ? error.message : String(error),
        error,
      ));
    },
  );
  return stop;
}
