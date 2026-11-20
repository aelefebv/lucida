/**
 * Pool growths, reported to the page for the trace. A growth allocates a
 * larger texture and copies the pool into it, and the frames queued behind
 * the copy wait for it, so a run says when each growth was and how long the
 * GPU took to get through it.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { PoolMode } from "../workerProtocol.ts";

/**
 * Report a growth whose copy was just submitted, once the GPU has done
 * everything submitted so far. Not awaited: the delivery that grew the pool
 * goes on meanwhile.
 */
export function reportPoolGrowth(
  ctx: WorkerCtx,
  poolKey: string,
  mode: PoolMode,
  fromBytes: number,
  toBytes: number,
): void {
  const submittedAtMs = performance.timeOrigin + performance.now();
  const done = () => ctx.post({
    type: "poolGrowth",
    poolKey,
    mode,
    fromBytes,
    toBytes,
    submittedAtMs,
    doneAtMs: performance.timeOrigin + performance.now(),
  });
  ctx.device.queue.onSubmittedWorkDone().then(done, done);
}
