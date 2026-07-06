import { describe, it, expect } from "vitest";
import { annotationVertices, isClosedShape } from "./annotationGeometry.ts";
import type { Annotation } from "./annotationDocument.ts";

// Parity tests for the TS geometry mirror. These assert the SAME contract the
// Rust unit tests (`vertices_point_is_single_anchor`,
// `vertices_line_is_two_endpoints_in_order`, `vertices_box_is_four_corner_ring`,
// `vertices_line_or_box_without_end_collapses_to_anchor`) lock for
// `Annotation::vertices()` / `is_closed()` in lucida-core, so the two
// implementations can't silently drift.

function pin(kind: string, position: [number, number], end?: [number, number] | null): Annotation {
  return { id: "a", position, end: end ?? null, author: "bio", kind };
}

describe("annotationVertices", () => {
  it("point is a single anchor", () => {
    expect(annotationVertices(pin("point", [3, 4]))).toEqual([[3, 4]]);
  });

  it("line is its two endpoints in order", () => {
    expect(annotationVertices(pin("line", [1, 2], [5, 6]))).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it("box is the four-corner ring, wound p -> (end.x,p.y) -> end -> (p.x,end.y)", () => {
    expect(annotationVertices(pin("box", [1, 2], [5, 6]))).toEqual([
      [1, 2],
      [5, 2],
      [5, 6],
      [1, 6],
    ]);
  });

  it("a line or box missing its end collapses to the single anchor", () => {
    expect(annotationVertices(pin("line", [7, 8]))).toEqual([[7, 8]]);
    expect(annotationVertices(pin("box", [7, 8], null))).toEqual([[7, 8]]);
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
