// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from "vitest";
import type { WasmScene } from "lucida-core";
import {
  centerForWorldAnchor,
  eventToScreenPx,
  eventToWorld,
  makeProjectAnnotationToCss,
  makeWorldToScreen,
} from "./cameraProjection.ts";

/** A scene stub exposing only the 2D camera accessors the projections read. */
function makeScene2D(zoom: number, center: [number, number]): WasmScene {
  return {
    zoom: () => zoom,
    center: () => new Float64Array(center),
  } as unknown as WasmScene;
}

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
    expect(eventToWorld(scene, canvas, { clientX: 500, clientY: 400 })).toEqual([100, 100]);
    expect(eventToWorld(scene, canvas, { clientX: 400, clientY: 300 })).toEqual([0, 0]);
  });

  it("applies zoom and center: world = (screenPx − half)/zoom + center", () => {
    const scene = makeScene2D(2, [50, -20]);
    const canvas = makeCanvas();
    // screenPx (500, 400) → ((500−400)/2 + 50, (400−300)/2 − 20) = (100, 30)
    expect(eventToWorld(scene, canvas, { clientX: 500, clientY: 400 })).toEqual([100, 30]);
  });

  it("maps the same CSS point identically at DPR1 and DPR2", () => {
    const canvas = makeCanvas();
    const scene = makeScene2D(1, [0, 0]);
    const at1 = eventToWorld(scene, canvas, { clientX: 500, clientY: 400 });
    setDpr(2);
    const at2 = eventToWorld(scene, canvas, { clientX: 500, clientY: 400 });
    expect(at2).toEqual(at1);
  });
});

describe("makeWorldToScreen (2D forward camera)", () => {
  it("is the exact inverse of eventToWorld (round-trips to the CSS point)", () => {
    const scene = makeScene2D(1.7, [12.5, -3.25]);
    const canvas = makeCanvas();
    setDpr(2);
    const world = eventToWorld(scene, canvas, { clientX: 231, clientY: 377 });
    const project = makeWorldToScreen(scene, canvas);
    const [sx, sy] = project(world);
    // Screen coords are canvas-relative CSS px; the canvas box sits at (0,0).
    expect(sx).toBeCloseTo(231, 10);
    expect(sy).toBeCloseTo(377, 10);
  });

  it("snapshots the camera at creation: later scene movement doesn't shift this frame's projection", () => {
    let zoom = 1;
    const scene = {
      zoom: () => zoom,
      center: () => new Float64Array([0, 0]),
    } as unknown as WasmScene;
    const canvas = makeCanvas();
    const project = makeWorldToScreen(scene, canvas);
    const before = project([100, 100]);
    zoom = 4; // the camera moves mid-frame…
    expect(project([100, 100])).toEqual(before); // …but this frame stays consistent
  });

  it("projects identical serialized 2D camera state identically across DPR", () => {
    const scene = makeScene2D(1.75, [41, -9]);
    const canvas = makeCanvas(0, 0, 960, 540);
    const world: [number, number] = [123, 77];
    setDpr(1);
    const at1 = makeWorldToScreen(scene, canvas)(world);
    setDpr(2);
    const at2 = makeWorldToScreen(scene, canvas)(world);
    expect(at2).toEqual(at1);
    expect(eventToWorld(scene, canvas, { clientX: at2[0], clientY: at2[1] }))
      .toEqual(world);
  });
});

describe("centerForWorldAnchor (2D wheel anchoring)", () => {
  it("keeps the same world point under the same CSS pointer at DPR1 and DPR2", () => {
    const canvas = makeCanvas(100, 50, 800, 600);
    const pointer = { clientX: 620, clientY: 410 };
    const initial = makeScene2D(1.25, [20, -30]);
    setDpr(1);
    const world = eventToWorld(initial, canvas, pointer);
    const at1 = centerForWorldAnchor(canvas, pointer, world, 2.5);
    setDpr(2);
    const at2 = centerForWorldAnchor(canvas, pointer, world, 2.5);
    expect(at2).toEqual(at1);
    expect(eventToWorld(makeScene2D(2.5, at2), canvas, pointer)).toEqual(world);
  });
});

describe("makeProjectAnnotationToCss (3D per-vertex marker projection)", () => {
  it("converts the physical-pixel projection to CSS px via dpr", () => {
    setDpr(2);
    const scene = {
      project_annotation: (_ds: string, _x: number, _y: number, _z: number) =>
        new Float64Array([200, 300]),
    } as unknown as WasmScene;
    const project = makeProjectAnnotationToCss(scene, "wds-1");
    expect(project([10, 20], 3)).toEqual([100, 150]);
  });

  it("returns null for an empty projection (vertex behind the camera)", () => {
    const scene = {
      project_annotation: () => new Float64Array([]),
    } as unknown as WasmScene;
    const project = makeProjectAnnotationToCss(scene, "wds-1");
    expect(project([10, 20], 3)).toBeNull();
  });

  it("passes the dataset id and full (x, y, z) point through to the scene", () => {
    const calls: unknown[][] = [];
    const scene = {
      project_annotation: (...args: unknown[]) => {
        calls.push(args);
        return new Float64Array([0, 0]);
      },
    } as unknown as WasmScene;
    makeProjectAnnotationToCss(scene, "wds-9")([7, 8], 9);
    expect(calls).toEqual([["wds-9", 7, 8, 9]]);
  });
});
