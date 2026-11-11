import { describe, expect, it } from "vitest";
import type { SceneMap } from "../userTransform.ts";
import { cornerPoint, moveMap, scaleMap, turnAngle, type PlaneQuad } from "./moveScaleGesture.ts";

const apply = (map: SceneMap, p: [number, number, number]) =>
  [0, 1, 2].map((r) => map.offset[r] + [0, 1, 2].reduce((sum, c) => sum + map.linear[r][c] * p[c], 0));
const diagonal = (map: SceneMap) => [0, 1, 2].map((i) => map.linear[i][i]);
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const rect: PlaneQuad = { origin: [10, 20], across: [100, 0], down: [0, 50] };
/** A drag of `corner`, pressed exactly on it, to `now`. */
const scale = (corner: "nw" | "ne" | "se" | "sw", now: [number, number], uniform = true, cut: "x" | "y" | "z" = "z") =>
  scaleMap(rect, corner, cornerPoint(rect, corner), now, { uniform, cut, cutOrigin: 5, minExtent: 4 });

describe("a Move, scale and rotate drag", () => {
  it("moves by the pointer's travel in the plane, onto the axes the view shows", () => {
    expect(moveMap([0, 0], [7, -3], "z")).toEqual({ linear: IDENTITY, offset: [7, -3, 0] });
    // An XZ view draws X across and Z down.
    expect(moveMap([0, 0], [7, -3], "y")).toEqual({ linear: IDENTITY, offset: [7, 0, -3] });
  });

  it("scales from the opposite corner, which stays put", () => {
    const map = scale("se", [210, 120]);
    expect(diagonal(map)).toEqual([2, 2, 2]);
    expect(apply(map, [10, 20, 5])).toEqual([10, 20, 5]);
    expect(apply(map, [110, 70, 5])).toEqual([210, 120, 5]);
    // Dragging the top-left corner holds the bottom-right one.
    const nw = scale("nw", [60, 45]);
    expect(diagonal(nw)[0]).toBeCloseTo(0.5);
    expect(apply(nw, [110, 70, 5])).toEqual([110, 70, 5]);
  });

  it("moves the corner as far as the pointer travels, wherever on the handle the press landed", () => {
    const pressed = scaleMap(rect, "se", [106, 73], [206, 123], { uniform: true, cut: "z", cutOrigin: 0, minExtent: 4 });
    expect(diagonal(pressed)).toEqual([2, 2, 2]);
  });

  it("follows each axis on its own with Shift, keeping the cut's size", () => {
    const map = scale("se", [310, 45], false);
    expect(diagonal(map)).toEqual([3, 0.5, 1]);
    expect(apply(map, [10, 20, 0])).toEqual([10, 20, 0]);
  });

  it("never turns the outline over or shrinks it past the smallest size", () => {
    const map = scale("se", [0, 0], false);
    // 4 of 100 across and 4 of 50 down.
    expect(diagonal(map)[0]).toBeCloseTo(0.04);
    expect(diagonal(map)[1]).toBeCloseTo(0.08);
    expect(diagonal(scale("se", [-500, -500]))[0]).toBeCloseTo(0.08);
  });

  it("scales the cut about where the dataset starts along it in a side view", () => {
    // A YZ view draws Y across and Z down, and cuts X.
    const map = scale("se", [210, 120], true, "x");
    expect(diagonal(map)).toEqual([2, 2, 2]);
    expect(apply(map, [5, 10, 20])).toEqual([5, 10, 20]);
  });

  it("scales a turned outline along its own edges, from its opposite corner", () => {
    // A 100 x 50 outline turned 30 degrees from across toward down.
    const [cos, sin] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const turned: PlaneQuad = { origin: [10, 20], across: [100 * cos, 100 * sin], down: [-50 * sin, 50 * cos] };
    const reach = cornerPoint(turned, "se");
    const anchor = cornerPoint(turned, "nw");
    // Pulled out along its across edge by half its length, with Shift.
    const now: [number, number] = [reach[0] + 50 * cos, reach[1] + 50 * sin];
    const map = scaleMap(turned, "se", reach, now, { uniform: false, cut: "z", cutOrigin: 0, minExtent: 4 });
    const close = (p: number[], q: number[]) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 9));
    close(apply(map, [anchor[0], anchor[1], 0]), [anchor[0], anchor[1], 0]);
    close(apply(map, [reach[0], reach[1], 0]), [now[0], now[1], 0]);
    // The far end of the down edge stays as long: only the across edge grew.
    const sw = cornerPoint(turned, "sw");
    close(apply(map, [sw[0], sw[1], 0]), [sw[0], sw[1], 0]);
  });

  it("turns by the angle the pointer sweeps about the middle, the short way round", () => {
    expect(turnAngle([0, 0], [10, 0], [0, 10])).toBeCloseTo(Math.PI / 2);
    expect(turnAngle([0, 0], [0, 10], [10, 0])).toBeCloseTo(-Math.PI / 2);
    // From just above the negative across axis to just below it is a small turn.
    expect(turnAngle([0, 0], [-10, -0.1], [-10, 0.1])).toBeCloseTo(-0.02, 3);
  });
});
