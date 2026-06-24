import { describe, expect, it } from "vitest";

import { draftBoxRect } from "./annotationDraft.ts";

describe("draftBoxRect", () => {
  it("builds a rect for a down-right drag", () => {
    expect(draftBoxRect(10, 20, 60, 80)).toEqual({ x: 10, y: 20, width: 50, height: 60 });
  });

  it("normalizes an up-left drag to a non-negative rect", () => {
    // Dragging back past the anchor must still yield a valid (positive w/h) rect.
    expect(draftBoxRect(60, 80, 10, 20)).toEqual({ x: 10, y: 20, width: 50, height: 60 });
  });

  it("handles a mixed-direction drag", () => {
    expect(draftBoxRect(60, 20, 10, 80)).toEqual({ x: 10, y: 20, width: 50, height: 60 });
  });

  it("yields a zero-size rect at the anchor", () => {
    expect(draftBoxRect(30, 30, 30, 30)).toEqual({ x: 30, y: 30, width: 0, height: 0 });
  });
});
