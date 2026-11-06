import { describe, expect, it } from "vitest";
import { placeThread, THREAD_GAP, type Box } from "./threadPlacement.ts";

const bounds: Box = { left: 8, top: 68, right: 748, bottom: 1172 };
const size = { width: 288, height: 340 };

function placed(x: number, y: number, s = size) {
  const { left, top } = placeThread({ x, y }, s, bounds);
  return { left: x + left, top: y + top, right: x + left + s.width, bottom: y + top + s.height };
}

function inside(box: ReturnType<typeof placed>) {
  return box.left >= bounds.left && box.top >= bounds.top && box.right <= bounds.right && box.bottom <= bounds.bottom;
}

describe("placeThread", () => {
  it("sits below and to the right of the pin where there is room", () => {
    expect(placeThread({ x: 200, y: 300 }, size, bounds)).toEqual({ left: THREAD_GAP, top: THREAD_GAP });
  });

  it("flips to the pin's other side on an axis that would run off", () => {
    expect(placeThread({ x: 700, y: 300 }, size, bounds).left).toBe(-THREAD_GAP - size.width);
    expect(placeThread({ x: 200, y: 1100 }, size, bounds).top).toBe(-THREAD_GAP - size.height);
  });

  it.each([
    [8, 68],
    [378, 68],
    [748, 68],
    [8, 620],
    [748, 620],
    [8, 1172],
    [378, 1172],
    [748, 1172],
  ])("stays inside for a pin at (%s, %s)", (x, y) => {
    expect(inside(placed(x, y))).toBe(true);
  });

  it("slides along an axis where neither side of the pin has room", () => {
    const short: Box = { left: 0, top: 0, right: 400, bottom: 360 };
    const { top } = placeThread({ x: 50, y: 180 }, { width: 288, height: 340 }, short);
    expect(180 + top).toBe(20);
  });

  it("stays inside when the pin has left the bounds", () => {
    expect(inside(placed(400, -200))).toBe(true);
    expect(inside(placed(900, 1400))).toBe(true);
  });
});
