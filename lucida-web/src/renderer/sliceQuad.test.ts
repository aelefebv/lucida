import { describe, expect, it } from "vitest";
import { axisAlignedQuad, quadBounds, quadEdgeLengths, quadPoint, quadUV, transposeQuad, type SliceQuad } from "./sliceQuad.ts";

/** A `w × h` quad at `origin`, turned by `radians` in the plane. */
function turned(origin: [number, number], w: number, h: number, radians: number): SliceQuad {
  const [s, c] = [Math.sin(radians), Math.cos(radians)];
  return { origin, across: [w * c, w * s], down: [-h * s, h * c] };
}

describe("a slice layer's quad", () => {
  it("reads a scene point back to the UV it was placed at, turned or not", () => {
    for (const q of [axisAlignedQuad(5, -3, 40, 20), turned([5, -3], 40, 20, 0.7)]) {
      const [x, y] = quadPoint(q, 0.25, 0.8);
      const [u, v] = quadUV(q, x, y);
      expect(u).toBeCloseTo(0.25, 12);
      expect(v).toBeCloseTo(0.8, 12);
    }
  });

  it("measures an unturned quad as the rect it is", () => {
    const q = axisAlignedQuad(5, -3, 40, 20);
    expect(quadBounds(q)).toEqual({ x: 5, y: -3, w: 40, h: 20 });
    expect(quadEdgeLengths(q)).toEqual([40, 20]);
    expect(quadUV(q, 15, 2)).toEqual([(15 - 5) / 40, (2 + 3) / 20]);
  });

  it("covers the rect around a turned quad's corners, and keeps its edges' lengths", () => {
    const q = turned([0, 0], 10, 10, Math.PI / 4);
    const r = 10 * Math.SQRT1_2;
    const bounds = quadBounds(q);
    expect(bounds.x).toBeCloseTo(-r, 12);
    expect(bounds.y).toBeCloseTo(0, 12);
    expect(bounds.w).toBeCloseTo(2 * r, 12);
    expect(bounds.h).toBeCloseTo(2 * r, 12);
    const [w, h] = quadEdgeLengths(q);
    expect(w).toBeCloseTo(10, 12);
    expect(h).toBeCloseTo(10, 12);
    // A corner of the rect around it lies outside the quad's unit square.
    const [u, v] = quadUV(q, bounds.x + 0.5, bounds.y + 0.5);
    expect(u >= 0 && u <= 1 && v >= 0 && v <= 1).toBe(false);
  });
});

describe("transposeQuad", () => {
  it("swaps the plane's axes, so a point lands where the transposed screen draws it", () => {
    const quad = { origin: [5, 2], across: [20, 0], down: [0, 10] } as const;
    const turned = transposeQuad(quad);
    expect(turned).toEqual({ origin: [2, 5], across: [0, 20], down: [10, 0] });
    const [x, y] = quadPoint(quad, 0.25, 0.5);
    expect(quadPoint(turned, 0.25, 0.5)).toEqual([y, x]);
    expect(quadUV(turned, y, x)).toEqual([0.25, 0.5]);
  });
});
