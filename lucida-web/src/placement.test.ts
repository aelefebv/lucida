import { describe, expect, it } from "vitest";
import {
  IDENTITY_PLACEMENT,
  frameToScene,
  keepsCut,
  placementInPlane,
  readPlacement,
  rectToQuad,
  sceneToFrame,
  type Placement,
} from "./placement.ts";

/** A placement that turns the frame by `radians` about `axis` (0, 1 or 2), then moves it by `offset`. */
function turnedAbout(axis: number, radians: number, offset: [number, number, number] = [0, 0, 0]): Placement {
  const [s, c] = [Math.sin(radians), Math.cos(radians)];
  const [i, j] = [(axis + 1) % 3, (axis + 2) % 3];
  const linear = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((row) => [...row]);
  linear[i][i] = c;
  linear[i][j] = -s;
  linear[j][i] = s;
  linear[j][j] = c;
  return { offset, linear: linear as unknown as Placement["linear"] };
}

describe("a dataset's placement", () => {
  it("reads the offset and the linear part by rows", () => {
    const scene = { dataset_placement: () => new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) };
    expect(readPlacement(scene, "ds")).toEqual({ offset: [1, 2, 3], linear: [[4, 5, 6], [7, 8, 9], [10, 11, 12]] });
    expect(readPlacement({ dataset_placement: () => new Float64Array() }, "ds")).toBe(IDENTITY_PLACEMENT);
  });

  it("keeps the cut a turn is about, and tilts the cuts across the others", () => {
    const aboutZ = turnedAbout(2, 0.5);
    expect(keepsCut(aboutZ, "z")).toBe(true);
    expect(keepsCut(aboutZ, "x")).toBe(false);
    expect(keepsCut(aboutZ, "y")).toBe(false);
    expect(keepsCut(IDENTITY_PLACEMENT, "x")).toBe(true);
  });

  it("maps a frame point on a side view's plane, and back", () => {
    // Turned about Y, which an XZ view cuts: X and Z turn on its plane.
    const m = placementInPlane(turnedAbout(1, 0.5, [10, 20, 30]), "y");
    const p = frameToScene(m, [4, 7]);
    const back = sceneToFrame(m, p);
    expect(back[0]).toBeCloseTo(4, 12);
    expect(back[1]).toBeCloseTo(7, 12);
    expect(m.offset).toEqual([10, 30]);
  });

  it("covers a frame rect with the quad it lands on", () => {
    const m = placementInPlane(turnedAbout(2, Math.PI / 2, [5, 0, 0]), "z");
    const q = rectToQuad(m, 0, 0, 4, 2);
    expect(q.origin).toEqual([5, 0]);
    expect(q.across[0]).toBeCloseTo(0, 12);
    expect(q.across[1]).toBeCloseTo(4, 12);
    expect(q.down[0]).toBeCloseTo(-2, 12);
    expect(q.down[1]).toBeCloseTo(0, 12);
  });
});
