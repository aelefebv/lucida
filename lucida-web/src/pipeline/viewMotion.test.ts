import { describe, expect, it } from "vitest";

import { STILL_MS, ViewMotion } from "./viewMotion.ts";

describe("ViewMotion", () => {
  it("is still until the camera changes", () => {
    const motion = new ViewMotion();
    motion.note(1, 0);
    expect(motion.moving(0)).toBe(false);
    expect(motion.moving(1000)).toBe(false);
  });

  it("takes one change for a jump, not a move", () => {
    const motion = new ViewMotion();
    motion.note(1, 0);
    motion.note(2, 1000);
    expect(motion.moving(1000)).toBe(false);
    expect(motion.moving(1016)).toBe(false);
  });

  it("moves while the camera changes frame after frame, and stops once it holds still", () => {
    const motion = new ViewMotion();
    motion.note(1, 0);
    let at = 1000;
    for (let epoch = 2; epoch < 10; epoch++, at += 16) motion.note(epoch, at);
    const last = at - 16;
    expect(motion.moving(at)).toBe(true);
    // A tick that sees no change mid-gesture is still the gesture.
    motion.note(9, at);
    expect(motion.moving(last + STILL_MS - 1)).toBe(true);
    expect(motion.stopsAt()).toBe(last + STILL_MS);
    expect(motion.stopped(last + STILL_MS - 1)).toBe(false);
    expect(motion.moving(last + STILL_MS)).toBe(false);
    expect(motion.stopped(last + STILL_MS)).toBe(true);
  });

  it("starts a new move after a pause, its first change a jump again", () => {
    const motion = new ViewMotion();
    motion.note(1, 0);
    motion.note(2, 1000);
    motion.note(3, 1016);
    expect(motion.moving(1016)).toBe(true);
    motion.note(4, 1016 + STILL_MS);
    expect(motion.moving(1016 + STILL_MS)).toBe(false);
    // A change at this tick is no stop, whatever came before it.
    expect(motion.stopped(1016 + STILL_MS)).toBe(false);
    motion.note(5, 1032 + STILL_MS);
    expect(motion.moving(1032 + STILL_MS)).toBe(true);
  });
});
