import { beforeEach, describe, expect, it } from "vitest";
import {
  DOUBLE_TAP_MS,
  GestureRecognizer,
  LONG_PRESS_MS,
  TWO_FINGER_TAP_MS,
  type Gesture,
} from "./gestures.ts";

let r: GestureRecognizer;
beforeEach(() => {
  r = new GestureRecognizer();
});

const down = (id: number, x: number, y: number, time: number, press = false) => r.down({ id, x, y, time }, { press });
const move = (id: number, x: number, y: number, time: number) => r.move({ id, x, y, time });
const up = (id: number, x: number, y: number, time: number) => r.up({ id, x, y, time });

/** Each pinch's scale rounded, so ratios compare cleanly. */
function rounded(gestures: Gesture[]): Gesture[] {
  return gestures.map((g) => (g.type === "pinch" ? { ...g, scale: Math.round(g.scale * 1000) / 1000 } : g));
}

/** The pinches in `gestures` composed into one move: scales multiply, travel adds. */
function composed(gestures: Gesture[]): { dx: number; dy: number; scale: number } {
  const total = { dx: 0, dy: 0, scale: 1 };
  for (const g of gestures) {
    if (g.type !== "pinch") continue;
    total.dx += g.dx;
    total.dy += g.dy;
    total.scale *= g.scale;
  }
  return total;
}

describe("one finger", () => {
  it("drags once past the slop, the first drag covering the way from the press", () => {
    expect(down(1, 100, 100, 0)).toEqual([]);
    expect(move(1, 105, 100, 10)).toEqual([]);
    expect(move(1, 120, 100, 20)).toEqual([{ type: "drag", x: 120, y: 100, dx: 20, dy: 0 }]);
    expect(move(1, 130, 110, 30)).toEqual([{ type: "drag", x: 130, y: 110, dx: 10, dy: 10 }]);
    expect(up(1, 130, 110, 40)).toEqual([]);
  });

  it("taps where it landed when it lifts within the slop", () => {
    down(1, 100, 100, 0);
    move(1, 104, 103, 30);
    expect(up(1, 104, 103, 60)).toEqual([{ type: "tap", x: 100, y: 100 }]);
  });

  it("makes a double tap of two quick taps close together", () => {
    down(1, 100, 100, 0);
    up(1, 100, 100, 50);
    expect(down(2, 120, 110, 50 + DOUBLE_TAP_MS)).toEqual([]);
    expect(up(2, 120, 110, 400)).toEqual([{ type: "doubleTap", x: 120, y: 110 }]);
    // The pair is used up: a third tap starts over.
    down(3, 120, 110, 450);
    expect(up(3, 120, 110, 480)).toEqual([{ type: "tap", x: 120, y: 110 }]);
  });

  it("keeps two taps apart when they are slow or far from each other", () => {
    down(1, 100, 100, 0);
    up(1, 100, 100, 50);
    down(1, 100, 100, 51 + DOUBLE_TAP_MS);
    expect(up(1, 100, 100, 400)).toEqual([{ type: "tap", x: 100, y: 100 }]);
    down(1, 200, 100, 450);
    expect(up(1, 200, 100, 480)).toEqual([{ type: "tap", x: 200, y: 100 }]);
  });

  it("fires a long press at its deadline, and then no tap", () => {
    down(1, 100, 100, 1000);
    move(1, 103, 100, 1200);
    expect(r.nextDeadline()).toBe(1000 + LONG_PRESS_MS);
    expect(r.tick(1000 + LONG_PRESS_MS - 1)).toEqual([]);
    expect(r.tick(1000 + LONG_PRESS_MS)).toEqual([{ type: "longPress", x: 100, y: 100 }]);
    expect(r.nextDeadline()).toBeNull();
    expect(move(1, 150, 100, 1600)).toEqual([]);
    expect(up(1, 150, 100, 1700)).toEqual([]);
  });

  it("still fires a long press on release when the deadline passed before the timer ran", () => {
    down(1, 100, 100, 0);
    expect(up(1, 100, 100, LONG_PRESS_MS + 20)).toEqual([{ type: "longPress", x: 100, y: 100 }]);
  });

  it("never long-presses once it has dragged", () => {
    down(1, 100, 100, 0);
    move(1, 140, 100, 100);
    expect(r.nextDeadline()).toBeNull();
    expect(r.tick(LONG_PRESS_MS * 2)).toEqual([]);
  });
});

describe("two fingers", () => {
  it("pinches around the centroid once a finger leaves the slop", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 10);
    expect(move(2, 205, 100, 20)).toEqual([]);
    // Spread 50 → 60 as the centroid moves from 150 to 160.
    expect(rounded(move(2, 220, 100, 30))).toEqual([{ type: "pinch", x: 160, y: 100, dx: 10, dy: 0, scale: 1.2 }]);
    // Then 60 → 70, the centroid back at 150.
    expect(rounded(move(1, 80, 100, 40))).toEqual([{ type: "pinch", x: 150, y: 100, dx: -10, dy: 0, scale: 1.167 }]);
  });

  it("pinches together below a scale of 1", () => {
    down(1, 100, 100, 0);
    down(2, 300, 100, 0);
    expect(rounded(move(1, 150, 100, 20))).toEqual([{ type: "pinch", x: 225, y: 100, dx: 25, dy: 0, scale: 0.75 }]);
    expect(rounded(move(2, 250, 100, 30))).toEqual([{ type: "pinch", x: 200, y: 100, dx: -25, dy: 0, scale: 0.667 }]);
  });

  it("drags with both fingers as a pinch that keeps its spread", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 0);
    // Each finger's move is its own event, so only the pair keeps the spread.
    const total = composed([...move(1, 100, 140, 20), ...move(2, 200, 140, 30)]);
    expect(total.dx).toBeCloseTo(0);
    expect(total.dy).toBeCloseTo(40);
    expect(total.scale).toBeCloseTo(1);
  });

  it("taps with two fingers that land and lift together without moving", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 30);
    expect(up(1, 100, 100, 120)).toEqual([]);
    expect(up(2, 202, 101, 140)).toEqual([{ type: "twoFingerTap", x: 150, y: 100 }]);
  });

  it("is no two-finger tap when held too long, moved, or joined by a third finger", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 0);
    up(1, 100, 100, TWO_FINGER_TAP_MS);
    expect(up(2, 200, 100, TWO_FINGER_TAP_MS + 1)).toEqual([]);

    down(1, 100, 100, 1000);
    down(2, 200, 100, 1000);
    move(2, 240, 100, 1050);
    up(1, 100, 100, 1100);
    expect(up(2, 240, 100, 1120)).toEqual([]);

    down(1, 100, 100, 2000);
    down(2, 200, 100, 2000);
    down(3, 150, 50, 2010);
    up(1, 100, 100, 2050);
    up(2, 200, 100, 2060);
    expect(up(3, 150, 50, 2070)).toEqual([]);
  });

  it("carries on as a one-finger drag, without a jump, when one finger lifts mid-pinch", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 0);
    move(2, 240, 100, 20);
    up(2, 240, 100, 30);
    expect(move(1, 110, 100, 40)).toEqual([{ type: "drag", x: 110, y: 100, dx: 10, dy: 0 }]);
  });

  it("doesn't jump when a third finger lands mid-pinch", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 0);
    move(2, 240, 100, 20);
    down(3, 170, 300, 30);
    const step = composed(move(3, 170, 303, 40));
    expect(step.dx).toBeCloseTo(0);
    expect(step.dy).toBeCloseTo(1);
    expect(Math.abs(step.scale - 1)).toBeLessThan(0.02);
  });

  it("breaks up a double tap", () => {
    down(1, 100, 100, 0);
    up(1, 100, 100, 30);
    down(1, 100, 100, 60);
    down(2, 160, 100, 70);
    up(1, 100, 100, 100);
    up(2, 160, 100, 110);
    down(1, 100, 100, 150);
    expect(up(1, 100, 100, 170)).toEqual([{ type: "tap", x: 100, y: 100 }]);
  });

  it("long-presses with neither finger", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 100);
    expect(r.nextDeadline()).toBeNull();
    expect(r.tick(LONG_PRESS_MS * 2)).toEqual([]);
  });
});

describe("a claimed press", () => {
  it("reports the first finger raw, within the slop too, and never as a tap or long press", () => {
    expect(down(1, 100, 100, 0, true)).toEqual([{ type: "pressStart", x: 100, y: 100 }]);
    expect(r.nextDeadline()).toBeNull();
    expect(move(1, 102, 101, 10)).toEqual([{ type: "pressMove", x: 102, y: 101 }]);
    expect(move(1, 150, 120, 20)).toEqual([{ type: "pressMove", x: 150, y: 120 }]);
    expect(up(1, 150, 120, LONG_PRESS_MS * 2)).toEqual([{ type: "pressEnd", x: 150, y: 120 }]);
  });

  it("is cancelled by a second finger, which then pinches", () => {
    down(1, 100, 100, 0, true);
    move(1, 103, 100, 10);
    expect(down(2, 200, 100, 20, true)).toEqual([{ type: "pressCancel" }]);
    expect(rounded(move(2, 220, 100, 30))).toEqual([{ type: "pinch", x: 161.5, y: 100, dx: 10, dy: 0, scale: 1.206 }]);
    up(1, 103, 100, 40);
    expect(up(2, 220, 100, 50)).toEqual([]);
  });

  it("still makes a two-finger tap when the press hadn't moved", () => {
    down(1, 100, 100, 0, true);
    down(2, 200, 100, 20);
    up(2, 200, 100, 80);
    expect(up(1, 100, 100, 100)).toEqual([{ type: "twoFingerTap", x: 150, y: 100 }]);
  });
});

describe("cancel", () => {
  it("abandons a claimed press", () => {
    down(1, 100, 100, 0, true);
    expect(r.cancel({ id: 1, x: 100, y: 100, time: 10 })).toEqual([{ type: "pressCancel" }]);
    expect(r.active).toBe(false);
  });

  it("ends a gesture without a tap or long press, ignoring the fingers left", () => {
    down(1, 100, 100, 0);
    down(2, 200, 100, 0);
    expect(r.cancel({ id: 1, x: 100, y: 100, time: 10 })).toEqual([]);
    expect(move(2, 260, 100, 20)).toEqual([]);
    expect(up(2, 260, 100, 30)).toEqual([]);
    down(1, 100, 100, 40);
    expect(r.cancel({ id: 1, x: 100, y: 100, time: 50 })).toEqual([]);
    expect(r.tick(LONG_PRESS_MS * 2)).toEqual([]);
  });

  it("ignores fingers it never saw land", () => {
    expect(move(9, 0, 0, 0)).toEqual([]);
    expect(up(9, 0, 0, 0)).toEqual([]);
    expect(r.cancel({ id: 9, x: 0, y: 0, time: 0 })).toEqual([]);
  });
});
