import { describe, expect, it } from "vitest";
import { BAND_TARGET_MS, BANDED_FRAME_MS, FramePacer, MAX_BANDS, MAX_INTERACTIVE_FRAMES_IN_FLIGHT, STREAMING_FRAME_SHARE, bandsFor } from "./framePacing.ts";
import { LONG_FRAME_MS } from "./renderResolution.ts";

describe("FramePacer", () => {
  it("lets a view change queue one frame behind the one drawing, and no more", () => {
    const pacer = new FramePacer();
    expect(pacer.mayDrawInteractive(0)).toBe(true);
    expect(pacer.mayDrawInteractive(MAX_INTERACTIVE_FRAMES_IN_FLIGHT - 1)).toBe(true);
    expect(pacer.mayDrawInteractive(MAX_INTERACTIVE_FRAMES_IN_FLIGHT)).toBe(false);
  });

  it("queues no view change behind a long frame", () => {
    const pacer = new FramePacer();
    pacer.noteFrameDone(LONG_FRAME_MS + 10, 1000);
    expect(pacer.mayDrawInteractive(0)).toBe(true);
    expect(pacer.mayDrawInteractive(1)).toBe(false);
    // Once frames keep up again, one may queue behind the one drawing.
    pacer.noteFrameDone(LONG_FRAME_MS, 1100);
    expect(pacer.mayDrawInteractive(1)).toBe(true);
  });

  it("holds a frame for new chunks while any frame is still drawing", () => {
    const pacer = new FramePacer();
    expect(pacer.mayDrawResidency(1000, 1, false)).toBe(false);
    expect(pacer.mayDrawResidency(1000, 0, false)).toBe(true);
  });

  it("draws new chunks at once when no more are on their way", () => {
    const pacer = new FramePacer();
    pacer.noteFrameDone(3000, 1000);
    expect(pacer.mayDrawResidency(1001, 0, false)).toBe(true);
  });

  it("while chunks stream, holds a frame until the one before has taken no more than its share of the time", () => {
    const pacer = new FramePacer();
    pacer.noteFrameDone(100, 1000);
    const wait = 100 * (1 / STREAMING_FRAME_SHARE - 1);
    expect(pacer.mayDrawResidency(1016, 0, true)).toBe(false);
    expect(pacer.mayDrawResidency(1000 + wait - 1, 0, true)).toBe(false);
    expect(pacer.mayDrawResidency(1000 + wait, 0, true)).toBe(true);
    // The frame that went and the wait after it: the frame took its share.
    expect(100 / (100 + wait)).toBeCloseTo(STREAMING_FRAME_SHARE);
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

describe("bandsFor", () => {
  it("draws a frame whole until a full-quality frame has been seen to run long", () => {
    expect(bandsFor(null)).toBe(1);
    expect(bandsFor(BANDED_FRAME_MS)).toBe(1);
  });

  it("splits a long frame into bands of about the target, up to the most", () => {
    expect(bandsFor(BANDED_FRAME_MS + 1)).toBe(Math.ceil((BANDED_FRAME_MS + 1) / BAND_TARGET_MS));
    expect(bandsFor(1_000)).toBe(1_000 / BAND_TARGET_MS);
    expect(bandsFor(11_000)).toBe(MAX_BANDS);
  });
});
