/** Production-safe, pull-based observability for renderer acceptance tests. */
import type { RenderClientRuntimeSnapshot } from "./renderer/renderClient.ts";

export interface MainThreadRuntimeSnapshot {
  readonly longTaskObserverSupported: boolean;
  readonly longTaskCount: number;
  readonly longTaskDurationMs: number;
  readonly longestLongTaskMs: number;
  readonly lastLongTaskAt: number | null;
}

export interface LucidaRenderRuntimeSnapshot {
  readonly version: 1;
  readonly at: number;
  readonly mode: "slice" | "volume";
  readonly loop: {
    readonly animationFramePending: boolean;
    readonly interactiveDirty: boolean;
    readonly residencyDirty: boolean;
  };
  readonly client: RenderClientRuntimeSnapshot;
  readonly mainThread: MainThreadRuntimeSnapshot;
}

export interface LucidaRenderContract {
  readonly version: 1;
  getSnapshot(): LucidaRenderRuntimeSnapshot;
}

declare global {
  interface Window {
    /**
     * Bounded renderer telemetry for browser acceptance checks. It contains
     * counters and last-observation metadata only—never dataset or user data.
     */
    __lucidaRenderContract?: LucidaRenderContract;
  }
}

/**
 * Counts browser Long Task entries while a viewer is mounted. Long Task
 * entries have a browser-defined 50 ms threshold, which makes a zero-delta
 * idle assertion meaningful without adding a sampling timer of our own.
 */
export class MainThreadLongTaskMonitor {
  private observer: PerformanceObserver | null = null;
  private supported = false;
  private count = 0;
  private durationMs = 0;
  private longestMs = 0;
  private lastAt: number | null = null;

  constructor() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.count++;
          this.durationMs += entry.duration;
          this.longestMs = Math.max(this.longestMs, entry.duration);
          this.lastAt = entry.startTime;
        }
      });
      this.observer.observe({ entryTypes: ["longtask"] });
      this.supported = true;
    } catch {
      // Older engines may expose PerformanceObserver without the Long Tasks
      // entry type. The snapshot makes that lack of support explicit.
      this.observer?.disconnect();
      this.observer = null;
    }
  }

  snapshot(): MainThreadRuntimeSnapshot {
    return {
      longTaskObserverSupported: this.supported,
      longTaskCount: this.count,
      longTaskDurationMs: this.durationMs,
      longestLongTaskMs: this.longestMs,
      lastLongTaskAt: this.lastAt,
    };
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
