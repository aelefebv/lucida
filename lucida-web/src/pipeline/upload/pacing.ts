/**
 * How much the render worker may be handed now, in time rather than bytes.
 *
 * The worker reports each delivery once it and the GPU are done with it, with
 * the time the worker spent on it. A write rate learned from those reports
 * costs every delivery, and the deliveries handed over but not yet reported
 * are kept to a time budget. So the bytes a tick hands over follow the device
 * rather than the display's refresh rate: a fast GPU takes more, a slow one
 * less, and work never piles up in front of the frames, whether the worker,
 * the GPU or a long frame is what holds it up.
 *
 * Each pool mode has a rate of its own. A slice delivery is one plane of a
 * chunk, much of whose cost is per message, so a rate learned from whole
 * volume chunks would hand a slice view more than its budget.
 */

import type { PoolMode } from "../../renderer/workerProtocol.ts";
import { INITIAL_UPLOAD_BYTES_PER_MS, UPLOAD_COST_HALF_LIFE_MS } from "./constants.ts";

export class UploadPacer {
  private readonly rates: Record<PoolMode, WriteRate> = {
    slice: new WriteRate(),
    volume: new WriteRate(),
  };
  /**
   * Bytes handed to the pools of each mode that the worker has not reported
   * done. The worker reports every delivery, whatever becomes of it, so
   * nothing stays here for good.
   */
  private readonly inFlight: Record<PoolMode, number> = { slice: 0, volume: 0 };

  /** What a delivery of `bytes` to the pools of `mode` costs the worker, in milliseconds. */
  costMs(mode: PoolMode, bytes: number): number {
    return bytes * this.rates[mode].msPerByte();
  }

  /** How much more the worker may be handed before the work it has not finished reaches `aheadMs`. */
  roomMs(aheadMs: number): number {
    return aheadMs - this.costMs("slice", this.inFlight.slice) - this.costMs("volume", this.inFlight.volume);
  }

  /** A delivery of `bytes` to the pools of `mode` was handed over. Returns what it costs the worker. */
  posted(mode: PoolMode, bytes: number): number {
    this.inFlight[mode] += bytes;
    return this.costMs(mode, bytes);
  }

  /** Deliveries to the pools of `mode` that carried `bytes` are done, and took the worker `ms`. */
  noteDone(mode: PoolMode, bytes: number, ms: number): void {
    this.rates[mode].note(bytes, ms);
    this.inFlight[mode] = Math.max(0, this.inFlight[mode] - bytes);
  }
}

/**
 * Milliseconds per byte over the worker's recent deliveries. A report weighs
 * what it measured, and an earlier one's weight halves with every
 * {@link UPLOAD_COST_HALF_LIFE_MS} measured since, so many small reports
 * count for no more than the time they took. It starts as if that much time
 * had been measured at {@link INITIAL_UPLOAD_BYTES_PER_MS}.
 */
class WriteRate {
  private bytes = INITIAL_UPLOAD_BYTES_PER_MS * UPLOAD_COST_HALF_LIFE_MS;
  private ms = UPLOAD_COST_HALF_LIFE_MS;

  note(bytes: number, ms: number): void {
    if (!(bytes > 0) || !(ms >= 0)) return;
    const keep = 0.5 ** (ms / UPLOAD_COST_HALF_LIFE_MS);
    this.bytes = this.bytes * keep + bytes;
    this.ms = this.ms * keep + ms;
  }

  msPerByte(): number {
    return this.ms / this.bytes;
  }
}
