import { describe, it, expect } from "vitest";
import {
  annotationVertices,
  boxPlane,
  isClosedShape,
  liesOnPlane,
  onPlane,
  shiftPin,
  translateOnPlane,
  withOnPlane,
} from "./annotationGeometry.ts";
import type { Annotation } from "./annotationDocument.ts";

// Parity with the Rust `vertices_*` unit tests for `Annotation::vertices()` and
// `is_closed()`, so the two implementations can't drift.

function pin(kind: string, position: [number, number], end?: [number, number] | null): Annotation {
  return { id: "a", position, end: end ?? null, author: "ada", kind };
}

describe("annotationVertices", () => {
  it("point is a single anchor", () => {
    expect(annotationVertices(pin("point", [3, 4]))).toEqual([[3, 4, 0]]);
  });

  it("line is its two endpoints in order", () => {
    expect(annotationVertices(pin("line", [1, 2], [5, 6]))).toEqual([
      [1, 2, 0],
      [5, 6, 0],
    ]);
  });

  it("box is the four-corner ring, wound p -> (end.x,p.y) -> end -> (p.x,end.y)", () => {
    expect(annotationVertices(pin("box", [1, 2], [5, 6]))).toEqual([
      [1, 2, 0],
      [5, 2, 0],
      [5, 6, 0],
      [1, 6, 0],
    ]);
  });

  it("a box drawn in a side view is the ring in the plane its corners share", () => {
    // XZ: the corners share Y, X runs across and Z down.
    const xz = { ...pin("box", [1, 40.5], [9, 40.5]), z: 2, end_z: 7 };
    expect(annotationVertices(xz)).toEqual([
      [1, 40.5, 2],
      [9, 40.5, 2],
      [9, 40.5, 7],
      [1, 40.5, 7],
    ]);
    // YZ: they share X, Y runs across and Z down.
    const yz = { ...pin("box", [30.5, 2], [30.5, 8]), z: 1, end_z: 4 };
    expect(annotationVertices(yz)).toEqual([
      [30.5, 2, 1],
      [30.5, 8, 1],
      [30.5, 8, 4],
      [30.5, 2, 4],
    ]);
  });

  it("a line drawn in a side view runs between its two depths", () => {
    expect(annotationVertices({ ...pin("line", [1, 2], [5, 2]), z: 3, end_z: 9 })).toEqual([
      [1, 2, 3],
      [5, 2, 9],
    ]);
  });

  it("a line or box missing its end collapses to the single anchor", () => {
    expect(annotationVertices(pin("line", [7, 8]))).toEqual([[7, 8, 0]]);
    expect(annotationVertices(pin("box", [7, 8], null))).toEqual([[7, 8, 0]]);
  });
});

describe("a shape's plane", () => {
  it("is the one across the axis both corners share, XY when they share their depth", () => {
    expect(boxPlane([1, 2, 3], [5, 6, 3])).toBe("xy");
    expect(boxPlane([1, 2, 3], [5, 2, 9])).toBe("xz");
    expect(boxPlane([1, 2, 3], [1, 6, 9])).toBe("yz");
  });

  it("reshapes only on a plane of the kind it lies on", () => {
    expect(liesOnPlane([1, 2, 3], [5, 2, 9], "xz")).toBe(true);
    expect(liesOnPlane([1, 2, 3], [5, 2, 9], "xy")).toBe(false);
    expect(liesOnPlane([1, 2, 3], [5, 2, 9], "yz")).toBe(false);
  });
});

describe("a point's place on a plane", () => {
  it("reads across and down each plane, and moves there keeping its place along the cut", () => {
    expect(onPlane([1, 2, 3], "xy")).toEqual([1, 2]);
    expect(onPlane([1, 2, 3], "xz")).toEqual([1, 3]);
    expect(onPlane([1, 2, 3], "yz")).toEqual([2, 3]);
    expect(withOnPlane([1, 2, 3], [7, 8], "xz")).toEqual([7, 2, 8]);
    expect(withOnPlane([1, 2, 3], [7, 8], "yz")).toEqual([1, 7, 8]);
  });

  it("moves a whole shape across a plane, each vertex at its own place along the cut", () => {
    const moved = translateOnPlane({ position: [1, 2, 3], end: [5, 6, 9] }, [10, -1], "xy");
    expect(moved).toEqual({ position: [11, 1, 3], end: [15, 5, 9] });
  });
});

describe("shiftPin", () => {
  it("moves every vertex alike, so a side-view box stays on its plane", () => {
    const box: Annotation = { ...pin("box", [10, 52.5], [30, 52.5]), z: 2, end_z: 6 };
    const moved = shiftPin(box, [0, -40, 20]);
    expect(annotationVertices(moved)).toEqual(annotationVertices(box).map(([x, y, z]) => [x, y - 40, z + 20]));
    expect(boxPlane([moved.position[0], moved.position[1], moved.z ?? 0], [30, 12.5, 26])).toBe("xz");
    expect(shiftPin(box, [0, 0, 0])).toBe(box);
  });
});

describe("isClosedShape", () => {
  it("is true only for a box with an end", () => {
    expect(isClosedShape(pin("box", [1, 2], [5, 6]))).toBe(true);
  });

  it("is false for a box without an end, a line, and a point", () => {
    expect(isClosedShape(pin("box", [1, 2], null))).toBe(false);
    expect(isClosedShape(pin("line", [1, 2], [5, 6]))).toBe(false);
    expect(isClosedShape(pin("point", [1, 2]))).toBe(false);
  });
});
