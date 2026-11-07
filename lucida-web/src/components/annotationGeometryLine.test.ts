import { describe, it, expect } from "vitest";
import {
  LINE_HANDLES,
  lineHandlePoint,
  reshapeLine,
  type LineEndpoints,
} from "./annotationGeometry.ts";

// Dragging one endpoint moves only that vertex. The overlay tests cover the
// gesture end to end.

const base: LineEndpoints = { position: [1, 2], end: [5, 6] };

describe("LINE_HANDLES", () => {
  it("is exactly the two endpoints, anchor then far", () => {
    expect([...LINE_HANDLES]).toEqual(["start", "end"]);
  });
});

describe("lineHandlePoint", () => {
  it("start rides the anchor (position); end rides the far vertex (end)", () => {
    expect(lineHandlePoint(base, "start")).toEqual([1, 2]);
    expect(lineHandlePoint(base, "end")).toEqual([5, 6]);
  });
});

describe("reshapeLine", () => {
  it("dragging start sets position to the world point and holds end", () => {
    expect(reshapeLine(base, "start", [10, 20])).toEqual({
      position: [10, 20],
      end: [5, 6],
    });
  });

  it("dragging end sets end to the world point and holds position", () => {
    expect(reshapeLine(base, "end", [10, 20])).toEqual({
      position: [1, 2],
      end: [10, 20],
    });
  });

  it("is pure — it does not mutate the input endpoints", () => {
    const input: LineEndpoints = { position: [1, 2], end: [5, 6] };
    reshapeLine(input, "start", [99, 99]);
    expect(input).toEqual({ position: [1, 2], end: [5, 6] });
  });
});
