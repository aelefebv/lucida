import { describe, expect, it } from "vitest";
import type { SceneMap } from "../userTransform.ts";
import { cornerPoint, moveMap, scaleMap, type PlaneRect } from "./moveScaleGesture.ts";

const apply = (map: SceneMap, p: [number, number, number]) =>
  [0, 1, 2].map((i) => map.offset[i] + p[i] * map.scale[i]);

const rect: PlaneRect = [10, 20, 110, 70];
/** A drag of `corner`, pressed exactly on it, to `now`. */
const scale = (corner: "nw" | "ne" | "se" | "sw", now: [number, number], uniform = true, cut: "x" | "y" | "z" = "z") =>
  scaleMap(rect, corner, cornerPoint(rect, corner), now, { uniform, cut, cutOrigin: 5, minExtent: 4 });

describe("a Move and scale drag", () => {
  it("moves by the pointer's travel in the plane, onto the axes the view shows", () => {
    expect(moveMap([0, 0], [7, -3], "z")).toEqual({ scale: [1, 1, 1], offset: [7, -3, 0] });
    // An XZ view draws X across and Z down.
    expect(moveMap([0, 0], [7, -3], "y")).toEqual({ scale: [1, 1, 1], offset: [7, 0, -3] });
  });

  it("scales from the opposite corner, which stays put", () => {
    const map = scale("se", [210, 120]);
    expect(map.scale).toEqual([2, 2, 2]);
    expect(apply(map, [10, 20, 5])).toEqual([10, 20, 5]);
    expect(apply(map, [110, 70, 5])).toEqual([210, 120, 5]);
    // Dragging the top-left corner holds the bottom-right one.
    const nw = scale("nw", [60, 45]);
    expect(nw.scale[0]).toBeCloseTo(0.5);
    expect(apply(nw, [110, 70, 5])).toEqual([110, 70, 5]);
  });

  it("moves the corner as far as the pointer travels, wherever on the handle the press landed", () => {
    const pressed = scaleMap(rect, "se", [106, 73], [206, 123], { uniform: true, cut: "z", cutOrigin: 0, minExtent: 4 });
    expect(pressed.scale).toEqual([2, 2, 2]);
  });

  it("follows each axis on its own with Shift, keeping the cut's size", () => {
    const map = scale("se", [310, 45], false);
    expect(map.scale).toEqual([3, 0.5, 1]);
    expect(apply(map, [10, 20, 0])).toEqual([10, 20, 0]);
  });

  it("never turns the outline over or shrinks it past the smallest size", () => {
    const map = scale("se", [0, 0], false);
    // 4 of 100 across and 4 of 50 down.
    expect(map.scale[0]).toBeCloseTo(0.04);
    expect(map.scale[1]).toBeCloseTo(0.08);
    expect(scale("se", [-500, -500]).scale[0]).toBeCloseTo(0.08);
  });

  it("scales the cut about where the dataset starts along it in a side view", () => {
    // A YZ view draws Y across and Z down, and cuts X.
    const map = scale("se", [210, 120], true, "x");
    expect(map.scale).toEqual([2, 2, 2]);
    expect(apply(map, [5, 10, 20])).toEqual([5, 10, 20]);
  });
});
