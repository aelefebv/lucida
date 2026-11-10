/**
 * The lag reading: how the view kept up with input, read from the run's lag
 * tier over the run or a window of it.
 *
 * A dropped frame is a display refresh an input waited through with no new
 * frame, beyond what a frame that keeps up takes. Each frame that answers an
 * input is measured from when its earliest input started waiting on it: the
 * frame before it finishing, if that input was already waiting then, when a
 * new frame was owed one refresh later; otherwise the input's own event, when
 * a frame that keeps up needs two refreshes, one for the next frame callback
 * and one for the frame. Input slower than the display leaves gaps nobody
 * waited through, and those are not drops.
 */

import type { TraceRun } from "../types.ts";
import { usToMs } from "./phaseRollup.ts";
import { summariseTiming } from "./renderTiming.ts";
import type { LagReading } from "./types.ts";
import { clipSpan, inWindow, type RunWindow } from "./window.ts";

const MEASURED =
  "Input to frame runs from each input event to the GPU finishing the first frame dispatched after it, timed by the render worker; the display shows that frame at its next refresh, so each figure reads up to one display interval low.";

export function deriveLag(run: TraceRun, window: RunWindow): LagReading | null {
  const lag = run.lag;
  if (!lag) return null;
  // The whole run keeps an input whose event came before the run opened:
  // its wait is the lag being measured.
  const inputs = window.whole ? lag.inputs : lag.inputs.filter((input) => inWindow(input.atUs, window));
  if (inputs.length === 0) return null;

  const frames = [...lag.framesUs].sort((a, b) => a - b);
  const latencies: number[] = [];
  /** The earliest input event each answering frame drew, by the frame's index. */
  const earliest = new Map<number, number>();
  let unanswered = 0;
  let motionStartUs = Number.POSITIVE_INFINITY;
  let motionEndUs = Number.NEGATIVE_INFINITY;
  let firstInputMs: number | null = null;
  for (const input of inputs) {
    if (input.atUs < motionStartUs) {
      firstInputMs = input.presentedUs === null ? null : usToMs(input.presentedUs - input.atUs);
    }
    motionStartUs = Math.min(motionStartUs, input.atUs);
    if (input.presentedUs === null) {
      unanswered++;
      continue;
    }
    latencies.push(input.presentedUs - input.atUs);
    motionEndUs = Math.max(motionEndUs, input.presentedUs);
    const answer = lowerBound(frames, input.presentedUs);
    if (frames[answer] !== input.presentedUs) continue;
    earliest.set(answer, Math.min(earliest.get(answer) ?? Number.POSITIVE_INFINITY, input.atUs));
  }

  let presented = 0;
  for (const frameUs of frames) if (frameUs >= motionStartUs && frameUs <= motionEndUs) presented++;
  const intervalUs = lag.displayIntervalUs;
  let dropped: number | null = null;
  if (intervalUs !== null && intervalUs > 0) {
    dropped = 0;
    for (const [index, arrivedUs] of earliest) {
      const previousUs = index > 0 ? frames[index - 1] : Number.NEGATIVE_INFINITY;
      const waitedUs = frames[index] - Math.max(previousUs, arrivedUs);
      const keepsUp = arrivedUs <= previousUs ? 1 : 2;
      dropped += Math.max(0, Math.round(waitedUs / intervalUs) - keepsUp);
    }
  }

  let count = 0;
  let longestUs = 0;
  let totalUs = 0;
  for (const task of lag.longTasks) {
    const us = window.whole
      ? task.durationUs
      : (clipSpan(task.startUs, task.startUs + task.durationUs, window)?.us ?? 0);
    if (us <= 0) continue;
    count++;
    longestUs = Math.max(longestUs, us);
    totalUs += us;
  }

  const unrecorded = lag.inputsUnrecorded + lag.framesUnrecorded + lag.longTasksUnrecorded;
  const displayIntervalMs = intervalUs === null ? null : usToMs(intervalUs);
  return {
    inputs: inputs.length,
    inputToFrame: summariseTiming(latencies),
    firstInputMs,
    unanswered,
    longTasks: { count, longestMs: usToMs(longestUs), totalMs: usToMs(totalUs) },
    frames: { presented, dropped, displayIntervalMs },
    unrecorded,
    statement: [
      MEASURED,
      displayIntervalMs === null
        ? "The page had not drawn enough consecutive animation frames to tell the display's refresh interval, so dropped frames are not counted."
        : `Dropped frames are the display refreshes an input waited through beyond what a frame that keeps up takes, against a ${displayIntervalMs} ms refresh interval, the median gap between the page's recent animation frames; like input to frame they are approximate.`,
      unanswered > 0
        ? `${unanswered} input(s) had no finished frame when the run closed and are left out of the timing.`
        : null,
      unrecorded > 0 ? `${unrecorded} record(s) past the lag tier's capacity were counted and not kept.` : null,
    ]
      .filter((sentence) => sentence !== null)
      .join(" "),
  };
}

/** The first index whose value is at least `target`, in an ascending array. */
function lowerBound(sorted: number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
