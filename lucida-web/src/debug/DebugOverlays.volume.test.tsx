// @vitest-environment happy-dom

/**
 * The overlay layer in volume mode (#1063), mounted over a stub scene: with
 * every toggle off it draws nothing and asks the scene nothing; with the
 * chunk grid on it draws one wireframe box per chunk, in the shared draw
 * list's colors, and hovering a box opens the same inspector a cell opens.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";

import type { CpuCache } from "../pipeline/fetch/index.ts";
import type { RequestPlan } from "../pipeline/planning/index.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { DatasetState } from "../types.ts";
import { DebugOverlays } from "./DebugOverlays.tsx";
import { DEBUG_OVERLAYS, setOverlayEnabled } from "./logging.ts";
import { BOX_EDGES, NO_ROW_DASH, NO_ROW_STROKE } from "./volumeWireframe.ts";

const CANVAS = { width: 800, height: 600 };
/** A retina display: the scene answers in physical pixels and the overlay has to divide. */
const DPR = 2;

/**
 * A scene holding one tile of one 8×8×4 image in one 4×4×4 chunk per
 * corner, seen nearly straight on: the model matrix is the identity, so
 * world space is the tile's unit cube, and the camera maps it onto a
 * 400×300 CSS-pixel rectangle from (100, 100), sheared 20 px along depth
 * so all twelve edges of a box have length. Every scene call is counted.
 */
function makeScene() {
  const calls = { project: 0, region: 0 };
  const scene = {
    t: () => 0,
    c: () => 0,
    member_positions: () => JSON.stringify({ tile: [0, 0] }),
    visible_region: () => {
      calls.region += 1;
      return JSON.stringify({
        xy_bounds: [0, 0, 8, 8],
        z_range: [0, 4],
        effective_zoom: 40,
        sort_center: [4, 4, 2],
        frustum_planes: null,
      });
    },
    member_model_matrix: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    eye_position: () => new Float32Array([0.5, 0.5, -3]),
    project_to_screen: (wx: number, wy: number, wz: number) => {
      calls.project += 1;
      return new Float64Array([DPR * (100 + wx * 400 + wz * 20), DPR * (100 + wy * 300 + wz * 20)]);
    },
  };
  return { scene: scene as unknown as WasmScene, calls };
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: CANVAS.width });
  Object.defineProperty(canvas, "clientHeight", { value: CANVAS.height });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: CANVAS.width, bottom: CANVAS.height, width: CANVAS.width, height: CANVAS.height, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
}

function makeDatasets(): Map<string, DatasetState> {
  const dataset = {
    id: "ds",
    name: "ds",
    manifest: {
      dataset_id: "ds",
      name: "ds",
      kind: "SingleImage",
      entities: [{ id: "tile", kind: "Tile", parent: null }],
      transforms: [],
      images: [
        {
          image_id: "img",
          owner: "tile",
          multiscale: {
            axes: [],
            levels: [{ level_index: 0, shape: [1, 1, 4, 8, 8], chunk_shape: [1, 1, 4, 4, 4], grid_shape: [1, 1, 1, 2, 2], scale: [1, 1, 1, 1, 1] }],
            data_type: "Uint16",
            pinned_axes: [],
          },
        },
      ],
      source_layouts: [],
      default_layout_id: null,
    },
    fetch: {},
  };
  return new Map([["ds", dataset as unknown as DatasetState]]);
}

function makeLoop(): RenderLoop {
  const plan = {
    requests: [],
    activeSet: [{ kind: "tile", entityId: "tile", imageId: "img", mode: "tiles-with-detail", detailLevels: [0], coarseLevel: null }],
    proxyRequests: [],
  } as unknown as RequestPlan;
  return {
    getTickCoordinator: () => ({ getLastPlans: () => new Map([["ds", plan]]) }),
    workerChunkResidency: () => "unknown",
  } as unknown as RenderLoop;
}

function makeCache(): CpuCache {
  return {
    snapshot: () => ({
      cached: new Map([["tile", new Set(["0/0/0/0/0/0"])]]),
      inFlight: new Map([["tile", new Set(["0/0/0/0/0/1"])]]),
    }),
    getPendingSnapshot: () => [],
    getPendingProxySnapshot: () => [],
    deliveryState: { wasChunkSent: () => false },
    getCachedChunkTier: () => null,
    getCachedProxy: () => null,
    isProxyInFlight: () => false,
  } as unknown as CpuCache;
}

function mount(scene: WasmScene, canvas: HTMLCanvasElement) {
  return render(
    <DebugOverlays
      wasmSceneRef={{ current: scene }}
      canvasRef={{ current: canvas }}
      datasets={makeDatasets()}
      renderLoopRef={{ current: makeLoop() }}
      cpuCache={makeCache()}
      viewMode="3d"
    />,
  );
}

function pointerMove(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  act(() => {
    canvas.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY, bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal("devicePixelRatio", DPR);
});

afterEach(() => {
  cleanup();
  for (const name of DEBUG_OVERLAYS) setOverlayEnabled(name, false);
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the overlay layer in volume mode", () => {
  it("draws nothing and asks the scene nothing while every toggle is off", () => {
    const { scene, calls } = makeScene();
    const { container } = mount(scene, makeCanvas());

    expect(container.innerHTML).toBe("");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(container.innerHTML).toBe("");
    expect(calls).toEqual({ project: 0, region: 0 });
  });

  it("draws each chunk as a wireframe box in the draw list's color, one path per style, and no rectangle", () => {
    setOverlayEnabled("chunkGrid", true);
    const { scene, calls } = makeScene();
    const { container } = mount(scene, makeCanvas());

    const batches = Array.from(container.querySelectorAll('[data-testid="overlay-box-batch"]'));
    expect(container.querySelectorAll("div[title]")).toHaveLength(0);
    expect(calls.project).toBe(4 * 8);

    // One cached, one in flight, two planned: three styles over four boxes.
    const byStroke = new Map(batches.map((path) => [path.getAttribute("stroke"), path]));
    expect(byStroke.get("rgba(80, 220, 120, 0.9)")!.getAttribute("data-count")).toBe("1");
    expect(byStroke.get("rgba(240, 200, 70, 0.9)")!.getAttribute("data-count")).toBe("1");
    expect(byStroke.get("rgba(240, 90, 90, 0.9)")!.getAttribute("data-count")).toBe("2");
    expect(batches).toHaveLength(3);
    for (const path of batches) {
      const count = Number(path.getAttribute("data-count"));
      expect(path.getAttribute("d")!.split("M")).toHaveLength(count * BOX_EDGES.length + 1);
      expect(path.getAttribute("fill")).toBe("none");
    }
  });

  it("opens the inspector for the box under the pointer and marks that box", () => {
    setOverlayEnabled("chunkGrid", true);
    const { scene } = makeScene();
    const canvas = makeCanvas();
    const { container } = mount(scene, canvas);

    // voxelToWorld flips y in volume mode, so chunk row 0 is the lower half
    // of the projected tile.
    pointerMove(canvas, 150, 350);
    let inspector = screen.getByTestId("overlay-inspector");
    expect(inspector.textContent).toContain("tile · 0/0/0/0/0/0");
    expect(inspector.textContent).toContain("no interval open, so no row to read");
    let marked = container.querySelectorAll('[data-testid="overlay-box-hovered"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("data-chunk")).toBe("0/0/0/0/0/0");
    const d = marked[0].getAttribute("d")!;
    expect(d.split("M")).toHaveLength(BOX_EDGES.length + 1);
    // Corners in CSS pixels, after the overlay divides out the ratio: the
    // chunk is the tile's lower-left quarter at full depth, so corner 0 lands
    // at (100, 400) and corner 7 at (320, 270).
    expect(d).toContain("M100.0 400.0 L");
    expect(d).toContain(" L320.0 270.0");

    pointerMove(canvas, 450, 150);
    inspector = screen.getByTestId("overlay-inspector");
    expect(inspector.textContent).toContain("tile · 0/0/0/0/1/1");
    marked = container.querySelectorAll('[data-testid="overlay-box-hovered"]');
    expect(marked[0].getAttribute("data-chunk")).toBe("0/0/0/0/1/1");

    act(() => {
      canvas.dispatchEvent(new MouseEvent("pointerleave"));
    });
    expect(screen.queryByTestId("overlay-inspector")).toBeNull();
    expect(container.querySelectorAll('[data-testid="overlay-box-hovered"]')).toHaveLength(0);
  });

  it("colors the boxes by a cache mode as the cells would be colored", () => {
    setOverlayEnabled("chunkGrid", true);
    setOverlayEnabled("chunkTier", true);
    const { scene } = makeScene();
    const { container } = mount(scene, makeCanvas());

    // No chunk is resident in the worker, so every box shows the missing tier.
    const batches = Array.from(container.querySelectorAll('[data-testid="overlay-box-batch"]'));
    expect(batches).toHaveLength(1);
    expect(batches[0].getAttribute("data-count")).toBe("4");
    expect(batches[0].getAttribute("stroke")).toBe("rgba(245, 70, 70, 0.9)");
  });

  it("draws a box with no row dashed and captions the empty picture, as the slice overlay does", () => {
    setOverlayEnabled("phaseColor", true);
    const { scene } = makeScene();
    const { container } = mount(scene, makeCanvas());

    const batches = Array.from(container.querySelectorAll('[data-testid="overlay-box-batch"]'));
    expect(batches).toHaveLength(1);
    expect(batches[0].getAttribute("data-count")).toBe("4");
    expect(batches[0].getAttribute("stroke")).toBe(NO_ROW_STROKE);
    expect(batches[0].getAttribute("stroke-dasharray")).toBe(NO_ROW_DASH);
    expect(screen.getByTestId("overlay-absence").textContent).toContain("no interval is open");
  });
});
