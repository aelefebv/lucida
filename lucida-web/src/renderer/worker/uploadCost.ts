/**
 * What chunk deliveries cost the worker, reported to the page, which paces
 * its uploads by it. The cost is the whole delivery: the texture writes, and
 * the slot search and eviction that make room for them, since all of it
 * holds up the frame the page posts behind them.
 */

import type { MainToWorkerMessage, PoolMode, UploadCostMessage } from "../workerProtocol.ts";

/**
 * The delivery time that sends a report without waiting for the deliveries
 * queued behind it, so the page hears of room in the worker as it is made
 * rather than once the worker is through everything it was handed.
 */
export const UPLOAD_REPORT_MS = 4;

/** The pools a message delivers chunks to and the bytes it carries, or null for any other message. */
export function chunkDeliveryOf(msg: MainToWorkerMessage): { mode: PoolMode; bytes: number } | null {
  let mode: PoolMode;
  switch (msg.type) {
    case "sliceChunkData":
    case "labelSliceChunkData":
      mode = "slice";
      break;
    case "volumeChunkData":
    case "labelVolumeChunkData":
      mode = "volume";
      break;
    default:
      return null;
  }
  let bytes = 0;
  for (const chunk of msg.chunks) bytes += chunk.data.byteLength;
  return { mode, bytes };
}

/**
 * Sums the cost of each delivery and reports it once the deliveries already
 * queued have run, or once {@link UPLOAD_REPORT_MS} of it has built up, one
 * report per mode. A report goes once the GPU has done the writes as well,
 * so the page counts a delivery until then: a GPU behind on them, drawing a
 * long frame or copying slowly, holds the page's next uploads back rather
 * than letting them queue in front of the frame that answers an input.
 */
export class UploadCostMeter {
  private pending: Record<PoolMode, { bytes: number; ms: number }> = emptyPending();
  private pendingMs = 0;
  private scheduled = false;
  private readonly post: (msg: UploadCostMessage) => void;
  private readonly gpuDone: () => Promise<unknown>;
  private readonly schedule: (flush: () => void) => void;

  constructor(
    post: (msg: UploadCostMessage) => void,
    gpuDone: () => Promise<unknown>,
    schedule: (flush: () => void) => void = (flush) => setTimeout(flush, 0),
  ) {
    this.post = post;
    this.gpuDone = gpuDone;
    this.schedule = schedule;
  }

  /** A delivery to the pools of `mode` carried `bytes` and took the worker `ms`. */
  note(mode: PoolMode, bytes: number, ms: number): void {
    const pending = this.pending[mode];
    pending.bytes += bytes;
    pending.ms += ms;
    this.pendingMs += ms;
    if (this.pendingMs >= UPLOAD_REPORT_MS) {
      this.flush();
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const reports: UploadCostMessage[] = [];
    for (const mode of ["slice", "volume"] as const) {
      const { bytes, ms } = this.pending[mode];
      if (bytes > 0) reports.push({ type: "uploadCost", mode, bytes, ms });
    }
    this.pending = emptyPending();
    this.pendingMs = 0;
    if (reports.length === 0) return;
    // A device lost before it answers still settles the report, so the page
    // never waits on writes that will not happen.
    const send = () => {
      for (const report of reports) this.post(report);
    };
    this.gpuDone().then(send, send);
  }
}

function emptyPending(): Record<PoolMode, { bytes: number; ms: number }> {
  return { slice: { bytes: 0, ms: 0 }, volume: { bytes: 0, ms: 0 } };
}
