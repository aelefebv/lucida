import { describe, expect, it } from "vitest";
import type { WasmScene } from "lucida-core";
import { sceneClipDepth } from "./clipDepth.ts";

/** A camera at z = -5 looking down +z at a unit box spanning z 0..2, so the
 * box lies 5 to 7 units in front of it. */
function makeScene(initialDistance = 0) {
  let distance = initialDistance;
  const scene = {
    dataset_fit_bounds: () => new Float64Array([0, 0, 0, 1, 1, 2]),
    eye_position: () => new Float32Array([0.5, 0.5, -5]),
    camera_forward: () => new Float32Array([0, 0, 1]),
    clip_distance: () => distance,
    adjust_clip_distance: (delta: number) => {
      distance = Math.max(0, distance + delta);
    },
  } as unknown as WasmScene;
  return { scene, distance: () => distance };
}

describe("sceneClipDepth", () => {
  it("maps the slider across the box's depth in front of the camera", () => {
    const { scene, distance } = makeScene();
    let changes = 0;
    const depth = sceneClipDepth(scene, "ds", () => changes++);
    depth.write(0.5);
    expect(distance()).toBeCloseTo(6);
    expect(depth.read()).toBeCloseTo(0.5);
    depth.write(1);
    expect(distance()).toBeCloseTo(7);
    expect(changes).toBe(2);
  });

  it("reads off as 0 and writes 0 as no clip at all", () => {
    const { scene, distance } = makeScene(6);
    const depth = sceneClipDepth(scene, "ds", () => {});
    depth.write(0);
    expect(distance()).toBe(0);
    expect(depth.read()).toBe(0);
  });

  it("does nothing for a dataset with no bounds", () => {
    const { scene, distance } = makeScene(3);
    (scene as unknown as { dataset_fit_bounds: () => Float64Array }).dataset_fit_bounds = () => new Float64Array();
    const depth = sceneClipDepth(scene, "ds", () => {});
    depth.write(0.5);
    expect(distance()).toBe(3);
    expect(depth.read()).toBe(0);
  });
});
