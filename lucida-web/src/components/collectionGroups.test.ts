import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";
import { groupAt, unionRects } from "./collectionGroups.ts";
import type { VoxelRect } from "../pipeline/layoutBuilders.ts";

beforeAll(async () => {
  // wasm-bindgen web target: init with the built .wasm bytes (cwd is lucida-web).
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

describe("unionRects", () => {
  it("spans every rect and skips nulls", () => {
    expect(
      unionRects([
        { min: [10, 20], max: [30, 40] },
        null,
        { min: [-5, 25], max: [15, 90] },
      ]),
    ).toEqual({ min: [-5, 20], max: [30, 90] });
  });

  it("is null when nothing has a rect", () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([null, null])).toBeNull();
  });
});

describe("groupAt", () => {
  const groups: { key: string; bounds: VoxelRect }[] = [
    { key: "left", bounds: { min: [0, 0], max: [100, 100] } },
    { key: "right", bounds: { min: [120, 0], max: [220, 100] } },
    { key: "inset", bounds: { min: [140, 20], max: [160, 40] } },
  ];

  it("names the group under the point, edges included", () => {
    expect(groupAt(groups, [50, 50])).toBe("left");
    expect(groupAt(groups, [100, 100])).toBe("left");
  });

  it("is null between groups", () => {
    expect(groupAt(groups, [110, 50])).toBeNull();
    expect(groupAt([], [0, 0])).toBeNull();
  });

  it("prefers the smallest of overlapping groups", () => {
    expect(groupAt(groups, [150, 30])).toBe("inset");
    expect(groupAt(groups, [200, 80])).toBe("right");
  });
});

describe("a group click", () => {
  // The scene's viewport is the canvas in device pixels, as the slice path sets it.
  for (const dpr of [1, 2]) {
    it(`frames the whole group, centered, at devicePixelRatio ${dpr}`, () => {
      const rect: VoxelRect = { min: [2400, 1300], max: [2900, 1700] };
      const scene = new WasmScene(1280 * dpr, 800 * dpr);
      expect(scene.frame_region(rect.min[0], rect.min[1], rect.max[0], rect.max[1])).toBe(true);

      expect(Array.from(scene.center())).toEqual([2650, 1500]);
      const [minX, minY, maxX, maxY] = JSON.parse(scene.world_bounds()) as number[];
      expect(minX).toBeLessThanOrEqual(rect.min[0]);
      expect(minY).toBeLessThanOrEqual(rect.min[1]);
      expect(maxX).toBeGreaterThanOrEqual(rect.max[0]);
      expect(maxY).toBeGreaterThanOrEqual(rect.max[1]);
      // The same CSS framing at either ratio: zoom is device pixels per voxel.
      expect(scene.zoom() / dpr).toBeCloseTo(800 / (400 * 1.15));
      expect(scene.camera_framing()).toBe("placed");
    });
  }
});
