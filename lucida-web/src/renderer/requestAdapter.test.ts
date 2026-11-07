import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADAPTER_ATTEMPTS, ADAPTER_RETRY_MS, requestAdapterWithRetry } from "./requestAdapter.ts";

function gpuAnswering(answers: Array<GPUAdapter | null>): { gpu: GPU; calls: () => number } {
  let calls = 0;
  const gpu = {
    requestAdapter: vi.fn(async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return answer;
    }),
  } as unknown as GPU;
  return { gpu, calls: () => calls };
}

const adapter = { name: "adapter" } as unknown as GPUAdapter;

describe("requestAdapterWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first adapter without waiting", async () => {
    const { gpu, calls } = gpuAnswering([adapter]);
    const result = requestAdapterWithRetry(gpu);
    await expect(result).resolves.toBe(adapter);
    expect(calls()).toBe(1);
  });

  it("asks again after a pause when the first answers are null", async () => {
    const { gpu, calls } = gpuAnswering([null, null, adapter]);
    const result = requestAdapterWithRetry(gpu);
    await vi.advanceTimersByTimeAsync(ADAPTER_RETRY_MS * 2);
    await expect(result).resolves.toBe(adapter);
    expect(calls()).toBe(3);
  });

  it("takes null as final once the attempts are spent", async () => {
    const { gpu, calls } = gpuAnswering([null]);
    const result = requestAdapterWithRetry(gpu, {}, { attempts: 3, retryMs: 10 });
    await vi.advanceTimersByTimeAsync(10 * 3);
    await expect(result).resolves.toBeNull();
    expect(calls()).toBe(3);
  });

  it("passes the caller's options through and defaults to a bounded budget", async () => {
    const { gpu } = gpuAnswering([adapter]);
    await requestAdapterWithRetry(gpu, { powerPreference: "high-performance" });
    expect(gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
    expect(ADAPTER_ATTEMPTS * ADAPTER_RETRY_MS).toBeGreaterThanOrEqual(5000);
  });
});
