import { describe, expect, it, vi } from "vitest";
import {
  GpuDeviceFailure,
  observeGpuDeviceFailure,
} from "./deviceLifecycle.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("observeGpuDeviceFailure", () => {
  it("routes a controlled device-lost promise exactly once", async () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const fail = vi.fn();
    const device = {
      lost: lost.promise,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as GPUDevice;
    observeGpuDeviceFailure(device, fail);

    lost.resolve({ reason: "unknown", message: "adapter reset" } as GPUDeviceLostInfo);
    await lost.promise;
    await Promise.resolve();

    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0].message).toContain("adapter reset");
    expect(fail.mock.calls[0][0]).toMatchObject({
      name: "GpuDeviceFailure",
      kind: "device-lost",
    });
    expect(device.removeEventListener).toHaveBeenCalledOnce();
  });

  it("turns an asynchronous allocation OOM into one actionable terminal failure", async () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const fail = vi.fn();
    let onUncapturedError: ((event: GPUUncapturedErrorEvent) => void) | undefined;
    const device = {
      lost: lost.promise,
      addEventListener: vi.fn((_type, listener) => { onUncapturedError = listener; }),
      removeEventListener: vi.fn(),
    } as unknown as GPUDevice;
    observeGpuDeviceFailure(device, fail);

    const oom = Object.assign(new Error("allocation failed"), {
      constructor: { name: "GPUOutOfMemoryError" },
    }) as unknown as GPUError;
    onUncapturedError?.({ error: oom } as GPUUncapturedErrorEvent);
    // Browsers may resolve `device.lost` immediately after the OOM. The
    // observer still reports only the first root cause.
    lost.resolve({ reason: "unknown", message: "device reset" } as GPUDeviceLostInfo);
    await lost.promise;
    await Promise.resolve();

    expect(fail).toHaveBeenCalledTimes(1);
    const failure = fail.mock.calls[0][0] as GpuDeviceFailure;
    expect(failure.kind).toBe("out-of-memory");
    expect(failure.message).toContain("restart the renderer");
    expect(failure.message).toContain("reduce active layers");
    expect(device.removeEventListener).toHaveBeenCalledOnce();
  });

  it("settles once when repeated uncaptured validation errors arrive", () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const fail = vi.fn();
    let onUncapturedError: ((event: GPUUncapturedErrorEvent) => void) | undefined;
    const device = {
      lost: lost.promise,
      addEventListener: vi.fn((_type, listener) => { onUncapturedError = listener; }),
      removeEventListener: vi.fn(),
    } as unknown as GPUDevice;
    observeGpuDeviceFailure(device, fail);
    const event = {
      error: new Error("invalid texture") as unknown as GPUError,
    } as GPUUncapturedErrorEvent;

    onUncapturedError?.(event);
    onUncapturedError?.(event);

    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0]).toMatchObject({ kind: "uncaptured-error" });
  });

  it("cancels observation during intentional teardown", async () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const fail = vi.fn();
    const device = {
      lost: lost.promise,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as GPUDevice;
    const stop = observeGpuDeviceFailure(device, fail);
    stop();

    lost.resolve({ reason: "destroyed", message: "normal shutdown" } as GPUDeviceLostInfo);
    await lost.promise;
    await Promise.resolve();

    expect(fail).not.toHaveBeenCalled();
    expect(device.removeEventListener).toHaveBeenCalledOnce();
  });
});
