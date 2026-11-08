/**
 * The main thread's long tasks, as the browser reports them, handed to the
 * recorder. Input waits behind a long task and the render loop cannot tick
 * during one, so a long task during a gesture is lag the frame timings alone
 * would only show the effect of.
 */

import type { TraceRecorder } from "./recorder.ts";

/** Start observing. Returns the function that stops. A browser without the entry type observes nothing. */
export function observeLongTasks(recorder: Pick<TraceRecorder, "noteLongTask">): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) recorder.noteLongTask(entry.startTime, entry.duration);
  });
  observer.observe({ type: "longtask" });
  return () => observer.disconnect();
}
