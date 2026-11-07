import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";
import { fitRectToViewport, frameRect, GROUP_FIT_MARGIN, groupAt, unionRects } from "./groupFraming.ts";
import type { VoxelRect } from "../pipeline/layoutBuilders.ts";

beforeAll(async () => {
  // wasm-bindgen web target: init with the built .wasm bytes (cwd is lucida-web).
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe("fitRectToViewport", () => {
  it("centers on the rect, not its corner", () => {
    const fit = fitRectToViewport({ min: [1000, 2000], max: [1400, 2300] }, [800, 600]);
    expect(fit!.center).toEqual([1200, 2150]);
  });

  it("fits the limiting axis with the margin and leaves room on the other", () => {
    // An 800×300 rect in an 800×600 view is bound by its width.
    const fit = fitRectToViewport({ min: [0, 0], max: [800, 300] }, [800, 600])!;
    expect(fit.zoom).toBeCloseTo(800 / (800 * GROUP_FIT_MARGIN));
    expect(800 * fit.zoom).toBeCloseTo(800 / GROUP_FIT_MARGIN);
    expect(300 * fit.zoom).toBeLessThan(600 / GROUP_FIT_MARGIN);

    const tall = fitRectToViewport({ min: [0, 0], max: [100, 1200] }, [800, 600])!;
    expect(tall.zoom).toBeCloseTo(600 / (1200 * GROUP_FIT_MARGIN));
  });

  it("zooms in on a group smaller than the view", () => {
    const fit = fitRectToViewport({ min: [0, 0], max: [64, 64] }, [800, 600])!;
    expect(fit.zoom).toBeGreaterThan(1);
  });

  it("scales the zoom with the device pixel viewport so the CSS framing is the same", () => {
    const rect: VoxelRect = { min: [0, 0], max: [500, 400] };
    const dpr1 = fitRectToViewport(rect, [1280, 800])!;
    const dpr2 = fitRectToViewport(rect, [2560, 1600])!;
    expect(dpr2.zoom).toBeCloseTo(dpr1.zoom * 2);
    expect(dpr2.center).toEqual(dpr1.center);
  });

  it("fits a zero-width rect on its height", () => {
    const fit = fitRectToViewport({ min: [5, 0], max: [5, 300] }, [800, 600])!;
    expect(fit.zoom).toBeCloseTo(600 / (300 * GROUP_FIT_MARGIN));
  });

  it("is null for a viewport with no area", () => {
    expect(fitRectToViewport({ min: [0, 0], max: [10, 10] }, [0, 600])).toBeNull();
  });
});

describe("frameRect", () => {
  // The scene's viewport is the canvas in device pixels, as the slice path sets it.
  function framedScene(cssSize: [number, number], dpr: number, rect: VoxelRect): WasmScene {
    vi.stubGlobal("devicePixelRatio", dpr);
    const scene = new WasmScene(cssSize[0] * dpr, cssSize[1] * dpr);
    const canvas = { clientWidth: cssSize[0], clientHeight: cssSize[1] } as HTMLCanvasElement;
    frameRect(scene, canvas, rect);
    return scene;
  }

  for (const dpr of [1, 2]) {
    it(`puts the whole rect in view, centered, at devicePixelRatio ${dpr}`, () => {
      const rect: VoxelRect = { min: [2400, 1300], max: [2900, 1700] };
      const scene = framedScene([1280, 800], dpr, rect);

      expect(Array.from(scene.center())).toEqual([2650, 1500]);
      const [minX, minY, maxX, maxY] = JSON.parse(scene.world_bounds()) as number[];
      expect(minX).toBeLessThanOrEqual(rect.min[0]);
      expect(minY).toBeLessThanOrEqual(rect.min[1]);
      expect(maxX).toBeGreaterThanOrEqual(rect.max[0]);
      expect(maxY).toBeGreaterThanOrEqual(rect.max[1]);
      // Tight on the limiting axis (height here): the rect fills 1/margin of it.
      expect((rect.max[1] - rect.min[1]) / (maxY - minY)).toBeCloseTo(1 / GROUP_FIT_MARGIN);
    });
  }
});
