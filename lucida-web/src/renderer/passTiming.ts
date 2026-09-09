/**
 * GPU pass time per viewport frame, measured on the device.
 *
 * The trace's frame time is main-thread time: how long the tick held the main
 * thread, which says nothing about what the GPU did with the frame. Where the
 * adapter offers the `timestamp-query` feature, this module reads the GPU's
 * own clock at the start of the frame's first render pass and the end of its
 * last, and hands the difference to the main thread, so "is it the shader or
 * the laptop" has a measurement behind it.
 *
 * The worker timestamps nothing else. GPU timestamps are durations on the
 * device's clock and never compared with the main thread's, so this adds no
 * cross-context clock to reconcile (ADR 0047).
 *
 * A frame's passes span several command buffers and several submits, and the
 * queue runs them in order, so one query set of two stamps covers the frame:
 * the first pass writes stamp 0 at its start and stamp 1 at its end, and every
 * later pass overwrites stamp 1 at its end, so the last pass's end wins. After
 * the last submit the two stamps are resolved, copied to a mappable buffer,
 * and read back asynchronously. A frame whose read-back buffers are all still
 * mapped goes unmeasured rather than waiting. An absent sample is honest. A
 * stall in the render loop is not.
 */

/** What a render pass asks for its timestamps. Passed to every viewport pass; the minimap and thumbnails pass nothing. */
export interface PassTiming {
  /**
   * The timestamp writes for the next render pass of the current frame, or
   * undefined when the frame is not being timed. Call it once per pass, at
   * the moment the pass descriptor is built, so the stamp indices follow the
   * passes as they are encoded.
   */
  nextPass(): GPURenderPassTimestampWrites | undefined;
}

/** What a frame handler brackets a viewport frame with. */
export interface FrameTiming extends PassTiming {
  beginFrame(): void;
  endFrame(): void;
  destroy(): void;
}

/** The frame timing of a device without timestamp queries: no frame is ever measured. */
export const UNTIMED: FrameTiming = {
  nextPass: () => undefined,
  beginFrame: () => {},
  endFrame: () => {},
  destroy: () => {},
};

/**
 * The frame timing for a device: a real timer where the device offers
 * timestamp queries, and {@link UNTIMED} where it does not, so a frame
 * handler brackets its frame the same way on either.
 */
export function createFrameTiming(
  device: GPUDevice,
  onPassTime: (gpuPassUs: number) => void,
): FrameTiming {
  return FramePassTimer.create(device, onPassTime) ?? UNTIMED;
}

const BEGIN = 0;
const END = 1;
const QUERY_COUNT = 2;
const STAMP_BYTES = QUERY_COUNT * 8;
/**
 * A read-back lands within a frame or two, so four covers a burst of quick
 * frames. A frame that finds none free goes unmeasured.
 */
const READ_BACK_POOL = 4;

export class FramePassTimer implements FrameTiming {
  /**
   * The timer for a device, or null when the device lacks timestamp queries,
   * in which case no frame is ever measured and the main thread records
   * nothing for the GPU.
   */
  static create(device: GPUDevice, onPassTime: (gpuPassUs: number) => void): FramePassTimer | null {
    if (!device.features.has("timestamp-query")) return null;
    return new FramePassTimer(device, onPassTime);
  }

  private readonly device: GPUDevice;
  private readonly onPassTime: (gpuPassUs: number) => void;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly idle: GPUBuffer[] = [];
  private passes = 0;
  private timing = false;
  private destroyed = false;

  private constructor(device: GPUDevice, onPassTime: (gpuPassUs: number) => void) {
    this.device = device;
    this.onPassTime = onPassTime;
    this.querySet = device.createQuerySet({ type: "timestamp", count: QUERY_COUNT });
    this.resolveBuffer = device.createBuffer({
      size: STAMP_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < READ_BACK_POOL; i++) {
      this.idle.push(
        device.createBuffer({
          size: STAMP_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
    }
  }

  /** Start a frame. The frame goes unmeasured when every read-back buffer is still mapped. */
  beginFrame(): void {
    this.passes = 0;
    this.timing = !this.destroyed && this.idle.length > 0;
  }

  nextPass(): GPURenderPassTimestampWrites | undefined {
    if (!this.timing) return undefined;
    const first = this.passes === 0;
    this.passes += 1;
    return first
      ? { querySet: this.querySet, beginningOfPassWriteIndex: BEGIN, endOfPassWriteIndex: END }
      : { querySet: this.querySet, endOfPassWriteIndex: END };
  }

  /**
   * End the frame: resolve the two stamps behind the frame's last submit,
   * copy them into a read-back buffer, and read them off the queue. A frame
   * that encoded no pass has no stamps and is not read.
   */
  endFrame(): void {
    const timed = this.timing && this.passes > 0;
    this.timing = false;
    if (!timed) return;
    const readBack = this.idle.pop();
    if (!readBack) return;
    const encoder = this.device.createCommandEncoder();
    encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, readBack, 0, STAMP_BYTES);
    this.device.queue.submit([encoder.finish()]);
    void this.readBack(readBack);
  }

  private async readBack(buffer: GPUBuffer): Promise<void> {
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      // Copy before `unmap` detaches the mapped range.
      const stamps = new BigUint64Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      const begin = stamps[BEGIN];
      const end = stamps[END];
      // Zero is a real measurement: a frame under the stamp resolution. A
      // reversed pair is a lost stamp and is dropped.
      if (end >= begin) this.onPassTime(Number(end - begin) / 1_000);
    } catch {
      // A lost device or a destroyed buffer: the frame goes unmeasured.
    } finally {
      if (this.destroyed) buffer.destroy();
      else this.idle.push(buffer);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.timing = false;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    for (const buffer of this.idle) buffer.destroy();
    this.idle.length = 0;
  }
}
