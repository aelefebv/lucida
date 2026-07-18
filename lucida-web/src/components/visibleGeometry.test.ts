// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  elementVisibleGeometry,
  intersectVisibleRects,
  overflowClippingAncestors,
  type VisibleRect,
} from "./visibleGeometry.ts";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

const VIEWPORT: VisibleRect = {
  left: 0,
  top: 0,
  right: 200,
  bottom: 200,
  width: 200,
  height: 200,
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("visible geometry", () => {
  it("intersects overflow clipping ancestors as well as the visual viewport", () => {
    const clip = document.createElement("div");
    clip.style.overflow = "hidden";
    const element = document.createElement("div");
    clip.append(element);
    document.body.append(clip);
    vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(rect(20, 20, 100, 100));
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(80, 80, 80, 80));

    const geometry = elementVisibleGeometry(element, VIEWPORT);

    expect(overflowClippingAncestors(element)).toEqual([clip]);
    expect(geometry.visibleRect).toEqual({
      left: 80,
      top: 80,
      right: 120,
      bottom: 120,
      width: 40,
      height: 40,
    });
  });

  it("reports an offscreen positive-size anchor as measurable but not visible", () => {
    const element = document.createElement("button");
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(250, 20, 40, 30));

    expect(elementVisibleGeometry(element, VIEWPORT)).toMatchObject({
      measurable: true,
      visibleRect: null,
    });
  });

  it("applies overflow clipping independently per axis", () => {
    const clip = document.createElement("div");
    clip.style.overflowX = "hidden";
    clip.style.overflowY = "visible";
    const element = document.createElement("div");
    clip.append(element);
    document.body.append(clip);
    vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(rect(20, 20, 100, 100));
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(80, 80, 80, 80));

    expect(elementVisibleGeometry(element, VIEWPORT).visibleRect).toEqual({
      left: 80,
      top: 80,
      right: 120,
      bottom: 160,
      width: 40,
      height: 80,
    });
  });

  it("keeps zero-layout test DOMs distinguishable from genuinely clipped anchors", () => {
    const element = document.createElement("button");
    document.body.append(element);

    expect(elementVisibleGeometry(element, VIEWPORT)).toMatchObject({
      measurable: false,
      paintSuppressed: false,
      visibleRect: null,
    });
  });

  it.each([
    ["display", "none"],
    ["visibility", "hidden"],
    ["content-visibility", "hidden"],
  ])("treats an anchor with %s: %s as unable to paint", (property, value) => {
    const element = document.createElement("button");
    element.style.setProperty(property, value);
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(20, 20, 40, 30));

    expect(elementVisibleGeometry(element, VIEWPORT)).toMatchObject({
      measurable: true,
      paintSuppressed: true,
      visibleRect: null,
    });
  });

  it("inherits paint suppression from a CSS-hidden ancestor", () => {
    const ancestor = document.createElement("div");
    ancestor.style.visibility = "hidden";
    const element = document.createElement("button");
    ancestor.append(element);
    document.body.append(ancestor);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(20, 20, 40, 30));

    expect(elementVisibleGeometry(element, VIEWPORT)).toMatchObject({
      paintSuppressed: true,
      visibleRect: null,
    });
  });

  it("treats a disconnected anchor as unable to paint", () => {
    const element = document.createElement("button");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(20, 20, 40, 30));

    expect(elementVisibleGeometry(element, VIEWPORT)).toMatchObject({
      paintSuppressed: true,
      visibleRect: null,
    });
  });

  it("does not treat edge contact as painted overlap", () => {
    expect(intersectVisibleRects(
      { left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 },
      { left: 20, top: 0, right: 40, bottom: 20, width: 20, height: 20 },
    )).toBeNull();
  });
});
