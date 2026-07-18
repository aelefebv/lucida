import { describe, expect, it, vi } from "vitest";
import {
  DemandDrivenAnimationFrame,
  type AnimationFrameDriver,
} from "./demandDrivenAnimationFrame.ts";

class FakeFrames implements AnimationFrameDriver {
  private nextId = 1;
  readonly callbacks = new Map<number, FrameRequestCallback>();
  readonly cancel = vi.fn((id: number) => { this.callbacks.delete(id); });
  readonly request = vi.fn((callback: FrameRequestCallback) => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  });

  flush(timestamp: number): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(timestamp);
  }
}

describe("DemandDrivenAnimationFrame", () => {
  it("owns zero callbacks while idle and coalesces an event burst", () => {
    const frames = new FakeFrames();
    const step = vi.fn(() => false);
    const owner = new DemandDrivenAnimationFrame(step, frames);

    expect(frames.request).not.toHaveBeenCalled();
    for (let i = 0; i < 10_000; i++) owner.wake();
    expect(frames.callbacks.size).toBe(1);
    expect(frames.request).toHaveBeenCalledTimes(1);

    frames.flush(16);
    expect(step).toHaveBeenCalledExactlyOnceWith(16);
    expect(frames.callbacks.size).toBe(0);
    expect(owner.pending).toBe(false);
  });

  it("continues only while the step declares work and resumes promptly later", () => {
    const frames = new FakeFrames();
    const step = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const owner = new DemandDrivenAnimationFrame(step, frames);

    owner.wake();
    frames.flush(16);
    frames.flush(32);
    frames.flush(48);
    expect(step).toHaveBeenCalledTimes(3);
    expect(frames.callbacks.size).toBe(0);

    owner.wake();
    expect(frames.callbacks.size).toBe(1);
    frames.flush(64);
    expect(step).toHaveBeenCalledTimes(4);
    expect(frames.callbacks.size).toBe(0);
  });

  it("cancels its one pending callback on teardown", () => {
    const frames = new FakeFrames();
    const owner = new DemandDrivenAnimationFrame(() => true, frames);
    owner.wake();
    owner.dispose();
    owner.dispose();

    expect(frames.cancel).toHaveBeenCalledTimes(1);
    expect(frames.callbacks.size).toBe(0);
    expect(owner.wake()).toBe(false);
  });
});
