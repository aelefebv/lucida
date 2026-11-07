/**
 * The flat-colour check on a fallback frame: one colour in every pixel of
 * the canvas's region is a screenshot that left the canvas out, and anything
 * else is a picture.
 */
import { describe, expect, it } from "vitest";

import { type DecodedImage, flatColourOf, visibleRectOf } from "./flatFrame.ts";

function image(width: number, height: number, fill: [number, number, number, number]): DecodedImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(fill, offset);
  return { width, height, data };
}

function paint(target: DecodedImage, x: number, y: number, fill: [number, number, number, number]) {
  target.data.set(fill, (y * target.width + x) * 4);
}

describe("flatColourOf", () => {
  it("names the one colour an opaque flat image is, as a hex triple", () => {
    expect(flatColourOf(image(4, 3, [0, 0, 0, 255]))).toBe("#000000");
    expect(flatColourOf(image(2, 2, [0x12, 0xab, 0xff, 255]))).toBe("#12abff");
  });

  it("adds the alpha when the flat colour is not opaque", () => {
    expect(flatColourOf(image(2, 2, [10, 11, 12, 0x80]))).toBe("#0a0b0c80");
    expect(flatColourOf(image(1, 1, [0, 0, 0, 0]))).toBe("#00000000");
  });

  it("is null as soon as any pixel differs, in any channel", () => {
    const lastPixel = image(64, 2, [0, 0, 0, 255]);
    lastPixel.data[lastPixel.data.length - 2] = 1;
    expect(flatColourOf(lastPixel)).toBeNull();

    const alphaOnly = image(3, 3, [7, 7, 7, 255]);
    alphaOnly.data[4 * 4 + 3] = 254;
    expect(flatColourOf(alphaOnly)).toBeNull();
  });

  it("treats an image with no pixels as not flat, since it has no colour to name", () => {
    expect(flatColourOf(image(0, 0, [0, 0, 0, 255]))).toBeNull();
    expect(flatColourOf({ width: 2, height: 2, data: new Uint8ClampedArray(4) })).toBeNull();
  });

  it("reads pixels through a view that does not start on a word boundary", () => {
    const backing = new Uint8ClampedArray(1 + 4 * 6);
    backing.fill(0x22);
    const offset = new Uint8ClampedArray(backing.buffer, 1, 4 * 6);
    expect(flatColourOf({ width: 3, height: 2, data: offset })).toBe("#22222222");
    offset[9] = 0x23;
    expect(flatColourOf({ width: 3, height: 2, data: offset })).toBeNull();
  });

  /**
   * The geometry the hardware pass saw: a black canvas filling the page,
   * with the scrollbars of an overflowing page along the last rows and
   * columns. The scrollbars are outside the canvas's visible rectangle.
   */
  describe("over a region", () => {
    function screenshotWithScrollbars(): DecodedImage {
      const shot = image(100, 60, [0, 0, 0, 255]);
      for (let y = 0; y < 60; y += 1) paint(shot, 99, y, [252, 252, 252, 255]);
      for (let x = 0; x < 100; x += 1) paint(shot, x, 59, [139, 139, 139, 255]);
      return shot;
    }

    it("reads only the region, so a scrollbar outside it does not make a picture", () => {
      const shot = screenshotWithScrollbars();
      expect(flatColourOf(shot)).toBeNull();
      expect(flatColourOf(shot, { x: 0, y: 0, width: 98, height: 58 })).toBe("#000000");
    });

    it("is a picture when anything inside the region differs", () => {
      const shot = screenshotWithScrollbars();
      paint(shot, 50, 30, [13, 13, 20, 255]);
      expect(flatColourOf(shot, { x: 0, y: 0, width: 98, height: 58 })).toBeNull();
    });

    it("reads the region's interior, inset by two percent, so a rounded corner is not content", () => {
      const shot = image(100, 100, [0, 0, 0, 255]);
      paint(shot, 0, 0, [30, 30, 30, 255]);
      paint(shot, 99, 99, [30, 30, 30, 255]);
      expect(flatColourOf(shot, { x: 0, y: 0, width: 100, height: 100 })).toBe("#000000");
      // Two pixels in: past the inset, so content.
      paint(shot, 2, 2, [30, 30, 30, 255]);
      expect(flatColourOf(shot, { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
    });

    it("clamps a region to the image and falls back to the whole image when nothing is left", () => {
      const shot = image(10, 10, [5, 5, 5, 255]);
      paint(shot, 9, 9, [6, 6, 6, 255]);
      expect(flatColourOf(shot, { x: -5, y: -5, width: 12, height: 12 })).toBe("#050505");
      // Entirely outside: the whole image is read, and the whole image is not flat.
      expect(flatColourOf(shot, { x: 20, y: 20, width: 5, height: 5 })).toBeNull();
      expect(flatColourOf(shot, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    });
  });
});

describe("visibleRectOf", () => {
  function element(rect: { left: number; top: number; right: number; bottom: number }, client: [number, number]) {
    return {
      getBoundingClientRect: () => rect,
      ownerDocument: { documentElement: { clientWidth: client[0], clientHeight: client[1] } },
    } as unknown as Element;
  }

  it("clips the element's rectangle to the document's client area, which excludes scrollbars", () => {
    const rect = visibleRectOf(element({ left: 0, top: 0, right: 1440, bottom: 900 }, [1425, 885]));
    expect(rect).toEqual({ x: 0, y: 0, width: 1425, height: 885 });
  });

  it("keeps an element that starts inside the page where it is", () => {
    const rect = visibleRectOf(element({ left: 300, top: 40, right: 1400, bottom: 800 }, [1440, 900]));
    expect(rect).toEqual({ x: 300, y: 40, width: 1100, height: 760 });
  });

  it("is null for no element, a hidden element, or one scrolled out of view", () => {
    expect(visibleRectOf(null)).toBeNull();
    expect(visibleRectOf(element({ left: 0, top: 0, right: 0, bottom: 0 }, [1440, 900]))).toBeNull();
    expect(visibleRectOf(element({ left: -200, top: 0, right: -10, bottom: 100 }, [1440, 900]))).toBeNull();
  });
});
