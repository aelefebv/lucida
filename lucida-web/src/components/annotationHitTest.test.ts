import { describe, expect, it } from "vitest";
import { hitTestShapes, translateShape, type ShapeOnScreen } from "./annotationGeometry.ts";
import { threadOffset } from "./threadPlacement.ts";

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

describe("translateShape", () => {
  it("moves both vertices by the same delta", () => {
    expect(translateShape({ position: [1, 2], end: [5, 8] }, [10, -2])).toEqual({ position: [11, 0], end: [15, 6] });
  });
});

describe("threadOffset", () => {
  const size = { width: 288, height: 200 };
  const bounds = { width: 1000, height: 800 };

  it("sits below and right of the pin where it fits", () => {
    expect(threadOffset([100, 100], size, bounds)).toEqual([12, 12]);
  });

  it("flips left and up near the far edges", () => {
    expect(threadOffset([900, 700], size, bounds)).toEqual([-300, -212]);
  });

  it("slides along an axis with no room on either side, staying inside", () => {
    const narrow = { width: 342, height: 800 };
    const [x] = threadOffset([200, 100], size, narrow);
    expect(200 + x).toBe(342 - 8 - 288);
  });
});
