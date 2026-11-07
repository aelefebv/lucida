import { beforeEach, describe, expect, it } from "vitest";

import type { MinimapOverlayData } from "../renderLoopTypes.ts";
import {
  drawDynamicMinimapOverlays,
  drawMinimapOverlays,
  drawStaticMinimapOverlays,
  drawViewportOverlays,
  drawZPlaneOverlays,
  zPlaneLayerDirty,
  type MinimapColors,
} from "./minimapOverlay.ts";
import { paint, rgbColor } from "../theme/tokenColors.ts";

/** Distinct colors per role, so an assertion can tell the layers apart. */
const COLORS: MinimapColors = {
  background: rgbColor(0, 0, 0),
  stroke: rgbColor(255, 255, 255, 0.85),
  label: rgbColor(250, 250, 250),
  axisX: rgbColor(255, 0, 0),
  axisY: rgbColor(0, 255, 0),
  axisZ: rgbColor(0, 0, 255),
  viewport: rgbColor(100, 180, 255),
  plane: rgbColor(255, 200, 50),
};
const PLANE_FILL = paint(COLORS.plane, 0.25);
const VIEWPORT_FILL = paint(COLORS.viewport, 0.3);

type Op = { type: "call"; name: string; args: unknown[] } | { type: "set"; name: string; value: unknown };

/**
 * A canvas 2D context stand-in that records every method call and property
 * assignment in order. The overlay drawing functions only ever write to the
 * context (never read a property back), so recording sets + calls captures the
 * complete, ordered draw program.
 */
function recordingCtx(log: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return (...args: unknown[]) => {
          log.push({ type: "call", name: String(prop), args });
        };
      },
      set(_t, prop, value) {
        log.push({ type: "set", name: String(prop), value });
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function makeData(mode: "slice" | "volume", overrides: Partial<MinimapOverlayData> = {}): MinimapOverlayData {
  const model = identity();
  return {
    viewProj: identity(),
    layers: [
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model },
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model },
    ],
    datasetLayers: [
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model, width: 500, height: 500, depth: 9 },
    ],
    sliceViewports: [
      {
        datasetId: "ds",
        memberId: "m0",
        modelMatrix: model,
        bounds: { minX: 10, minY: 20, maxX: 100, maxY: 120 },
        width: 500,
        height: 500,
        depth: 9,
      },
      {
        datasetId: "ds",
        memberId: "m1",
        modelMatrix: model,
        bounds: { minX: 30, minY: 40, maxX: 130, maxY: 140 },
        width: 500,
        height: 500,
        depth: 9,
      },
    ],
    mode,
    topDown: false,
    theta: 0.5,
    phi: 1.2,
    canvasW: 400,
    canvasH: 400,
    currentZ: 3,
    datasetDims: new Map([["ds", { width: 500, height: 500, depth: 9 }]]),
    mainInvViewProj: identity(),
    staticDirty: false,
    ...overrides,
  };
}

describe("dynamic overlay split", () => {
  beforeEach(() => {
    globalThis.devicePixelRatio = 2;
  });

  for (const mode of ["slice", "volume"] as const) {
    it(`drawZPlaneOverlays + drawViewportOverlays is byte-identical to drawDynamicMinimapOverlays (${mode} mode)`, () => {
      const data = makeData(mode);

      const combined: Op[] = [];
      drawDynamicMinimapOverlays(recordingCtx(combined), data, COLORS);

      const split: Op[] = [];
      const ctx = recordingCtx(split);
      drawZPlaneOverlays(ctx, data, COLORS);
      drawViewportOverlays(ctx, data, COLORS);

      expect(split).toEqual(combined);
      // The split must actually exercise draw ops, not trivially match by both
      // being empty (the orientation cube alone guarantees a non-trivial program).
      expect(combined.length).toBeGreaterThan(0);
    });
  }

  it("drawZPlaneOverlays draws only the Z-plane sub-layer in slice mode and does not clear", () => {
    const log: Op[] = [];
    drawZPlaneOverlays(recordingCtx(log), makeData("slice"), COLORS);

    // No canvas clear (the consumer owns clearing the cache canvas).
    expect(log.some((op) => op.type === "call" && op.name === "clearRect")).toBe(false);
    // Slice planes fill with the plane color; viewport rects and the cube are not here.
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === PLANE_FILL)).toBe(true);
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === VIEWPORT_FILL)).toBe(false);
    // No orientation-cube background circle.
    expect(log.some((op) => op.type === "call" && op.name === "arc")).toBe(false);
  });

  it("drawZPlaneOverlays draws nothing in volume mode", () => {
    const log: Op[] = [];
    drawZPlaneOverlays(recordingCtx(log), makeData("volume"), COLORS);
    expect(log).toEqual([]);
  });

  it("drawViewportOverlays draws viewport rects + cube in slice mode without clearing", () => {
    const log: Op[] = [];
    drawViewportOverlays(recordingCtx(log), makeData("slice"), COLORS);

    expect(log.some((op) => op.type === "call" && op.name === "clearRect")).toBe(false);
    // Viewport rect fill present, slice-plane fill absent.
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === VIEWPORT_FILL)).toBe(true);
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === PLANE_FILL)).toBe(false);
    // Orientation cube always drawn (its background circle uses arc()).
    expect(log.some((op) => op.type === "call" && op.name === "arc")).toBe(true);
  });

  it("drawViewportOverlays draws only the orientation cube in volume mode", () => {
    const log: Op[] = [];
    drawViewportOverlays(recordingCtx(log), makeData("volume"), COLORS);

    // No viewport rects in volume mode, but the cube is still present.
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === VIEWPORT_FILL)).toBe(false);
    expect(log.some((op) => op.type === "call" && op.name === "arc")).toBe(true);
  });
});

describe("top-down minimap", () => {
  beforeEach(() => {
    globalThis.devicePixelRatio = 2;
  });

  // The orientation cube's background circle is the only arc() the overlay draws.
  const drawsCube = (log: Op[]) => log.some((op) => op.type === "call" && op.name === "arc");
  const axisLabels = (log: Op[]) =>
    log.filter((op) => op.type === "call" && op.name === "fillText").map((op) => (op as { args: unknown[] }).args[0]);

  for (const mode of ["slice", "volume"] as const) {
    it(`hides the orientation cube in ${mode} mode`, () => {
      const orbit: Op[] = [];
      drawViewportOverlays(recordingCtx(orbit), makeData(mode), COLORS);
      expect(drawsCube(orbit)).toBe(true);

      const topDown: Op[] = [];
      drawViewportOverlays(recordingCtx(topDown), makeData(mode, { topDown: true }), COLORS);
      expect(drawsCube(topDown)).toBe(false);
    });
  }

  it("still draws the slice viewport rectangles", () => {
    const log: Op[] = [];
    drawViewportOverlays(recordingCtx(log), makeData("slice", { topDown: true }), COLORS);
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === VIEWPORT_FILL)).toBe(true);
  });

  it("omits the axis arrows but keeps the member outlines", () => {
    const orbit: Op[] = [];
    drawStaticMinimapOverlays(recordingCtx(orbit), makeData("slice"), COLORS);
    expect(axisLabels(orbit)).toEqual(["X", "Y", "Z"]);

    const topDown: Op[] = [];
    drawStaticMinimapOverlays(recordingCtx(topDown), makeData("slice", { topDown: true }), COLORS);
    expect(axisLabels(topDown)).toEqual([]);
    expect(topDown.some((op) => op.type === "set" && op.name === "strokeStyle" && op.value === paint(COLORS.stroke, 0.6))).toBe(true);
  });

  it("draws no slice plane", () => {
    const log: Op[] = [];
    drawZPlaneOverlays(recordingCtx(log), makeData("slice", { topDown: true }), COLORS);
    expect(log).toEqual([]);
  });
});

describe("zPlaneLayerDirty", () => {
  it("is true on the first draw (no previous Z)", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5 }), null)).toBe(true);
  });

  it("is true when the Z-plane changed", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5 }), 4)).toBe(true);
  });

  it("is true on a geometry change even when Z is unchanged", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5, staticDirty: true }), 5)).toBe(true);
  });

  it("is false on a pan/zoom with unchanged Z and no geometry change", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5, staticDirty: false }), 5)).toBe(false);
  });
});

describe("overlay colors", () => {
  beforeEach(() => {
    globalThis.devicePixelRatio = 1;
  });

  /** Every fill and stroke the full overlay sets, in both modes. */
  function styles(colors: MinimapColors): unknown[] {
    const log: Op[] = [];
    for (const mode of ["slice", "volume"] as const) drawMinimapOverlays(recordingCtx(log), makeData(mode), colors);
    return log
      .filter((op) => op.type === "set" && (op.name === "fillStyle" || op.name === "strokeStyle"))
      .map((op) => (op as { value: unknown }).value);
  }

  it("takes every color it paints from the colors it is given", () => {
    const other: MinimapColors = {
      background: rgbColor(255, 255, 255),
      stroke: rgbColor(0, 0, 0, 0.75),
      label: rgbColor(10, 10, 10),
      axisX: rgbColor(200, 40, 40),
      axisY: rgbColor(20, 130, 60),
      axisZ: rgbColor(40, 100, 230),
      viewport: rgbColor(30, 110, 215),
      plane: rgbColor(176, 120, 0),
    };
    const a = styles(COLORS);
    const b = styles(other);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toHaveLength(a.length);
    a.forEach((value, i) => expect(value, `style ${i}`).not.toBe(b[i]));
  });
});
