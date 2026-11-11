import { describe, expect, it } from "vitest";
import { cutLocalAt, cutNdcToWorld, transposePlaneToWorld } from "./sliceCut.ts";

/** An XZ view's plane at Y = 5, in a world that halves the scene frame: across is X, down is Z. */
const PLANE_TO_WORLD = [0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 2.5, 0, 1];
const CAMERA = { zoom: 2, cx: 10, cy: 20, canvasW: 100, canvasH: 80 };

/** A column-major 4x4 applied to a point. */
function apply(m: ArrayLike<number>, p: [number, number, number]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

describe("a tilted cut", () => {
  it("maps the target's center to the camera's center on the cut, and its corner a half-view away", () => {
    const m = cutNdcToWorld(CAMERA, PLANE_TO_WORLD);
    expect(apply(m, [0, 0, 0])).toEqual([5, 2.5, 10, 1]);
    // NDC (1, 1) is the top right: across 25 scene units more, down 20 less.
    expect(apply(m, [1, 1, 0])).toEqual([0.5 * 35, 2.5, 0.5 * 0, 1]);
  });

  it("reads the member-local point under a target pixel, and nothing off the member", () => {
    // A member spanning world [0, 10] on each axis.
    const invModel = [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];
    const local = cutLocalAt(CAMERA, PLANE_TO_WORLD, invModel, 50, 40)!;
    expect(local.map((v) => +v.toFixed(6))).toEqual([0.5, 0.25, 1]);
    // Further down the target, the cut passes below the member.
    expect(cutLocalAt(CAMERA, PLANE_TO_WORLD, invModel, 50, 60)).toBeNull();
  });

  it("draws the same cut transposed, its down axis across the target", () => {
    const transposed = cutNdcToWorld(
      { ...CAMERA, cx: CAMERA.cy, cy: CAMERA.cx },
      transposePlaneToWorld(PLANE_TO_WORLD),
    );
    expect(apply(transposed, [0, 0, 0])).toEqual([5, 2.5, 10, 1]);
    // NDC x now runs down the plane, along Z: 25 scene units right is Z 45.
    expect(apply(transposed, [1, 0, 0])).toEqual([5, 2.5, 0.5 * 45, 1]);
  });
});
