import { describe, expect, it } from "vitest";
import { findContent, frameContent, previewSize, PREVIEW_ASPECT } from "./encode.ts";

/** A `width` × `height` RGBA frame of `background`, with `paint` filled in. */
function frame(
  width: number,
  height: number,
  background: [number, number, number],
  paint: { x: number; y: number; width: number; height: number; color: [number, number, number] }[] = [],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const hit = paint.find((p) => x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height);
      pixels.set([...(hit ? hit.color : background), 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

describe("previewSize", () => {
  it("brings the long side down to the preview size and keeps the shape", () => {
    expect(previewSize(2560, 1600)).toEqual({ width: 480, height: 300 });
    expect(previewSize(800, 1200)).toEqual({ width: 320, height: 480 });
  });

  it("never enlarges a small region", () => {
    expect(previewSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(previewSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("findContent", () => {
  it("finds the data on a background the corners share", () => {
    const pixels = frame(40, 30, [0, 0, 0], [{ x: 25, y: 4, width: 10, height: 12, color: [200, 40, 220] }]);
    expect(findContent(pixels, 40, 30)).toEqual({
      background: [0, 0, 0],
      bounds: { x: 25, y: 4, width: 10, height: 12 },
    });
  });

  it("treats near-background as background, so dark data edges do not widen the frame", () => {
    const pixels = frame(20, 20, [255, 255, 255], [
      { x: 0, y: 8, width: 20, height: 2, color: [250, 250, 250] },
      { x: 5, y: 5, width: 3, height: 3, color: [10, 10, 10] },
    ]);
    expect(findContent(pixels, 20, 20).bounds).toEqual({ x: 5, y: 5, width: 3, height: 3 });
  });

  it("takes the whole frame when the data reaches a corner", () => {
    const pixels = frame(20, 10, [0, 0, 0], [{ x: 15, y: 0, width: 5, height: 5, color: [90, 90, 90] }]);
    expect(findContent(pixels, 20, 10)).toEqual({ background: null, bounds: { x: 0, y: 0, width: 20, height: 10 } });
  });

  it("calls a frame of nothing but background blank", () => {
    expect(findContent(frame(8, 8, [0, 0, 0]), 8, 8)).toEqual({ background: [0, 0, 0], bounds: null });
  });
});

describe("frameContent", () => {
  it("grows square data to the card's shape with a margin, centered on the data", () => {
    const region = frameContent({ x: 600, y: 100, width: 200, height: 200 });
    expect(region).toEqual({ x: 476, y: 88, width: 448, height: 224 });
    expect(region.width / region.height).toBeCloseTo(PREVIEW_ASPECT);
  });

  it("grows wide data downward and upward instead", () => {
    const region = frameContent({ x: 0, y: 300, width: 1000, height: 100 });
    expect(region.width).toBeCloseTo(1120);
    expect(region.height).toBeCloseTo(560);
    expect(region.x + region.width / 2).toBeCloseTo(500);
    expect(region.y + region.height / 2).toBeCloseTo(350);
  });
});
