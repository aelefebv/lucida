// @vitest-environment happy-dom

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { WasmScene } from "lucida-core";
import {
  eventToScreenPx,
  eventToWorld,
  makeFrameToScreen,
  makeMarkToScreen,
  makeProjectAnnotationToCss,
  makeWorldToScreen,
  markShift,
  pickFramePoint,
} from "./cameraProjection.ts";
import type { FramePoint } from "./annotationGeometry.ts";
import { datasetId, fixture, loadWasm, openIn, type DatasetOpenedJson } from "../viewProperties.ts";

/** A scene stub exposing only the 2D camera accessors the projections read. */
function makeScene2D(zoom: number, center: [number, number]): WasmScene {
  return {
    active_view: () => 0,
    zoom: () => zoom,
    center: () => new Float64Array(center),
    transposed: () => false,
  } as unknown as WasmScene;
}

describe("a transposed view", () => {
  it("reads the plane's across axis down the screen, and projects back", () => {
    const scene = { zoom: () => 2, center: () => new Float64Array([10, 20]), transposed: () => true } as unknown as WasmScene;
    const element = makeCanvas(0, 0, 400, 200);
    const surface = { view: 0, element };
    // 100 px right of the middle is 50 units down the plane, 20 px below it 10 across.
    expect(eventToWorld(scene, surface, { clientX: 300, clientY: 120 })).toEqual([20, 70]);
    expect(makeWorldToScreen(scene, surface)([20, 70])).toEqual([300, 120]);
  });
});

/** A canvas with a fixed layout box (like the overlay test harnesses), so the
 * math is deterministic regardless of happy-dom's zero-size default. */
function makeCanvas(left = 0, top = 0, w = 800, h = 600): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: h, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON() {} }) as DOMRect;
  return canvas;
}

function setDpr(value: number) {
  Object.defineProperty(globalThis, "devicePixelRatio", { value, configurable: true });
}

beforeEach(() => {
  setDpr(1);
});

describe("eventToScreenPx", () => {
  it("maps a client point to canvas-relative physical pixels", () => {
    const canvas = makeCanvas(100, 50);
    expect(eventToScreenPx(canvas, { clientX: 100, clientY: 50 })).toEqual([0, 0]);
    expect(eventToScreenPx(canvas, { clientX: 340, clientY: 170 })).toEqual([240, 120]);
  });

  it("scales by the device pixel ratio (physical, not CSS, pixels)", () => {
    setDpr(2);
    const canvas = makeCanvas(0, 0);
    expect(eventToScreenPx(canvas, { clientX: 10, clientY: 20 })).toEqual([20, 40]);
  });
});

describe("eventToWorld (2D inverse camera)", () => {
  it("at zoom=1, center=(0,0): world = clientPx − canvas half", () => {
    const scene = makeScene2D(1, [0, 0]);
    const canvas = makeCanvas(); // 800x600 → half (400, 300)
    expect(eventToWorld(scene, { view: 0, element: canvas }, { clientX: 500, clientY: 400 })).toEqual([100, 100]);
    expect(eventToWorld(scene, { view: 0, element: canvas }, { clientX: 400, clientY: 300 })).toEqual([0, 0]);
  });

  it("applies zoom and center: world = (screenPx − half)/zoom + center", () => {
    const scene = makeScene2D(2, [50, -20]);
    const canvas = makeCanvas();
    // screenPx (500, 400) → ((500−400)/2 + 50, (400−300)/2 − 20) = (100, 30)
    expect(eventToWorld(scene, { view: 0, element: canvas }, { clientX: 500, clientY: 400 })).toEqual([100, 30]);
  });

  it("is dpr-aware: cursor and canvas half both scale, so a CSS point maps identically", () => {
    const canvas = makeCanvas();
    const scene = makeScene2D(1, [0, 0]);
    const at1 = eventToWorld(scene, { view: 0, element: canvas }, { clientX: 500, clientY: 400 });
    setDpr(2);
    // With zoom in PHYSICAL px per world unit, doubling dpr doubles both the
    // cursor offset and the half-extents; at the same zoom the world point's
    // offset from center doubles too.
    const at2 = eventToWorld(scene, { view: 0, element: canvas }, { clientX: 500, clientY: 400 });
    expect(at2).toEqual([at1[0] * 2, at1[1] * 2]);
  });
});

describe("makeWorldToScreen (2D forward camera)", () => {
  it("is the exact inverse of eventToWorld (round-trips to the CSS point)", () => {
    const scene = makeScene2D(1.7, [12.5, -3.25]);
    const canvas = makeCanvas();
    setDpr(2);
    const world = eventToWorld(scene, { view: 0, element: canvas }, { clientX: 231, clientY: 377 });
    const project = makeWorldToScreen(scene, { view: 0, element: canvas });
    const [sx, sy] = project(world);
    // Screen coords are canvas-relative CSS px; the canvas box sits at (0,0).
    expect(sx).toBeCloseTo(231, 10);
    expect(sy).toBeCloseTo(377, 10);
  });

  it("snapshots the camera at creation: later scene movement doesn't shift this frame's projection", () => {
    let zoom = 1;
    const scene = {
      active_view: () => 0,
      zoom: () => zoom,
      center: () => new Float64Array([0, 0]),
      transposed: () => false,
    } as unknown as WasmScene;
    const canvas = makeCanvas();
    const project = makeWorldToScreen(scene, { view: 0, element: canvas });
    const before = project([100, 100]);
    zoom = 4; // the camera moves mid-frame…
    expect(project([100, 100])).toEqual(before); // …but this frame stays consistent
  });
});

describe("makeProjectAnnotationToCss (3D per-vertex marker projection)", () => {
  it("converts the physical-pixel projection to CSS px via dpr", () => {
    setDpr(2);
    const scene = {
      project_annotation: (_view: number, _ds: string, _x: number, _y: number, _z: number) =>
        new Float64Array([200, 300]),
    } as unknown as WasmScene;
    const project = makeProjectAnnotationToCss(scene, 0, "wds-1");
    expect(project([10, 20, 3])).toEqual([100, 150]);
  });

  it("returns null for an empty projection (vertex behind the camera)", () => {
    const scene = {
      project_annotation: () => new Float64Array([]),
    } as unknown as WasmScene;
    const project = makeProjectAnnotationToCss(scene, 0, "wds-1");
    expect(project([10, 20, 3])).toBeNull();
  });

  it("passes the view, the dataset id and the full (x, y, z) point through to the scene", () => {
    const calls: unknown[][] = [];
    const scene = {
      project_annotation: (...args: unknown[]) => {
        calls.push(args);
        return new Float64Array([0, 0]);
      },
    } as unknown as WasmScene;
    makeProjectAnnotationToCss(scene, 2, "wds-9")([7, 8, 9]);
    expect(calls).toEqual([[2, "wds-9", 7, 8, 9]]);
  });
});

describe("makeFrameToScreen (a mark's frame point on the view's plane)", () => {
  /** A view of `plane` at one device pixel per unit, centred on the scene
   * origin, over a dataset placed with samples 2 apart along Z. */
  function sideScene(plane: string): WasmScene {
    return {
      zoom: () => 1,
      center: () => new Float64Array([0, 0]),
      transposed: () => false,
      slice_plane: () => plane,
      dataset_placement: () => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2]),
    } as unknown as WasmScene;
  }

  it("draws a point at its place across and down each plane, through the placement", () => {
    const surface = { view: 0, element: makeCanvas() };
    const point: [number, number, number] = [30, 40, 5.5];
    // XY: X across, Y down; the depth doesn't show.
    expect(makeFrameToScreen(sideScene("xy"), surface, "ds")(point)).toEqual([430, 340]);
    // XZ: X across, Z down, 2 scene units a sample.
    expect(makeFrameToScreen(sideScene("xz"), surface, "ds")(point)).toEqual([430, 311]);
    // YZ: Y across, Z down.
    expect(makeFrameToScreen(sideScene("yz"), surface, "ds")(point)).toEqual([440, 311]);
  });
});

describe("pickFramePoint", () => {
  it("asks the scene for the view's point under the pointer, in device pixels", () => {
    setDpr(2);
    const calls: unknown[][] = [];
    const scene = {
      pick_annotation_voxel: (...args: unknown[]) => {
        calls.push(args);
        return new Float64Array([1, 2, 3.5]);
      },
    } as unknown as WasmScene;
    const surface = { view: 3, element: makeCanvas(100, 50) };
    expect(pickFramePoint(scene, surface, "ds", { clientX: 110, clientY: 70 })).toEqual([1, 2, 3.5]);
    expect(calls).toEqual([[3, "ds", 20, 40, undefined, undefined]]);
  });

  it("is null where the scene has no point", () => {
    const scene = { pick_annotation_voxel: () => new Float64Array([]) } as unknown as WasmScene;
    expect(pickFramePoint(scene, { view: 0, element: makeCanvas() }, "ds", { clientX: 1, clientY: 1 })).toBeNull();
  });

  it("passes the mark the point belongs to: its first vertex and its tile", () => {
    const calls: unknown[][] = [];
    const scene = {
      pick_annotation_voxel: (...args: unknown[]) => {
        calls.push(args);
        return new Float64Array([1, 2, 3.5]);
      },
    } as unknown as WasmScene;
    pickFramePoint(scene, { view: 0, element: makeCanvas() }, "ds", { clientX: 1, clientY: 1 }, { start: [4, 5, 6.5], anchor: "t4" });
    expect([...(calls[0][4] as Float64Array)]).toEqual([4, 5, 6.5]);
    expect(calls[0][5]).toBe("t4");
  });
});

describe("makeMarkToScreen (a mark's vertices moved by its shift)", () => {
  it("moves every vertex by the shift of the mark's tile", () => {
    const asked: unknown[][] = [];
    const scene = {
      zoom: () => 1,
      center: () => new Float64Array([0, 0]),
      transposed: () => false,
      slice_plane: () => "xz",
      dataset_placement: () => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      annotation_shift: (...args: unknown[]) => {
        asked.push(args);
        return new Float64Array([0, -40, 20]);
      },
    } as unknown as WasmScene;
    const surface = { view: 2, element: makeCanvas() };
    const start: FramePoint = [30, 52.5, 3.5];
    const project = makeMarkToScreen(scene, surface)("ds", { start, anchor: "t4" });
    expect(project(start)).toEqual([430, 323.5]);
    // A vertex past the tile still moves by the mark's shift.
    expect(project([90, 52.5, 30])).toEqual([490, 350]);
    expect(asked).toEqual([[2, "ds", 30, 52.5, 3.5, "t4"]]);
    const none = { annotation_shift: () => new Float64Array([]) } as unknown as WasmScene;
    expect(markShift(none, surface, "ds", { start })).toEqual([0, 0, 0]);
  });
});

describe("a mark on a tile of a collection, in a side view and in XY", () => {
  beforeAll(loadWasm);

  /** The twelve tiles of the collection fixture, 256 samples square and 288
   * apart, each made 16 planes deep. */
  function deepCollection(): DatasetOpenedJson {
    const opened = structuredClone(fixture("collection").opened);
    for (const multiscale of opened.manifest.multiscales ?? []) {
      for (const level of multiscale.levels) {
        level.shape[2] = 16;
        level.grid_shape[2] = 16;
      }
    }
    return opened;
  }

  /** A canvas 800 by 600 CSS px over a view of `plane`, at `dpr`. */
  function viewOf(plane: string, dpr: number) {
    Object.defineProperty(globalThis, "devicePixelRatio", { value: dpr, configurable: true });
    const scene = new WasmScene(800 * dpr, 600 * dpr);
    const opened = deepCollection();
    openIn(scene, opened);
    scene.apply_command(JSON.stringify({ type: "set_slice_plane", plane }));
    if (plane === "xz") scene.apply_command(JSON.stringify({ type: "set_y", y: 100 }));
    const surface = { view: scene.active_view(), element: makeCanvas() };
    return { scene, surface, id: datasetId(fixture("collection")) };
  }

  /** Where `surface`'s view draws the sample `local` of tile `entity`, from
   * its corner, as the renderer places the tile's cell. */
  function drawnAt(scene: WasmScene, surface: { view: number; element: HTMLElement }, id: string, entity: string, local: FramePoint) {
    const cells = JSON.parse(scene.plane_positions(surface.view, id)) as Record<string, [number, number]>;
    const [across, down] = cells[entity];
    const side = scene.slice_plane(surface.view) === "xz";
    const point: FramePoint = side ? [across + local[0], 0, down + local[2]] : [across + local[0], down + local[1], 0];
    const [x, y] = makeFrameToScreen(scene, surface, id)(point);
    return { clientX: x, clientY: y };
  }

  for (const dpr of [1, 2]) {
    it(`lands on the tile under the pointer and draws back there, at dpr ${dpr}`, () => {
      const { scene, surface, id } = viewOf("xz", dpr);
      // The second tile of the second row starts at (288, 288).
      const tile = "collection-r1c1";
      const at = drawnAt(scene, surface, id, tile, [40.5, 0, 5.5]);
      const point = pickFramePoint(scene, surface, id, at);
      [328.5, 388.5, 5.5].forEach((v, i) => expect(point?.[i]).toBeCloseTo(v, 6));
      const back = makeMarkToScreen(scene, surface)(id, { start: point! })(point!);
      expect(back[0]).toBeCloseTo(at.clientX, 6);
      expect(back[1]).toBeCloseTo(at.clientY, 6);

      // XY draws it over the same tile, where the frame puts it.
      scene.apply_command(JSON.stringify({ type: "set_slice_plane", plane: "xy" }));
      const [x, y] = makeMarkToScreen(scene, surface)(id, { start: point! })(point!);
      expect(makeFrameToScreen(scene, surface, id)(point!)).toEqual([x, y]);
      const under = JSON.parse(scene.tile_at(surface.view, x / 800, y / 600)) as { entity: string } | null;
      expect(under?.entity).toBe(tile);
    });
  }
});
