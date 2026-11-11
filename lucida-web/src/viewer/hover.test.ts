/**
 * The pointer over a view and the crosshairs the scene puts in the others:
 * worked out again each frame, told to listeners only when they move, and
 * read with the pointer as points on the canvas.
 */
import { describe, expect, it, vi } from "vitest";
import { Hover, readPoints, type CrosshairMark } from "./hover.ts";

const AT: CrosshairMark = { view: 1, kind: "at", at: [0.25, 0.5], arms: [[1, 0], [0, 1], [0, 0]] };
const OUTSIDE: CrosshairMark = { view: 2, kind: "outside" };

function sceneAnswering(marks: CrosshairMark[]) {
  return { crosshairs: vi.fn((_view: number, _x: number, _y: number) => JSON.stringify(marks)) };
}

describe("Hover", () => {
  it("asks the scene where the pointer's point lands, and tells listeners only when that moves", () => {
    const hover = new Hover();
    const listener = vi.fn();
    hover.subscribe(listener);
    const scene = sceneAnswering([AT, OUTSIDE]);

    hover.refresh(scene);
    expect(scene.crosshairs).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    hover.setPointer({ view: 0, x: 0.3, y: 0.6, touch: false, atMs: 5 });
    hover.refresh(scene);
    expect(scene.crosshairs).toHaveBeenCalledWith(0, 0.3, 0.6);
    expect(hover.markOf(1)).toEqual(AT);
    expect(hover.markOf(2)).toEqual(OUTSIDE);
    expect(hover.markOf(0)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    hover.refresh(scene);
    expect(listener).toHaveBeenCalledTimes(1);

    hover.setPointer(null);
    hover.refresh(scene);
    expect(hover.markOf(1)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("readPoints", () => {
  it("reads the pointer's point first, then each crosshair on screen, on the canvas", () => {
    const rects: Record<number, [number, number, number, number]> = {
      0: [0, 0, 0.5, 1],
      1: [0.5, 0, 0.5, 1],
      2: [0, 0.5, 1, 0.5],
    };
    const marks = new Map<number, CrosshairMark>([[1, AT], [2, OUTSIDE]]);
    const points = readPoints({ view: 0, x: 0.2, y: 0.4, touch: true, atMs: 0 }, marks, (view) => rects[view]);
    expect(points).toEqual([
      { view: 0, x: 0.1, y: 0.4, rect: rects[0], touch: true, crosshair: false },
      { view: 1, x: 0.625, y: 0.5, rect: rects[1], touch: false, crosshair: true },
    ]);
  });
});
