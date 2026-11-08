import { afterEach, describe, expect, it, vi } from "vitest";

import { observeLongTasks } from "./longTasks.ts";

type Callback = (list: { getEntries: () => Array<{ startTime: number; duration: number }> }) => void;

function stubObserver(supported: string[]) {
  const observers: Array<{ callback: Callback; options: unknown; disconnected: boolean }> = [];
  class FakeObserver {
    static supportedEntryTypes = supported;
    private readonly record: (typeof observers)[number];
    constructor(callback: Callback) {
      this.record = { callback, options: null, disconnected: false };
      observers.push(this.record);
    }
    observe(options: unknown) {
      this.record.options = options;
    }
    disconnect() {
      this.record.disconnected = true;
    }
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
  return observers;
}

describe("observing long tasks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands each long task the browser reports to the recorder", () => {
    const observers = stubObserver(["longtask", "mark"]);
    const noteLongTask = vi.fn();
    const stop = observeLongTasks({ noteLongTask });
    expect(observers).toHaveLength(1);
    expect(observers[0].options).toEqual({ type: "longtask" });

    observers[0].callback({ getEntries: () => [{ startTime: 120, duration: 75 }, { startTime: 400, duration: 51 }] });
    expect(noteLongTask.mock.calls).toEqual([[120, 75], [400, 51]]);
    stop();
    expect(observers[0].disconnected).toBe(true);
  });

  it("observes nothing in a browser without the entry type", () => {
    const observers = stubObserver(["mark"]);
    observeLongTasks({ noteLongTask: vi.fn() })();
    expect(observers).toHaveLength(0);
  });
});
