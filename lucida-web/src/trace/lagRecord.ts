/**
 * The lag tier: each input a run took and the frame that answered it, the
 * frames the render worker finished, and the main thread's long tasks.
 * Allocated at an interval's first input, so an interval that took none
 * holds no lag tier and spends nothing on one.
 *
 * An input is tied to its frame by order, not by time. Every frame dispatched
 * after an input was applied draws the view the input set, and the worker
 * finishes frames in the order they were dispatched. So an input takes the
 * sequence number of the next frame dispatched, and is answered when the
 * worker reports that frame, or a later one, done.
 *
 * Each list is a drop-oldest ring that counts what it overwrote. Inputs still
 * waiting for a frame are always the newest few, so the ring never overwrites
 * one before it is answered.
 */

import { INPUT_KINDS, type InputKind, type TraceLag } from "./types.ts";

/** About seventeen seconds of continuous input at 60 Hz; a scripted drag sends at most 60. */
export const INPUT_CAPACITY = 1024;
export const FRAME_CAPACITY = 1024;
/** A long task is at least 50 ms, so a run full of them has stopped being interactive long before this. */
export const LONG_TASK_CAPACITY = 64;

export class LagRecord {
  /** Kind, event time, frame sequence number, dispatch and done per input; done per frame; start and duration per task. */
  static readonly BYTE_LENGTH =
    INPUT_CAPACITY * (1 + 8 + 4 + 8 + 8) + FRAME_CAPACITY * 8 + LONG_TASK_CAPACITY * 16;

  private readonly inputKind = new Uint8Array(INPUT_CAPACITY);
  private readonly inputAtMs = new Float64Array(INPUT_CAPACITY);
  private readonly inputFrameSeq = new Uint32Array(INPUT_CAPACITY);
  private readonly inputDispatchedMs = new Float64Array(INPUT_CAPACITY);
  private readonly inputPresentedMs = new Float64Array(INPUT_CAPACITY);
  /** Inputs taken, inputs given a frame, and inputs answered: counts over every input, oldest first. */
  private taken = 0;
  private dispatched = 0;
  private answered = 0;
  private lastDispatchedSeq = 0;

  private readonly frameDoneMs = new Float64Array(FRAME_CAPACITY);
  private frames = 0;

  private readonly taskStartMs = new Float64Array(LONG_TASK_CAPACITY);
  private readonly taskDurationMs = new Float64Array(LONG_TASK_CAPACITY);
  private tasks = 0;

  /** Fixed when the interval closes, from the recorder's page-wide estimate. */
  private displayIntervalMs: number | null = null;

  get byteLength(): number {
    return LagRecord.BYTE_LENGTH;
  }

  /** Whether an input is still waiting for a frame to be dispatched. */
  get awaitingFrame(): boolean {
    return this.dispatched < this.taken;
  }

  noteInput(kind: InputKind, atMs: number): void {
    const slot = this.taken % INPUT_CAPACITY;
    this.inputKind[slot] = INPUT_KINDS.indexOf(kind);
    this.inputAtMs[slot] = atMs;
    this.inputDispatchedMs[slot] = Number.NaN;
    this.inputPresentedMs[slot] = Number.NaN;
    this.taken++;
  }

  /** A viewport frame left for the worker; every input not yet given one is drawn by it. */
  noteFrameDispatched(frameSeq: number, atMs: number): void {
    // A sequence that went backwards is a new render client, which will
    // never report the old one's frames, so their inputs stay unanswered.
    if (frameSeq <= this.lastDispatchedSeq) this.answered = this.dispatched;
    this.lastDispatchedSeq = frameSeq;
    for (let n = Math.max(this.dispatched, this.taken - INPUT_CAPACITY); n < this.taken; n++) {
      const slot = n % INPUT_CAPACITY;
      this.inputFrameSeq[slot] = frameSeq;
      this.inputDispatchedMs[slot] = atMs;
    }
    this.dispatched = this.taken;
  }

  /** The worker finished frame `frameSeq`, and with it every frame before it. */
  noteFrameDone(frameSeq: number, atMs: number): void {
    this.frameDoneMs[this.frames % FRAME_CAPACITY] = atMs;
    this.frames++;
    let n = Math.max(this.answered, this.taken - INPUT_CAPACITY);
    for (; n < this.dispatched; n++) {
      const slot = n % INPUT_CAPACITY;
      if (this.inputFrameSeq[slot] > frameSeq) break;
      this.inputPresentedMs[slot] = atMs;
    }
    this.answered = n;
  }

  noteLongTask(startMs: number, durationMs: number): void {
    const slot = this.tasks % LONG_TASK_CAPACITY;
    this.taskStartMs[slot] = startMs;
    this.taskDurationMs[slot] = durationMs;
    this.tasks++;
  }

  close(displayIntervalMs: number | null): void {
    this.displayIntervalMs = displayIntervalMs;
  }

  /** The tier in the trace's units, against the interval's start on the recorder's clock. */
  serialise(startedAtMs: number): TraceLag {
    const us = (ms: number): number => Math.round((ms - startedAtMs) * 1000);
    const orNull = (ms: number): number | null => (Number.isNaN(ms) ? null : us(ms));
    const inputs: TraceLag["inputs"] = [];
    for (let n = Math.max(0, this.taken - INPUT_CAPACITY); n < this.taken; n++) {
      const slot = n % INPUT_CAPACITY;
      inputs.push({
        kind: INPUT_KINDS[this.inputKind[slot]],
        atUs: us(this.inputAtMs[slot]),
        dispatchedUs: orNull(this.inputDispatchedMs[slot]),
        presentedUs: orNull(this.inputPresentedMs[slot]),
      });
    }
    const framesUs: number[] = [];
    for (let n = Math.max(0, this.frames - FRAME_CAPACITY); n < this.frames; n++) {
      framesUs.push(us(this.frameDoneMs[n % FRAME_CAPACITY]));
    }
    const longTasks: TraceLag["longTasks"] = [];
    for (let n = Math.max(0, this.tasks - LONG_TASK_CAPACITY); n < this.tasks; n++) {
      const slot = n % LONG_TASK_CAPACITY;
      longTasks.push({
        startUs: us(this.taskStartMs[slot]),
        durationUs: Math.round(this.taskDurationMs[slot] * 1000),
      });
    }
    return {
      inputs,
      inputsUnrecorded: Math.max(0, this.taken - INPUT_CAPACITY),
      framesUs,
      framesUnrecorded: Math.max(0, this.frames - FRAME_CAPACITY),
      longTasks,
      longTasksUnrecorded: Math.max(0, this.tasks - LONG_TASK_CAPACITY),
      displayIntervalUs: this.displayIntervalMs === null ? null : Math.round(this.displayIntervalMs * 1000),
    };
  }
}
