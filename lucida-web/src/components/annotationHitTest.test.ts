import { describe, expect, it } from "vitest";
import { hitTestShapes, type ShapeOnScreen } from "./annotationGeometry.ts";

const square = (id: string, x0: number, y0: number, x1: number, y1: number): ShapeOnScreen => ({
  id,
  points: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
  closed: true,
});
const line = (id: string, x0: number, y0: number, x1: number, y1: number): ShapeOnScreen => ({
  id,
  points: [
    [x0, y0],
    [x1, y1],
  ],
  closed: false,
});

describe("hitTestShapes", () => {
  it("hits a closed shape anywhere inside, and a line only near its stroke", () => {
    const shapes = [square("box", 0, 0, 100, 100), line("ln", 200, 0, 300, 0)];
    expect(hitTestShapes([50, 50], shapes, 6)).toBe("box");
    expect(hitTestShapes([250, 4], shapes, 6)).toBe("ln");
    expect(hitTestShapes([250, 20], shapes, 6)).toBeNull();
  });

  it("widens the target by the tolerance outside a stroke", () => {
    const shapes = [square("box", 0, 0, 100, 100)];
    expect(hitTestShapes([-15, 50], shapes, 6)).toBeNull();
    expect(hitTestShapes([-15, 50], shapes, 22)).toBe("box");
  });

  it("prefers the nearest stroke, so a line inside a box and a nested box stay reachable", () => {
    const shapes = [square("outer", 0, 0, 200, 200), square("inner", 80, 80, 120, 120), line("ln", 20, 30, 60, 30)];
    expect(hitTestShapes([100, 100], shapes, 6)).toBe("inner");
    expect(hitTestShapes([40, 32], shapes, 6)).toBe("ln");
    expect(hitTestShapes([160, 40], shapes, 6)).toBe("outer");
  });

  it("measures a line's ends as points, not its infinite extension", () => {
    expect(hitTestShapes([320, 0], [line("ln", 200, 0, 300, 0)], 6)).toBeNull();
  });
});
