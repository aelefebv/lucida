/**
 * Ask for the default WebGPU adapter, allowing for a GPU process that is
 * still starting. On a cold headless launch `requestAdapter()` can resolve
 * `null` for a few seconds. `null` is also the permanent answer without a
 * usable GPU, so the retry is bounded: twenty tries half a second apart cover
 * the four seconds seen on a Linux host with a discrete GPU. The render
 * worker and the trace seam both come through here, so the recorded adapter
 * is the worker's.
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
