import { describe, expect, it } from "vitest";
import { FramePacer, MAX_INTERACTIVE_FRAMES_IN_FLIGHT } from "./framePacing.ts";

describe("FramePacer", () => {
  it("lets a view change queue one frame behind the one drawing, and no more", () => {
    const pacer = new FramePacer();
    expect(pacer.mayDrawInteractive(0)).toBe(true);
    expect(pacer.mayDrawInteractive(MAX_INTERACTIVE_FRAMES_IN_FLIGHT - 1)).toBe(true);
    expect(pacer.mayDrawInteractive(MAX_INTERACTIVE_FRAMES_IN_FLIGHT)).toBe(false);
  });

  it("holds a frame for new chunks while any frame is still drawing", () => {
    const pacer = new FramePacer();
    expect(pacer.mayDrawResidency(1000, 1, false)).toBe(false);
    expect(pacer.mayDrawResidency(1000, 0, false)).toBe(true);
  });

  it("draws new chunks at once when nothing is left to deliver", () => {
    const pacer = new FramePacer();
    pacer.noteFrameDone(3000, 1000);
    expect(pacer.mayDrawResidency(1001, 0, false)).toBe(true);
  });

  it("lets the ticks after a slow frame deliver for as long as that frame took", () => {
    const pacer = new FramePacer();
    pacer.noteFrameDone(3000, 1000);
    expect(pacer.mayDrawResidency(1016, 0, true)).toBe(false);
    expect(pacer.mayDrawResidency(3999, 0, true)).toBe(false);
    expect(pacer.mayDrawResidency(4000, 0, true)).toBe(true);
  });

  it("never holds a frame on a GPU that finishes within a tick", () => {
    const pacer = new FramePacer();
    pacer.noteFrameDone(4, 1000);
    expect(pacer.mayDrawResidency(1016, 0, true)).toBe(true);
  });

  it("draws before any frame has finished", () => {
    expect(new FramePacer().mayDrawResidency(0, 0, true)).toBe(true);
  });
});
