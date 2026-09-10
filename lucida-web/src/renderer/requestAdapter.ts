/**
 * Ask for the default WebGPU adapter, allowing for a GPU process that is
 * still starting.
 *
 * On a cold headless launch with a hardware backend, the first
 * `requestAdapter()` can resolve to `null` for a few seconds and then start
 * answering with the real adapter. `null` is also the permanent answer on a
 * machine with no usable GPU, so the retry is bounded: twenty attempts half a
 * second apart cover the start-up observed on a Linux host with a discrete
 * GPU (about four seconds) without holding a GPU-less page for long.
 *
 * Both the render worker and the trace seam go through here, so the adapter
 * the seam records is the one the worker's device came from.
 */

export const ADAPTER_ATTEMPTS = 20;
export const ADAPTER_RETRY_MS = 500;

export interface AdapterRetry {
  /** Total requests before `null` is taken as final. At least one. */
  attempts?: number;
  /** Pause between requests, in milliseconds. */
  retryMs?: number;
}

export async function requestAdapterWithRetry(
  gpu: GPU,
  options: GPURequestAdapterOptions = {},
  retry: AdapterRetry = {},
): Promise<GPUAdapter | null> {
  const attempts = Math.max(1, retry.attempts ?? ADAPTER_ATTEMPTS);
  const retryMs = retry.retryMs ?? ADAPTER_RETRY_MS;
  for (let attempt = 1; ; attempt++) {
    const adapter = await gpu.requestAdapter(options);
    if (adapter || attempt >= attempts) return adapter;
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}
