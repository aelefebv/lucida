import { afterEach, describe, expect, it, vi } from "vitest";
import { MainThreadLongTaskMonitor } from "./renderRuntimeContract.ts";

describe("mounted renderer main-thread telemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retains bounded Long Task counters and disconnects cleanly", () => {
    let callback: PerformanceObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("PerformanceObserver", class {
      constructor(next: PerformanceObserverCallback) {
        callback = next;
      }
      observe = observe;
      disconnect = disconnect;
    });

    const monitor = new MainThreadLongTaskMonitor();
    const list = {
      getEntries: () => [
        { duration: 55, startTime: 100 },
        { duration: 80, startTime: 250 },
      ],
    } as unknown as PerformanceObserverEntryList;
    expect(callback).not.toBeNull();
    (callback as unknown as PerformanceObserverCallback)(list, {} as PerformanceObserver);

    expect(observe).toHaveBeenCalledWith({ entryTypes: ["longtask"] });
    expect(monitor.snapshot()).toEqual({
      longTaskObserverSupported: true,
      longTaskCount: 2,
      longTaskDurationMs: 135,
      longestLongTaskMs: 80,
      lastLongTaskAt: 250,
    });
    monitor.disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("reports unsupported instead of throwing when Long Tasks cannot be observed", () => {
    vi.stubGlobal("PerformanceObserver", class {
      observe() {
        throw new Error("unsupported entry type");
      }
      disconnect() {}
    });

    expect(new MainThreadLongTaskMonitor().snapshot()).toEqual({
      longTaskObserverSupported: false,
      longTaskCount: 0,
      longTaskDurationMs: 0,
      longestLongTaskMs: 0,
      lastLongTaskAt: null,
    });
  });
});
